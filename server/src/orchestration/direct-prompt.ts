import { createHash, randomUUID } from "node:crypto";

import {
  AI_DM_PROTOCOL_VERSION,
  type AiDmAccessScope,
  type AiDmActionProposal,
  type AiDmAuthenticatedIdentity,
  type AiDmClientMessage,
  type AiDmContinuationCapsule,
  type AiDmContextReceipt,
  type AiDmEffectiveAudience,
  type AiDmMessage,
  type AiDmNormalizedEvent,
  type AiDmPromptSubmit,
  type AiDmRequestedAudience,
  type AiDmRun,
  type AiDmRunBudgets,
  type AiDmRunPrincipal,
  type AiDmRunStatus,
  type AiDmRuntimeProjection,
  type AiDmServerDelivery,
  type AiDmServerPayload,
  type AiDmThread,
} from "@foundry-ai-dungeon-master/shared";

import type { AiDmOperationalStore } from "../storage/index.js";
import type { AiDmCommandHandler } from "../transport/websocket-gateway.js";
import { AiDmProviderError } from "../runner/types.js";

export interface AiDmAuthoritativeProjection {
  principal: AiDmRunPrincipal;
  projection: AiDmRuntimeProjection;
  activeUserIds: string[];
  gmUserIds: string[];
}

export interface AiDmWorldGateway {
  project(input: {
    event: AiDmNormalizedEvent;
    identity: AiDmAuthenticatedIdentity;
  }): Promise<AiDmAuthoritativeProjection>;
  mirrorPublicNarration?(input: { text: string; eventId: string }): Promise<void>;
}

export interface AiDmExecutionHooks {
  status(status: AiDmRunStatus): Promise<void>;
  output(delta: string): Promise<void>;
  providerResponse(responseId: string): Promise<void>;
}

export interface AiDmRunExecutionResult {
  finalText: string;
  receipt: AiDmContextReceipt;
  capsule: AiDmContinuationCapsule;
  proposals?: AiDmActionProposal[];
}

export interface AiDmRunExecutor {
  execute(input: {
    run: AiDmRun;
    event: AiDmNormalizedEvent;
    projection: AiDmRuntimeProjection;
    effectiveAudience: AiDmEffectiveAudience;
    signal: AbortSignal;
    hooks: AiDmExecutionHooks;
  }): Promise<AiDmRunExecutionResult>;
}

export interface AiDmDeliverySink {
  deliver(delivery: AiDmServerDelivery): void;
}

const DEFAULT_BUDGETS: AiDmRunBudgets = {
  context: {
    maxReads: 12,
    maxDepth: 3,
    maxNodes: 48,
    maxCharacters: 80_000,
    maxEstimatedTokens: 20_000,
  },
  maxToolSearches: 6,
  maxLoadedDefinitions: 12,
  maxToolCalls: 24,
  maxProposalOperations: 12,
  maxOutputCharacters: 40_000,
  maxProviderAttempts: 3,
  maxWallClockMs: 120_000,
};

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32)}`;
}

function scopeForThread(userId: string): AiDmAccessScope {
  return { kind: "users", userIds: [userId] };
}

function requestedAudienceAllowed(
  requested: AiDmRequestedAudience,
  identity: AiDmAuthenticatedIdentity,
): boolean {
  if (requested.kind === "private" || requested.kind === "gm") return true;
  if (requested.kind === "table") return identity.isGm;
  return identity.isGm;
}

function effectiveAudience(
  requested: AiDmRequestedAudience,
  identity: AiDmAuthenticatedIdentity,
  projection: AiDmAuthoritativeProjection,
): { audience: AiDmEffectiveAudience; recipients: string[] } {
  if (requested.kind === "private") {
    return {
      audience: {
        scope: { kind: "users", userIds: [identity.userId] },
        transcript: true,
        mirrorToFoundryChat: false,
      },
      recipients: [identity.userId],
    };
  }
  if (requested.kind === "gm") {
    const recipients = [...new Set(projection.gmUserIds)].sort();
    return {
      audience: { scope: { kind: "gm" }, transcript: true, mirrorToFoundryChat: false },
      recipients,
    };
  }
  if (requested.kind === "selected-users") {
    const active = new Set(projection.activeUserIds);
    const recipients = [...new Set(requested.recipientUserIds)]
      .filter((id) => active.has(id))
      .sort();
    return {
      audience: {
        scope: { kind: "users", userIds: recipients },
        transcript: true,
        mirrorToFoundryChat: false,
      },
      recipients,
    };
  }
  return {
    audience: { scope: { kind: "public" }, transcript: true, mirrorToFoundryChat: true },
    recipients: [...new Set(projection.activeUserIds)].sort(),
  };
}

function privateAudience(userId: string): AiDmEffectiveAudience {
  return {
    scope: { kind: "users", userIds: [userId] },
    transcript: true,
    mirrorToFoundryChat: false,
  };
}

export class DirectPromptOrchestrator implements AiDmCommandHandler {
  readonly #abortControllers = new Map<string, AbortController>();

  constructor(
    private readonly store: AiDmOperationalStore,
    private readonly world: AiDmWorldGateway,
    private readonly executor: AiDmRunExecutor,
    private readonly sink: AiDmDeliverySink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async handle(command: AiDmClientMessage, identity: AiDmAuthenticatedIdentity): Promise<void> {
    switch (command.type) {
      case "aiDm.prompt.submit":
        await this.#prompt(command.payload, identity);
        return;
      case "aiDm.event.submit":
        if (!identity.isGm)
          throw new Error("Only an authenticated GM may submit automatic events.");
        await this.#prompt(
          {
            requestId: command.payload.requestId,
            text: `Automatic Foundry event: ${command.payload.eventType}`,
            requestedAudience: { kind: "gm" },
            contextHints: command.payload.contextHints,
          },
          identity,
          {
            eventType: command.payload.eventType,
            source: "foundry-hook",
            presentation: command.payload.presentation,
            payload: command.payload.payload,
            sourceCorrelationId: command.payload.sourceCorrelationId,
            recordPrompt: false,
          },
        );
        return;
      case "aiDm.history.fetch":
        this.#history(command.payload, identity);
        return;
      case "aiDm.run.cancel":
        this.#cancel(command.payload.runId, identity);
        return;
      case "aiDm.run.retry":
      case "aiDm.approval.decide":
      case "aiDm.choice.submit":
        throw new Error("This command is not enabled until its durable workflow is configured.");
    }
  }

  async #prompt(
    prompt: AiDmPromptSubmit,
    identity: AiDmAuthenticatedIdentity,
    eventOptions: {
      eventType: string;
      source: import("@foundry-ai-dungeon-master/shared").AiDmEventSource;
      presentation: import("@foundry-ai-dungeon-master/shared").AiDmPresentationPolicy;
      payload: import("@foundry-ai-dungeon-master/shared").AiDmJsonValue;
      sourceCorrelationId: string;
      recordPrompt: boolean;
    } = {
      eventType: "player.prompt.submitted",
      source: "direct-prompt",
      presentation: "normal",
      payload: { text: prompt.text },
      sourceCorrelationId: prompt.requestId,
      recordPrompt: true,
    },
  ): Promise<void> {
    if (!requestedAudienceAllowed(prompt.requestedAudience, identity)) {
      throw new Error("The requested audience is not authorized for this identity.");
    }
    const deduplicationKey = `${eventOptions.source === "direct-prompt" ? "prompt" : eventOptions.eventType}:${identity.userId}:${prompt.requestId}`;
    let event = this.store.getEventByDeduplicationKey(
      identity.worldId,
      deduplicationKey,
      identity.userId,
      identity.isGm,
    );
    const acceptedAt = event?.receivedAt ?? this.now().toISOString();
    const thread = this.#thread(identity, acceptedAt);
    if (!event) {
      const created = this.store.appendEvent({
        schemaVersion: 1,
        eventId: stableId("event", identity.worldId, identity.userId, prompt.requestId),
        eventType: eventOptions.eventType,
        source: eventOptions.source,
        occurredAt: acceptedAt,
        authenticatedIdentity: identity,
        presentation: eventOptions.presentation,
        requestedAudience: prompt.requestedAudience,
        contextHints: prompt.contextHints,
        payload: eventOptions.payload,
        sourceCorrelationId: eventOptions.sourceCorrelationId,
        deduplicationKey,
        sourceStateRevision: null,
      });
      event = created.event;
    }
    const runId = stableId("run", event.eventId, "1");
    const existingRun = this.store.getRun(runId);
    if (existingRun) {
      this.#deliver(identity.userId, identity.worldId, thread.threadId, runId, acceptedAt, {
        type: "aiDm.run.acknowledged",
        payload: {
          requestId: prompt.requestId,
          eventId: event.eventId,
          runId,
          threadId: thread.threadId,
        },
      });
      return;
    }

    const authority = await this.world.project({ event, identity });
    if (
      authority.principal.userId !== identity.userId ||
      authority.principal.worldId !== identity.worldId ||
      authority.principal.isGm !== identity.isGm
    ) {
      throw new Error("Authoritative projection identity does not match the enrolled connection.");
    }
    this.store.recordProjection(authority.projection);
    const run: AiDmRun = {
      runId,
      eventId: event.eventId,
      threadId: thread.threadId,
      principal: authority.principal,
      attempt: 1,
      status: "queued",
      statusRevision: 0,
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
      providerResponseId: null,
      providerResponseRunBinding: null,
      budgets: structuredClone(DEFAULT_BUDGETS),
      cancelRequestedAt: null,
      failureCode: null,
    };
    this.store.createRun(run);
    if (eventOptions.recordPrompt) {
      this.#appendMessage(
        {
          messageId: stableId("message", event.eventId, "prompt"),
          threadId: thread.threadId,
          runId,
          eventId: event.eventId,
          kind: "prompt",
          deliveryClass: "private",
          effectiveAudience: privateAudience(identity.userId),
          createdAt: acceptedAt,
          content: { kind: "plain-text", text: prompt.text },
        },
        [identity.userId],
      );
    }
    this.#deliver(identity.userId, identity.worldId, thread.threadId, runId, acceptedAt, {
      type: "aiDm.run.acknowledged",
      payload: {
        requestId: prompt.requestId,
        eventId: event.eventId,
        runId,
        threadId: thread.threadId,
      },
    });

    const resolved = effectiveAudience(prompt.requestedAudience, identity, authority);
    if (resolved.recipients.length === 0) throw new Error("The effective audience is empty.");
    const recipientThreads = new Map(
      resolved.recipients.map((recipientUserId) => [
        recipientUserId,
        recipientUserId === identity.userId
          ? thread
          : this.#recipientThread(identity.worldId, recipientUserId, acceptedAt),
      ]),
    );
    const outputMessageIds = new Map(
      resolved.recipients.map((recipientUserId) => [
        recipientUserId,
        stableId("message", event.eventId, "result", recipientUserId),
      ]),
    );
    const abort = new AbortController();
    this.#abortControllers.set(runId, abort);
    let current = this.#transition(run, "projecting");
    let streamed = "";
    let deltaSequence = 0;
    try {
      current = this.#transition(current, "reading-context");
      const result = await this.executor.execute({
        run: current,
        event,
        projection: authority.projection,
        effectiveAudience: resolved.audience,
        signal: abort.signal,
        hooks: {
          status: (status) => {
            if (status === current.status) return Promise.resolve();
            current = this.#transition(current, status);
            return Promise.resolve();
          },
          output: (delta) => {
            const offset = streamed.length;
            streamed += delta;
            deltaSequence += 1;
            for (const recipient of resolved.recipients) {
              const recipientThread = recipientThreads.get(recipient);
              const messageId = outputMessageIds.get(recipient);
              if (!recipientThread || !messageId) continue;
              this.#deliver(
                recipient,
                identity.worldId,
                recipientThread.threadId,
                runId,
                this.now().toISOString(),
                {
                  type: "aiDm.output.delta",
                  payload: {
                    runId,
                    messageId,
                    deltaSequence,
                    offset,
                    messageRevision: deltaSequence,
                    delta,
                    final: false,
                  },
                },
              );
            }
            return Promise.resolve();
          },
          providerResponse: (responseId) => {
            if (current.providerResponseId !== null) return Promise.resolve();
            current = this.store.bindProviderResponse(
              runId,
              responseId,
              current.statusRevision,
              this.now().toISOString(),
            );
            return Promise.resolve();
          },
        },
      });
      if (current.status !== "delivering") current = this.#transition(current, "delivering");
      this.store.recordContextReceipt(result.receipt);
      this.store.recordContinuationCapsule(result.capsule);
      if (resolved.audience.mirrorToFoundryChat) {
        await this.world.mirrorPublicNarration?.({
          text: result.finalText,
          eventId: event.eventId,
        });
      }
      for (const proposal of result.proposals ?? []) {
        if (proposal.status !== "waiting-for-gm" && proposal.status !== "waiting-for-player") {
          continue;
        }
        const approvalRecipients =
          proposal.approvalAuthority.kind === "gm"
            ? authority.gmUserIds
            : proposal.approvalAuthority.kind === "users"
              ? proposal.approvalAuthority.userIds
              : authority.activeUserIds;
        for (const recipient of [...new Set(approvalRecipients)]) {
          const approvalThread =
            recipient === identity.userId
              ? thread
              : this.#recipientThread(identity.worldId, recipient, acceptedAt);
          this.#deliver(
            recipient,
            identity.worldId,
            approvalThread.threadId,
            runId,
            this.now().toISOString(),
            {
              type: "aiDm.approval.required",
              payload: {
                proposalId: proposal.proposalId,
                proposalRevision: proposal.proposalRevision,
                summary: proposal.summary,
                expiresAt: proposal.expiresAt,
                operationSummaries: proposal.operations.map(
                  ({ toolId }) => `Use ${toolId} with revision protection.`,
                ),
                approvalAuthority: proposal.approvalAuthority,
              },
            },
          );
        }
      }
      for (const recipient of resolved.recipients) {
        const recipientThread = recipientThreads.get(recipient);
        const messageId = outputMessageIds.get(recipient);
        if (!recipientThread || !messageId) continue;
        this.#appendMessage(
          {
            messageId,
            threadId: recipientThread.threadId,
            runId: recipient === identity.userId ? runId : null,
            eventId: event.eventId,
            kind: "narration",
            deliveryClass:
              resolved.audience.scope.kind === "public"
                ? "public"
                : resolved.audience.scope.kind === "gm"
                  ? "gm"
                  : "private",
            effectiveAudience: resolved.audience,
            createdAt: this.now().toISOString(),
            content: { kind: "plain-text", text: result.finalText },
          },
          [recipient],
        );
      }
      current = this.#transition(current, "complete");
      this.#deliver(identity.userId, identity.worldId, thread.threadId, runId, current.updatedAt, {
        type: "aiDm.run.completed",
        payload: {
          runId,
          ...(identity.isGm
            ? { diagnostics: { receipt: result.receipt, capsule: result.capsule } }
            : {}),
        },
      });
    } catch (error) {
      const providerFailure = error instanceof AiDmProviderError ? error : null;
      const code = abort.signal.aborted ? "RUN_CANCELLED" : (providerFailure?.code ?? "RUN_FAILED");
      const terminal = abort.signal.aborted ? "cancelled" : "failed";
      if (current.status !== terminal) current = this.#transition(current, terminal, code);
      for (const recipient of new Set([...resolved.recipients, identity.userId])) {
        const recipientThread =
          recipient === identity.userId ? thread : recipientThreads.get(recipient);
        if (!recipientThread) continue;
        this.#deliver(
          recipient,
          identity.worldId,
          recipientThread.threadId,
          runId,
          current.updatedAt,
          {
            type: "aiDm.run.failed",
            payload: {
              runId,
              code,
              message: abort.signal.aborted
                ? "The AI Dungeon Master run was cancelled."
                : (providerFailure?.message ?? "The AI Dungeon Master run failed safely."),
              retryable:
                providerFailure !== null &&
                !providerFailure.requestAccepted &&
                providerFailure.retryable,
              ...(identity.isGm && recipient === identity.userId && providerFailure
                ? {
                    diagnostics: {
                      ...(providerFailure.httpStatus === undefined
                        ? {}
                        : { httpStatus: providerFailure.httpStatus }),
                      ...(providerFailure.providerCode
                        ? { providerCode: providerFailure.providerCode }
                        : {}),
                      ...(providerFailure.providerType
                        ? { providerType: providerFailure.providerType }
                        : {}),
                      ...(providerFailure.providerParam
                        ? { providerParam: providerFailure.providerParam }
                        : {}),
                      ...(providerFailure.requestId
                        ? { requestId: providerFailure.requestId }
                        : {}),
                      ...(providerFailure.terminalEventType
                        ? { terminalEventType: providerFailure.terminalEventType }
                        : {}),
                    },
                  }
                : {}),
            },
          },
        );
      }
    } finally {
      this.#abortControllers.delete(runId);
    }
  }

  #thread(identity: AiDmAuthenticatedIdentity, createdAt: string): AiDmThread {
    const existing = this.store.resolveActiveThread(identity.userId, {
      worldId: identity.worldId,
      requesterUserId: identity.userId,
      requesterIsGm: identity.isGm,
    });
    if (existing) return existing;
    const thread: AiDmThread = {
      threadId: stableId("thread", identity.worldId, identity.userId),
      worldId: identity.worldId,
      ownerUserId: identity.userId,
      participantScope: scopeForThread(identity.userId),
      authorizedAudienceKinds: identity.isGm
        ? ["private", "gm", "selected-users", "table"]
        : ["private", "gm"],
      revision: stableId("revision", identity.worldId, identity.userId),
      status: "active",
      createdAt,
      updatedAt: createdAt,
    };
    return this.store.createThread(thread).thread;
  }

  #recipientThread(worldId: string, ownerUserId: string, createdAt: string): AiDmThread {
    const existing = this.store.resolveActiveThread(ownerUserId, {
      worldId,
      requesterUserId: ownerUserId,
      requesterIsGm: true,
    });
    if (existing) return existing;
    const thread: AiDmThread = {
      threadId: stableId("thread", worldId, ownerUserId),
      worldId,
      ownerUserId,
      participantScope: scopeForThread(ownerUserId),
      authorizedAudienceKinds: ["private", "gm"],
      revision: stableId("revision", worldId, ownerUserId),
      status: "active",
      createdAt,
      updatedAt: createdAt,
    };
    return this.store.createThread(thread).thread;
  }

  #history(
    request: Extract<AiDmClientMessage, { type: "aiDm.history.fetch" }>["payload"],
    identity: AiDmAuthenticatedIdentity,
  ): void {
    const thread = request.threadId
      ? this.store.getThread(request.threadId, {
          worldId: identity.worldId,
          requesterUserId: identity.userId,
          requesterIsGm: identity.isGm,
        })
      : this.store.resolveActiveThread(identity.userId, {
          worldId: identity.worldId,
          requesterUserId: identity.userId,
          requesterIsGm: identity.isGm,
        });
    if (!thread) return;
    const page = this.store.fetchHistory({
      threadId: thread.threadId,
      worldId: identity.worldId,
      requesterUserId: identity.userId,
      requesterIsGm: identity.isGm,
      ...(request.afterSequence === undefined ? {} : { afterSequence: request.afterSequence }),
      limit: request.limit,
    });
    this.#deliver(
      identity.userId,
      identity.worldId,
      thread.threadId,
      null,
      this.now().toISOString(),
      {
        type: "aiDm.history.result",
        payload: { requestId: request.requestId, threadId: thread.threadId, ...page },
      },
    );
  }

  #cancel(runId: string, identity: AiDmAuthenticatedIdentity): void {
    const run = this.store.getRun(runId);
    if (!run || run.principal.worldId !== identity.worldId) {
      throw new Error("Run cancellation is not authorized.");
    }
    if (run.principal.userId !== identity.userId && !identity.isGm) {
      throw new Error("Run cancellation is not authorized.");
    }
    this.#abortControllers.get(runId)?.abort();
  }

  #transition(run: AiDmRun, status: AiDmRunStatus, failureCode?: string): AiDmRun {
    const occurredAt = this.now().toISOString();
    const next = this.store.transitionRun(run.runId, run.statusRevision, status, occurredAt, {
      ...(failureCode ? { failureCode } : {}),
      ...(status === "cancelled" ? { cancelRequestedAt: occurredAt } : {}),
    });
    this.#deliver(
      run.principal.userId,
      run.principal.worldId,
      run.threadId,
      run.runId,
      occurredAt,
      {
        type: "aiDm.run.status",
        payload: { runId: run.runId, status, occurredAt },
      },
    );
    return next;
  }

  #appendMessage(
    message: Omit<AiDmMessage, "threadSequence">,
    recipientUserIds: readonly string[],
  ): void {
    const result = this.store.appendMessage(
      message,
      [...new Set(recipientUserIds)].map((recipientUserId) => ({
        recipientUserId,
        deliveryId: randomUUID(),
      })),
    );
    for (const delivery of result.deliveries) this.sink.deliver(delivery);
  }

  #deliver(
    recipientUserId: string,
    worldId: string,
    threadId: string | null,
    runId: string | null,
    occurredAt: string,
    message: AiDmServerPayload,
  ): void {
    const { delivery } = this.store.enqueueDelivery({
      protocolVersion: AI_DM_PROTOCOL_VERSION,
      deliveryId: randomUUID(),
      recipientUserId,
      worldId,
      threadId,
      runId,
      occurredAt,
      message,
    });
    this.sink.deliver(delivery);
  }
}

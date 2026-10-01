import type {
  AiDmApprovalCard,
  AiDmMessage,
  AiDmRunStatus,
  AiDmServerDelivery,
  AiDmPlayerPromptRequest,
  AiDmTransportServerMessage,
} from "@foundry-ai-dungeon-master/shared";

export interface AiDmOutputStream {
  messageId: string;
  runId: string;
  text: string;
  deltaSequence: number;
  messageRevision: number;
  final: boolean;
}

export interface AiDmRunFailure {
  code: string;
  message: string;
  retryable: boolean;
  diagnostics?: {
    httpStatus?: number;
    providerCode?: string;
    providerType?: string;
    providerParam?: string;
    requestId?: string;
    terminalEventType?: string;
  };
}

export interface AiDmClientState {
  connection:
    "disconnected" | "connecting" | "authenticating" | "authentication-failed" | "connected";
  connectionMessage: string;
  authenticatedLane: "gm" | "player" | "tv" | null;
  messages: AiDmMessage[];
  outputStreams: ReadonlyMap<string, AiDmOutputStream>;
  approvals: ReadonlyMap<string, AiDmApprovalCard>;
  runStatuses: ReadonlyMap<string, AiDmRunStatus>;
  runFailures: ReadonlyMap<string, AiDmRunFailure>;
  activeThreadId: string | null;
  lastRecipientSequence: number;
  chatGpt: {
    state: "signed-out" | "identity-only" | "model-unavailable" | "ready";
    identityConnected: boolean;
    planUsageAuthorized: boolean;
    modelDiscoveryState: "not-authorized" | "unavailable" | "empty" | "available";
    availableModels: readonly { slug: string; displayName: string }[];
    selectedModel: string | null;
    modelSelectionPending: boolean;
    email?: string;
  };
  allowAllPlayerRequests: boolean;
  playerRequests: readonly AiDmPlayerPromptRequest[];
}

type Listener = (state: AiDmClientState) => void;

export class AiDmClientStore {
  #state: AiDmClientState = {
    connection: "disconnected",
    connectionMessage: "AI Dungeon Master server is disconnected.",
    authenticatedLane: null,
    messages: [],
    outputStreams: new Map(),
    approvals: new Map(),
    runStatuses: new Map(),
    runFailures: new Map(),
    activeThreadId: null,
    lastRecipientSequence: 0,
    chatGpt: {
      state: "signed-out",
      identityConnected: false,
      planUsageAuthorized: false,
      modelDiscoveryState: "not-authorized",
      availableModels: [],
      selectedModel: null,
      modelSelectionPending: false,
    },
    allowAllPlayerRequests: false,
    playerRequests: [],
  };
  readonly #listeners = new Set<Listener>();
  readonly #messageIds = new Set<string>();

  get state(): AiDmClientState {
    return this.#state;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  setConnection(connection: AiDmClientState["connection"], connectionMessage: string): void {
    this.#replace({
      ...this.#state,
      connection,
      connectionMessage,
      ...(connection === "connected" ? {} : { authenticatedLane: null }),
    });
  }

  setAuthenticated(lane: "gm" | "player" | "tv", connectionMessage: string): void {
    this.#replace({
      ...this.#state,
      connection: "connected",
      connectionMessage,
      authenticatedLane: lane,
    });
  }

  setModelSelectionPending(pending: boolean): void {
    this.#replace({
      ...this.#state,
      chatGpt: { ...this.#state.chatGpt, modelSelectionPending: pending },
    });
  }

  applyControlMessage(message: AiDmTransportServerMessage): void {
    if (message.type === "aiDm.chatgpt.status") {
      this.#replace({
        ...this.#state,
        chatGpt: {
          state: !message.payload.identityConnected
            ? "signed-out"
            : !message.payload.planUsageAuthorized
              ? "identity-only"
              : message.payload.modelDiscoveryState === "available" &&
                  message.payload.selectedModel !== null &&
                  message.payload.availableModels.some(
                    ({ slug }) => slug === message.payload.selectedModel,
                  )
                ? "ready"
                : "model-unavailable",
          identityConnected: message.payload.identityConnected,
          planUsageAuthorized:
            message.payload.identityConnected && message.payload.planUsageAuthorized,
          modelDiscoveryState: message.payload.modelDiscoveryState,
          availableModels: message.payload.availableModels,
          selectedModel: message.payload.selectedModel,
          modelSelectionPending: false,
          ...(message.payload.email ? { email: message.payload.email } : {}),
        },
      });
    } else if (message.type === "aiDm.player-requests.state") {
      this.#replace({
        ...this.#state,
        allowAllPlayerRequests: message.payload.allowAll,
        playerRequests: message.payload.requests,
      });
    }
  }

  applyDelivery(delivery: AiDmServerDelivery): "applied" | "duplicate" | "gap" {
    if (delivery.recipientSequence <= this.#state.lastRecipientSequence) return "duplicate";
    if (
      delivery.recipientSequence !== this.#state.lastRecipientSequence + 1 &&
      delivery.message.type !== "aiDm.history.result"
    )
      return "gap";

    const statuses = new Map(this.#state.runStatuses);
    const outputStreams = new Map(this.#state.outputStreams);
    const approvals = new Map(this.#state.approvals);
    const runFailures = new Map(this.#state.runFailures);
    let messages = this.#state.messages;
    const { message } = delivery;
    if (message.type === "aiDm.message.created") {
      if (!this.#messageIds.has(message.payload.messageId)) {
        this.#messageIds.add(message.payload.messageId);
        messages = [...messages, message.payload].sort((left, right) =>
          left.threadId === right.threadId
            ? left.threadSequence - right.threadSequence
            : left.createdAt.localeCompare(right.createdAt),
        );
      }
      outputStreams.delete(message.payload.messageId);
    } else if (message.type === "aiDm.run.status") {
      statuses.set(message.payload.runId, message.payload.status);
      if (["complete", "failed", "cancelled"].includes(message.payload.status)) {
        this.#deleteOutputStreamsForRun(outputStreams, message.payload.runId);
      }
      if (message.payload.status !== "failed") runFailures.delete(message.payload.runId);
    } else if (message.type === "aiDm.run.completed") {
      statuses.set(message.payload.runId, "complete");
      runFailures.delete(message.payload.runId);
      this.#deleteOutputStreamsForRun(outputStreams, message.payload.runId);
    } else if (message.type === "aiDm.run.failed") {
      statuses.set(message.payload.runId, "failed");
      runFailures.set(message.payload.runId, {
        code: message.payload.code,
        message: message.payload.message,
        retryable: message.payload.retryable,
        ...(message.payload.diagnostics ? { diagnostics: message.payload.diagnostics } : {}),
      });
      if (message.payload.code === "PROVIDER_RECONNECT_REQUIRED") {
        this.#state = {
          ...this.#state,
          chatGpt: {
            state: "signed-out",
            identityConnected: false,
            planUsageAuthorized: false,
            modelDiscoveryState: "not-authorized",
            availableModels: [],
            selectedModel: null,
            modelSelectionPending: false,
          },
        };
      }
      this.#deleteOutputStreamsForRun(outputStreams, message.payload.runId);
    } else if (message.type === "aiDm.output.delta") {
      const current = outputStreams.get(message.payload.messageId);
      const valid =
        (!current && message.payload.offset === 0 && message.payload.deltaSequence === 1) ||
        (current &&
          message.payload.offset === current.text.length &&
          message.payload.deltaSequence === current.deltaSequence + 1 &&
          message.payload.messageRevision >= current.messageRevision);
      if (!valid) return "gap";
      {
        outputStreams.set(message.payload.messageId, {
          messageId: message.payload.messageId,
          runId: message.payload.runId,
          text: `${current?.text ?? ""}${message.payload.delta}`,
          deltaSequence: message.payload.deltaSequence,
          messageRevision: message.payload.messageRevision,
          final: message.payload.final,
        });
      }
    } else if (message.type === "aiDm.approval.required") {
      approvals.set(message.payload.proposalId, message.payload);
    } else if (message.type === "aiDm.history.result") {
      for (const item of message.payload.messages) this.#messageIds.add(item.messageId);
      const merged = new Map(messages.map((item) => [item.messageId, item]));
      for (const item of message.payload.messages) merged.set(item.messageId, item);
      messages = [...merged.values()].sort((left, right) =>
        left.threadId === right.threadId
          ? left.threadSequence - right.threadSequence
          : left.createdAt.localeCompare(right.createdAt),
      );
      for (const run of message.payload.runs ?? []) {
        statuses.set(run.runId, run.status);
        if (run.status === "failed") {
          runFailures.set(run.runId, {
            code: run.failureCode ?? "RUN_FAILED",
            message: "This run failed safely. Submit a new prompt only after resolving the cause.",
            retryable: false,
          });
        } else {
          runFailures.delete(run.runId);
        }
        if (["complete", "failed", "cancelled"].includes(run.status)) {
          this.#deleteOutputStreamsForRun(outputStreams, run.runId);
        }
      }
    }

    this.#replace({
      ...this.#state,
      messages,
      outputStreams,
      approvals,
      runStatuses: statuses,
      runFailures,
      activeThreadId:
        this.#state.activeThreadId ??
        (message.type === "aiDm.history.result" ? message.payload.threadId : delivery.threadId),
      lastRecipientSequence: delivery.recipientSequence,
    });
    return "applied";
  }

  resetRecipientSequence(sequence = 0): void {
    this.#replace({ ...this.#state, lastRecipientSequence: sequence });
  }

  #deleteOutputStreamsForRun(outputStreams: Map<string, AiDmOutputStream>, runId: string): void {
    for (const [messageId, stream] of outputStreams) {
      if (stream.runId === runId) outputStreams.delete(messageId);
    }
  }

  #replace(state: AiDmClientState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }
}

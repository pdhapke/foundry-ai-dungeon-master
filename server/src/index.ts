import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import type {
  AiDmAuthenticatedIdentity,
  AiDmClientMessage,
  AiDmJsonValue,
  AiDmPlayerPromptRequest,
  AiDmPromptSubmit,
  AiDmTransportServerMessage,
} from "@foundry-ai-dungeon-master/shared";

import { createAiDmApp } from "./app.js";
import {
  AiDmFoundrySessionService,
  ChatGptPlanAuth,
  SqliteAiDmEnrollmentRepository,
  type AiDmLocalSessionProof,
} from "./auth/index.js";
import { loadAiDmServerConfig } from "./config.js";
import { ChatKitReadTools } from "./chatkit/read-tools.js";
import { createChatKitGateway } from "./chatkit/gateway.js";
import { ContinuationCapsuleSigner } from "./context/index.js";
import { FoundryWorldGateway, StreamableFoundryLocalApiMcpClient } from "./integrations/index.js";
import {
  createCampaignContext,
  DirectPromptOrchestrator,
  ProductionRunExecutor,
  type AiDmWorldGateway,
} from "./orchestration/index.js";
import {
  ChatGptPlanResponsesProvider,
  OpenAiResponsesProvider,
  PreferredResponsesProvider,
  type AiDmProvider,
} from "./runner/index.js";
import { AiDmOperationalStore, openStorageDatabase } from "./storage/index.js";
import {
  DEFAULT_FOUNDRY_LOCAL_API_METADATA,
  FoundryLocalApiProviderAdapter,
  TrustedToolCatalog,
  type ProviderToolSnapshot,
  type ToolCatalogProvider,
} from "./tool-catalog/index.js";
import {
  AiDmDeliveryOutboxPump,
  AiDmWebSocketGateway,
  type AiDmDeliverySender,
} from "./transport/index.js";

class UnavailableWorldGateway implements AiDmWorldGateway {
  project(): Promise<never> {
    return Promise.reject(new Error("The Foundry capability provider is not configured."));
  }
}

class EmptyCatalogProvider implements ToolCatalogProvider {
  snapshot(): Promise<ProviderToolSnapshot> {
    return Promise.resolve({
      providerId: "foundry-local-api",
      providerVersion: "unavailable",
      revision: "unavailable",
      tools: [],
    });
  }
  invokeSelected(): Promise<AiDmJsonValue> {
    return Promise.reject(new Error("The Foundry capability provider is not configured."));
  }
}

async function main(): Promise<void> {
  const config = loadAiDmServerConfig();
  if (!config.foundryBrokerSecret) {
    throw new Error("Foundry identity broker unavailable; start the AI companion through Foundry.");
  }
  const database = await openStorageDatabase({
    path: join(config.runtimeRoot, "ai-dungeon-master", "operations.sqlite"),
    backupDirectory: join(config.runtimeRoot, "ai-dungeon-master", "backups"),
  });
  const store = new AiDmOperationalStore(database.connection);
  store.recoverInterruptedWork(new Date().toISOString());

  const mcpClient = config.foundryLocalApiKey
    ? new StreamableFoundryLocalApiMcpClient({
        baseUrl: config.foundryLocalApiBaseUrl,
        apiKey: config.foundryLocalApiKey,
        clientVersion: "0.1.0",
      })
    : null;
  const world: AiDmWorldGateway = mcpClient
    ? new FoundryWorldGateway(mcpClient)
    : new UnavailableWorldGateway();
  const foundrySessions = new AiDmFoundrySessionService({
    repository: new SqliteAiDmEnrollmentRepository(database.connection),
    moduleVersion: "0.1.0",
    assertionSecret: config.foundryBrokerSecret,
  });
  const chatGptAuth = new ChatGptPlanAuth({
    path: join(config.runtimeRoot, "ai-dungeon-master", "chatgpt-plan-auth.json"),
    redirectUri: `http://127.0.0.1:${config.port}/auth/callback`,
    encryptionKey: config.signingKey,
    validateLocalSessionProof: (proof) => foundrySessions.validateProof(proof),
  });
  await chatGptAuth.initialize();
  const context = createCampaignContext(config.campaignRoot);
  const catalogProvider = mcpClient
    ? new FoundryLocalApiProviderAdapter({
        providerVersion: "0.1.0",
        client: mcpClient,
      })
    : new EmptyCatalogProvider();
  const catalog = new TrustedToolCatalog(
    catalogProvider,
    DEFAULT_FOUNDRY_LOCAL_API_METADATA,
    "ai-dm-policy-v1",
  );
  const provider: AiDmProvider = new PreferredResponsesProvider(
    new ChatGptPlanResponsesProvider(
      (worldId, configuredModel) => chatGptAuth.resolveModel(worldId, configuredModel),
      undefined,
      globalThis.fetch,
      (worldId, authorizationId) => chatGptAuth.invalidate(worldId, authorizationId),
    ),
    config.openAiApiKey ? new OpenAiResponsesProvider(config.openAiApiKey) : null,
    (worldId) => chatGptAuth.providerState(worldId),
  );
  const executor = new ProductionRunExecutor({
    store,
    provider,
    model: config.openAiModel,
    catalog,
    context: context.service,
    directNodeIds: context.directNodeIds,
    capsuleSigner: new ContinuationCapsuleSigner(config.signingKey),
  });

  const authorizeChatKit = async (identity: AiDmAuthenticatedIdentity, signal?: AbortSignal): Promise<void> => {
        if (!mcpClient) throw new Error("Foundry capability provider unavailable.");
        const values = await Promise.all(
          ["foundry_get_world", "foundry_get_user_by_id"].map((name) =>
            mcpClient.callTool(
              {
                name,
                arguments: name === "foundry_get_world" ? {} : { userId: identity.userId },
                idempotencyKey: null,
              },
              { ...(signal ? { signal } : {}), timeout: 10_000, maxTotalTimeout: 10_000 },
            ),
          ),
        );
        const world = values[0] as Record<string, AiDmJsonValue>;
        const user = values[1] as Record<string, AiDmJsonValue>;
        if (
          !world ||
          !user ||
          (world["_id"] ?? world["id"]) !== identity.worldId ||
          (user["_id"] ?? user["id"]) !== identity.userId ||
          !(user["isGM"] === true || Number(user["role"]) >= 4)
        )
          throw new Error("Current Foundry GM authorization required.");
      };
  const readTools = mcpClient ? new ChatKitReadTools(mcpClient, authorizeChatKit) : null;

  const chatkitSecret = randomBytes(32).toString("hex");
  const chatkitDirectory = fileURLToPath(new URL("../../chatkit-server/", import.meta.url));
  const chatkitChild = spawn(
    config.chatkitPython,
    [
      "-m",
      "uvicorn",
      "app:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(config.chatkitPort),
      "--no-access-log",
    ],
    {
      cwd: chatkitDirectory,
      env: {
        ...process.env,
        AI_DM_CHATKIT_INTERNAL_SECRET: chatkitSecret,
        AI_DM_CHATKIT_READ_URL: `http://127.0.0.1:${config.port}/internal/chatkit/read`,
        AI_DM_CHATKIT_DATABASE_PATH: config.chatkitDatabasePath,
      },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  chatkitChild.on("error", () =>
    process.stderr.write(
      "ChatKit service could not start. Check AI_DM_CHATKIT_PYTHON and installed requirements.\n",
    ),
  );
  chatkitChild.on("exit", (code) => {
    if (code) process.stderr.write(`ChatKit service exited (${code}).\n`);
  });
  process.once("exit", () => {
    chatkitChild.kill();
  });
  const app = createAiDmApp({
    ...(readTools ? { chatkitReadHandler: readTools.handler } : {}),
    chatkitHandler: createChatKitGateway({
      sidecarUrl: `http://127.0.0.1:${config.chatkitPort}`,
      internalSecret: chatkitSecret,
      allowedOrigins: config.allowedFoundryOrigins,
      authenticate: (input) =>
        foundrySessions.validateProof(foundrySessions.authenticate(input)).identity,
      authorize: authorizeChatKit,
      beginReadRun: (identity, body, signal) => {
        if (!readTools) throw new Error("Foundry read provider unavailable");
        return readTools.begin(identity, body, signal);
      },
      resolveAuthorization: async (identity) => {
        if (
          config.chatkitAuth === "existing" &&
          chatGptAuth.providerState(identity.worldId) !== "absent"
        ) {
          const authorization = await chatGptAuth.resolveModel(
            identity.worldId,
            config.openAiModel,
          );
          return { apiKey: authorization.accessToken, model: authorization.model };
        }
        if (!config.openAiApiKey)
          throw new Error(
            "ChatKit requires authorized OpenAI API access. Configure the explicit API-key fallback.",
          );
        return { apiKey: config.openAiApiKey, model: config.openAiModel };
      },
    }),
    chatGptAuth,
    callbackPostMessageOrigins: config.allowedFoundryOrigins,
    readiness: async () => {
      let foundryDependencyReady = false;
      if (mcpClient) {
        try {
          await mcpClient.listTools();
          foundryDependencyReady = true;
        } catch {
          foundryDependencyReady = false;
        }
      }
      const localAuthenticationReady = Boolean(config.foundryBrokerSecret);
      return {
        ready: foundryDependencyReady && localAuthenticationReady,
        details: {
          processLive: true,
          foundryDependencyConfigured: Boolean(config.foundryLocalApiKey),
          foundryDependencyReady,
          localAuthenticationReady,
          chatGptPlanAuthorizationPresent: chatGptAuth.hasPlanAuthorization(),
          openAiApiKeyFallbackConfigured: Boolean(config.openAiApiKey),
          signingKeyPersistent: !config.signingKeyEphemeral,
        },
      };
    },
  });
  const httpServer = createServer(app);
  let gateway: AiDmWebSocketGateway | null = null;
  const sender: AiDmDeliverySender = {
    sendDelivery: (delivery) => gateway?.sendDelivery(delivery) ?? 0,
  };
  const outbox = new AiDmDeliveryOutboxPump(store, sender);
  const orchestrator = new DirectPromptOrchestrator(store, world, executor, outbox);
  type QueuedRequest = AiDmPlayerPromptRequest & { prompt: AiDmPromptSubmit };
  const playerRequests = new Map<string, QueuedRequest[]>();
  const allowAllWorlds = new Set<string>();
  const requestState = (worldId: string, requestId: string): AiDmTransportServerMessage => ({
    type: "aiDm.player-requests.state",
    payload: {
      requestId,
      allowAll: allowAllWorlds.has(worldId),
      requests: (playerRequests.get(worldId) ?? []).map((request) => ({
        playerRequestId: request.playerRequestId,
        requesterUserId: request.requesterUserId,
        text: request.text,
        status: request.status,
        requestedAt: request.requestedAt,
      })),
    },
  });
  const executePlayerRequest = async (
    request: QueuedRequest,
    gm: AiDmAuthenticatedIdentity,
  ): Promise<void> => {
    await orchestrator.handle(
      {
        type: "aiDm.prompt.submit",
        payload: {
          ...request.prompt,
          requestId: `player-${request.playerRequestId}`,
          requestedAudience: {
            kind: "selected-users",
            recipientUserIds: [request.requesterUserId],
          },
        },
      },
      gm,
    );
  };
  const commands = {
    async handle(
      command: AiDmClientMessage,
      identity: AiDmAuthenticatedIdentity,
      sessionProof: AiDmLocalSessionProof,
    ): Promise<AiDmTransportServerMessage | void> {
      if (command.type === "aiDm.prompt.submit" && !identity.isGm) {
        const request: QueuedRequest = {
          playerRequestId: randomUUID(),
          requesterUserId: identity.userId,
          text: command.payload.text,
          status: "waiting-for-gm",
          requestedAt: new Date().toISOString(),
          prompt: command.payload,
        };
        const requests = playerRequests.get(identity.worldId) ?? [];
        if (
          !requests.some(
            (item) =>
              item.requesterUserId === identity.userId &&
              item.prompt.requestId === command.payload.requestId,
          )
        ) {
          if (requests.filter(({ status }) => status === "waiting-for-gm").length >= 200) {
            throw new Error("The GM approval queue is full.");
          }
          requests.push(request);
          playerRequests.set(identity.worldId, requests);
        }
        const gm = gateway?.currentGm(identity.worldId) ?? null;
        if (allowAllWorlds.has(identity.worldId) && gm) {
          request.status = "approved";
          gateway?.sendToGms(
            identity.worldId,
            requestState(identity.worldId, command.payload.requestId),
          );
          await executePlayerRequest(request, gm);
        } else {
          gateway?.sendToGms(
            identity.worldId,
            requestState(identity.worldId, command.payload.requestId),
          );
        }
        return requestState(identity.worldId, command.payload.requestId);
      }
      if (command.type === "aiDm.player-requests.status") {
        if (!identity.isGm) throw new Error("GM access required.");
        return requestState(identity.worldId, command.payload.requestId);
      }
      if (command.type === "aiDm.player-requests.policy.set") {
        if (!identity.isGm || identity.lane !== "gm") throw new Error("GM access required.");
        if (command.payload.allowAll) allowAllWorlds.add(identity.worldId);
        else allowAllWorlds.delete(identity.worldId);
        const response = requestState(identity.worldId, command.payload.requestId);
        gateway?.sendToGms(identity.worldId, response);
        return response;
      }
      if (command.type === "aiDm.player-request.decide") {
        if (!identity.isGm || identity.lane !== "gm") throw new Error("GM access required.");
        const request = (playerRequests.get(identity.worldId) ?? []).find(
          (item) => item.playerRequestId === command.payload.playerRequestId,
        );
        if (!request || request.status !== "waiting-for-gm") {
          throw new Error("Player request is no longer waiting for approval.");
        }
        request.status = command.payload.decision === "approve" ? "approved" : "refused";
        const response = requestState(identity.worldId, command.payload.requestId);
        gateway?.sendToGms(identity.worldId, response);
        gateway?.sendToUser(identity.worldId, request.requesterUserId, response);
        if (request.status === "approved") await executePlayerRequest(request, identity);
        return response;
      }
      if (command.type === "aiDm.chatgpt.signin.begin") {
        if (!identity.isGm || identity.lane !== "gm") throw new Error("GM access required.");
        const started = chatGptAuth.begin(identity, sessionProof);
        return {
          type: "aiDm.chatgpt.signin.started",
          payload: { requestId: command.payload.requestId, ...started },
        };
      }
      if (command.type === "aiDm.chatgpt.status") {
        if (!identity.isGm || identity.lane !== "gm") throw new Error("GM access required.");
        return {
          type: "aiDm.chatgpt.status",
          payload: {
            requestId: command.payload.requestId,
            ...(await chatGptAuth.statusWithModels(identity, config.openAiModel)),
          },
        };
      }
      if (command.type === "aiDm.chatgpt.model.select") {
        if (!identity.isGm || identity.lane !== "gm") throw new Error("GM access required.");
        return {
          type: "aiDm.chatgpt.status",
          payload: {
            requestId: command.payload.requestId,
            ...(await chatGptAuth.selectModel(identity, command.payload.model, config.openAiModel)),
          },
        };
      }
      if (command.type === "aiDm.chatgpt.signout") {
        if (!identity.isGm || identity.lane !== "gm") throw new Error("GM access required.");
        const signedOut = await chatGptAuth.signOut(identity);
        return {
          type: "aiDm.chatgpt.status",
          payload: {
            requestId: command.payload.requestId,
            state: "signed-out",
            identityConnected: false,
            planUsageAuthorized: false,
            modelDiscoveryState: "not-authorized",
            availableModels: [],
            selectedModel: null,
            remoteRevocationConfirmed: signedOut.remoteRevocationConfirmed,
          },
        };
      }
      await orchestrator.handle(command, identity);
    },
  };
  gateway = new AiDmWebSocketGateway(httpServer, {
    enrollment: foundrySessions,
    commands,
    allowedOrigins: config.allowedFoundryOrigins,
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, config.host, () => resolve());
  });
  outbox.start();
  process.stderr.write(
    `AI Dungeon Master server listening on http://${config.host}:${config.port}\n`,
  );

  const shutdown = async () => {
    chatkitChild.kill();
    outbox.stop();
    gateway?.close();
    await mcpClient?.close().catch(() => undefined);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    database.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup failure";
  process.stderr.write(`AI Dungeon Master server failed to start: ${message}\n`);
  process.exitCode = 1;
});

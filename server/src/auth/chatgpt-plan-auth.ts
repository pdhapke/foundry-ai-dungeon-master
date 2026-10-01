import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AiDmAuthenticatedIdentity } from "@foundry-ai-dungeon-master/shared";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

import type { AiDmLocalSessionProof } from "./foundry-session.js";

const AUTHORIZATION_ENDPOINT = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_ENDPOINT = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE = "https://api.openai.com/v1";
const INITIAL_CLIENT_ID = "dynamic_agent_client";
const MODELS_ENDPOINT = "https://api.openai.com/v1/models";
const REQUIRED_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = `openid profile email offline_access resource.invoke ${REQUIRED_SCOPE}`;
const MODEL_CACHE_TTL_MS = 60_000;
const MODEL_CACHE_MAX_WORLDS = 32;
const MODEL_RESPONSE_MAX_BYTES = 1024 * 1024;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  scope: z.string(),
  client_id: z.string().min(1).optional(),
});
const discoverySchema = z.object({
  issuer: z.literal("https://auth.openai.com"),
  jwks_uri: z.string().url(),
  revocation_endpoint: z.string().url().optional(),
});
const modelsSchema = z
  .object({
    models: z
      .array(
        z
          .object({
            slug: z
              .string()
              .min(1)
              .max(256)
              .regex(/^[A-Za-z0-9._:-]+$/),
            display_name: z
              .string()
              .min(1)
              .max(256)
              .regex(/^[^\p{Cc}]+$/u),
            visibility: z
              .string()
              .min(1)
              .max(64)
              .regex(/^[A-Za-z0-9._:-]+$/),
          })
          .passthrough(),
      )
      .max(1_000),
  })
  .passthrough();

interface PendingAuthorization {
  registeredClientId: string | null;
  worldId: string;
  gmUserId: string;
  localSessionProof: AiDmLocalSessionProof;
  verifier: string;
  nonce: string;
  createdAt: number;
}

interface StoredSession {
  worldId: string;
  gmUserId: string;
  email: string | null;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  selectedModel?: string | null;
}

interface StoredFile {
  hostId: string;
  registrations: StoredRegistration[];
  sessions: StoredSession[];
  blockedWorldIds: string[];
}

interface StoredRegistration {
  worldId: string;
  gmUserId: string;
  clientId: string;
  email: string | null;
}

interface ModelCacheEntry {
  owner: string;
  tokenHash: string;
  models: Array<{ slug: string; displayName: string }>;
  expiresAt: number;
}

export type ChatGptProviderState = "absent" | "eligible" | "blocked";

export class ChatGptReconnectRequiredError extends Error {
  constructor() {
    super("ChatGPT authorization was rejected. Reconnect ChatGPT and select an eligible model.");
    this.name = "ChatGptReconnectRequiredError";
  }
}

export interface ChatGptPlanAuthStatus {
  state: "signed-out" | "connected";
  identityConnected: boolean;
  planUsageAuthorized: boolean;
  modelDiscoveryState: "not-authorized" | "unavailable" | "empty" | "available";
  gmUserId?: string;
  email?: string;
  expiresAt?: string;
  availableModels: Array<{ slug: string; displayName: string }>;
  selectedModel: string | null;
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

export class ChatGptPlanAuth {
  readonly #path: string;
  readonly #redirectUri: string;
  readonly #key: Buffer;
  readonly #fetch: typeof fetch;
  readonly #idTokenVerifier:
    ((token: string, audience: string, nonce: string) => Promise<{ email?: unknown }>) | undefined;
  readonly #validateLocalSessionProof: (
    proof: AiDmLocalSessionProof,
  ) => AiDmLocalSessionProof | Promise<AiDmLocalSessionProof>;
  readonly #pending = new Map<string, PendingAuthorization>();
  readonly #refreshes = new Map<string, Promise<string>>();
  readonly #modelCache = new Map<string, ModelCacheEntry>();
  readonly #modelDiscoveryStates = new Map<string, "unavailable" | "empty" | "available">();
  readonly #modelDiscoveries = new Map<
    string,
    Promise<Array<{ slug: string; displayName: string }>>
  >();
  readonly #modelDiscoveryTimeoutMs: number;
  readonly #now: () => number;
  #persistTail: Promise<void> = Promise.resolve();
  #data: StoredFile = {
    hostId: `urn:uuid:${randomUUID()}`,
    registrations: [],
    sessions: [],
    blockedWorldIds: [],
  };

  constructor(options: {
    path: string;
    redirectUri: string;
    encryptionKey: string;
    fetch?: typeof fetch;
    idTokenVerifier?: (
      token: string,
      audience: string,
      nonce: string,
    ) => Promise<{ email?: unknown }>;
    validateLocalSessionProof: (
      proof: AiDmLocalSessionProof,
    ) => AiDmLocalSessionProof | Promise<AiDmLocalSessionProof>;
    modelDiscoveryTimeoutMs?: number;
    now?: () => number;
  }) {
    this.#path = options.path;
    this.#redirectUri = options.redirectUri;
    this.#key = createHash("sha256").update(options.encryptionKey).digest();
    this.#fetch = options.fetch ?? fetch;
    this.#idTokenVerifier = options.idTokenVerifier;
    this.#validateLocalSessionProof = options.validateLocalSessionProof;
    this.#modelDiscoveryTimeoutMs = options.modelDiscoveryTimeoutMs ?? 5_000;
    this.#now = options.now ?? Date.now;
    if (this.#modelDiscoveryTimeoutMs <= 0 || this.#modelDiscoveryTimeoutMs > 30_000) {
      throw new Error("Model discovery timeout must be between 1 and 30000 milliseconds.");
    }
  }

  async initialize(): Promise<void> {
    try {
      const envelope = JSON.parse(await readFile(this.#path, "utf8")) as {
        iv: string;
        tag: string;
        ciphertext: string;
      };
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.#key,
        Buffer.from(envelope.iv, "base64url"),
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]);
      const parsed = JSON.parse(plaintext.toString("utf8")) as Partial<StoredFile>;
      this.#data = {
        hostId: parsed.hostId ?? `urn:uuid:${randomUUID()}`,
        registrations: parsed.registrations ?? [],
        sessions: parsed.sessions ?? [],
        blockedWorldIds: parsed.blockedWorldIds ?? [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.#persist();
    }
  }

  begin(
    identity: AiDmAuthenticatedIdentity,
    localSessionProof: AiDmLocalSessionProof,
  ): { authorizationUrl: string } {
    this.#requireGm(identity);
    this.#requireMatchingProof(identity, localSessionProof);
    const owner = this.owner(identity.worldId);
    if (owner && owner !== identity.userId) {
      throw new Error("ChatGPT is already connected by another GM for this world.");
    }
    const state = base64Url(randomBytes(32));
    const nonce = base64Url(randomBytes(32));
    const verifier = base64Url(randomBytes(64));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const registration = this.#data.registrations.find(
      (item) => item.worldId === identity.worldId && item.gmUserId === identity.userId,
    );
    this.#pending.set(state, {
      registeredClientId: registration?.clientId ?? null,
      worldId: identity.worldId,
      gmUserId: identity.userId,
      localSessionProof: structuredClone(localSessionProof),
      verifier,
      nonce,
      createdAt: this.#now(),
    });
    const url = new URL(AUTHORIZATION_ENDPOINT);
    const parameters = new URLSearchParams({
      client_id: registration?.clientId ?? INITIAL_CLIENT_ID,
      ext_agent_host_id: this.#data.hostId,
      response_type: "code",
      redirect_uri: this.#redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    if (!registration) parameters.set("agent_name_hint", "Foundry AI Dungeon Master");
    url.search = parameters.toString();
    return { authorizationUrl: url.toString() };
  }

  async complete(code: string, state: string, callbackClientId?: string): Promise<void> {
    const pending = this.#pending.get(state);
    this.#pending.delete(state);
    if (!pending || this.#now() - pending.createdAt > 10 * 60_000) {
      throw new Error("The sign-in request is invalid or expired.");
    }
    const issuedClientId = callbackClientId ?? pending.registeredClientId;
    if (!issuedClientId || issuedClientId === INITIAL_CLIENT_ID) {
      throw new Error("ChatGPT registration did not return an issued client ID.");
    }
    if (pending.registeredClientId && issuedClientId !== pending.registeredClientId) {
      throw new Error("ChatGPT callback client ID does not match the selected registration.");
    }
    await this.#validatePendingProof(pending);
    const owner = this.owner(pending.worldId);
    if (owner && owner !== pending.gmUserId) {
      throw new Error("ChatGPT is already connected by another GM for this world.");
    }
    const registration: StoredRegistration = {
      worldId: pending.worldId,
      gmUserId: pending.gmUserId,
      clientId: issuedClientId,
      email: null,
    };
    this.#data.registrations = this.#data.registrations.filter(
      (item) => item.worldId !== pending.worldId || item.gmUserId !== pending.gmUserId,
    );
    this.#data.registrations.push(registration);
    // Preserve the issued registration even if code exchange fails or is retried.
    await this.#persist();
    const response = await this.#fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: issuedClientId,
        redirect_uri: this.#redirectUri,
        code_verifier: pending.verifier,
        resource: RESOURCE,
      }),
    });
    if (!response.ok) throw new Error("ChatGPT rejected the authorization code.");
    const tokens = tokenResponseSchema.parse(await response.json());
    const clientId = tokens.client_id ?? issuedClientId;
    if (clientId !== issuedClientId) {
      throw new Error("ChatGPT token client ID does not match the authorization attempt.");
    }
    if (!tokens.id_token) throw new Error("ChatGPT did not return an identity token.");
    const claims = await this.#verifyIdToken(tokens.id_token, clientId, pending.nonce);
    await this.#validatePendingProof(pending);
    const currentOwner = this.owner(pending.worldId);
    if (currentOwner && currentOwner !== pending.gmUserId) {
      throw new Error("ChatGPT ownership changed while sign-in was in progress.");
    }
    const session: StoredSession = {
      worldId: pending.worldId,
      gmUserId: pending.gmUserId,
      email: typeof claims.email === "string" ? claims.email : null,
      clientId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: this.#now() + tokens.expires_in * 1_000,
      scope: tokens.scope,
    };
    registration.clientId = clientId;
    registration.email = session.email;
    this.#data.sessions = this.#data.sessions.filter(
      (item) => item.worldId !== pending.worldId || item.gmUserId !== pending.gmUserId,
    );
    this.#data.sessions.push(session);
    this.#data.blockedWorldIds = this.#data.blockedWorldIds.filter(
      (worldId) => worldId !== pending.worldId,
    );
    this.#modelCache.delete(pending.worldId);
    this.#modelDiscoveryStates.delete(pending.worldId);
    await this.#persist();
  }

  status(worldId: string, gmUserId: string): ChatGptPlanAuthStatus {
    const session = this.#data.sessions.find(
      (item) => item.worldId === worldId && item.gmUserId === gmUserId,
    );
    if (session) {
      const planUsageAuthorized = session.scope.split(/\s+/).includes(REQUIRED_SCOPE);
      return {
        state: "connected",
        identityConnected: true,
        planUsageAuthorized,
        modelDiscoveryState: planUsageAuthorized
          ? (this.#modelDiscoveryStates.get(worldId) ?? "unavailable")
          : "not-authorized",
        gmUserId: session.gmUserId,
        ...(session.email ? { email: session.email } : {}),
        expiresAt: new Date(session.expiresAt).toISOString(),
        availableModels: this.#modelCache.get(worldId)?.models ?? [],
        selectedModel: session.selectedModel ?? null,
      };
    }
    return {
      state: "signed-out",
      identityConnected: false,
      planUsageAuthorized: false,
      modelDiscoveryState: "not-authorized",
      availableModels: [],
      selectedModel: null,
    };
  }

  owner(worldId: string): string | null {
    return this.#data.sessions.find((item) => item.worldId === worldId)?.gmUserId ?? null;
  }

  hasPlanAuthorization(): boolean {
    return this.#data.sessions.some((session) =>
      session.scope.split(/\s+/).includes(REQUIRED_SCOPE),
    );
  }

  providerState(worldId: string): ChatGptProviderState {
    if (this.#data.blockedWorldIds.includes(worldId)) return "blocked";
    const owner = this.owner(worldId);
    if (!owner) return "absent";
    const session = this.#data.sessions.find(
      (item) => item.worldId === worldId && item.gmUserId === owner,
    );
    return session?.scope.split(/\s+/).includes(REQUIRED_SCOPE) ? "eligible" : "blocked";
  }

  async invalidate(worldId: string, expectedAuthorizationId?: string): Promise<void> {
    const session = this.#data.sessions.find((item) => item.worldId === worldId);
    if (
      expectedAuthorizationId &&
      (!session ||
        createHash("sha256").update(session.accessToken).digest("hex") !== expectedAuthorizationId)
    ) {
      return;
    }
    this.#data.sessions = this.#data.sessions.filter((session) => session.worldId !== worldId);
    if (!this.#data.blockedWorldIds.includes(worldId)) this.#data.blockedWorldIds.push(worldId);
    this.#modelCache.delete(worldId);
    this.#modelDiscoveryStates.delete(worldId);
    await this.#persist();
  }

  async resolveModel(
    worldId: string,
    configuredModel: string,
  ): Promise<{ accessToken: string; model: string; authorizationId: string }> {
    const owner = this.owner(worldId);
    if (!owner) throw new Error("The GM has not connected ChatGPT for this world.");
    if (this.providerState(worldId) !== "eligible") {
      throw new Error("ChatGPT plan usage is not authorized for this world.");
    }
    const session = this.#data.sessions.find(
      (item) => item.worldId === worldId && item.gmUserId === owner,
    )!;
    const accessToken = await this.accessToken(worldId);
    await this.#refreshModelSelection(worldId, owner, accessToken, configuredModel);
    const model = session.selectedModel;
    if (!model) throw new Error("No eligible ChatGPT model is selected for this world.");
    return {
      accessToken,
      model,
      authorizationId: createHash("sha256").update(accessToken).digest("hex"),
    };
  }

  async statusWithModels(
    identity: AiDmAuthenticatedIdentity,
    configuredModel: string,
  ): Promise<ChatGptPlanAuthStatus> {
    this.#requireGm(identity);
    const owner = this.owner(identity.worldId);
    if (!owner) return this.status(identity.worldId, identity.userId);
    if (owner !== identity.userId) {
      throw new Error("Only the GM who connected ChatGPT may view models for this world.");
    }
    if (this.providerState(identity.worldId) === "eligible") {
      try {
        const accessToken = await this.accessToken(identity.worldId);
        await this.#refreshModelSelection(identity.worldId, owner, accessToken, configuredModel);
      } catch {
        this.#modelDiscoveryStates.set(identity.worldId, "unavailable");
        await this.#clearModelState(identity.worldId);
      }
    } else {
      await this.#clearModelState(identity.worldId);
    }
    return this.status(identity.worldId, identity.userId);
  }

  async selectModel(
    identity: AiDmAuthenticatedIdentity,
    model: string,
    configuredModel: string,
  ): Promise<ChatGptPlanAuthStatus> {
    this.#requireGm(identity);
    const owner = this.owner(identity.worldId);
    if (!owner || owner !== identity.userId) {
      throw new Error("Only the GM who connected ChatGPT may select models for this world.");
    }
    if (this.providerState(identity.worldId) !== "eligible") {
      throw new Error("ChatGPT plan usage is not authorized for this world.");
    }
    const accessToken = await this.accessToken(identity.worldId);
    await this.#refreshModelSelection(identity.worldId, owner, accessToken, configuredModel);
    const cached = this.#modelCache.get(identity.worldId);
    if (!cached?.models.some(({ slug }) => slug === model)) {
      throw new Error("The selected model is not available for this ChatGPT session.");
    }
    const session = this.#data.sessions.find(
      (item) => item.worldId === identity.worldId && item.gmUserId === identity.userId,
    )!;
    session.selectedModel = model;
    await this.#persist();
    return this.status(identity.worldId, identity.userId);
  }

  async #modelsFor(
    worldId: string,
    owner: string,
    accessToken: string,
  ): Promise<Array<{ slug: string; displayName: string }>> {
    const tokenHash = createHash("sha256").update(accessToken).digest("hex");
    const now = this.#now();
    let cached = this.#modelCache.get(worldId);
    if (
      !cached ||
      cached.owner !== owner ||
      cached.tokenHash !== tokenHash ||
      cached.expiresAt <= now
    ) {
      const discoveryKey = `${worldId}:${tokenHash}`;
      let discovery = this.#modelDiscoveries.get(discoveryKey);
      if (!discovery) {
        discovery = this.#discoverModels(accessToken).finally(() =>
          this.#modelDiscoveries.delete(discoveryKey),
        );
        this.#modelDiscoveries.set(discoveryKey, discovery);
      }
      let models: Array<{ slug: string; displayName: string }>;
      try {
        models = await discovery;
      } catch (error) {
        this.#modelCache.delete(worldId);
        if (error instanceof ChatGptReconnectRequiredError) {
          await this.invalidate(worldId, tokenHash).catch(() => undefined);
        } else {
          this.#modelDiscoveryStates.set(worldId, "unavailable");
        }
        throw error;
      }
      this.#modelDiscoveryStates.set(worldId, models.length === 0 ? "empty" : "available");
      cached = { owner, tokenHash, models, expiresAt: now + MODEL_CACHE_TTL_MS };
      this.#modelCache.delete(worldId);
      this.#modelCache.set(worldId, cached);
      while (this.#modelCache.size > MODEL_CACHE_MAX_WORLDS) {
        const oldest = this.#modelCache.keys().next().value;
        if (!oldest) break;
        this.#modelCache.delete(oldest);
        this.#modelDiscoveryStates.delete(oldest);
      }
    }
    return cached.models;
  }

  async #refreshModelSelection(
    worldId: string,
    owner: string,
    accessToken: string,
    configuredModel: string,
  ): Promise<void> {
    const models = await this.#modelsFor(worldId, owner, accessToken);
    const slugs = models.map(({ slug }) => slug);
    const session = this.#data.sessions.find(
      (item) => item.worldId === worldId && item.gmUserId === owner,
    );
    if (!session) throw new Error("The GM has not connected ChatGPT for this world.");
    const selected = session.selectedModel;
    const next =
      selected && slugs.includes(selected)
        ? selected
        : slugs.includes(configuredModel)
          ? configuredModel
          : null;
    if (session.selectedModel !== next) {
      session.selectedModel = next;
      await this.#persist();
    }
  }

  async #clearModelState(worldId: string): Promise<void> {
    this.#modelCache.delete(worldId);
    let changed = false;
    for (const session of this.#data.sessions) {
      if (session.worldId === worldId && session.selectedModel) {
        session.selectedModel = null;
        changed = true;
      }
    }
    if (changed) await this.#persist();
  }

  async accessToken(worldId: string): Promise<string> {
    const owner = this.owner(worldId);
    const session = owner
      ? this.#data.sessions.find((item) => item.worldId === worldId && item.gmUserId === owner)
      : undefined;
    if (!session) throw new Error("The GM has not connected ChatGPT for this world.");
    if (!session.scope.split(/\s+/).includes(REQUIRED_SCOPE)) {
      throw new Error("ChatGPT plan usage is not authorized for this world.");
    }
    if (session.expiresAt - this.#now() > 60_000) return session.accessToken;
    const inFlight = this.#refreshes.get(worldId);
    if (inFlight) return inFlight;
    const refresh = this.#refresh(session).finally(() => this.#refreshes.delete(worldId));
    this.#refreshes.set(worldId, refresh);
    return refresh;
  }

  async #refresh(session: StoredSession): Promise<string> {
    const authorizationId = createHash("sha256").update(session.accessToken).digest("hex");
    const response = await this.#fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
        client_id: session.clientId,
        resource: RESOURCE,
      }),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        await this.invalidate(session.worldId, authorizationId).catch(() => undefined);
        throw new ChatGptReconnectRequiredError();
      }
      throw new Error("The ChatGPT session could not be refreshed.");
    }
    let tokens: z.infer<typeof tokenResponseSchema>;
    try {
      tokens = tokenResponseSchema.parse(await response.json());
    } catch {
      await this.invalidate(session.worldId, authorizationId).catch(() => undefined);
      throw new ChatGptReconnectRequiredError();
    }
    if (!tokens.scope.split(/\s+/).includes(REQUIRED_SCOPE)) {
      await this.invalidate(session.worldId, authorizationId).catch(() => undefined);
      throw new ChatGptReconnectRequiredError();
    }
    session.accessToken = tokens.access_token;
    session.refreshToken = tokens.refresh_token;
    session.expiresAt = this.#now() + tokens.expires_in * 1_000;
    session.scope = tokens.scope;
    this.#modelCache.delete(session.worldId);
    this.#modelDiscoveryStates.delete(session.worldId);
    await this.#persist();
    return session.accessToken;
  }

  async signOut(
    identity: AiDmAuthenticatedIdentity,
  ): Promise<{ remoteRevocationConfirmed: boolean }> {
    this.#requireGm(identity);
    const owner = this.owner(identity.worldId);
    if (owner && owner !== identity.userId) {
      throw new Error("Only the GM who connected ChatGPT may sign it out for this world.");
    }
    const session = this.#data.sessions.find(
      (item) => item.worldId === identity.worldId && item.gmUserId === identity.userId,
    );
    let remoteRevocationConfirmed = false;
    if (session) {
      try {
        const discovery = await this.#discovery();
        if (discovery.revocation_endpoint) {
          const response = await this.#fetch(discovery.revocation_endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              token: session.refreshToken,
              token_type_hint: "refresh_token",
              client_id: session.clientId,
            }),
          });
          remoteRevocationConfirmed = response.ok;
        }
      } catch {
        // Local sign-out must still succeed if the identity service is unavailable.
      }
    }
    this.#data.sessions = this.#data.sessions.filter(
      (item) => item.worldId !== identity.worldId || item.gmUserId !== identity.userId,
    );
    this.#data.blockedWorldIds = this.#data.blockedWorldIds.filter(
      (worldId) => worldId !== identity.worldId,
    );
    this.#modelCache.delete(identity.worldId);
    this.#modelDiscoveryStates.delete(identity.worldId);
    await this.#persist();
    return { remoteRevocationConfirmed };
  }

  async #verifyIdToken(token: string, audience: string, nonce: string) {
    if (this.#idTokenVerifier) return this.#idTokenVerifier(token, audience, nonce);
    const discovery = await this.#discovery();
    const verified = await jwtVerify(token, createRemoteJWKSet(new URL(discovery.jwks_uri)), {
      issuer: discovery.issuer,
      audience,
    });
    if (verified.payload.nonce !== nonce)
      throw new Error("The ChatGPT identity nonce did not match.");
    return verified.payload;
  }

  async #discovery(): Promise<z.infer<typeof discoverySchema>> {
    const response = await this.#fetch("https://auth.openai.com/.well-known/openid-configuration");
    if (!response.ok) throw new Error("Could not load OpenAI identity configuration.");
    return discoverySchema.parse(await response.json());
  }

  async #discoverModels(
    accessToken: string,
  ): Promise<Array<{ slug: string; displayName: string }>> {
    let response: Response;
    try {
      response = await this.#fetch(MODELS_ENDPOINT, {
        method: "GET",
        headers: { authorization: `Bearer ${accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(this.#modelDiscoveryTimeoutMs),
      });
    } catch {
      throw new Error("ChatGPT model discovery is temporarily unavailable.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new ChatGptReconnectRequiredError();
    }
    if (!response.ok) throw new Error("ChatGPT model discovery is temporarily unavailable.");
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (
      mediaType !== "application/json" &&
      !/^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType ?? "")
    ) {
      throw new Error("ChatGPT model discovery returned an invalid response.");
    }
    if (!response.body) throw new Error("ChatGPT model discovery returned an invalid response.");
    const reader: ReadableStreamDefaultReader<Uint8Array> = (
      response.body as ReadableStream<Uint8Array>
    ).getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.byteLength;
        if (length > MODEL_RESPONSE_MAX_BYTES) {
          await reader.cancel();
          throw new Error("ChatGPT model discovery returned an invalid response.");
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
    let parsed: z.infer<typeof modelsSchema>;
    try {
      parsed = modelsSchema.parse(JSON.parse(body));
    } catch {
      throw new Error("ChatGPT model discovery returned an invalid response.");
    }
    const seen = new Set<string>();
    return parsed.models.flatMap(({ slug, display_name: displayName, visibility }) => {
      if (visibility !== "list" || seen.has(slug)) return [];
      seen.add(slug);
      return [{ slug, displayName }];
    });
  }

  #requireGm(identity: AiDmAuthenticatedIdentity): void {
    if (!identity.isGm || identity.lane !== "gm") {
      throw new Error("Only a connected world GM may manage ChatGPT sign-in.");
    }
  }

  #requireMatchingProof(identity: AiDmAuthenticatedIdentity, proof: AiDmLocalSessionProof): void {
    if (
      proof.identity.worldId !== identity.worldId ||
      proof.identity.userId !== identity.userId ||
      proof.identity.clientId !== identity.clientId ||
      proof.identity.lane !== identity.lane ||
      proof.identity.isGm !== identity.isGm ||
      proof.clientId !== identity.clientId
    ) {
      throw new Error("The local session proof does not match the authenticated GM.");
    }
  }

  async #validatePendingProof(pending: PendingAuthorization): Promise<void> {
    const validated = await this.#validateLocalSessionProof(pending.localSessionProof);
    this.#requireMatchingProof(
      {
        ...validated.identity,
        worldId: pending.worldId,
        userId: pending.gmUserId,
      },
      validated,
    );
    if (
      validated.identity.worldId !== pending.worldId ||
      validated.identity.userId !== pending.gmUserId ||
      !validated.identity.isGm ||
      validated.identity.lane !== "gm"
    ) {
      throw new Error("The initiating Foundry GM session is no longer valid.");
    }
  }

  async #persist(): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const plaintext = JSON.stringify(this.#data);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const envelope = JSON.stringify({
      iv: base64Url(iv),
      tag: base64Url(cipher.getAuthTag()),
      ciphertext: base64Url(ciphertext),
    });
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    const write = this.#persistTail.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      await writeFile(temporary, envelope, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.#path);
    });
    this.#persistTail = write.catch(() => undefined);
    await write;
  }
}

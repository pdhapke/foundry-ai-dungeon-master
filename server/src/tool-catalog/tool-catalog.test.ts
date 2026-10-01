import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  AiDmJsonValue,
  AiDmRunPrincipal,
  AiDmToolEffect,
  AiDmToolRisk,
} from "@foundry-ai-dungeon-master/shared";

import { TrustedToolCatalog } from "./catalog.js";
import { FoundryLocalApiProviderAdapter } from "./foundry-local-api-adapter.js";
import { DEFAULT_FOUNDRY_LOCAL_API_METADATA } from "./metadata.js";
import { ToolCatalogRunSession } from "./runtime.js";
import type {
  ProviderInvocation,
  ProviderToolDefinition,
  ProviderToolSnapshot,
  ToolCatalogClock,
  ToolCommitAuthorizer,
  ToolCatalogIds,
  ToolCatalogProvider,
  ToolMetadataOverlay,
} from "./types.js";

const OBJECT_SCHEMA = {
  type: "object",
  properties: { id: { type: "string", minLength: 1 } },
  required: ["id"],
  additionalProperties: false,
} as const satisfies AiDmJsonValue;

function tool(toolId: string, description = toolId): ProviderToolDefinition {
  return {
    toolId,
    description,
    inputSchema: OBJECT_SCHEMA,
    outputSchema: { type: "object" },
  };
}

class FakeProvider implements ToolCatalogProvider {
  revision = "provider-revision-1";
  definitions: ProviderToolDefinition[];
  readonly invocations: ProviderInvocation[] = [];

  constructor(definitions: ProviderToolDefinition[]) {
    this.definitions = definitions;
  }

  snapshot(): Promise<ProviderToolSnapshot> {
    return Promise.resolve({
      providerId: "foundry-local-api",
      providerVersion: "0.1.0",
      revision: this.revision,
      tools: this.definitions,
    });
  }

  invokeSelected(invocation: ProviderInvocation): Promise<AiDmJsonValue> {
    this.invocations.push(invocation);
    return Promise.resolve({ ok: true, toolId: invocation.toolId });
  }
}

const gmPrincipal: AiDmRunPrincipal = {
  clientId: "client-gm",
  userId: "user-gm",
  lane: "gm",
  worldId: "world-1",
  isGm: true,
  connectionId: "connection-gm",
  role: 4,
  authorizedAudienceKinds: ["private", "gm", "selected-users", "table"],
  permissionSnapshotRevision: "permissions-1",
};

const playerPrincipal: AiDmRunPrincipal = {
  ...gmPrincipal,
  clientId: "client-player",
  userId: "user-player",
  lane: "player",
  isGm: false,
  connectionId: "connection-player",
  role: 1,
  authorizedAudienceKinds: ["private"],
};

function metadata(
  toolId: string,
  options: {
    risk?: AiDmToolRisk;
    effects?: AiDmToolEffect[];
    discoverableBy?: ("authenticated" | "gm")[];
    executableBy?: ("authenticated" | "gm")[];
    guarantees?: { expectedRevision: boolean; idempotentCommit: boolean };
  } = {},
): ToolMetadataOverlay {
  return {
    toolId,
    displayName: toolId,
    purpose: `Read ${toolId} data`,
    useCases: ["inspect current state"],
    effects: options.effects ?? ["read"],
    acceptsEntityTypes: ["reference"],
    producesEntityTypes: ["result"],
    relatedToolIds: [],
    risk: options.risk ?? "low",
    approvalPolicy: options.risk === "consequential" ? "gm-approval" : "none",
    requiredPermissions: [],
    discoverableBy: options.discoverableBy ?? ["authenticated", "gm"],
    executableBy: options.executableBy ?? ["authenticated", "gm"],
    idempotency: options.effects?.includes("commit") ? "provider-guaranteed" : "not-applicable",
    guarantees: options.guarantees ?? { expectedRevision: false, idempotentCommit: true },
    keywords: ["read", "state"],
  };
}

function deterministicIds(): ToolCatalogIds {
  let sequence = 0;
  return { nextId: (prefix) => `${prefix}:${++sequence}` };
}

function session(
  catalog: TrustedToolCatalog,
  principal = gmPrincipal,
  clock?: ToolCatalogClock,
  commitAuthorizer?: ToolCommitAuthorizer,
): ToolCatalogRunSession {
  return new ToolCatalogRunSession(
    catalog,
    {
      runId: "run-1",
      principal,
      budgets: { maxSearches: 4, maxLoadedDefinitions: 12, maxToolCalls: 4 },
      grantTtlMs: 60_000,
    },
    clock,
    deterministicIds(),
    commitAuthorizer,
  );
}

void describe("trusted catalog snapshots", () => {
  void it("adapts an injected live MCP tools/list client without network behavior", async () => {
    const calls: string[] = [];
    const adapter = new FoundryLocalApiProviderAdapter({
      providerVersion: "0.1.0",
      client: {
        listTools: () =>
          Promise.resolve([
            { name: "tool_b", inputSchema: { type: "object" } },
            { name: "tool_a", description: "A", inputSchema: { type: "object" } },
          ]),
        callTool: ({ name }) => {
          calls.push(name);
          return Promise.resolve({ ok: true });
        },
      },
    });
    const snapshot = await adapter.snapshot();
    assert.deepEqual(
      snapshot.tools.map(({ toolId }) => toolId),
      ["tool_a", "tool_b"],
    );
    assert.match(snapshot.revision, /^[a-f0-9]{64}$/);
    await adapter.invokeSelected({
      providerId: "foundry-local-api",
      toolId: "tool_a",
      arguments: {},
      schemaDigest: "digest-bound-by-facade",
      idempotencyKey: null,
    });
    assert.deepEqual(calls, ["tool_a"]);
  });

  void it("has a stable order-independent revision and quarantines tools without exact metadata", async () => {
    const firstProvider = new FakeProvider([tool("tool_b"), tool("tool_a"), tool("tool_unknown")]);
    const secondProvider = new FakeProvider([tool("tool_unknown"), tool("tool_a"), tool("tool_b")]);
    const overlays = [metadata("tool_a"), metadata("tool_b")];
    const first = await new TrustedToolCatalog(firstProvider, overlays, "policy-1").refresh();
    const second = await new TrustedToolCatalog(secondProvider, overlays, "policy-1").refresh();

    assert.equal(first.catalogRevision, second.catalogRevision);
    assert.deepEqual([...first.records.keys()], ["tool_a", "tool_b"]);
    assert.deepEqual(first.quarantinedToolIds, ["tool_unknown"]);
  });

  void it("changes catalog and policy-view revisions for schema and permission changes", async () => {
    const provider = new FakeProvider([tool("tool_read")]);
    const catalog = new TrustedToolCatalog(provider, [metadata("tool_read")], "policy-1");
    const before = await catalog.refresh();
    const gmView = catalog.policyViewRevision(gmPrincipal);
    const playerView = catalog.policyViewRevision(playerPrincipal);
    assert.notEqual(gmView, playerView);

    provider.definitions = [
      { ...tool("tool_read"), inputSchema: { type: "object", additionalProperties: false } },
    ];
    provider.revision = "provider-revision-2";
    const after = await catalog.refresh();
    assert.notEqual(before.catalogRevision, after.catalogRevision);
  });

  void it("rejects duplicate provider names and duplicate metadata deterministically", async () => {
    assert.throws(
      () =>
        new TrustedToolCatalog(
          new FakeProvider([tool("tool_a")]),
          [metadata("tool_a"), metadata("tool_a")],
          "policy-1",
        ),
      /Duplicate tool metadata/,
    );
    await assert.rejects(
      () =>
        new TrustedToolCatalog(
          new FakeProvider([tool("tool_a"), tool("tool_a")]),
          [metadata("tool_a")],
          "policy-1",
        ).refresh(),
      /duplicate tool/,
    );
  });
});

void describe("search and deferred loading", () => {
  void it("filters by principal without returning denied tools or denied counts", async () => {
    const provider = new FakeProvider([tool("public_read"), tool("gm_secret")]);
    const catalog = new TrustedToolCatalog(
      provider,
      [metadata("public_read"), metadata("gm_secret", { discoverableBy: ["gm"] })],
      "policy-1",
    );
    await catalog.refresh();

    const result = session(catalog, playerPrincipal).search({
      query: "read state secret",
      alreadyLoaded: [],
      limit: 10,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.value.descriptors.map(({ toolId }) => toolId),
      ["public_read"],
    );
    assert.equal("deniedCount" in result.value, false);
  });

  void it("loads a full schema only after search and binds an expiring digest grant", async () => {
    const provider = new FakeProvider([tool("tool_read")]);
    const catalog = new TrustedToolCatalog(provider, [metadata("tool_read")], "policy-1");
    await catalog.refresh();
    const run = session(catalog);

    const beforeSearch = run.load("missing-search", "tool_read");
    assert.deepEqual(beforeSearch.ok ? null : beforeSearch.denial.code, "TOOL_UNKNOWN");
    const search = run.search({ query: "tool_read", alreadyLoaded: [], limit: 1 });
    assert.equal(search.ok, true);
    if (!search.ok) return;
    assert.equal("inputSchema" in search.value.descriptors[0]!, false);

    const loaded = run.load(search.value.searchId, "tool_read");
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.deepEqual(loaded.value.definition.inputSchema, OBJECT_SCHEMA);
    assert.match(loaded.value.definition.schemaDigest, /^[a-f0-9]{64}$/);
    assert.equal(loaded.value.grant.schemaDigest, loaded.value.definition.schemaDigest);
    assert.equal(run.loadReceipts.length, 1);
  });

  void it("adds only one hop of related tools after lexical ranking", async () => {
    const alpha = { ...metadata("alpha"), keywords: ["summon"], relatedToolIds: ["beta"] };
    const beta = { ...metadata("beta"), keywords: ["unrelated"], relatedToolIds: ["gamma"] };
    const gamma = { ...metadata("gamma"), keywords: ["distant"], relatedToolIds: [] };
    const provider = new FakeProvider([tool("alpha"), tool("beta"), tool("gamma")]);
    const catalog = new TrustedToolCatalog(provider, [alpha, beta, gamma], "policy-1");
    await catalog.refresh();
    const result = session(catalog).search({ query: "summon", alreadyLoaded: [], limit: 10 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.value.descriptors.map(({ toolId }) => toolId),
      ["alpha", "beta"],
    );
  });

  void it("enforces search and loaded-definition budgets", async () => {
    const provider = new FakeProvider([tool("tool_read")]);
    const catalog = new TrustedToolCatalog(provider, [metadata("tool_read")], "policy-1");
    await catalog.refresh();
    const run = new ToolCatalogRunSession(
      catalog,
      {
        runId: "run-budget",
        principal: gmPrincipal,
        budgets: { maxSearches: 1, maxLoadedDefinitions: 0, maxToolCalls: 1 },
      },
      undefined,
      deterministicIds(),
    );
    const first = run.search({ query: "read", alreadyLoaded: [], limit: 1 });
    assert.equal(first.ok, true);
    const second = run.search({ query: "read", alreadyLoaded: [], limit: 1 });
    assert.deepEqual(second.ok ? null : second.denial.code, "TOOL_BUDGET_EXCEEDED");
    if (!first.ok) return;
    const load = run.load(first.value.searchId, "tool_read");
    assert.deepEqual(load.ok ? null : load.denial.code, "TOOL_BUDGET_EXCEEDED");
  });
});

void describe("grant-only execution facade", () => {
  void it("validates arguments and invokes only the tool bound to a loaded grant", async () => {
    const provider = new FakeProvider([tool("tool_read")]);
    const catalog = new TrustedToolCatalog(provider, [metadata("tool_read")], "policy-1");
    await catalog.refresh();
    const run = session(catalog);
    const search = run.search({ query: "tool_read", alreadyLoaded: [], limit: 1 });
    assert.equal(search.ok, true);
    if (!search.ok) return;
    const loaded = run.load(search.value.searchId, "tool_read");
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;

    const invalid = await run.executeGrant({
      grantId: loaded.value.grant.grantId,
      effect: "read",
      arguments: { id: "", injected: true },
    });
    assert.deepEqual(invalid.ok ? null : invalid.denial.code, "TOOL_ARGUMENT_INVALID");
    const executed = await run.executeGrant({
      grantId: loaded.value.grant.grantId,
      effect: "read",
      arguments: { id: "actor-1" },
    });
    assert.equal(executed.ok, true);
    assert.equal(provider.invocations.length, 1);
    assert.equal(provider.invocations[0]?.toolId, "tool_read");
  });

  void it("rejects grants after provider catalog change and after expiry", async () => {
    const provider = new FakeProvider([tool("tool_read")]);
    const catalog = new TrustedToolCatalog(provider, [metadata("tool_read")], "policy-1");
    await catalog.refresh();
    let now = new Date("2026-09-29T12:00:00.000Z");
    const clock: ToolCatalogClock = { now: () => now };
    const run = session(catalog, gmPrincipal, clock);
    const search = run.search({ query: "tool_read", alreadyLoaded: [], limit: 1 });
    assert.equal(search.ok, true);
    if (!search.ok) return;
    const loaded = run.load(search.value.searchId, "tool_read");
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;

    provider.revision = "changed-provider-revision";
    const stale = await run.executeGrant({
      grantId: loaded.value.grant.grantId,
      effect: "read",
      arguments: { id: "actor-1" },
    });
    assert.deepEqual(stale.ok ? null : stale.denial.code, "TOOL_CATALOG_STALE");

    provider.revision = "provider-revision-1";
    await catalog.refresh();
    now = new Date("2026-09-29T12:02:00.000Z");
    const expired = await run.executeGrant({
      grantId: loaded.value.grant.grantId,
      effect: "read",
      arguments: { id: "actor-1" },
    });
    assert.deepEqual(expired.ok ? null : expired.denial.code, "TOOL_GRANT_EXPIRED");
  });

  void it("replays guaranteed idempotent commits and rejects key reuse with changed arguments", async () => {
    const provider = new FakeProvider([tool("safe_commit")]);
    const catalog = new TrustedToolCatalog(
      provider,
      [
        metadata("safe_commit", {
          risk: "consequential",
          effects: ["propose", "commit"],
          guarantees: { expectedRevision: true, idempotentCommit: true },
        }),
      ],
      "policy-1",
    );
    await catalog.refresh();
    const run = session(catalog, gmPrincipal, undefined, {
      authorize: ({ authorization }) =>
        Promise.resolve(authorization.authorizationId === "approved-operation-1"),
    });
    const search = run.search({ query: "safe_commit", alreadyLoaded: [], limit: 1 });
    assert.equal(search.ok, true);
    if (!search.ok) return;
    const loaded = run.load(search.value.searchId, "safe_commit");
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const request = {
      grantId: loaded.value.grant.grantId,
      effect: "commit" as const,
      arguments: { id: "actor-1" },
      commitAuthorization: {
        authorizationId: "approved-operation-1",
        expectedRevisionCount: 1,
        idempotencyKey: "idem-1",
      },
    };
    const first = await run.executeGrant(request);
    const replay = await run.executeGrant(request);
    assert.equal(first.ok, true);
    assert.equal(replay.ok && replay.value.kind === "executed" && replay.value.replayed, true);
    assert.equal(provider.invocations.length, 1);

    const conflict = await run.executeGrant({ ...request, arguments: { id: "actor-2" } });
    assert.deepEqual(conflict.ok ? null : conflict.denial.code, "TOOL_REVISION_CONFLICT");
  });

  void it("denies guaranteed commits when no store-backed authorizer is injected", async () => {
    const provider = new FakeProvider([tool("safe_commit")]);
    const catalog = new TrustedToolCatalog(
      provider,
      [
        metadata("safe_commit", {
          risk: "consequential",
          effects: ["commit"],
          guarantees: { expectedRevision: true, idempotentCommit: true },
        }),
      ],
      "policy-1",
    );
    await catalog.refresh();
    const run = session(catalog);
    const search = run.search({ query: "safe_commit", alreadyLoaded: [], limit: 1 });
    assert.equal(search.ok, true);
    if (!search.ok) return;
    const loaded = run.load(search.value.searchId, "safe_commit");
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const denied = await run.executeGrant({
      grantId: loaded.value.grant.grantId,
      effect: "commit",
      arguments: { id: "actor-1" },
      commitAuthorization: {
        authorizationId: "unverified",
        expectedRevisionCount: 1,
        idempotencyKey: "idem-unverified",
      },
    });
    assert.deepEqual(denied.ok ? null : denied.denial.code, "TOOL_REVISION_CONFLICT");
    assert.equal(provider.invocations.length, 0);
  });
});

void describe("cross-domain spell and item workflow", () => {
  void it("discovers the workflow without an interaction classifier and keeps legacy writes proposal-only", async () => {
    const required = [
      "foundry_search",
      "foundry_get_document_schema",
      "foundry_validate_document_data",
      "foundry_create_actor",
      "foundry_create_scene_token",
      "foundry_add_combatant",
      "foundry_send_chat_message",
    ];
    const provider = new FakeProvider(
      required.map((toolId) =>
        tool(toolId, `Trusted provider definition for ${toolId.replaceAll("_", " ")}.`),
      ),
    );
    const catalog = new TrustedToolCatalog(
      provider,
      DEFAULT_FOUNDRY_LOCAL_API_METADATA,
      "policy-1",
    );
    await catalog.refresh();
    const run = session(catalog);

    const search = run.search({
      query:
        "Create the creature caused by the spell, look up its actor, validate its data, place its token in the current Scene, add it to combat, and narrate its arrival",
      alreadyLoaded: [],
      limit: 12,
    });
    assert.equal(search.ok, true);
    if (!search.ok) return;
    const discovered = new Set(search.value.descriptors.map(({ toolId }) => toolId));
    for (const toolId of required) assert.ok(discovered.has(toolId), toolId);

    const createActor = run.load(search.value.searchId, "foundry_create_actor");
    assert.equal(createActor.ok, true);
    if (!createActor.ok) return;
    assert.deepEqual(createActor.value.grant.allowedEffects, ["propose"]);

    const proposal = await run.executeGrant({
      grantId: createActor.value.grant.grantId,
      effect: "propose",
      arguments: { id: "summoned-creature" },
    });
    assert.equal(proposal.ok && proposal.value.kind === "proposal-required", true);
    const refusedCommit = await run.executeGrant({
      grantId: createActor.value.grant.grantId,
      effect: "commit",
      arguments: { id: "summoned-creature" },
      commitAuthorization: {
        authorizationId: "model-cannot-authorize-this",
        expectedRevisionCount: 1,
        idempotencyKey: "spell-event-1:create-actor",
      },
    });
    assert.deepEqual(refusedCommit.ok ? null : refusedCommit.denial.code, "TOOL_UNAUTHORIZED");
    assert.equal(provider.invocations.length, 0);
  });
});

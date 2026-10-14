import assert from "node:assert/strict";
import test from "node:test";
import { TrustedToolCatalog } from "./catalog.js";
import { ToolCatalogRunSession } from "./runtime.js";
import type { ToolMetadataOverlay } from "./types.js";
void test("destructive proposal effects require trusted durable review boundary after grants and schema validation", async () => {
  let invokes = 0,
    authorizations = 0;
  const metadata: ToolMetadataOverlay = {
    toolId: "setter",
    displayName: "setter",
    purpose: "routine setter",
    useCases: ["setter"],
    effects: ["propose"],
    acceptsEntityTypes: [],
    producesEntityTypes: [],
    relatedToolIds: [],
    risk: "destructive",
    approvalPolicy: "gm-approval",
    requiredPermissions: ["GM"],
    discoverableBy: ["gm"],
    executableBy: ["gm"],
    idempotency: "required",
    guarantees: { expectedRevision: false, idempotentCommit: false },
    keywords: ["setter"],
  };
  const catalog = new TrustedToolCatalog(
    {
      snapshot: () =>
        Promise.resolve({
          providerId: "fixture",
          providerVersion: "1",
          revision: "r",
          tools: [
            {
              toolId: "setter",
              description: "setter",
              inputSchema: {
                type: "object",
                properties: { value: { type: "boolean" } },
                required: ["value"],
                additionalProperties: false,
              },
              outputSchema: null,
            },
          ],
        }),
      invokeSelected: () => {
        invokes++;
        return Promise.resolve({ changed: true });
      },
    },
    [metadata],
    "fixture",
  );
  await catalog.refresh();
  const session = new ToolCatalogRunSession(catalog, {
    runId: "run",
    principal: {
      worldId: "w",
      userId: "gm",
      isGm: true,
      lane: "gm",
      clientId: "fixture",
      connectionId: "fixture",
      role: 4,
      permissionSnapshotRevision: "fixture",
      authorizedAudienceKinds: ["gm"],
    },
    budgets: { maxSearches: 4, maxLoadedDefinitions: 4, maxToolCalls: 4 },
  });
  const found = session.search({ query: "setter", limit: 4, alreadyLoaded: [] });
  assert.equal(found.ok, true);
  if (!found.ok) throw new Error("No search");
  const loaded = session.load(found.value.searchId, "setter");
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error("No grant");
  const request = {
    grantId: loaded.value.grant.grantId,
    effect: "propose" as const,
    arguments: { value: false },
  };
  const fallback = await session.executeGrant(request);
  assert.equal(fallback.ok, true);
  if (fallback.ok) assert.equal(fallback.value.kind, "proposal-required");
  assert.equal(invokes, 0);
  const boundary = {
    signal: new AbortController().signal,
    durableProposal: true,
    authorizeProposal: () => {
      authorizations++;
      return Promise.resolve(true);
    },
    invoke: () => {
      invokes++;
      return Promise.resolve({ changed: true });
    },
  };
  assert.equal(
    (await session.executeGrant({ ...request, arguments: { value: "invalid" } }, boundary)).ok,
    false,
  );
  assert.equal(authorizations, 0);
  assert.equal(
    (
      await session.executeGrant(request, {
        ...boundary,
        authorizeProposal: () => Promise.resolve(false),
      })
    ).ok,
    false,
  );
  assert.equal(invokes, 0);
  assert.equal((await session.executeGrant(request, boundary)).ok, true);
  assert.equal(authorizations, 1);
  assert.equal(invokes, 1);
});

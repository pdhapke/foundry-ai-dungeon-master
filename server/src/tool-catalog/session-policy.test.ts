import assert from "node:assert/strict";
import test from "node:test";
import { TrustedToolCatalog } from "./catalog.js";
import { ToolCatalogRunSession } from "./runtime.js";
import type { ToolMetadataOverlay } from "./types.js";
void test("session effects default deny and only verified grants/arguments reach trusted request boundary", async () => {
  let invokes = 0,
    authorizations = 0;
  const metadata: ToolMetadataOverlay = {
    toolId: "setter",
    displayName: "setter",
    purpose: "routine setter",
    useCases: ["setter"],
    effects: ["session"],
    acceptsEntityTypes: [],
    producesEntityTypes: [],
    relatedToolIds: [],
    risk: "consequential",
    approvalPolicy: "gm-request",
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
    effect: "session" as const,
    arguments: { value: false },
  };
  assert.equal((await session.executeGrant(request)).ok, false);
  const boundary = {
    signal: new AbortController().signal,
    authorizeSession: () => {
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
        authorizeSession: () => Promise.resolve(false),
      })
    ).ok,
    false,
  );
  assert.equal(invokes, 0);
  assert.equal((await session.executeGrant(request, boundary)).ok, true);
  assert.equal(authorizations, 1);
  assert.equal(invokes, 1);
});

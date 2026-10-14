import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CampaignStorage } from "./campaign-storage.js";
import { WorldCampaignContext } from "./world-campaign.js";
import { assertProtectedCampaignRoot } from "./protected-campaign.js";
import { planCampaignMigration, copyCampaignMigration } from "./campaign-migration.js";
import type { AiDmRunPrincipal } from "@foundry-ai-dungeon-master/shared";
const principal: AiDmRunPrincipal = { worldId: "one", userId: "gm", clientId: "c", lane: "gm", isGm: true, role: 4, connectionId: "c", authorizedAudienceKinds: ["gm"], permissionSnapshotRevision: "live" };
test("protected copy preserves original bytes, URI and source isolation without fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "campaign-private-"));
  try {
    const publicDataRoot = join(root, "Data"), worlds = join(publicDataRoot, "worlds"), protectedRoot = join(root, "private");
    const source = join(worlds, "one", "data", "campaign"); mkdirSync(source, { recursive: true }); mkdirSync(protectedRoot);
    const text = "---\nid: OVERVIEW\nrevision: 1\nschema_version: 1\nvisibility: gm\ncanon_status: canon\n---\nSecret old fact.";
    writeFileSync(join(source, "overview.md"), text); writeFileSync(join(source, "spatial.json"), Buffer.from([0, 255, 10])); writeFileSync(join(source, "map.png"), Buffer.from([1, 2, 3]));
    const options = { publicDataRoot, protectedRoot }; let authorized = true;
    const authority = { authorize: (world: string) => { if (!authorized || world !== "one") throw new Error("unauthorized"); } };
    const context = new WorldCampaignContext(worlds, options);
    assert.equal((context.overview(principal) as { status: string }).status, "unavailable");
    const signal = new AbortController().signal, plan = planCampaignMigration(worlds, "one", options, authority, signal);
    assert.equal(plan.files.length, 2); assert.equal(plan.excludedAssets, 1); assert.equal(existsSync(join(protectedRoot, "one")), false);
    copyCampaignMigration(worlds, "one", options, authority, signal, plan.manifestRevision);
    assert.equal(readFileSync(join(source, "overview.md"), "utf8"), text);
    assert.deepEqual(readFileSync(join(protectedRoot, "one", "data", "campaign", "spatial.json")), Buffer.from([0, 255, 10]));
    assert.equal((context.overview(principal) as { sourceUri: string }).sourceUri, "campaign://one/overview.md");
    writeFileSync(join(source, "overview.md"), text + " public changed");
    assert.equal((context.overview(principal) as { text: string }).text.trim(), "Secret old fact.");
    assert.throws(() => copyCampaignMigration(worlds, "one", options, authority, signal, plan.manifestRevision), /revision changed/);
    const storage = new CampaignStorage(worlds, authority, 128000, 512000, options);
    authorized = false; assert.throws(() => storage.read("one", "overview.md"), /unauthorized/);
    assert.equal((context.overview({ ...principal, worldId: "two" }) as { status: string }).status, "unavailable");
    assert.equal((context.overview({ ...principal, isGm: false }) as { status: string }).status, "unavailable");
    assert.throws(() => assertProtectedCampaignRoot({ protectedRoot: source, publicDataRoot }), /public Foundry/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("protected storage writes use existing revision repository and cancellation prevents copy", () => {
  const root = mkdtempSync(join(tmpdir(), "campaign-private-write-"));
  try {
    const publicDataRoot = join(root, "Data"), worlds = join(publicDataRoot, "worlds"), protectedRoot = join(root, "private");
    mkdirSync(join(worlds, "one", "data", "campaign"), { recursive: true }); mkdirSync(protectedRoot);
    const options = { protectedRoot, publicDataRoot }, authority = { authorize: (world: string) => { if (world !== "one") throw new Error("unauthorized"); } };
    const storage = new CampaignStorage(worlds, authority, 128000, 512000, options);
    storage.commit("one", [{ path: "lore/new.md", text: "private", expectedRevision: null }]);
    assert.equal(storage.read("one", "lore/new.md")?.text, "private");
    assert.equal(existsSync(join(worlds, "one", "data", "campaign", "lore")), false);
    assert.throws(() => storage.commit("two", [{ path: "new.md", text: "x", expectedRevision: null }]), /unauthorized/);
    const abort = new AbortController(); abort.abort();
    assert.throws(() => planCampaignMigration(worlds, "one", options, authority, abort.signal));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

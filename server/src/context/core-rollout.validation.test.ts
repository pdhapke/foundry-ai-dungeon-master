import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { AiDmRunPrincipal } from "@foundry-ai-dungeon-master/shared";
import { WorldCampaignContext } from "./world-campaign.js";

const principal: AiDmRunPrincipal = { clientId: "c", lane: "gm", userId: "gm", worldId: "one", isGm: true, role: 4, connectionId: "c", authorizedAudienceKinds: ["gm"], permissionSnapshotRevision: "p1" };
void test("independent overview parse cache invalidates content, permissions, world and active writer", () => {
  const root = mkdtempSync(join(tmpdir(), "ai-dm-core-validator-"));
  const one = join(root, "one", "data", "campaign"), two = join(root, "two", "data", "campaign");
  const header = "---\nschema_version: 1\nid: overview\nrevision: r1\nvisibility: gm\ncanon_status: canon\n---\n";
  try {
    mkdirSync(one, { recursive: true }); mkdirSync(two, { recursive: true });
    writeFileSync(join(one, "overview.md"), header + "First world");
    writeFileSync(join(two, "overview.md"), header + "Second world");
    const context = new WorldCampaignContext(root);
    const first = context.overview(principal) as Record<string, unknown>;
    assert.equal((context.overview(principal) as Record<string, unknown>)["sourceHash"], first["sourceHash"]);
    writeFileSync(join(one, "overview.md"), header + "Changed world");
    const changed = context.overview(principal) as Record<string, unknown>;
    assert.notEqual(changed["sourceHash"], first["sourceHash"]);
    assert.match(String(changed["text"]), /Changed world/);
    assert.equal((context.overview({ ...principal, isGm: false, permissionSnapshotRevision: "p2" }) as Record<string, unknown>)["text"], "");
    assert.match(String((context.overview({ ...principal, worldId: "two" }) as Record<string, unknown>)["text"]), /Second world/);
    writeFileSync(join(one, ".write-lock"), "validator lock");
    assert.equal((context.overview(principal) as Record<string, unknown>)["text"], "");
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + "\\ai-dm-core-validator-"));
    rmSync(root, { recursive: true, force: true });
  }
});

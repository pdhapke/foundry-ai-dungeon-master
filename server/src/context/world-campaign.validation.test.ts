import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { AiDmRunPrincipal } from "@foundry-ai-dungeon-master/shared";
import { WorldCampaignContext } from "./world-campaign.js";

const principal: AiDmRunPrincipal = {
  clientId: "fixture",
  lane: "gm",
  userId: "gm",
  worldId: "one",
  isGm: true,
  role: 4,
  connectionId: "c",
  authorizedAudienceKinds: ["gm"],
  permissionSnapshotRevision: "fixture",
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "campaign-context-validator-"));
  const campaign = join(root, "one/data/campaign");
  mkdirSync(campaign, { recursive: true });
  return {
    campaign,
    context: new WorldCampaignContext(root),
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}
const header =
  "---\nschema_version: 1\nid: main\nrevision: r1\nvisibility: gm\ncanon_status: canon\n---\n";
void it("independent overview remains guaranteed when search index reaches file cap", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 256; i++)
      writeFileSync(join(f.campaign, `a${String(i).padStart(4, "0")}.md`), "# filler");
    writeFileSync(join(f.campaign, "overview.md"), header + "Guaranteed overview.");
    assert.equal(
      (f.context.overview(principal) as Record<string, unknown>)["text"],
      "Guaranteed overview.",
    );
  } finally {
    f.clean();
  }
});
void it("independent document-private metadata limits public section narration", () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.campaign, "private.md"),
      header + "foundry scene\n## PLAYER-VISIBLE\nSecretkeyword hidden identity.",
    );
    // Bind section activation to the current scene.
    writeFileSync(
      join(f.campaign, "private.md"),
      header.replace("revision: r1", "revision: r1\nfoundry_scene_id: scene") +
        "## PLAYER-VISIBLE\nSecretkeyword hidden identity.",
    );
    const result = f.context.retrieve(principal, "secretkeyword", "scene") as unknown as {
      excerpts: Array<{ text: string; narrationAllowed: boolean }>;
    };
    assert.ok(result.excerpts.length);
    assert.ok(result.excerpts.every((e) => !e.narrationAllowed));
  } finally {
    f.clean();
  }
});
void it("independent Unicode campaign result fits adapter byte allocation", () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.campaign, "campaign-state.md"),
      "# State\n## GM-ONLY\n" + "雪".repeat(9000),
    );
    const result = f.context.retrieve(principal, "", null);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 24000);
  } finally {
    f.clean();
  }
});

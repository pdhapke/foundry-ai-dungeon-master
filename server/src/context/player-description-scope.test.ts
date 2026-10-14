import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiDmRunPrincipal } from "@foundry-ai-dungeon-master/shared";
import { WorldCampaignContext } from "./world-campaign.js";

const principal: AiDmRunPrincipal = { worldId: "world", userId: "gm", clientId: "gm-client", lane: "gm", isGm: true, role: 4, connectionId: "c", authorizedAudienceKinds: ["gm"], permissionSnapshotRevision: "current" };
const source = (text = "A stone corridor is visible.", visibility = "public", canon = "canon") => `---\nschema_version: 1\nid: corridor\nrevision: r1\nvisibility: ${visibility}\ncanon_status: ${canon}\nfoundry_scene_id: scene\nobservation_scope: point\nobservation_x: 400\nobservation_y: 500\nobservation_elevation: 0\nauxiliary_instruction: SECRET_INJECTION\n---\n## PLAYER-VISIBLE\n${text}\n## GM-ONLY\nSECRET_TRAP\n`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "description-scope-"));
  const campaign = join(root, "world/data/campaign");
  mkdirSync(campaign, { recursive: true });
  return { root, campaign, context: new WorldCampaignContext(root), clean: () => rmSync(root, { recursive: true, force: true }) };
}
function observed(f: ReturnType<typeof fixture>) { return f.context.playerDescriptionPlan(principal, "scene"); }

void test("reserved domain admits approved point despite invalid unrelated campaign source; retrieval retains issues", () => {
  const f = fixture(); try {
    mkdirSync(join(f.campaign, "observations"));
    writeFileSync(join(f.campaign, "observations/corridor.md"), source());
    writeFileSync(join(f.campaign, "invalid-private.md"), source("Private transition.", "gm") + "\n## NEXT-LOAD\n[ref](../outside.md)\n");
    const plan = observed(f);
    assert.deepEqual(plan.points, [{ id: "description-1", x: 400, y: 500, elevation: 0 }]);
    assert.deepEqual(plan.descriptions.map(item => item.description), ["A stone corridor is visible."]);
    assert.equal(JSON.stringify(plan).includes("SECRET"), false);
    const retrieval = f.context.retrieve(principal, "corridor", "scene") as { status: string };
    assert.equal(retrieval.status, "partial");
    assert.deepEqual(observed(f), plan);
  } finally { f.clean(); }
});
void test("invalid reserved source suppresses entire domain without legacy fallback", () => {
  const f = fixture(); try {
    writeFileSync(join(f.campaign, "legacy.md"), source("Legacy must not leak."));
    mkdirSync(join(f.campaign, "observations"));
    writeFileSync(join(f.campaign, "observations/corridor.md"), source());
    writeFileSync(join(f.campaign, "observations/invalid.md"), source("Private transition.", "gm") + "\n## NEXT-LOAD\n[ref](../../outside.md)\n");
    assert.deepEqual(observed(f).descriptions, []);
    rmSync(join(f.campaign, "observations/invalid.md"));
    assert.equal(observed(f).descriptions.length, 1);
    writeFileSync(join(f.campaign, "observations/.write-lock"), "locked");
    assert.deepEqual(observed(f).points, []);
  } finally { f.clean(); }
});
void test("private draft and auxiliary instructions never become approved description", () => {
  const f = fixture(); try {
    mkdirSync(join(f.campaign, "observations"));
    writeFileSync(join(f.campaign, "observations/public.md"), source());
    writeFileSync(join(f.campaign, "observations/private.md"), source("PRIVATE", "gm"));
    writeFileSync(join(f.campaign, "observations/draft.md"), source("DRAFT", "public", "draft"));
    assert.deepEqual(observed(f).descriptions.map(item => item.description), ["A stone corridor is visible."]);
  } finally { f.clean(); }
});
void test("scoped cache refreshes changed source and visibility; legacy scope remains compatible", () => {
  const f = fixture(); try {
    writeFileSync(join(f.campaign, "legacy.md"), source("Legacy description."));
    assert.equal(observed(f).descriptions[0]?.description, "Legacy description.");
    mkdirSync(join(f.campaign, "observations"));
    const file = join(f.campaign, "observations/public.md");
    writeFileSync(file, source()); const before = observed(f);
    writeFileSync(file, source("A painted corridor is visible.")); const after = observed(f);
    assert.notEqual(after.sourceRevision, before.sourceRevision);
    assert.equal(after.descriptions[0]?.description, "A painted corridor is visible.");
    writeFileSync(file, source("PRIVATE", "secret")); assert.deepEqual(observed(f).descriptions, []);
    rmSync(join(f.campaign, "observations"), { recursive: true });
    assert.equal(observed(f).descriptions[0]?.description, "Legacy description.");
  } finally { f.clean(); }
});
void test("reserved file or redirected directory fails closed without fallback", () => {
  const f = fixture(); try {
    writeFileSync(join(f.campaign, "legacy.md"), source());
    writeFileSync(join(f.campaign, "observations"), "not a directory");
    assert.deepEqual(observed(f).points, []);
    rmSync(join(f.campaign, "observations"));
    const outside = join(f.root, "outside"); mkdirSync(outside);
    writeFileSync(join(outside, "public.md"), source());
    symlinkSync(outside, join(f.campaign, "observations"), "junction");
    assert.deepEqual(observed(f).points, []);
  } finally { f.clean(); }
});
void test("bounded domain discovery rejects partial source sets including nested excluded directories", () => {
  const f = fixture(); try {
    mkdirSync(join(f.campaign, "observations/assets"), { recursive: true });
    writeFileSync(join(f.campaign, "observations/public.md"), source());
    writeFileSync(join(f.campaign, "observations/assets/invalid.md"), "bad");
    assert.deepEqual(observed(f).points, []);
    rmSync(join(f.campaign, "observations/assets"), { recursive: true });
    for (let i = 0; i < 257; i++) writeFileSync(join(f.campaign, `observations/point-${i}.md`), source());
    assert.deepEqual(observed(f).points, []);
  } finally { f.clean(); }
});

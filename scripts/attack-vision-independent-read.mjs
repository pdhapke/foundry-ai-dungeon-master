// Read-only independent fixture/cleanup check. No model, mutations or credential output.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { StreamableFoundryLocalApiMcpClient } from "../server/dist/integrations/foundry-local-api-mcp.js";
const require = createRequire(new URL("../server/package.json", import.meta.url));
const local = require("dotenv").parse(readFileSync(new URL("../../foundry-local-api/server/.env", import.meta.url)));
const client = new StreamableFoundryLocalApiMcpClient({ baseUrl: "http://127.0.0.1:3939", apiKey: local.API_KEY ?? local.FOUNDRY_API_KEY, clientVersion: "0.1.0" });
const fixture = JSON.parse(readFileSync(new URL("../docs/attack-vision-evidence/live-fixture.json", import.meta.url), "utf8"));
const mode = process.argv[2] ?? "inspect";
if (!["inspect", "restore"].includes(mode)) throw new Error("Read-only inspect or restore verification required");
const call = (name, args = {}) => client.callTool({ name, arguments: args, idempotencyKey: null });
let record;
try {
  const status = await call("foundry_get_status");
  if (status.worldId !== fixture.worldId || status.userId !== fixture.userId) throw new Error("Exact fixture world/GM scope required");
  const base = { capturedAt: new Date().toISOString(), boundary: "Read-only authenticated SDK; no model or mutation", worldId: status.worldId, userId: status.userId, mode };
  if (mode === "inspect") {
    const [scene, actor] = await Promise.all([call("foundry_get_scene", { id: fixture.sceneId }), call("foundry_get_actor", { id: fixture.targetActorId })]);
    record = { ...base, scene: { id: scene._id, active: scene.active, tokenVision: scene.tokenVision, darkness: scene.environment.darknessLevel, globalLight: scene.environment.globalLight.enabled, fogMode: scene.fog.mode },
      tokens: scene.tokens.filter(t => [fixture.tokenId, fixture.targetTokenId].includes(t._id)).map(t => ({ id: t._id, actorId: t.actorId, x: t.x, y: t.y, elevation: t.elevation })),
      door: scene.walls.filter(w => w._id === fixture.doorId).map(w => ({ id: w._id, ds: w.ds })), hp: { value: actor.system.attributes.hp.value, temp: actor.system.attributes.hp.temp, max: actor.system.attributes.hp.max } };
  } else {
    const [scenes, fixtureScene, actor, pause, combats] = await Promise.all([call("foundry_list_scenes"), call("foundry_get_scene", { id: fixture.sceneId }), call("foundry_get_actor", { id: fixture.targetActorId }), call("foundry_get_game_paused"), call("foundry_list_combats")]);
    const original = scenes.find(s => s._id === fixture.original.sceneId);
    const token = fixtureScene.tokens.find(t => t._id === fixture.tokenId), door = fixtureScene.walls.find(w => w._id === fixture.doorId), light = fixtureScene.lights.find(l => l._id === fixture.lightId);
    const hp = actor.system.attributes.hp;
    const activeCombatIds = combats.filter(c => c.active).map(c => c._id);
    record = { ...base, originalSceneId: fixture.original.sceneId, originalSceneActive: original?.active === true, paused: pause.paused, expectedPaused: fixture.original.paused, activeCombatIds,
      retainedFixture: { sceneId: fixtureScene._id, active: fixtureScene.active, token: { x: token?.x, y: token?.y }, door: door?.ds, globalLight: fixtureScene.environment.globalLight.enabled, lightHidden: light?.hidden, hp: { value: hp.value, temp: hp.temp, max: hp.max } },
      pass: original?.active === true && pause.paused === fixture.original.paused && fixtureScene.active === false && token?.x === 300 && token?.y === 400 && door?.ds === 0 && fixtureScene.environment.globalLight.enabled === true && light?.hidden === false && hp.value === 40 && hp.temp === 4 && JSON.stringify(activeCombatIds.slice().sort()) === JSON.stringify(fixture.original.activeCombatIds.slice().sort()) };
  }
  writeFileSync(new URL(`../docs/attack-vision-evidence/independent-sdk-${mode}.json`, import.meta.url), JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record));
  if (record.pass === false) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ mode, outcome: "BLOCKED", message: "Read-only verification unavailable; no state changed" }));
  process.exitCode = 1;
} finally { await client.close(); }

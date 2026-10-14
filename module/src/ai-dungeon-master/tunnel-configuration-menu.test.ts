import assert from "node:assert/strict";
import test from "node:test";
import { openTunnelConfiguration, registerTunnelConfigurationMenu } from "./tunnel-configuration-menu.js";

type Menu = { namespace: string; key: string; name: string; label: string; hint: string; restricted: boolean; type: new () => { render(options?: { force?: boolean }): unknown } };
function fixture(t: test.TestContext) {
  const saved = new Map(["game", "ui", "foundry"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const set = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  t.after(() => { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
  const notifications: string[] = [];
  set("ui", { notifications: { warn: (message: string) => notifications.push(message), error: (message: string) => notifications.push(message) } });
  class Application { render(options?: { force?: boolean }): unknown { void options; return this; } }
  set("foundry", { applications: { api: { ApplicationV2: Application } } });
  const modules = new Map<string, { active?: boolean; api?: unknown }>();
  let menu: Menu | undefined, user: { isGM: boolean; name: string } | null = null;
  const settings = { registerMenu: (namespace: string, key: string, options: Omit<Menu, "namespace" | "key">) => { menu = { ...options, namespace, key }; } };
  set("game", { get user() { return user; }, settings, modules });
  return { Application, notifications, modules, settings, menu: () => menu!, setUser: (value: typeof user) => { user = value; }, set };
}

void test("init registers the native restricted searchable menu under AI Dungeon Master without reading user or dependency", async t => {
  const f = fixture(t);
  f.set("game", { get user() { throw new Error("init user unavailable"); }, settings: f.settings, get modules() { throw new Error("ready API unavailable"); } });
  registerTunnelConfigurationMenu();
  const menu = f.menu(); assert.equal(menu.namespace, "foundry-ai-dungeon-master"); assert.equal(menu.key, "tunnelConfiguration"); assert.equal(menu.label, "Configure tunnel"); assert.equal(menu.restricted, true);
  for (const term of ["openai", "dot", "tunnel", "runtime key"]) assert.ok(`${menu.name} ${menu.hint}`.toLowerCase().includes(term));
  const application = new menu.type(); assert.ok(application instanceof f.Application);
  f.set("game", { user: { isGM: true, name: "GM" }, settings: f.settings, modules: f.modules });
  assert.equal(application.render({ force: true }), application);
  await Promise.resolve(); assert.match(f.notifications[0]!, /Enable Foundry local api/);
});
void test("menu resolves the ready API on each open regardless of module initialization order", async t => {
  const f = fixture(t); f.setUser({ isGM: true, name: "GM" }); registerTunnelConfigurationMenu();
  const module: { active: boolean; api?: unknown } = { active: true }; f.modules.set("foundry-local-api", module);
  await openTunnelConfiguration(); assert.match(f.notifications[0]!, /not ready/);
  let opens = 0;
  const setup = { show(this: unknown) { assert.equal(this, setup); opens++; return Promise.resolve(); } };
  f.modules.set("foundry-ai-dungeon-master", module); module.api = { dotTunnelSetup: setup };
  await openTunnelConfiguration(); assert.equal(opens, 1);
  let replacementOpens = 0; f.modules.set("foundry-ai-dungeon-master", module); module.api = { dotTunnelSetup: { show: () => { replacementOpens++; } } };
  await openTunnelConfiguration(); assert.equal(replacementOpens, 1); assert.equal(opens, 1);
});
void test("missing/inactive dependency, malformed API and failed delegate produce helpful fixed errors", async t => {
  const f = fixture(t); f.setUser({ isGM: true, name: "GM" });
  await openTunnelConfiguration(); assert.match(f.notifications.at(-1)!, /Enable Foundry local api/);
  f.modules.set("foundry-local-api", { active: false, api: { dotTunnelSetup: { show: () => assert.fail("inactive dependency must not open") } } });
  await openTunnelConfiguration(); assert.match(f.notifications.at(-1)!, /Enable Foundry local api/);
  f.modules.set("foundry-local-api", { active: true }); f.modules.set("foundry-ai-dungeon-master", { active: true, api: { dotTunnelSetup: { show: "malformed" } } });
  await openTunnelConfiguration(); assert.match(f.notifications.at(-1)!, /not ready/);
  f.modules.set("foundry-local-api", { active: true }); f.modules.set("foundry-ai-dungeon-master", { active: true, api: { dotTunnelSetup: { show: () => Promise.reject(new Error("synthetic secret raw error")) } } });
  await openTunnelConfiguration(); assert.match(f.notifications.at(-1)!, /could not open/); assert.ok(!f.notifications.join(" ").includes("synthetic secret"));
});
void test("render-time GM guard denies missing user, players and TV without calling companion", async t => {
  const f = fixture(t); let opens = 0;
  f.modules.set("foundry-local-api", { active: true }); f.modules.set("foundry-ai-dungeon-master", { active: true, api: { dotTunnelSetup: { show: () => { opens++; } } } });
  for (const user of [null, { isGM: false, name: "Player" }, { isGM: true, name: "TV" }]) { f.setUser(user); await openTunnelConfiguration(); }
  assert.equal(opens, 0); assert.equal(f.notifications.length, 3);
});

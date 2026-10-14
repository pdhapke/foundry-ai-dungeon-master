import assert from "node:assert/strict";
import { it } from "node:test";

it("rerender cancels detached player panel and removes its source hooks", async () => {
  class Node extends EventTarget {
    tagName = "DIV"; children: Node[] = []; textContent = ""; value = ""; disabled = false; hidden = false;
    style: Record<string, string> = {}; type = "";
    setAttribute() {} append(...nodes: Node[]) { this.children.push(...nodes); } replaceChildren(...nodes: Node[]) { this.children = nodes; } remove() {}
  }
  let host = new Node(); const hooks = new Map<number, string>(); let nextHook = 0;
  class Base {
    element = { querySelector: (selector: string) => selector === ".ai-dm-player-observations" ? host : null };
    render() {} async close() {}
  }
  Object.assign(globalThis, {
    foundry: { applications: { api: { ApplicationV2: Base, HandlebarsApplicationMixin: (base: unknown) => base } } },
    game: { user: { id: "gm", isGM: true }, world: { id: "world" }, users: { contents: [{ id: "player", name: "Izzy", active: true, isGM: false }] }, settings: { get: (_module: string, key: string) => key === "serverUrl" ? "ws://localhost:3940/ws" : "domain-public" } },
    canvas: { scene: { id: "scene", toObject: () => ({ id: "scene" }) }, tokens: { controlled: [{ document: { id: "token", testUserPermission: () => true } }] } },
    customElements: { get: () => class {} },
    window: { addEventListener: () => undefined, setTimeout, clearTimeout },
    document: { createElement: (tag: string) => { const node = new Node(); node.tagName = tag.toUpperCase(); return node; } },
    Hooks: { on: (event: string) => { const id = ++nextHook; hooks.set(id, event); return id; }, off: (_event: string, id: number) => hooks.delete(id) },
  });
  const { AiDungeonMasterApplication } = await import("./application.js");
  const app = new AiDungeonMasterApplication();
  await app.openPlayerObservations();
  const oldButton = host.children[1];
  assert.equal(oldButton?.disabled, false); assert.equal(hooks.size, 7);
  host = new Node(); app._onRender();
  assert.equal(oldButton?.disabled, true); assert.equal(hooks.size, 0);
  assert.equal(host.children.length, 0);
  await app.close();
});

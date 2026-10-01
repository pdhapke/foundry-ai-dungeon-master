import assert from "node:assert/strict";
import { it } from "node:test";
import { AutomaticTriggers } from "./automatic-triggers.js";
void it("coalesces rapid keyed entry, suppresses AI echoes and bounds IDs (mocked hook timing)", async () => {
  const events: Array<{ prompt: string; requestId: string }> = [];
  const adapter = new AutomaticTriggers((value) => events.push(value), 5);
  adapter.accept({ kind: "area", documentId: "token", key: "room", revision: 1 });
  adapter.accept({ kind: "area", documentId: "token", key: "room2", revision: 2 });
  adapter.accept({ kind: "door", documentId: "wall", revision: 3, origin: "ai-dungeon-master" });
  adapter.accept({ kind: "area", documentId: "token", revision: 4 });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.requestId, "area-token-2");
  assert.match(events[0]!.prompt, /room2/);
  adapter.accept({ kind: "turn", documentId: "combat", revision: 5 });
  adapter.cancel();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(events.length, 1);
});


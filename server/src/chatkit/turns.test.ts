import assert from "node:assert/strict";
import { it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ChatKitTurns } from "./turns.js";
import type { AiDmAuthenticatedIdentity } from "@foundry-ai-dungeon-master/shared";
const gm = { worldId: "world", userId: "gm", isGm: true } as AiDmAuthenticatedIdentity;
const body = (id: string) => ({
  type: "threads.custom_action",
  params: { thread_id: "thread", action: { payload: { requestId: id } } },
});
void it("serializes prompts/custom actions across clients, persists replay and recovers interrupted states (real SQLite)", async () => {
  const db = new DatabaseSync(":memory:");
  const queue = new ChatKitTurns(db);
  const signal = new AbortController().signal;
  const first = await queue.enter(gm, body("a"), signal);
  let second = false;
  const pending = queue
    .enter({ ...gm, userId: "other" }, { type: "threads.add_user_message" }, signal, "b")
    .then((finish) => {
      second = true;
      return finish;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second, false);
  first!();
  const finish = await pending;
  assert.equal(second, true);
  await assert.rejects(queue.enter(gm, body("a"), signal), /already recorded/);
  new ChatKitTurns(db);
  assert.equal(
    db.prepare("SELECT status FROM chatkit_turns WHERE event='b'").get()!["status"],
    "interrupted",
  );
  finish!();
  await assert.rejects(queue.enter(gm, body("b"), signal), /already recorded/);
  db.close();
});
void it("queued cancellation releases ordering without dispatch; AI echoes/malformed IDs cannot infer", async () => {
  const db = new DatabaseSync(":memory:");
  const q = new ChatKitTurns(db);
  const signal = new AbortController().signal;
  const first = await q.enter(gm, body("a"), signal);
  const abort = new AbortController();
  const cancelled = q.enter(gm, body("b"), abort.signal);
  abort.abort();
  await assert.rejects(cancelled);
  first!();
  const third = await q.enter(gm, body("c"), signal);
  third!();
  assert.equal(
    db.prepare("SELECT status FROM chatkit_turns WHERE event='b'").get()!["status"],
    "cancelled",
  );
  await assert.rejects(q.enter(gm, body("bad/id"), signal), /Invalid/);
  assert.equal(await q.enter(gm, { type: "threads.list" }, signal), undefined);
  db.close();
});

void it("real disk reopen preserves settled IDs and marks crashed inference interrupted", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const paths = await import("node:path");
  const dir = mkdtempSync(paths.join(os.tmpdir(), "ai-dm-turns-"));
  const path = paths.join(dir, "turns.sqlite");
  try {
    const db = new DatabaseSync(path);
    const q = new ChatKitTurns(db);
    const signal = new AbortController().signal;
    const settled = await q.enter(gm, body("settled"), signal);
    settled!();
    await q.enter(gm, body("crashed"), signal);
    db.close();
    const reopened = new DatabaseSync(path);
    const restored = new ChatKitTurns(reopened);
    assert.equal(
      reopened.prepare("SELECT status FROM chatkit_turns WHERE event='crashed'").get()!["status"],
      "interrupted",
    );
    await assert.rejects(restored.enter(gm, body("settled"), signal), /already recorded/);
    await assert.rejects(restored.enter(gm, body("crashed"), signal), /interrupted/);
    const fresh = await restored.enter(gm, body("fresh"), signal);
    fresh!();
    reopened.close();
  } finally {
    assert.equal(paths.dirname(dir), paths.resolve(os.tmpdir()));
    rmSync(dir, { recursive: true });
  }
});

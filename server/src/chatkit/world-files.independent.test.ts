import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { WorldFiles } from "./world-files.js";

void test("independent: failed recovery receipt insert preserves a recoverable journal", async () => {
  const root = mkdtempSync(join(tmpdir(), "world-files-validation-"));
  mkdirSync(join(root, "world"));
  const db = new DatabaseSync(join(root, "operations.sqlite"));
  const gm = {
    clientId: "fixture",
    worldId: "world",
    userId: "gm",
    lane: "gm" as const,
    isGm: true,
  };
  let interrupt = false;
  const authority = {
    authorize: async () => {
      await Promise.resolve();
      if (interrupt) {
        try {
          if (readFileSync(join(root, "world", "notes.txt"), "utf8") === "after")
            throw new Error("Simulated revocation after effect");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    },
    assertPrivateStorage: async () => {},
    authorizeWriteIntent: async () => {},
  };
  const service = new WorldFiles(root, db, authority);
  try {
    interrupt = true;
    const intent = await service.issueIntent(gm, {
      requestId: "write",
      operation: "write",
      path: "notes.txt",
      expectedRevision: null,
      encoding: "utf8",
      content: "after",
    });
    await assert.rejects(service.apply(gm, intent), /unresolved/);
    interrupt = false;
    db.exec(
      "CREATE TRIGGER reject_recovery_insert BEFORE INSERT ON chatkit_world_files WHEN NEW.scope_key LIKE '%recover%' BEGIN SELECT RAISE(ABORT, 'simulated receipt failure'); END",
    );
    const recovery = await service.issueIntent(gm, {
      requestId: "recover",
      operation: "recover",
      path: "notes.txt",
      expectedRevision: createHash("sha256").update("after").digest("hex"),
    });
    await assert.rejects(service.apply(gm, recovery), /simulated receipt failure/);
    assert.equal(db.prepare("SELECT state FROM chatkit_world_files").get()?.["state"], "pending");
    db.exec("DROP TRIGGER reject_recovery_insert");
    const restarted = new WorldFiles(root, db, authority);
    const retry = await restarted.issueIntent(gm, {
      requestId: "recover-again",
      operation: "recover",
      path: "notes.txt",
      expectedRevision: null,
    });
    const receipt = await restarted.apply(gm, retry);
    assert.equal(receipt.status, "recovered");
    assert.deepEqual(await restarted.apply(gm, retry), receipt);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

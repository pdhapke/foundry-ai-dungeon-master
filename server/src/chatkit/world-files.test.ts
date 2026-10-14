import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldFiles, type WorldFileRequest } from "./world-files.js";
const gm = { clientId: "client", worldId: "w", userId: "gm", lane: "gm" as const, isGm: true };
function fixture(privateGate = true) {
  const root = mkdtempSync(join(tmpdir(), "world-files-"));
  mkdirSync(join(root, "w"));
  mkdirSync(join(root, "other"));
  const db = new DatabaseSync(join(root, "operations.sqlite"));
  let revoked = false;
  let failAfterWrite = false;
  const authority = {
    authorize: () =>
      revoked ||
      (failAfterWrite &&
        (() => {
          try {
            return readFileSync(join(root, "w", "notes", "one.txt"), "utf8") === "new";
          } catch {
            return false;
          }
        })())
        ? Promise.reject(new Error("revoked"))
        : Promise.resolve(),
    ...(privateGate ? { assertPrivateStorage: () => Promise.resolve() } : {}),
    authorizeWriteIntent: () => Promise.resolve(),
    authorizeDeleteIntent: () => Promise.resolve(),
  };
  const service = new WorldFiles(root, db, authority);
  return {
    root,
    db,
    service,
    authority,
    revoke: () => {
      revoked = true;
    },
    restore: () => {
      revoked = false;
      failAfterWrite = false;
    },
    interrupt: () => {
      failAfterWrite = true;
    },
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const write = (
  requestId = "one",
  content = "old",
  expectedRevision: string | null = null,
): WorldFileRequest => ({
  requestId,
  operation: "write",
  path: "notes/one.txt",
  expectedRevision,
  encoding: "utf8",
  content,
});
void test("trusted intent writes arbitrary authored extensions, revisions, bounded binary and exact durable receipts", async () => {
  const f = fixture();
  try {
    const grant = await f.service.issueIntent(gm, write());
    const receipt = await f.service.apply(gm, grant);
    assert.equal(readFileSync(join(f.root, "w", "notes", "one.txt"), "utf8"), "old");
    assert.deepEqual(await f.service.apply(gm, grant), receipt);
    const read = await f.service.read(gm, "notes/one.txt", "utf8");
    assert.equal(read.revision, receipt.revision);
    await assert.rejects(f.service.apply(gm, { intentDigest: grant.intentDigest }));
    await assert.rejects(
      f.service.apply(gm, await f.service.issueIntent(gm, write("stale", "new"))),
    );
    const binary = {
      ...write("asset"),
      path: "assets/custom.asset",
      encoding: "base64" as const,
      content: Buffer.from([0, 255, 2]).toString("base64"),
    };
    await f.service.apply(gm, await f.service.issueIntent(gm, binary));
    assert.equal((await f.service.read(gm, binary.path, "base64")).content, binary.content);
    assert.equal((await f.service.list(gm, "", "", 1)).entries.length, 1);
  } finally {
    f.close();
  }
});
void test("real filesystem traversal/ADS/reserved/runtime/cross-world and junction escape rejected", async () => {
  const f = fixture();
  try {
    for (const path of [
      "../other/file",
      "C:/escape",
      "x:secret",
      "CON.txt",
      "a/NUL",
      "folder./x",
      "data/actors/file",
      "packs/a",
      "world.json",
      ".env",
      "assets/runner.js",
    ]) {
      await assert.rejects(f.service.issueIntent(gm, { ...write(), path }), path);
    }
    await assert.rejects(
      f.service.apply({ ...gm, worldId: "other" }, await f.service.issueIntent(gm, write())),
    );
    mkdirSync(join(f.root, "outside"));
    symlinkSync(
      join(f.root, "outside"),
      join(f.root, "w", "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(f.service.read(gm, "linked/file"));
  } finally {
    f.close();
  }
});
void test("privacy failclosed and live authentication revocation prevent effects", async () => {
  const f = fixture(false);
  try {
    await assert.rejects(f.service.issueIntent(gm, write()), /privacy/);
  } finally {
    f.close();
  }
  const ready = fixture();
  try {
    const grant = await ready.service.issueIntent(gm, write());
    ready.revoke();
    await assert.rejects(ready.service.apply(gm, grant));
    await assert.rejects(ready.service.list(gm));
  } finally {
    ready.close();
  }
});
void test("concurrent revisions permit only one write; interruption/restart requires exact recovery", async () => {
  const f = fixture();
  try {
    const initial = await f.service.apply(gm, await f.service.issueIntent(gm, write()));
    const first = await f.service.issueIntent(gm, write("a", "first", initial.revision)),
      second = await f.service.issueIntent(gm, write("b", "second", initial.revision));
    const results = await Promise.allSettled([
      f.service.apply(gm, first),
      f.service.apply(gm, second),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const current = await f.service.read(gm, "notes/one.txt", "utf8");
    f.interrupt();
    await assert.rejects(
      f.service.apply(
        gm,
        await f.service.issueIntent(gm, write("interrupted", "new", current.revision)),
      ),
      /unresolved/,
    );
    await assert.rejects(f.service.read(gm, "notes/one.txt", "utf8"));
    f.restore();
    const restarted = new WorldFiles(f.root, f.db, f.authority);
    const observed = readFileSync(join(f.root, "w", "notes", "one.txt"));
    const { createHash } = await import("node:crypto");
    const recovery: WorldFileRequest = {
      requestId: "recover",
      operation: "recover",
      path: "notes/one.txt",
      expectedRevision: createHash("sha256").update(observed).digest("hex"),
    };
    const receipt = await restarted.apply(gm, await restarted.issueIntent(gm, recovery));
    assert.equal(receipt.status, "recovered");
    assert.equal((await restarted.read(gm, "notes/one.txt", "utf8")).content, current.content);
  } finally {
    f.close();
  }
});
void test("mkdir and destructive delete require separately reviewed grant; stale deletion cannot remove file", async () => {
  const f = fixture();
  try {
    await f.service.apply(
      gm,
      await f.service.issueIntent(gm, {
        requestId: "mkdir",
        operation: "mkdir",
        path: "assets/sub",
        expectedRevision: null,
      }),
    );
    const receipt = await f.service.apply(gm, await f.service.issueIntent(gm, write()));
    const deletion: WorldFileRequest = {
      requestId: "delete",
      operation: "delete",
      path: "notes/one.txt",
      expectedRevision: receipt.revision,
    };
    const noDelete = new WorldFiles(f.root, f.db, {
      authorize: () => Promise.resolve(),
      assertPrivateStorage: () => Promise.resolve(),
      authorizeWriteIntent: () => Promise.resolve(),
    });
    await assert.rejects(noDelete.issueIntent(gm, deletion));
    await f.service.apply(gm, await f.service.issueIntent(gm, deletion));
    await assert.rejects(f.service.read(gm, deletion.path));
  } finally {
    f.close();
  }
});

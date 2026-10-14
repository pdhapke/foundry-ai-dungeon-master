import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatKitWorldFileActions } from "./world-file-actions.js";
import { hashText } from "../context/hash.js";

void test("independent: real file review is accepted by browser validator, while content substitution and another GM scope are denied", async () => {
  const root = mkdtempSync(join(tmpdir(), "world-file-ui-validation-"));
  mkdirSync(join(root, "world"));
  const db = new DatabaseSync(join(root, "actions.sqlite"));
  const gm = {
    clientId: "fixture",
    worldId: "world",
    userId: "gm",
    lane: "gm" as const,
    isGm: true,
  };
  const scope = { worldId: "world", userId: "gm", threadId: "thread" };
  const path = "notes.txt";
  const content = '<script>alert("reference data")</script>';
  writeFileSync(join(root, "world", path), content);
  const service = new ChatKitWorldFileActions(root, db, () => Promise.resolve(), {
    assertPrivateStorage: () => Promise.resolve(),
  });
  const loaded: unknown = await import(
    new URL("../../../module/src/ai-dungeon-master/world-review.ts", import.meta.url).href
  );
  const { validateWorldReview } = loaded as {
    validateWorldReview: (value: unknown, expectedScope: typeof scope) => Promise<unknown>;
  };
  const signal = new AbortController().signal;
  try {
    const proposal = (await service.request(
      gm,
      scope,
      "delete",
      { actionId: "delete", path, expectedRevision: hashText(content) },
      { worldControl: { manualRequest: true, requestDigest: "a".repeat(64) } },
      signal,
    )) as Record<string, unknown>;
    const review = (await service.browser(
      gm,
      { kind: "world-file", threadId: "thread", actionId: "delete" },
      signal,
    )) as Record<string, unknown>;
    await validateWorldReview(review, scope);
    await assert.rejects(
      validateWorldReview(
        { ...review, before: { ...(review["before"] as object), content: "substituted" } },
        scope,
      ),
      /changed/,
    );
    await assert.rejects(
      service.browser(
        { ...gm, userId: "another" },
        { kind: "world-file", threadId: "thread", actionId: "delete" },
        signal,
      ),
      /unavailable/,
    );
    assert.equal(readFileSync(join(root, "world", path), "utf8"), content);
    assert.equal(proposal["status"], "pending");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

void test("independent: late privacy callbacks at every pre-effect checkpoint cannot resume a canceled filesystem write", async () => {
  for (const checkpoint of [1, 2, 3, 4, 5, 6]) {
    const root = mkdtempSync(join(tmpdir(), "world-late-privacy-"));
    mkdirSync(join(root, "world"));
    const db = new DatabaseSync(join(root, "actions.sqlite"));
    const gm = {
      clientId: "fixture",
      worldId: "world",
      userId: "gm",
      lane: "gm" as const,
      isGm: true,
    };
    const scope = { worldId: "world", userId: "gm", threadId: "thread" };
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new ChatKitWorldFileActions(root, db, () => Promise.resolve(), {
      timeoutMs: 150,
      assertPrivateStorage: () => (++calls === checkpoint ? gate : Promise.resolve()),
    });
    try {
      await service
        .request(
          gm,
          scope,
          "write",
          {
            actionId: "late",
            path: "notes.txt",
            expectedRevision: null,
            encoding: "utf8",
            content: "must not arrive after cancellation",
          },
          { worldControl: { manualRequest: true, requestDigest: "a".repeat(64) } },
          new AbortController().signal,
        )
        .catch(() => {});
      assert.ok(calls >= checkpoint, `Checkpoint ${checkpoint} was reached`);
      assert.equal(
        existsSync(join(root, "world", "notes.txt")),
        false,
        `No effect before callback ${checkpoint} release`,
      );
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        existsSync(join(root, "world", "notes.txt")),
        false,
        `No late effect after callback ${checkpoint} release`,
      );
    } finally {
      release();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

void test("independent: missing or denied privacy gate cannot persist private proposals in SQLite", async () => {
  for (const denied of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "world-private-proposal-"));
    mkdirSync(join(root, "world"));
    const db = new DatabaseSync(join(root, "actions.sqlite"));
    const gm = {
      clientId: "fixture",
      worldId: "world",
      userId: "gm",
      lane: "gm" as const,
      isGm: true,
    };
    const scope = { worldId: "world", userId: "gm", threadId: "thread" };
    const options = denied
      ? { assertPrivateStorage: () => Promise.reject(new Error("Privacy not verified")) }
      : {};
    const service = new ChatKitWorldFileActions(root, db, () => Promise.resolve(), options);
    try {
      await service
        .request(
          gm,
          scope,
          "write",
          {
            actionId: "private",
            path: "private.txt",
            expectedRevision: null,
            encoding: "utf8",
            content: "private marker must never be journaled",
          },
          { worldControl: { manualRequest: true, requestDigest: "a".repeat(64) } },
          new AbortController().signal,
        )
        .catch(() => {});
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM chatkit_world_file_actions").get()?.["count"],
        0,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM chatkit_world_files").get()?.["count"],
        0,
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

void test("independent: supported bounded overwrite remains recoverable through complete browser review", async () => {
  const root = mkdtempSync(join(tmpdir(), "world-file-review-budget-"));
  mkdirSync(join(root, "world"));
  const db = new DatabaseSync(join(root, "actions.sqlite"));
  const gm = {
    clientId: "fixture",
    worldId: "world",
    userId: "gm",
    lane: "gm" as const,
    isGm: true,
  };
  const scope = { worldId: "world", userId: "gm", threadId: "thread" };
  const old = "a".repeat(7000),
    next = "b".repeat(7000);
  const path = join(root, "world", "notes.txt");
  writeFileSync(path, old);
  let interrupt = true;
  const service = new ChatKitWorldFileActions(
    root,
    db,
    () =>
      interrupt && readFileSync(path, "utf8") === next
        ? Promise.reject(new Error("Simulated revoked authority after overwrite"))
        : Promise.resolve(),
    { assertPrivateStorage: () => Promise.resolve() },
  );
  const authority = {
    worldControl: { manualRequest: true as const, requestDigest: "a".repeat(64) },
  };
  const signal = new AbortController().signal;
  const loaded: unknown = await import(
    new URL("../../../module/src/ai-dungeon-master/world-review.ts", import.meta.url).href
  );
  const ui = loaded as {
    validateWorldReview: (value: unknown, expectedScope: typeof scope) => Promise<unknown>;
  };
  try {
    const result = (await service.request(
      gm,
      scope,
      "write",
      {
        actionId: "overwrite",
        path: "notes.txt",
        expectedRevision: hashText(old),
        encoding: "utf8",
        content: next,
      },
      authority,
      signal,
    )) as Record<string, unknown>;
    assert.equal(result["status"], "uncertain");
    interrupt = false;
    await service.request(
      gm,
      scope,
      "recover",
      { actionId: "recover", path: "notes.txt", expectedRevision: hashText(next) },
      authority,
      signal,
    );
    const review = await service.browser(
      gm,
      { kind: "world-file", threadId: "thread", actionId: "recover" },
      signal,
    );
    await assert.doesNotReject(ui.validateWorldReview(review, scope));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

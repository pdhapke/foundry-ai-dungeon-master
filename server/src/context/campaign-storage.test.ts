import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CampaignStorage } from "./campaign-storage.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "campaign-storage-"));
  mkdirSync(join(root, "world-a"));
  mkdirSync(join(root, "world-b"));
  let authorized = true;
  const authority = {
    authorize: (id: string) => {
      if (!authorized || id !== "world-a") throw new Error("Unauthorized world.");
    },
    assertPrivateStorage: () => {},
  };
  const storage = new CampaignStorage(root, authority);
  return {
    root,
    storage,
    authority,
    revoke: () => {
      authorized = false;
    },
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}
void test("real files: missing folder, revision checks, bounded content and world isolation", () => {
  const f = fixture();
  try {
    const receipt = f.storage.commit("world-a", [
      { path: "overview.md", text: "first", expectedRevision: null },
    ]);
    assert.equal(f.storage.read("world-a", "overview.md")?.text, "first");
    assert.throws(
      () =>
        f.storage.commit("world-a", [
          { path: "overview.md", text: "stale", expectedRevision: null },
        ]),
      /revision conflict/,
    );
    f.storage.commit("world-a", [
      { path: "overview.md", text: "second", expectedRevision: receipt.files[0]!.revision },
    ]);
    assert.throws(() => f.storage.read("world-b", "overview.md"), /Unauthorized/);
    assert.throws(
      () =>
        f.storage.commit("world-a", [
          { path: "large.md", text: "a".repeat(128001), expectedRevision: null },
        ]),
      /budget/,
    );
    for (const path of [
      "../escape.md",
      "CON.md",
      "notes.md:secret",
      "a\\b.md",
      "/escape.md",
      "bad./notes.md",
    ])
      assert.throws(() =>
        f.storage.commit("world-a", [{ path, text: "bad", expectedRevision: null }]),
      );
    f.revoke();
    assert.throws(() => f.storage.read("world-a", "overview.md"), /Unauthorized/);
  } finally {
    f.clean();
  }
});
void test("private writes fail closed without trusted deployment verification", () => {
  const f = fixture();
  try {
    const storage = new CampaignStorage(f.root, { authorize: f.authority.authorize });
    assert.throws(
      () =>
        storage.commit("world-a", [{ path: "private.md", text: "secret", expectedRevision: null }]),
      /not verified/,
    );
  } finally {
    f.clean();
  }
});

void test("storage budgets and world identifiers remain explicitly bounded", () => {
  const f = fixture();
  try {
    for (const budget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1_048_577])
      assert.throws(() => new CampaignStorage(f.root, f.authority, budget), /budgets/);
    assert.throws(() => new CampaignStorage(f.root, f.authority, 128_000, 33_554_433), /budgets/);
    assert.throws(() => f.storage.read("a".repeat(201), "overview.md"), /identifier/);
  } finally {
    f.clean();
  }
});
void test("real directory junction escape and cooperative concurrent lock are rejected", () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), "campaign-outside-"));
  try {
    f.storage.commit("world-a", [{ path: "overview.md", text: "ok", expectedRevision: null }]);
    const campaign = join(f.root, "world-a", "data", "campaign");
    symlinkSync(outside, join(campaign, "escape"), "junction");
    assert.throws(
      () =>
        f.storage.commit("world-a", [
          { path: "escape/secret.md", text: "bad", expectedRevision: null },
        ]),
      /escape/,
    );
    mkdirSync(join(campaign, ".write-lock"));
    assert.throws(
      () =>
        f.storage.commit("world-a", [{ path: "other.md", text: "bad", expectedRevision: null }]),
      /EEXIST/,
    );
  } finally {
    f.clean();
    rmSync(outside, { recursive: true });
  }
});
void test("interrupted batch denies reads and recovers old state across repository restart", () => {
  const f = fixture();
  try {
    f.storage.commit("world-a", [{ path: "overview.md", text: "old", expectedRevision: null }]);
    const revision = f.storage.read("world-a", "overview.md")!.revision;
    let calls = 0;
    const broken = new CampaignStorage(f.root, {
      ...f.authority,
      authorize: (id) => {
        f.authority.authorize(id);
        if (++calls === 4) throw new Error("revoked mid-batch");
      },
    });
    assert.throws(
      () =>
        broken.commit("world-a", [
          { path: "overview.md", text: "new", expectedRevision: revision },
          { path: "npc.md", text: "npc", expectedRevision: null },
        ]),
      /revoked/,
    );
    assert.throws(() => f.storage.read("world-a", "overview.md"), /recovery/);
    const restarted = new CampaignStorage(f.root, f.authority);
    restarted.recover("world-a");
    assert.equal(restarted.read("world-a", "overview.md")!.text, "old");
    assert.equal(restarted.read("world-a", "npc.md"), null);
  } finally {
    f.clean();
  }
});
void test("recoverable journal validates world, staging links and interrupted rename", () => {
  const f = fixture();
  try {
    f.storage.commit("world-a", [{ path: "overview.md", text: "old", expectedRevision: null }]);
    const campaign = join(f.root, "world-a", "data", "campaign");
    writeFileSync(
      join(campaign, ".transaction.json"),
      JSON.stringify({ version: 1, worldId: "world-b", before: [] }),
    );
    assert.throws(() => f.storage.recover("world-a"), /Invalid recovery/);
    writeFileSync(
      join(campaign, ".transaction.json"),
      JSON.stringify({
        version: 1,
        worldId: "world-a",
        before: [{ path: "overview.md", text: "old" }],
      }),
    );
    writeFileSync(join(campaign, "overview.md"), "partial");
    writeFileSync(join(campaign, "overview.md.pending"), "interrupted");
    f.storage.recover("world-a");
    assert.equal(readFileSync(join(campaign, "overview.md"), "utf8"), "old");
  } finally {
    f.clean();
  }
});

void test("durable transaction receipts prevent conflicting replay and recover a committed marker", () => {
  const f = fixture();
  try {
    const transaction = { transactionId: "canon-one", batchDigest: "a".repeat(64) };
    const edits = [{ path: "overview.md", text: "canon", expectedRevision: null }];
    const receipt = f.storage.commit("world-a", edits, transaction);
    assert.deepEqual(f.storage.receipt("world-a", "canon-one"), receipt);
    assert.deepEqual(f.storage.commit("world-a", edits, transaction), receipt);
    assert.throws(
      () => f.storage.commit("world-a", [{ ...edits[0]!, text: "different" }], transaction),
      /conflict/,
    );
    const campaign = join(f.root, "world-a/data/campaign");
    writeFileSync(
      join(campaign, ".transaction.json"),
      JSON.stringify({
        version: 1,
        worldId: "world-a",
        before: [{ path: "overview.md", text: null }],
        transaction,
      }),
    );
    f.storage.recover("world-a");
    assert.equal(f.storage.read("world-a", "overview.md")!.text, "canon");
    assert.deepEqual(f.storage.receipt("world-a", "canon-one"), receipt);
  } finally {
    f.clean();
  }
});

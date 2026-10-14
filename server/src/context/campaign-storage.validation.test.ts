import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { CampaignStorage } from "./campaign-storage.js";

void test("independent regression: every accepted prior snapshot remains recoverable", () => {
  const root = mkdtempSync(join(tmpdir(), "campaign-validator-"));
  try {
    mkdirSync(join(root, "world-a"));
    const authority = { authorize: () => {}, assertPrivateStorage: () => {} };
    const storage = new CampaignStorage(root, authority);
    const edits = Array.from({ length: 6 }, (_, i) => {
      const path = `resource-${i}.md`;
      storage.commit("world-a", [{ path, text: "\u0000".repeat(128000), expectedRevision: null }]);
      return { path, text: "new", expectedRevision: storage.read("world-a", path)!.revision };
    });
    let calls = 0;
    const interrupted = new CampaignStorage(root, {
      ...authority,
      authorize: () => {
        if (++calls === 4) throw new Error("interrupted");
      },
    });
    assert.throws(() => interrupted.commit("world-a", edits), /interrupted/);
    assert.ok(statSync(join(root, "world-a/data/campaign/.transaction.json")).size > 4096000);
    storage.recover("world-a");
    assert.equal(storage.read("world-a", edits[0]!.path)!.text, "\u0000".repeat(128000));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("independent processes: live writer excludes edits and killed writer rolls back", async () => {
  const root = mkdtempSync(join(tmpdir(), "campaign-validator-process-"));
  try {
    mkdirSync(join(root, "world-a"));
    const authority = { authorize: () => {}, assertPrivateStorage: () => {} };
    const storage = new CampaignStorage(root, authority);
    const original = storage.commit("world-a", [
      { path: "overview.md", text: "old", expectedRevision: null },
    ]);
    const code = `import {CampaignStorage} from ${JSON.stringify(new URL("./campaign-storage.ts", import.meta.url).href)};
      let calls=0;
      const storage=new CampaignStorage(${JSON.stringify(root)}, {assertPrivateStorage:()=>{}, authorize:()=>{
        if(++calls===4){process.stdout.write('held\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
      }});
      storage.commit('world-a', [{path:'overview.md',text:'partial',expectedRevision:${JSON.stringify(original.files[0]!.revision)}},{path:'npc.md',text:'new',expectedRevision:null}]);`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += String(chunk);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`child readiness timeout: ${errors}`)),
          10000,
        );
        child.stdout.on("data", (chunk) => {
          if (String(chunk).includes("held")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on("error", reject);
      });
      assert.throws(
        () =>
          storage.commit("world-a", [
            { path: "other.md", text: "blocked", expectedRevision: null },
          ]),
        /EEXIST/,
      );
      assert.throws(() => storage.read("world-a", "overview.md"), /recovery/);
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
      // Process exit is confirmed before operator-equivalent stale-lock removal.
      rmSync(join(root, "world-a/data/campaign/.write-lock"), { recursive: true });
      storage.recover("world-a");
      assert.equal(storage.read("world-a", "overview.md")!.text, "old");
      assert.equal(storage.read("world-a", "npc.md"), null);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

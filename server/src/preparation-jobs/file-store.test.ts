import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { FilePreparationJobStore, type PreparationJob } from "./index.js";
test("file store claims before CAS, preserves conflicting/crash claims and releases only its own", () => {
  const root = mkdtempSync(join(tmpdir(), "prep-job-cas-")), privateRoot = join(root, "private"), publicRoot = join(root, "public");
  mkdirSync(privateRoot); mkdirSync(publicRoot);
  const config = { protectedRoot: privateRoot, publicDataRoot: publicRoot };
  const a = new FilePreparationJobStore(config), b = new FilePreparationJobStore(config);
  const job = { id: "job", revision: 1 } as PreparationJob;
  a.write(job, null);
  const claim = join(privateRoot, "preparation-job.json.write-claim");
  assert.equal(existsSync(claim), false);
  b.write({ ...job, revision: 2 }, 1);
  assert.throws(() => a.write({ ...job, revision: 2 }, 1), /Concurrent/);
  assert.equal(existsSync(claim), false);
  writeFileSync(claim, "another process or crashed owner", { flag: "wx" });
  assert.throws(() => a.write({ ...job, revision: 3 }, 2), /explicit recovery/);
  assert.equal(readFileSync(claim, "utf8"), "another process or crashed owner");
  assert.equal(b.read("job")?.revision, 2);
});
test("independent processes competing for one source revision produce one writer", { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "prep-job-process-")), privateRoot = join(root, "private"), publicRoot = join(root, "public");
  mkdirSync(privateRoot); mkdirSync(publicRoot);
  const config = { protectedRoot: privateRoot, publicDataRoot: publicRoot };
  const store = new FilePreparationJobStore(config);
  store.write({ id: "job", revision: 1 } as PreparationJob, null);
  const code = `import { FilePreparationJobStore } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    const store = new FilePreparationJobStore(${JSON.stringify(config)});
    process.on('message', () => { try { store.write({id:'job',revision:2},1); process.send('won'); }
      catch { process.send('lost'); } process.disconnect(); }); process.send('ready');`;
  const children = [0, 1].map(() => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe", "ipc"] }));
  const outcomes: Promise<string>[] = [];
  await Promise.all(children.map(child => new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("message", message => {
      assert.equal(message, "ready");
      outcomes.push(new Promise<string>(done => child.once("message", value => done(String(value))))); resolve();
    });
  })));
  children.forEach(child => child.send("write"));
  const results = await Promise.all(outcomes);
  assert.equal(results.filter(value => value === "won").length, 1);
  assert.equal(store.read("job")?.revision, 2);
});

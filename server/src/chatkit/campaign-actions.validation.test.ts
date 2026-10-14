import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ChatKitCampaignActions } from "./campaign-actions.js";
import type { AiDmAuthenticatedIdentity } from "@foundry-ai-dungeon-master/shared";

void test("independent process approval cannot be overwritten by an overlapping reject", async () => {
  const root = mkdtempSync(join(tmpdir(), "campaign-review-validator-"));
  const databasePath = join(root, "proposals.sqlite");
  const db = new DatabaseSync(databasePath);
  try {
    mkdirSync(join(root, "w"));
    const identity: AiDmAuthenticatedIdentity = {
      clientId: "client",
      worldId: "w",
      userId: "gm",
      lane: "gm",
      isGm: true,
    };
    const scope = { worldId: "w", userId: "gm", threadId: "thread" };
    const service = new ChatKitCampaignActions(db, async () => {}, {
      worldsRoot: root,
      assertPrivateStorage: () => {},
    });
    const text = (id: string) =>
      `---\nschema_version: 1\nid: ${id}\nrevision: r1\nvisibility: gm\ncanon_status: canon\n---\nCampaign`;
    const proposal = (await service.request(
      identity,
      scope,
      "campaign_propose",
      {
        proposalId: "p",
        title: "Setup",
        files: [
          { path: "overview.md", expectedRevision: null, proposedText: text("overview") },
          { path: "index.md", expectedRevision: null, proposedText: text("index") },
        ],
      },
      new AbortController().signal,
    )) as Record<string, unknown>;
    const decision = {
      kind: "campaign",
      threadId: "thread",
      proposalId: "p",
      batchDigest: proposal["batchDigest"],
      decision: "approve",
    };
    const childCode = `import {DatabaseSync} from 'node:sqlite'; import {ChatKitCampaignActions} from ${JSON.stringify(new URL("./campaign-actions.ts", import.meta.url).href)};
      const db=new DatabaseSync(${JSON.stringify(databasePath)});
      const service=new ChatKitCampaignActions(db,async()=>{}, {worldsRoot:${JSON.stringify(root)},assertPrivateStorage:()=>{}});
      const result=await service.browser(${JSON.stringify(identity)},${JSON.stringify(decision)},new AbortController().signal);
      if(result.status!=='completed')throw new Error(JSON.stringify(result)); db.close();`;
    const originalPrepare = db.prepare.bind(db);
    let scheduled = false;
    // Deterministic scheduling boundary: real second process commits between the
    // parent's pending read and final decision write. No fake filesystem or SQLite.
    db.prepare = (sql: string) => {
      if (!scheduled && sql.startsWith("INSERT INTO chatkit_campaign_proposals")) {
        scheduled = true;
        const child = spawnSync(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", childCode],
          { encoding: "utf8" },
        );
        assert.equal(child.status, 0, child.stderr);
        assert.ok(existsSync(join(root, "w/data/campaign/overview.md")));
      }
      return originalPrepare(sql);
    };
    const result = (await service.browser(
      identity,
      { ...decision, decision: "reject" },
      new AbortController().signal,
    )) as Record<string, unknown>;
    assert.ok(scheduled);
    assert.equal(result["status"], "completed");
    const persisted = (await service.request(
      identity,
      scope,
      "campaign_proposals",
      { proposalId: "p" },
      new AbortController().signal,
    )) as Record<string, unknown>;
    assert.equal(persisted["status"], "completed");
    assert.ok(persisted["receipt"]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

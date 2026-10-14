import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { spawnSync } from "node:child_process";
import type {
  AiDmAuthenticatedIdentity,
  AiDmJsonValue,
  AiDmRunPrincipal,
} from "@foundry-ai-dungeon-master/shared";
import { ChatKitCampaignActions } from "./campaign-actions.js";
import { CampaignStorage } from "../context/campaign-storage.js";
import { WorldCampaignContext } from "../context/world-campaign.js";
import { ChatKitTurns } from "./turns.js";
import { ChatKitReadTools } from "./read-tools.js";
import {
  CHATKIT_READ_TOOL_METADATA,
  FoundryLocalApiProviderAdapter,
  TrustedToolCatalog,
  type FoundryLocalApiMcpClient,
} from "../tool-catalog/index.js";

const identity: AiDmAuthenticatedIdentity = {
  clientId: "client",
  worldId: "w",
  userId: "gm",
  lane: "gm",
  isGm: true,
};
const scope = { worldId: "w", userId: "gm", threadId: "thread" };
const signal = () => new AbortController().signal;
function object(value: AiDmJsonValue): Record<string, AiDmJsonValue> {
  return value as Record<string, AiDmJsonValue>;
}
function text(id: string, rev: string, body: string) {
  return `---\nschema_version: 1\nid: ${id}\nrevision: ${rev}\nvisibility: gm\ncanon_status: canon\n---\n${body}\n`;
}
function input(proposalId = "setup") {
  return {
    proposalId,
    title: "Starting campaign",
    files: [
      {
        path: "overview.md",
        expectedRevision: null,
        proposedText: text("overview", "1", "The hero arrives in a rainy village."),
      },
      {
        path: "index.md",
        expectedRevision: null,
        proposedText: text("index", "1", "[Village](locations/village.md)"),
      },
      {
        path: "locations/village.md",
        expectedRevision: null,
        proposedText: text("village", "1", "# GM-ONLY\nThe village hides an old shrine."),
      },
    ],
  };
}
function fixture(privateStorage = true) {
  const root = mkdtempSync(join(tmpdir(), "campaign-actions-"));
  mkdirSync(join(root, "w"));
  mkdirSync(join(root, "other"));
  const db = new DatabaseSync(join(root, "proposals.sqlite"));
  let revoked = false;
  const authorize = async () => {
    await Promise.resolve();
    if (revoked) throw new Error("Revoked");
  };
  const options = {
    worldsRoot: root,
    ...(privateStorage ? { assertPrivateStorage: () => {} } : {}),
  };
  const service = new ChatKitCampaignActions(db, authorize, options);
  return {
    root,
    db,
    service,
    authorize,
    options,
    revoke: () => {
      revoked = true;
    },
    clean: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function decision(
  service: ChatKitCampaignActions,
  proposal: Record<string, AiDmJsonValue>,
  choice = "approve",
) {
  return service.browser(
    identity,
    {
      kind: "campaign",
      threadId: "thread",
      proposalId: proposal["proposalId"],
      batchDigest: proposal["batchDigest"],
      decision: choice,
    },
    signal(),
  );
}

void test("scripted setup → exact approval → persisted canon → prep → refreshed recall (real filesystem/SQLite, no model)", async () => {
  const f = fixture();
  try {
    const proposed = object(
      await f.service.request(identity, scope, "campaign_propose", input(), signal()),
    );
    assert.equal(proposed["status"], "pending");
    assert.equal(proposed["reviewAvailable"], true);
    assert.equal(
      object(
        await f.service.request(
          identity,
          scope,
          "campaign_read",
          { path: "overview.md" },
          signal(),
        ),
      )["status"],
      "missing",
    );
    const campaign = join(f.root, "w/data/campaign");
    const drafts = readdirSync(join(campaign, "drafts"));
    assert.match(
      readFileSync(join(campaign, "drafts", drafts[0]!, "0.md"), "utf8"),
      /canon_status: draft/,
    );
    await assert.rejects(
      f.service.request(identity, scope, "campaign_approve", { proposalId: "setup" }, signal()),
      /denied/,
    );
    await assert.rejects(
      f.service.request(
        identity,
        scope,
        "campaign_propose",
        { ...input(), approved: true },
        signal(),
      ),
    );
    const completed = object(await decision(f.service, proposed));
    assert.equal(completed["status"], "completed");
    assert.equal(object(completed["receipt"]!)["outcome"], "completed");
    assert.deepEqual(object(await decision(f.service, proposed))["receipt"], completed["receipt"]);
    const context = new WorldCampaignContext(f.root);
    const principal = {
      ...identity,
      connectionId: "c",
      role: 4,
      authorizedAudienceKinds: ["gm"],
      permissionSnapshotRevision: "r",
    } as AiDmRunPrincipal;
    assert.match(object(context.overview(principal))["text"] as string, /rainy village/);
    const prep = input("prep");
    for (const file of prep.files) {
      const read = object(
        await f.service.request(identity, scope, "campaign_read", { path: file.path }, signal()),
      );
      file.expectedRevision = read["revision"] as never;
      file.proposedText = file.proposedText
        .replace("revision: 1", "revision: 2")
        .replace("rainy village", "sunlit village");
    }
    const next = object(
      await f.service.request(identity, scope, "campaign_propose", prep, signal()),
    );
    await decision(f.service, next);
    assert.match(object(context.overview(principal))["text"] as string, /sunlit village/);
    const restarted = new ChatKitCampaignActions(f.db, f.authorize, f.options);
    assert.equal(
      object(
        await restarted.request(
          identity,
          scope,
          "campaign_proposals",
          { proposalId: "prep" },
          signal(),
        ),
      )["status"],
      "completed",
    );
  } finally {
    f.clean();
  }
});
void test("digest, stale revisions, reject/cancel, metadata and cross-scope policies", async () => {
  const f = fixture();
  try {
    const proposal = object(
      await f.service.request(identity, scope, "campaign_propose", input(), signal()),
    );
    await assert.rejects(
      f.service.browser(
        identity,
        {
          kind: "campaign",
          threadId: "thread",
          proposalId: "setup",
          batchDigest: "a".repeat(64),
          decision: "approve",
        },
        signal(),
      ),
      /digest/,
    );
    await assert.rejects(
      f.service.request(
        identity,
        { ...scope, worldId: "other" },
        "campaign_proposals",
        {},
        signal(),
      ),
      /scope/,
    );
    await assert.rejects(
      f.service.browser(
        { ...identity, userId: "other" },
        { kind: "campaign", threadId: "thread", proposalId: "setup" },
        signal(),
      ),
      /unavailable/,
    );
    await assert.rejects(
      f.service.browser(
        identity,
        { kind: "campaign", threadId: "elsewhere", proposalId: "setup" },
        signal(),
      ),
      /unavailable/,
    );
    await assert.rejects(
      f.service.request(
        identity,
        scope,
        "campaign_propose",
        { ...input(), title: "conflict" },
        signal(),
      ),
      /conflict/,
    );
    writeFileSync(
      join(f.root, "w/data/campaign/overview.md"),
      text("overview", "external", "Changed outside"),
    );
    assert.equal(object(await decision(f.service, proposal))["status"], "stale");
    const rejected = input("rejected");
    rejected.files[0]!.expectedRevision = object(
      await f.service.request(identity, scope, "campaign_read", { path: "overview.md" }, signal()),
    )["revision"] as never;
    rejected.files[0]!.proposedText = rejected.files[0]!.proposedText.replace(
      "revision: 1",
      "revision: 3",
    );
    const reject = object(
      await f.service.request(identity, scope, "campaign_propose", rejected, signal()),
    );
    assert.equal(object(await decision(f.service, reject, "reject"))["status"], "rejected");
    assert.equal(object(await decision(f.service, reject))["status"], "rejected");
    const cancel = object(
      await f.service.request(
        identity,
        scope,
        "campaign_propose",
        { ...rejected, proposalId: "cancel" },
        signal(),
      ),
    );
    assert.equal(object(await decision(f.service, cancel, "cancel"))["status"], "cancelled");
    const inconsistent = {
      ...rejected,
      proposalId: "bad",
      files: rejected.files.map((file) => ({
        ...file,
        proposedText:
          file.path === "index.md"
            ? text("index", "1", "[Missing](npcs/missing.md)")
            : file.proposedText,
      })),
    };
    await assert.rejects(
      f.service.request(identity, scope, "campaign_propose", inconsistent, signal()),
      /reference/,
    );
    f.revoke();
    await assert.rejects(
      f.service.request(identity, scope, "campaign_read", { path: "overview.md" }, signal()),
      /Revoked/,
    );
  } finally {
    f.clean();
  }
});
void test("privacy denial and cancelled run cannot persist drafts/canon", async () => {
  const f = fixture(false);
  try {
    const result = object(
      await f.service.request(identity, scope, "campaign_propose", input(), signal()),
    );
    assert.equal(result["status"], "storage_unavailable");
    assert.deepEqual(readdirSync(join(f.root, "w")), []);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      f.service.request(identity, scope, "campaign_propose", input(), abort.signal),
    );
  } finally {
    f.clean();
  }
});

void test("expired proposals, revoked approval and interrupted draft checkpoint remain safe", async () => {
  const f = fixture();
  try {
    const proposal = object(
      await f.service.request(identity, scope, "campaign_propose", input(), signal()),
    );
    const row = f.db.prepare("SELECT scope_key,entry_json FROM chatkit_campaign_proposals").get()!;
    const entry = JSON.parse(String(row["entry_json"])) as Record<string, unknown>;
    entry["status"] = "drafting";
    f.db
      .prepare("UPDATE chatkit_campaign_proposals SET entry_json=? WHERE scope_key=?")
      .run(JSON.stringify(entry), String(row["scope_key"]));
    const restart = new ChatKitCampaignActions(f.db, f.authorize, f.options);
    assert.equal(
      object(
        await restart.request(
          identity,
          scope,
          "campaign_proposals",
          { proposalId: "setup" },
          signal(),
        ),
      )["status"],
      "pending",
    );
    const expired = new ChatKitCampaignActions(f.db, f.authorize, {
      ...f.options,
      now: () => Date.now() + 86_400_001,
    });
    assert.equal(object(await decision(expired, proposal))["status"], "stale");
    f.revoke();
    await assert.rejects(decision(f.service, proposal), /Revoked/);
    assert.equal(
      object(
        await new ChatKitCampaignActions(f.db, () => Promise.resolve(), f.options).request(
          identity,
          scope,
          "campaign_read",
          { path: "overview.md" },
          signal(),
        ),
      )["status"],
      "missing",
    );
  } finally {
    f.clean();
  }
});

void test("overview and indexed retrieval withhold context during interrupted writes", async () => {
  const f = fixture();
  try {
    const proposal = object(
      await f.service.request(identity, scope, "campaign_propose", input(), signal()),
    );
    await decision(f.service, proposal);
    const context = new WorldCampaignContext(f.root);
    const principal = {
      ...identity,
      connectionId: "c",
      role: 4,
      authorizedAudienceKinds: ["gm"],
      permissionSnapshotRevision: "r",
    } as AiDmRunPrincipal;
    writeFileSync(join(f.root, "w/data/campaign/.transaction.json"), "{}");
    assert.equal(object(context.overview(principal))["status"], "unavailable");
    assert.equal(object(context.retrieve(principal, "village", null))["status"], "unavailable");
  } finally {
    f.clean();
  }
});
void test("restart reconciles durable filesystem receipt after missing SQLite completion checkpoint", async () => {
  const f = fixture();
  try {
    const pending = object(
      await f.service.request(identity, scope, "campaign_propose", input(), signal()),
    );
    await decision(f.service, pending);
    const row = f.db.prepare("SELECT scope_key,entry_json FROM chatkit_campaign_proposals").get()!;
    const entry = JSON.parse(String(row["entry_json"])) as Record<string, unknown>;
    entry["status"] = "dispatching";
    entry["receipt"] = null;
    f.db
      .prepare("UPDATE chatkit_campaign_proposals SET entry_json=? WHERE scope_key=?")
      .run(JSON.stringify(entry), String(row["scope_key"]));
    const restarted = new ChatKitCampaignActions(f.db, f.authorize, f.options);
    const reconciled = object(
      await restarted.request(
        identity,
        scope,
        "campaign_proposals",
        { proposalId: "setup" },
        signal(),
      ),
    );
    assert.equal(reconciled["status"], "completed");
    assert.equal(object(reconciled["receipt"]!)["outcome"], "completed");
    assert.equal(
      readdirSync(join(f.root, "w/data/campaign")).filter((path) => path.startsWith(".receipt-"))
        .length,
      2,
    );
  } finally {
    f.clean();
  }
});
void test("partial commit is rolled back on authorized inspection and never redispatched", async () => {
  const f = fixture();
  try {
    const pending = object(
      await f.service.request(identity, scope, "campaign_propose", input(), signal()),
    );
    const row = f.db.prepare("SELECT scope_key,entry_json FROM chatkit_campaign_proposals").get()!;
    const entry = JSON.parse(String(row["entry_json"])) as {
      status: string;
      transactionId: string;
      batchDigest: string;
      approval: unknown;
    };
    entry.status = "dispatching";
    entry.approval = { userId: "gm", batchDigest: entry.batchDigest, approvedAt: Date.now() };
    f.db
      .prepare("UPDATE chatkit_campaign_proposals SET entry_json=? WHERE scope_key=?")
      .run(JSON.stringify(entry), String(row["scope_key"]));
    let calls = 0;
    const storage = new CampaignStorage(f.root, {
      authorize: () => {
        if (++calls === 5) throw new Error("interrupt");
      },
      assertPrivateStorage: () => {},
    });
    assert.throws(
      () =>
        storage.commit(
          "w",
          input().files.map((file) => ({
            path: file.path,
            expectedRevision: null,
            text: file.proposedText,
          })),
          { transactionId: entry.transactionId, batchDigest: entry.batchDigest },
        ),
      /interrupt/,
    );
    const restarted = new ChatKitCampaignActions(f.db, f.authorize, f.options);
    const result = object(
      await restarted.request(
        identity,
        scope,
        "campaign_proposals",
        { proposalId: "setup" },
        signal(),
      ),
    );
    assert.equal(result["status"], "uncertain");
    assert.equal(result["receipt"], null);
    assert.equal(object(await decision(restarted, pending))["status"], "uncertain");
    assert.equal(
      object(
        await restarted.request(
          identity,
          scope,
          "campaign_read",
          { path: "overview.md" },
          signal(),
        ),
      )["status"],
      "missing",
    );
  } finally {
    f.clean();
  }
});
void test("authenticated adapter exposes campaign wrappers but no model approval", async () => {
  const f = fixture();
  try {
    const client: FoundryLocalApiMcpClient = {
      listTools: () => Promise.resolve([]),
      callTool: () => {
        throw new Error("No game/model calls required");
      },
    };
    const catalog = new TrustedToolCatalog(
      new FoundryLocalApiProviderAdapter({ client, providerVersion: "fixture" }),
      CHATKIT_READ_TOOL_METADATA,
      "fixture",
    );
    const adapter = new ChatKitReadTools(client, f.authorize, catalog, {
      internalSecret: "test",
      campaignActions: f.service,
    });
    const run = adapter.begin(
      identity,
      { type: "threads.add_user_message", params: { thread_id: "thread" } },
      signal(),
    );
    const proposed = object(
      await adapter.execute(run.token, scope, "campaign_propose", input(), signal()),
    );
    assert.equal(proposed["status"], "pending");
    await assert.rejects(
      adapter.execute(
        run.token,
        { ...scope, threadId: "wrong" },
        "campaign_proposals",
        {},
        signal(),
      ),
      /scope/,
    );
    await assert.rejects(
      adapter.execute(run.token, scope, "campaign_approve", {}, signal()),
      /Unsupported/,
    );
    run.release();
    await assert.rejects(
      adapter.execute(run.token, scope, "campaign_read", { path: "overview.md" }, signal()),
      /expired/,
    );
  } finally {
    f.clean();
  }
});
void test("campaign decisions wait for manual turn and cancellation releases their queue position", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const turns = new ChatKitTurns(db);
    const release = await turns.enter(identity, { type: "threads.add_user_message" }, signal());
    let entered = false;
    const abort = new AbortController();
    const queued = turns
      .enterAction(identity, { kind: "campaign", decision: "approve" }, abort.signal)
      .then(() => {
        entered = true;
      });
    abort.abort();
    await assert.rejects(queued);
    assert.equal(entered, false);
    const next = turns.enterAction(identity, { kind: "campaign", decision: "reject" }, signal());
    await Promise.resolve();
    release!();
    (await next)!();
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM chatkit_turns WHERE status='cancelled'").get()!["n"],
      1,
    );
  } finally {
    db.close();
  }
});

void test("a separate process winning rejection prevents parent approval dispatch", async () => {
  const f = fixture();
  try {
    const proposal = object(
      await f.service.request(identity, scope, "campaign_propose", input(), signal()),
    );
    const body = {
      kind: "campaign",
      threadId: "thread",
      proposalId: "setup",
      batchDigest: proposal["batchDigest"],
      decision: "reject",
    };
    const code = `import {DatabaseSync} from 'node:sqlite';import {ChatKitCampaignActions} from ${JSON.stringify(new URL("./campaign-actions.ts", import.meta.url).href)};const db=new DatabaseSync(${JSON.stringify(join(f.root, "proposals.sqlite"))});const service=new ChatKitCampaignActions(db,()=>Promise.resolve(),{worldsRoot:${JSON.stringify(f.root)},assertPrivateStorage:()=>{}});const result=await service.browser(${JSON.stringify(identity)},${JSON.stringify(body)},new AbortController().signal);if(result.status!=='rejected')throw new Error(JSON.stringify(result));db.close();`;
    const prepare = f.db.prepare.bind(f.db);
    let scheduled = false;
    f.db.prepare = (sql: string) => {
      if (!scheduled && sql.startsWith("INSERT INTO chatkit_campaign_proposals")) {
        scheduled = true;
        const child = spawnSync(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", code],
          { encoding: "utf8" },
        );
        assert.equal(child.status, 0, child.stderr);
      }
      return prepare(sql);
    };
    const result = object(await decision(f.service, proposal));
    assert.equal(scheduled, true);
    assert.equal(result["status"], "rejected");
    assert.equal(result["receipt"], null);
    assert.equal(
      object(
        await f.service.request(
          identity,
          scope,
          "campaign_read",
          { path: "overview.md" },
          signal(),
        ),
      )["status"],
      "missing",
    );
  } finally {
    f.clean();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CampaignStorage } from "../context/campaign-storage.js";
import {
  PreparationRecordStore,
  renderRecord,
  parseRecord,
  validateRecords,
  type CampaignRecord,
} from "./records.js";
import { CampaignRetrieval } from "./retrieval.js";
const hash = "a".repeat(64);
const record = (id: string, visibility: "gm" | "player" = "player"): CampaignRecord => ({
  schemaVersion: 1,
  id,
  worldId: "fixture",
  kind: "place",
  title: id,
  aliases: ["Gate"],
  revision: 1,
  visibility,
  status: "confirmed",
  epistemic: "established",
  sources: [{ uri: "campaign://fixture/source.md", hash, startLine: 1, endLine: 2 }],
  relationships: [],
  sections: [{ heading: "Entry", text: "A sealed gate. Its lock opens only at dawn." }],
  unknowns: [],
  contradictions: [],
  generated: false,
});
test("record envelope and world/provenance validation", () => {
  const r = record("gate");
  assert.deepEqual(parseRecord(renderRecord(r)), r);
  assert.match(
    parseRecord(renderRecord(r).replace("A sealed gate.", "changed")).sections[0]!.text,
    /changed/,
  );
  assert.throws(() => validateRecords("other", [r]));
  assert.throws(() => validateRecords("fixture", [{ ...r, sources: [] }]));
});
test("search filters secrets before rank, continuation and related metadata", () => {
  const publicRecord = record("gate");
  publicRecord.relationships = [{ id: "trap", relation: "contains" }];
  const retrieval = new CampaignRetrieval(
    "fixture",
    [publicRecord, record("trap", "gm")],
    () => {},
  );
  const player = { worldId: "fixture", audience: "player" } as const;
  assert.equal(retrieval.search(player, "Gate").hits.length, 1);
  assert.deepEqual(retrieval.related(player, "gate"), []);
  assert.equal(retrieval.read(player, "trap"), null);
  assert.equal(retrieval.read(player, "gate")?.sections.length, 1);
  assert.throws(() => retrieval.search({ ...player, worldId: "other" }, "Gate"));
  assert.equal(retrieval.search(player, "unsupported").hits.length, 0);
  assert.throws(() => retrieval.search(player, "Gate", { limit: 11 }));
});
test("private candidate publication, source drift, CAS and rollback preserve originals", () => {
  const root = mkdtempSync(join(tmpdir(), "preparation-records-"));
  mkdirSync(join(root, "fixture", "data", "campaign"), { recursive: true });
  let approved = false;
  let source = hash;
  const storage = new CampaignStorage(root, {
    authorize: (w) => {
      assert.equal(w, "fixture");
    },
    assertPrivateStorage: () => {},
  });
  const store = new PreparationRecordStore(
    storage,
    () => {
      if (!approved) throw Error("Review required");
    },
    (_world, uri) =>
      uri === "campaign://fixture/source.md"
        ? source
        : (storage.read("fixture", uri.split("/").pop()!)?.revision ?? null),
  );
  try {
    const first = {
      schemaVersion: 1 as const,
      worldId: "fixture",
      candidateId: "first",
      records: [
        record("gate"),
        { ...record("overview"), kind: "overview" as const },
        { ...record("index"), kind: "index" as const },
      ],
      manifest: { "campaign://fixture/source.md": hash },
      baseRevision: null,
    };
    store.stage(first);
    store.stage(first); // exact retry uses durable receipt
    assert.throws(() => store.publish("fixture", "first"));
    approved = true;
    source = "b".repeat(64);
    assert.throws(() => store.publish("fixture", "first"));
    source = hash;
    store.publish("fixture", "first");
    const before = store.active("fixture")!;
    store.stage({
      ...first,
      candidateId: "second",
      baseRevision: before.revision,
      manifest: {
        ...first.manifest,
        "campaign://fixture/overview.md": storage.read("fixture", "overview.md")!.revision,
        "campaign://fixture/index.md": storage.read("fixture", "index.md")!.revision,
      },
      records: [
        { ...record("gate"), revision: 2 },
        { ...record("overview"), kind: "overview" as const },
        { ...record("index"), kind: "index" as const },
      ],
    });
    store.publish("fixture", "second");
    const after = store.active("fixture")!;
    store.rollback("fixture", before.revision, after.revision);
    assert.equal(store.active("fixture")?.revision, before.revision);
    assert.throws(() => store.publish("fixture", "second"));
    const editablePath = `preparation/versions/first/${hashText("gate")}.md`;
    const editable = storage.read("fixture", editablePath)!;
    storage.commit("fixture", [
      {
        path: editablePath,
        expectedRevision: editable.revision,
        text: editable.text.replace("A sealed gate.", "A manually corrected gate."),
      },
    ]);
    assert.throws(() => store.active("fixture"), /Editable record revision conflict/);
    assert.match(storage.read("fixture", editablePath)!.text, /manually corrected/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
import { sourceDerivedDrafts } from "./source-drafts.js";
import { hashText } from "../context/hash.js";
import { writeFileSync } from "node:fs";
import { WorldCampaignContext } from "../context/world-campaign.js";
import type { AiDmRunPrincipal } from "@foundry-ai-dungeon-master/shared";
test("source draft copies whole qualified subsection and rejects stale/cross-world content", () => {
  const text =
    "# Title\n\n## Condition\nOnly when dawn arrives,\nthe gate opens.\n### Qualification\nThe west exit remains closed.\n## Next\nOther fact.";
  const source = {
    rootId: "fixture",
    relativePath: "entry.md",
    sourceUri: "campaign://fixture/entry.md",
    sourceHash: hashText(text),
    text,
  };
  const candidate = sourceDerivedDrafts("fixture", "review", [source]);
  const excerpt = candidate.records[0]!.sections[0]!.text;
  assert.match(excerpt, /Only when dawn arrives,\nthe gate opens/);
  assert.match(excerpt, /west exit remains closed/);
  assert.doesNotMatch(excerpt, /Other fact/);
  assert.equal(candidate.records[0]!.status, "draft");
  assert.throws(() => sourceDerivedDrafts("other", "review", [source]));
  assert.throws(() => sourceDerivedDrafts("fixture", "review", [{ ...source, text: "changed" }]));
  assert.throws(() =>
    sourceDerivedDrafts("fixture", "review", [
      {
        ...source,
        text: "# Title\n" + "x".repeat(4100),
        sourceHash: hashText("# Title\n" + "x".repeat(4100)),
      },
    ]),
  );
});
test("metadata and Unicode payloads remain bounded without slicing trap conditions", () => {
  const r = record("gate");
  r.sections = [
    { heading: "Condition", text: "When crossed: " + "龍".repeat(3000) + " consequence" },
  ];
  const retrieval = new CampaignRetrieval("fixture", [r], () => {});
  const caller = { worldId: "fixture", audience: "player" } as const;
  const small = retrieval.search(caller, "gate", { maxCharacters: 512 });
  assert.equal(small.hits.length, 0);
  assert.equal(small.oversizedSections, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(small)) <= 512);
  const large = retrieval.search(caller, "gate", { maxCharacters: 12000 });
  assert.equal(large.hits[0]?.excerpt, r.sections[0]!.text);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) <= 12000);
  assert.equal(retrieval.read(caller, "gate", { maxCharacters: 512 })?.oversizedSection, true);
});
test("legacy private validation paths counts and index ranking are withheld from player", () => {
  const root = mkdtempSync(join(tmpdir(), "preparation-records-"));
  const campaign = join(root, "fixture", "data", "campaign");
  mkdirSync(campaign, { recursive: true });
  const principal: AiDmRunPrincipal = {
    clientId: "player",
    lane: "player",
    userId: "player",
    worldId: "fixture",
    isGm: false,
    role: 1,
    connectionId: "c",
    authorizedAudienceKinds: ["table"],
    permissionSnapshotRevision: "r",
  };
  try {
    writeFileSync(
      join(campaign, "index.md"),
      "---\nvisibility: gm\n---\n# Private\n## GM-ONLY\n[gate](secret-target.md)\n",
    );
    writeFileSync(
      join(campaign, "private.md"),
      "---\nvisibility: gm\n---\n# Secret name\n## GM-ONLY\nHidden trap.",
    );
    const result = new WorldCampaignContext(root).retrieve(principal, "gate", null) as Record<
      string,
      unknown
    >;
    assert.deepEqual(result.sourceIssues, []);
    const utility = result.utility as {
      result: { indexedDocuments: number; invalidSources: string[]; partial: boolean };
    };
    assert.equal(utility.result.indexedDocuments, 0);
    assert.deepEqual(utility.result.invalidSources, []);
    assert.equal(utility.result.partial, false);
    assert.doesNotMatch(JSON.stringify(result), /secret-target|Hidden trap|Secret name/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("whole-word and conjunctive queries keep unsupported questions unknown", () => {
  const r = record("relationship");
  r.title = "Quest relationship";
  r.aliases = ["Guard of Dawn"];
  r.sections = [{ heading: "Motivation", text: "The guard protects gates and seeks peace. 龍 城" }];
  const retrieval = new CampaignRetrieval("fixture", [r], () => {});
  const caller = { worldId: "fixture", audience: "gm" } as const;
  for (const query of [
    "ghost ship",
    "ship",
    "ghost guard",
    "what is the ghost ship?",
    "the relationship ghost",
  ])
    assert.equal(retrieval.search(caller, query).hits.length, 0, query);
  assert.equal(retrieval.search(caller, "Guard of Dawn").hits.length, 1);
  assert.equal(retrieval.search(caller, "What is the guard motivation?").hits.length, 1);
  assert.equal(retrieval.search(caller, "guard gates").hits.length, 1);
  assert.equal(retrieval.search(caller, "guard gate").hits.length, 1);
  assert.equal(retrieval.search(caller, "龍 城").hits.length, 1);
  assert.equal(retrieval.search(caller, "龍 港").hits.length, 0);
});

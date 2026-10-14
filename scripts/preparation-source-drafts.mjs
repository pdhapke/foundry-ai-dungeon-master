import { mkdirSync, writeFileSync, lstatSync, realpathSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPrivateChatkitPath } from "../server/dist/config.js";
import { assertProtectedCampaignRoot } from "../server/dist/context/protected-campaign.js";
import { worldCampaignRoot } from "../server/dist/context/world-campaign.js";
import { CampaignSourceRepository } from "../server/dist/context/campaign-source.js";
import { sourceDerivedDrafts, sourceRecordDraftPackets, prepareSourceRecords } from "../server/src/preparation/source-drafts.ts";
import { renderRecord } from "../server/dist/preparation/records.js";
const args = process.argv.slice(2);
const value = (key) => args.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3);
const world = value("world"),
  candidate = value("candidate");
const paths = args.filter((a) => a.startsWith("--source=")).map((a) => a.slice(9));
const fullInventory = args.includes("--inventory-approved-campaign");
if (
  !world ||
  !candidate ||
  !/^[A-Za-z0-9_-]{1,128}$/.test(world) ||
  !/^[A-Za-z0-9_-]{1,128}$/.test(candidate) ||
  (!paths.length && !fullInventory) ||
  (paths.length && fullInventory) ||
  paths.length > 32 ||
  args.some((a) => !/^--(?:world|candidate|source)=/.test(a) && a !== "--inventory-approved-campaign")
)
  throw Error(
    "Run node --import tsx; use --world=<id> --candidate=<id> and 1-32 --source=<approved relative Markdown path>, or --inventory-approved-campaign for the approved private campaign root only.",
  );
const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const worldsRoot = resolve(process.env.AI_DM_WORLDS_ROOT ?? resolve(moduleRoot, "../../worlds"));
const chatkit = resolve(
  process.env.AI_DM_CHATKIT_DATABASE_PATH ??
    resolve(moduleRoot, "../../../../.runtime/foundry-ai-dungeon-master/chatkit.sqlite"),
);
const protectedRoot = resolve(
  process.env.AI_DM_CAMPAIGN_PROTECTED_ROOT ?? resolve(dirname(chatkit), "campaign-worlds"),
);
assertProtectedCampaignRoot({ protectedRoot, publicDataRoot: dirname(worldsRoot) });
const campaign = worldCampaignRoot(protectedRoot, world);
const repo = new CampaignSourceRepository([{ rootId: world, path: campaign }]);
const excluded = [], failures = [];
if (fullInventory) {
  const walk = (dir, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const rel = prefix + entry.name;
      if (entry.isSymbolicLink()) { excluded.push({ path: rel, reason: "redirect-not-followed" }); continue; }
      if (entry.isDirectory()) {
        if (["preparation", "node_modules", ".git", "__pycache__"].includes(entry.name)) { excluded.push({ path: rel, reason: "runtime-or-derived-directory" }); continue; }
        walk(join(dir, entry.name), rel + "/");
      } else if (entry.isFile() && /\.md$/i.test(rel)) paths.push(rel);
      else excluded.push({ path: rel, reason: "unsupported-source-format-not-executed" });
      if (paths.length + excluded.length > 512) throw Error("Inventory entry budget exceeded");
    }
  };
  walk(campaign);
}
const sources = [];
for (const path of paths) {
  try {
    const source = repo.load(world, path);
    if (fullInventory) {
      try { prepareSourceRecords(world, [source]); }
      catch (error) { excluded.push({ path, uri: source.sourceUri, hash: source.sourceHash, reason: "needs-bounded-review", detail: error.message }); continue; }
    }
    sources.push(source);
  }
  catch { failures.push({ path, reason: "unreadable-or-disallowed-source" }); }
}
if (failures.length) throw Error("Source admission failures; refusing an incomplete source packet");
const prepared = fullInventory ? sourceRecordDraftPackets(world, candidate, sources) : null;
const result = prepared ?? sourceDerivedDrafts(world, candidate, sources);
const outputBase = assertPrivateChatkitPath(join(dirname(protectedRoot), "preparation-drafts"), [
  resolve(moduleRoot, "../.."),
  dirname(worldsRoot),
]);
let output = outputBase;
for (const path of [outputBase, join(outputBase, world), join(outputBase, world, candidate)]) {
  if (!existsSync(path)) mkdirSync(path);
  if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== resolve(path))
    throw Error("Private draft directory redirect rejected");
  output = path;
}
writeFileSync(join(output, "candidate.json"), JSON.stringify(result, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
});
if (prepared) {
  writeFileSync(join(output, "inventory.json"), JSON.stringify({ entries: prepared.inventory, excluded, failures, sourceBytes: prepared.bytes }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  for (const packet of prepared.packets) {
    const packetDir = join(output, packet.candidateId);
    mkdirSync(packetDir);
    writeFileSync(join(packetDir, "candidate.json"), JSON.stringify(packet, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    for (const r of packet.records) writeFileSync(join(packetDir, `${r.id}.md`), renderRecord(r), { flag: "wx", mode: 0o600 });
  }
} else for (const r of result.records)
  writeFileSync(join(output, `${r.kind}-draft.md`), renderRecord(r), { flag: "wx", mode: 0o600 });
console.log(
  JSON.stringify({
    status: "private-review-drafts-only",
    worldId: world,
    candidateId: candidate,
    sources: paths.length,
    output,
    inferenceCalls: 0,
    canonicalWrites: 0,
    packets: prepared?.packets.length ?? 1,
    excluded: excluded.length,
  }),
);

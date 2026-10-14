import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
export interface LocalAssetApproval { worldId: string; sourcePath: string; sourceHash: string; license: string; playerVisibleApproved: true }
/** Raster-only import from explicit trusted approval. Public artwork must contain no GM secrets. */
export function importApprovedLocalMapAsset(input: LocalAssetApproval, config: {
  worldId: string; approvedSourceRoot: string; publicAssetRoot: string; publicUrlPrefix: string;
  authorize(approval: LocalAssetApproval): void;
}) {
  config.authorize(input);
  if (input.worldId !== config.worldId || input.playerVisibleApproved !== true || !input.license.trim()) throw new Error("Asset import approval unavailable.");
  if (lstatSync(config.approvedSourceRoot).isSymbolicLink()) throw new Error("Asset source root symlink forbidden.");
  const root = realpathSync(config.approvedSourceRoot), source = resolve(input.sourcePath);
  if(root!==resolve(config.approvedSourceRoot))throw new Error('Asset source root redirect forbidden.');
  const inside = relative(root, source);
  if (!inside || inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) throw new Error("Asset outside approved source scope.");
  const parts = inside.split(sep); let checked = root;
  for (const part of parts) { checked = join(checked, part); if (lstatSync(checked).isSymbolicLink()) throw new Error("Asset symlink forbidden."); }
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("Asset import size/type invalid.");
  const bytes = readFileSync(source), digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== input.sourceHash) throw new Error("Asset source changed since review.");
  const extension = extname(source).toLowerCase();
  const valid = extension === ".png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : [".jpg", ".jpeg"].includes(extension) ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : extension === ".webp" && bytes.subarray(0,4).toString() === "RIFF" && bytes.subarray(8,12).toString() === "WEBP";
  if (!valid) throw new Error("Only verified raster map assets may be imported.");
  // Root must be supplied by trusted configuration, never the model's request.
  if (!existsSync(config.publicAssetRoot) || lstatSync(config.publicAssetRoot).isSymbolicLink()) throw new Error("Asset destination unavailable.");
  const destinationRoot = realpathSync(config.publicAssetRoot);
  if(destinationRoot!==resolve(config.publicAssetRoot))throw new Error('Asset destination root redirect forbidden.');
  const target = join(destinationRoot, `${digest}${extension}`);
  config.authorize(input);
  const reused = existsSync(target);
  if (reused && (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink())) throw new Error("Unsafe asset destination.");
  if (!reused) writeFileSync(target, bytes, { flag: "wx" });
  if (createHash("sha256").update(readFileSync(target)).digest("hex") !== digest) throw new Error("Asset destination hash mismatch.");
  config.authorize(input);
  return { assetRef: `${config.publicUrlPrefix.replace(/\/$/, "")}/${basename(target)}`, sourceHash: digest, license: input.license, reused, bytes: bytes.length };
}

import { isAbsolute, relative, resolve, sep } from "node:path";
import { lstatSync, realpathSync, statSync } from "node:fs";

export interface ProtectedCampaignOptions {
  protectedRoot: string;
  /** Actual Foundry static Data directory, not merely its worlds subdirectory. */
  publicDataRoot: string;
}
export function assertProtectedCampaignRoot(options: ProtectedCampaignOptions): string {
  if (!isAbsolute(options.protectedRoot) || !isAbsolute(options.publicDataRoot))
    throw new Error("Campaign storage roots must be absolute server-owned paths.");
  const root = realpathSync(options.protectedRoot), publicRoot = realpathSync(options.publicDataRoot);
  const child = relative(publicRoot, root);
  if (child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`)))
    throw new Error("Protected campaign storage cannot be inside public Foundry Data.");
  if (root !== resolve(options.protectedRoot) || lstatSync(options.protectedRoot).isSymbolicLink() || !statSync(root).isDirectory())
    throw new Error("Protected campaign storage redirects or is not a directory.");
  return root;
}

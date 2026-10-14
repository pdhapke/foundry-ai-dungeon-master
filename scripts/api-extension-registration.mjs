import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** AI DM supplies its own extension descriptor. The generic API has no knowledge
 * of this module, its settings, or its lifecycle. No protected files are read. */
export function registerAiDmApiExtension(environment, {
  entry = new URL("../server/dist/dot-extension.js", import.meta.url),
  entryExists = existsSync,
} = {}) {
  if (!entryExists(fileURLToPath(entry))) throw new Error("AI_DM_EXTENSION_BUILD_REQUIRED");
  const previous = environment.FOUNDRY_API_EXTENSIONS;
  let entries;
  try { entries = previous ? JSON.parse(previous) : []; }
  catch { throw new Error("API_EXTENSION_CONFIGURATION_INVALID"); }
  if (!Array.isArray(entries) || entries.some(value => typeof value !== "string"))
    throw new Error("API_EXTENSION_CONFIGURATION_INVALID");
  const url = entry.href;
  environment.FOUNDRY_API_EXTENSIONS = JSON.stringify([...new Set([...entries, url])]);
  return () => {
    if (previous === undefined) delete environment.FOUNDRY_API_EXTENSIONS;
    else environment.FOUNDRY_API_EXTENSIONS = previous;
  };
}

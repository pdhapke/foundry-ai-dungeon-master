export async function resolve(specifier, context, nextResolve) {
  const resolution = await nextResolve(specifier, context);
  if (resolution.url.endsWith("/foundry-local-api/server/events-core.js")) {
    return { ...resolution, url: new URL("./src/mcp-events/index.ts", resolution.url).href };
  }
  return resolution;
}
import { URL } from "node:url";


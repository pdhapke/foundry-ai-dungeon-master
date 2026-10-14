// Read-only operator inspection. Never calls a mutation or loads server config.
import console from "node:console";
import process from "node:process";
import { URL } from "node:url";
const { fetch, AbortSignal } = globalThis;
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { StreamableFoundryLocalApiMcpClient } from "../server/dist/integrations/foundry-local-api-mcp.js";
const require = createRequire(new URL("../server/package.json", import.meta.url));
const { parse } = require("dotenv");
const env = parse(readFileSync(new URL("../../foundry-local-api/server/.env", import.meta.url)));
for (const port of [3939, 3940, 3941]) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json();
    const safe = Object.fromEntries(
      Object.entries(body).filter(([key]) =>
        ["status", "version", "module", "service", "ready"].includes(key),
      ),
    );
    const hex = (value) =>
      typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
    safe.loadedIdentity = {
      buildManifest: hex(body.build?.manifestDigest),
      promptDigest: hex(body.promptDigest),
      codeDigest: hex(body.codeDigest),
      // Missing hashes mean the legacy running service has no identity contract.
    };
    console.log(JSON.stringify({ health: port, httpStatus: response.status, body: safe }));
  } catch {
    console.log(JSON.stringify({ health: port, result: "unavailable" }));
  }
}
if (!env.API_KEY) {
  console.log("existing_api_key_missing");
  process.exit(0);
}
const client = new StreamableFoundryLocalApiMcpClient({
  baseUrl: "http://127.0.0.1:3939",
  apiKey: env.API_KEY,
  clientVersion: "0.1.0",
});
try {
  const tools = await client.listTools();
  writeFileSync(
    new URL("../docs/solo-dm-runtime-tools.json", import.meta.url),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        source: "authenticated loopback MCP tools/list",
        tools: tools.map(({ name, inputSchema, outputSchema, annotations }) => ({
          name,
          inputSchema,
          outputSchema,
          annotations,
        })),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      operation: "tools/list",
      count: tools.length,
      pauseTools: tools
        .filter((t) => /game_paused/.test(t.name))
        .map((t) => ({ name: t.name, inputSchema: t.inputSchema, annotations: t.annotations })),
    }),
  );
  if (tools.some((t) => t.name === "foundry_get_game_paused")) {
    const result = await client.callTool({ name: "foundry_get_game_paused", arguments: {} });
    // The selected state endpoint has no credentials or campaign text.
    console.log(
      JSON.stringify({
        operation: "tools/call",
        name: "foundry_get_game_paused",
        arguments: {},
        result,
      }),
    );
  }
} catch {
  console.log(
    JSON.stringify({
      operation: "mcp_inspection",
      result: "failed; details suppressed to protect credentials",
    }),
  );
} finally {
  await client.close();
}

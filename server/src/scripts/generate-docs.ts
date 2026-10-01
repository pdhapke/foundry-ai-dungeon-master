import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { AI_DM_BOOTSTRAP_TOOLS } from "../runner/bootstrap-tools.js";
import prettier from "prettier";

const root = resolve(import.meta.dirname, "../../..");
const openApi = {
  openapi: "3.1.0",
  info: {
    title: "AI Dungeon Master local HTTP API",
    version: "0.1.0",
    description:
      "Loopback-only health and ChatGPT sign-in callback endpoints. Foundry-authenticated run traffic uses the WebSocket protocol.",
  },
  servers: [{ url: "http://127.0.0.1:3940" }],
  paths: {
    "/health": {
      get: {
        operationId: "health",
        responses: { "200": { description: "Ready" }, "503": { description: "Degraded" } },
      },
    },
    "/auth/callback": {
      get: {
        operationId: "completeChatGptSignIn",
        description: "Completes the local ChatGPT sign-in redirect and returns to Foundry.",
        responses: {
          "200": { description: "ChatGPT sign-in completed" },
          "400": { description: "Sign-in failed or expired" },
        },
      },
    },
  },
};

const tools = [
  "# AI Dungeon Master bootstrap tool protocol",
  "",
  "Generated from `server/src/runner/bootstrap-tools.ts`. Provider tools are discovered from the live trusted catalog and are intentionally not copied into this document.",
  "",
  `Total stable bootstrap tools: ${AI_DM_BOOTSTRAP_TOOLS.length}`,
  "",
  ...AI_DM_BOOTSTRAP_TOOLS.flatMap((tool) => [
    `## \`${tool.name}\``,
    "",
    tool.description,
    "",
    "```json",
    JSON.stringify(tool.inputSchema, null, 2),
    "```",
    "",
  ]),
].join("\n");

const [formattedOpenApi, formattedTools] = await Promise.all([
  prettier.format(`${JSON.stringify(openApi, null, 2)}\n`, { parser: "json" }),
  prettier.format(tools, { parser: "markdown" }),
]);
await Promise.all([
  writeFile(resolve(root, "docs/openapi.json"), formattedOpenApi, "utf8"),
  writeFile(resolve(root, "docs/mcp-tools.md"), formattedTools, "utf8"),
]);
process.stdout.write(
  `Generated 2 HTTP paths and ${AI_DM_BOOTSTRAP_TOOLS.length} bootstrap tool definitions.\n`,
);

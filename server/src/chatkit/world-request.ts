import { createHash } from "node:crypto";

export interface WorldRequestAuthority {
  manualRequest: true;
  requestDigest: string;
}

/** Called only after gateway authentication and live GM authorization.
 * A manual conversation grants the GM's world role to reviewed typed adapters;
 * it never grants a filesystem root, raw MCP call, or destructive approval.
 */
export function explicitWorldRequest(body: unknown): WorldRequestAuthority | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const request = body as Record<string, unknown>;
  if (!["threads.create", "threads.add_user_message"].includes(String(request["type"])))
    return undefined;
  const params = request["params"] as Record<string, unknown> | undefined;
  const input = params?.["input"] as Record<string, unknown> | undefined;
  if (!Array.isArray(input?.["content"])) return undefined;
  const parts = input["content"] as unknown[];
  const text = parts
    .filter((part): part is Record<string, unknown> => !!part && typeof part === "object")
    .filter((part) => part["type"] === "input_text" && typeof part["text"] === "string")
    .map((part) => String(part["text"]))
    .join("\n")
    .trim();
  if (!text || Buffer.byteLength(text) > 32_000) return undefined;
  // Quoted resource text alone is reference material, not a manual operation.
  if (/^(?:"[\s\S]*"|'[\s\S]*'|`[\s\S]*`|>[\s\S]*)$/.test(text)) return undefined;
  return { manualRequest: true, requestDigest: createHash("sha256").update(text).digest("hex") };
}

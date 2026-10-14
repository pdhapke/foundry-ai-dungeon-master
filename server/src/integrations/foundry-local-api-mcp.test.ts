import assert from "node:assert/strict";
import test from "node:test";
import { selectedCapabilityError } from "./foundry-local-api-mcp.js";

void test("typed MCP failures preserve actionable codes without private fields", () => {
  for (const code of ["NOT_CONNECTED", "TIMEOUT", "PERMISSION_DENIED", "INVALID_PAYLOAD"]) {
    const error = selectedCapabilityError({ error: { code, retryable: true, message: "secret coordinates", details: { actorId: "secret" } } }) as Error & {code:string};
    assert.equal(error.code, code);
    assert.equal(JSON.stringify(error).includes("secret"), false);
    assert.equal(error.message.includes("secret"), false);
  }
  assert.equal((selectedCapabilityError({error:{code:"secret-name"}}) as Error & {code:string}).code, "CAPABILITY_UNAVAILABLE");
});

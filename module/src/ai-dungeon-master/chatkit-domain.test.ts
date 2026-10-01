import assert from "node:assert/strict";
import { it } from "node:test";
import { chatKitDomainKey } from "./chatkit-domain.js";

void it("uses the documented development key only for exact loopback hosts", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"])
    assert.equal(chatKitDomainKey("", host), "local-dev");
  for (const host of ["localhost.example.com", "192.168.1.2", "foundry.example.com", ""])
    assert.equal(chatKitDomainKey("", host), "");
  assert.equal(chatKitDomainKey(" registered-key ", "localhost"), "registered-key");
});

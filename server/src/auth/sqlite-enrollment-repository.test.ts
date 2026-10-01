import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openStorageDatabase } from "../storage/database.js";
import { AiDmEnrollmentService } from "./enrollment.js";
import { SqliteAiDmEnrollmentRepository } from "./sqlite-enrollment-repository.js";

void describe("durable AI Dungeon Master enrollment", () => {
  void it("stores only credential hashes and authenticates after service reconstruction", async () => {
    const database = await openStorageDatabase({ path: ":memory:" });
    const repository = new SqliteAiDmEnrollmentRepository(database.connection);
    const options = {
      repository,
      verifier: { verify: () => Promise.resolve({ verified: true as const, isGm: false }) },
      moduleVersion: "0.1.0",
      now: () => new Date("2026-09-29T00:00:00.000Z"),
    };
    const first = new AiDmEnrollmentService(options);
    const enrollment = await first.issue({
      userId: "user-1",
      worldId: "world-1",
      lane: "player",
      expectedClientId: "client-1",
    });
    const redeemed = await first.redeem({
      protocolVersion: 1,
      clientId: "client-1",
      oneTimeCode: enrollment.oneTimeCode,
      claimedUserId: "user-1",
      claimedWorldId: "world-1",
      moduleVersion: "0.1.0",
    });
    const reconstructed = new AiDmEnrollmentService(options);
    assert.equal(
      reconstructed.authenticate({
        sessionCredential: redeemed.sessionCredential,
        clientId: "client-1",
        moduleVersion: "0.1.0",
      }).identity.userId,
      "user-1",
    );
    const stored = database.connection.prepare("SELECT record_json FROM ai_dm_sessions").get() as {
      record_json: string;
    };
    assert.equal(stored.record_json.includes(redeemed.sessionCredential), false);
    assert.equal(stored.record_json.includes(enrollment.oneTimeCode), false);
    database.close();
  });
});

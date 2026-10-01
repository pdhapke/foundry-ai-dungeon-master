import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AiDmEnrollmentError,
  AiDmEnrollmentService,
  InMemoryAiDmEnrollmentRepository,
} from "./enrollment.js";

function service(now = new Date("2026-09-29T00:00:00.000Z")) {
  return new AiDmEnrollmentService({
    repository: new InMemoryAiDmEnrollmentRepository(),
    verifier: {
      verify: ({ userId, lane }) =>
        Promise.resolve({
          verified: true,
          isGm: lane === "gm" && userId === "gm-1",
        }),
    },
    moduleVersion: "0.1.0",
    now: () => now,
  });
}

void describe("AI Dungeon Master enrollment", () => {
  void it("binds one-time enrollment to exact verified world, user, lane, and client", async () => {
    const enrollment = service();
    const issued = await enrollment.issue({
      userId: "player-1",
      worldId: "world-1",
      lane: "player",
      expectedClientId: "client-1",
    });
    const redeemed = await enrollment.redeem({
      protocolVersion: 1,
      clientId: "client-1",
      oneTimeCode: issued.oneTimeCode,
      claimedUserId: "player-1",
      claimedWorldId: "world-1",
      moduleVersion: "0.1.0",
    });
    assert.equal(redeemed.identity.userId, "player-1");
    assert.equal(
      enrollment.authenticate({
        sessionCredential: redeemed.sessionCredential,
        clientId: "client-1",
        moduleVersion: "0.1.0",
      }).identity.lane,
      "player",
    );
    await assert.rejects(
      enrollment.redeem({
        protocolVersion: 1,
        clientId: "client-1",
        oneTimeCode: issued.oneTimeCode,
        claimedUserId: "player-1",
        claimedWorldId: "world-1",
        moduleVersion: "0.1.0",
      }),
      (error: unknown) =>
        error instanceof AiDmEnrollmentError && error.code === "ENROLLMENT_INVALID",
    );
  });

  void it("consumes a mismatched code and never returns a session", async () => {
    const enrollment = service();
    const issued = await enrollment.issue({
      userId: "player-1",
      worldId: "world-1",
      lane: "player",
      expectedClientId: "client-1",
    });
    await assert.rejects(
      enrollment.redeem({
        protocolVersion: 1,
        clientId: "attacker-client",
        oneTimeCode: issued.oneTimeCode,
        claimedUserId: "player-1",
        claimedWorldId: "world-1",
        moduleVersion: "0.1.0",
      }),
      (error: unknown) =>
        error instanceof AiDmEnrollmentError && error.code === "ENROLLMENT_IDENTITY_MISMATCH",
    );
    await assert.rejects(
      enrollment.redeem({
        protocolVersion: 1,
        clientId: "client-1",
        oneTimeCode: issued.oneTimeCode,
        claimedUserId: "player-1",
        claimedWorldId: "world-1",
        moduleVersion: "0.1.0",
      }),
    );
  });
});

import assert from "node:assert/strict";
import { it } from "node:test";

import type { AiDmRun } from "@foundry-ai-dungeon-master/shared";

import type { ContextService } from "../context/index.js";
import type { ToolCatalogRunSession } from "../tool-catalog/index.js";
import { AiDmRunBootstrapExecutor } from "./bootstrap-executor.js";

void it("refuses proposals for tools that were not discovered and loaded in the run", async () => {
  let proposalCalls = 0;
  const executor = new AiDmRunBootstrapExecutor({} as ContextService, {} as ToolCatalogRunSession, {
    create: () => {
      proposalCalls += 1;
      return Promise.reject(new Error("must not be reached"));
    },
  });

  await assert.rejects(
    executor.execute({
      run: { runId: "run-1" } as AiDmRun,
      callId: "call-1",
      name: "state_propose",
      arguments: {
        summary: "Attempt an undiscovered mutation",
        operations: [
          {
            toolId: "foundry_create_token",
            arguments: {},
            expectedRevisions: [],
          },
        ],
      },
    }),
    /not discovered and loaded/,
  );
  assert.equal(proposalCalls, 0);
});

import express, { type Express, type RequestHandler } from "express";
import { z } from "zod";

import type { ChatGptPlanAuth } from "./auth/index.js";
import { chatKitDiagnostics } from "./chatkit/gateway.js";

export function createAiDmApp(options: {
  chatGptAuth?: ChatGptPlanAuth;
  chatkitHandler?: RequestHandler;
  chatkitReadHandler?: RequestHandler;
  callbackPostMessageOrigins?: readonly string[];
  readiness: () =>
    | { ready: boolean; details: Record<string, boolean> }
    | Promise<{ ready: boolean; details: Record<string, boolean> }>;
}): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb", strict: true }));
  if (options.chatkitReadHandler) app.post("/internal/chatkit/read", options.chatkitReadHandler);
  if (options.chatkitHandler) {
    app.options("/chatkit", options.chatkitHandler);
    app.post("/chatkit", options.chatkitHandler);
    app.options("/chatkit/thread", options.chatkitHandler);
    app.post("/chatkit/thread", options.chatkitHandler);
  }
  app.get("/health", async (_request, response) => {
    const readiness = await options.readiness();
    response.status(readiness.ready ? 200 : 503).json({
      status: readiness.ready ? "ready" : "degraded",
      module: "foundry-ai-dungeon-master",
      version: "0.1.0",
      details: readiness.details,
      chatkit: chatKitDiagnostics(),
    });
  });
  app.get("/auth/callback", async (request, response) => {
    response.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    try {
      if (!options.chatGptAuth) throw new Error("ChatGPT sign-in is unavailable.");
      const code = z.string().min(1).parse(request.query["code"]);
      const state = z.string().min(1).parse(request.query["state"]);
      const clientId = z.string().min(1).optional().parse(request.query["client_id"]);
      await options.chatGptAuth.complete(code, state, clientId);
      const targetOrigins = JSON.stringify(options.callbackPostMessageOrigins ?? []);
      response
        .status(200)
        .type("html")
        .send(
          `<!doctype html>
<meta charset="utf-8">
<title>ChatGPT connected</title>
<p>ChatGPT is connected. Returning to Foundry…</p>
<script>
  if (window.opener) {
    for (const targetOrigin of ${targetOrigins}) {
      window.opener.postMessage({ type: "ai-dm.chatgpt.auth-complete" }, targetOrigin);
    }
    window.setTimeout(() => window.close(), 250);
  }
</script>`,
        );
    } catch {
      response
        .status(400)
        .type("html")
        .send(
          "<!doctype html><title>Sign-in failed</title><p>ChatGPT sign-in failed or expired. Return to Foundry and try again.</p>",
        );
    }
  });
  return app;
}

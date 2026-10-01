import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AI_DM_BOOTSTRAP_TOOLS } from "./bootstrap-tools.js";
import { ChatGptPlanResponsesProvider, PreferredResponsesProvider } from "./openai-provider.js";
import {
  AiDmProviderError,
  type AiDmProvider,
  type AiDmProviderRequest,
  type AiDmProviderResponse,
} from "./types.js";

const request: AiDmProviderRequest = {
  runId: "run-1",
  worldId: "world-1",
  model: "configured-model",
  instructions: "test",
  input: {},
  tools: [],
  previousResponseId: null,
  maxOutputTokens: 32,
  signal: new AbortController().signal,
};

const response: AiDmProviderResponse = {
  responseId: "response-1",
  outputs: [],
  usage: { inputTokens: 0, outputTokens: 0 },
};

function apiResponse(status: "in_progress" | "completed" | "failed" | "incomplete") {
  return {
    id: "response-1",
    object: "response",
    created_at: 1,
    status,
    error:
      status === "failed"
        ? { code: "subscription_sharing_usage_limit_exceeded", message: "private" }
        : null,
    incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
    instructions: null,
    max_output_tokens: null,
    model: "eligible-model",
    output:
      status === "completed"
        ? [
            {
              id: "message-1",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "café", annotations: [] }],
            },
          ]
        : [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: null,
    store: false,
    temperature: 1,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage:
      status === "completed"
        ? {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2,
          }
        : null,
  };
}

function sseEvent(
  type: string,
  responseValue: ReturnType<typeof apiResponse>,
  sequence: number,
): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence, response: responseValue })}\n\n`;
}

function streamResponse(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", ...headers } },
  );
}

function encoded(...values: string[]): Uint8Array[] {
  const encoder = new TextEncoder();
  return values.map((value) => encoder.encode(value));
}

function withFetch(providerFetch: typeof fetch, overrides: Partial<AiDmProviderRequest> = {}) {
  return {
    provider: new ChatGptPlanResponsesProvider(
      () => Promise.resolve({ accessToken: "oauth-test-credential", model: "eligible-model" }),
      undefined,
      providerFetch,
    ),
    request: { ...request, tools: [...AI_DM_BOOTSTRAP_TOOLS], ...overrides },
  };
}

async function providerError(operation: Promise<unknown>): Promise<AiDmProviderError> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof AiDmProviderError);
    return error;
  }
  assert.fail("Expected an AiDmProviderError.");
}

function provider(calls: string[], source: string): AiDmProvider {
  return {
    createResponse: () => {
      calls.push(source);
      return Promise.resolve(response);
    },
  };
}

void describe("source-aware Responses provider selection", () => {
  void it("passes the exact server-selected model to the Responses invocation", async () => {
    let observedModel: string | null = null;
    const plan = new ChatGptPlanResponsesProvider(
      (worldId, configuredModel) => {
        assert.equal(worldId, "world-1");
        assert.equal(configuredModel, "configured-model");
        return Promise.resolve({ accessToken: "server-token", model: "gm-selected-model" });
      },
      (body) => {
        assert.ok("model" in body);
        observedModel = body.model;
        return Promise.resolve(response);
      },
    );
    await plan.createResponse(request);
    assert.equal(observedModel, "gm-selected-model");
    assert.notEqual(observedModel, request.model);
  });

  void it("uses ChatGPT only when eligible and API-key fallback only when absent", async () => {
    const calls: string[] = [];
    const plan = provider(calls, "plan");
    const fallback = provider(calls, "fallback");

    await new PreferredResponsesProvider(plan, fallback, () => "eligible").createResponse(request);
    assert.deepEqual(calls, ["plan"]);

    calls.length = 0;
    await new PreferredResponsesProvider(plan, fallback, () => "absent").createResponse(request);
    assert.deepEqual(calls, ["fallback"]);
  });

  void it("fails closed without invoking either provider when ChatGPT is blocked", async () => {
    const calls: string[] = [];
    await assert.rejects(
      new PreferredResponsesProvider(
        provider(calls, "plan"),
        provider(calls, "fallback"),
        () => "blocked",
      ).createResponse(request),
      /not authorized/,
    );
    assert.deepEqual(calls, []);
  });

  void it("sends the bounded SIWC request contract with OAuth and namespaced local tools", async () => {
    type RequestObservation = {
      url: string;
      method: string | undefined;
      headers: Headers;
      body: Record<string, unknown>;
    };
    let observation: RequestObservation | null = null;
    const wire =
      sseEvent("response.created", apiResponse("in_progress"), 0) +
      ": keep-alive\n\n" +
      sseEvent("response.completed", apiResponse("completed"), 1);
    const fixture = withFetch(
      (input, init) => {
        const bodyText = init?.body;
        if (typeof bodyText !== "string")
          throw new Error("Expected a serialized JSON request body.");
        observation = {
          url: input instanceof Request ? input.url : input instanceof URL ? input.href : input,
          method: init?.method,
          headers: new Headers(init?.headers),
          body: JSON.parse(bodyText) as Record<string, unknown>,
        };
        return Promise.resolve(streamResponse(encoded(wire), { "x-request-id": "req-safe-1" }));
      },
      { model: "configured-model" },
    );

    const result = await fixture.provider.createResponse(fixture.request);
    const observed = observation as RequestObservation | null;
    assert.ok(observed);
    assert.equal(observed.url, "https://api.openai.com/v1/responses");
    assert.equal(observed.method, "POST");
    assert.equal(observed.headers.get("authorization"), "Bearer oauth-test-credential");
    assert.equal(observed.headers.get("content-type"), "application/json");
    assert.deepEqual(Object.keys(observed.body).sort(), [
      "input",
      "instructions",
      "model",
      "store",
      "stream",
      "tools",
    ]);
    assert.equal(observed.body["model"], "eligible-model");
    assert.equal(observed.body["store"], false);
    assert.equal(observed.body["stream"], true);
    assert.ok(Array.isArray(observed.body["input"]));
    const sentTools = observed.body["tools"] as Array<Record<string, unknown>>;
    assert.equal(sentTools.length, 1);
    assert.equal(sentTools[0]?.["type"], "namespace");
    assert.equal(sentTools[0]?.["name"], "foundry_ai_dm");
    const namespaced = sentTools[0]?.["tools"] as Array<Record<string, unknown>>;
    assert.equal(namespaced.length, AI_DM_BOOTSTRAP_TOOLS.length);
    assert.equal(namespaced.find(({ name }) => name === "state_propose")?.["strict"], false);
    for (const unsupported of [
      "background",
      "conversation",
      "max_output_tokens",
      "max_tool_calls",
      "metadata",
      "moderation",
      "multi_agent",
      "previous_response_id",
      "prompt",
      "prompt_cache_retention",
      "safety_identifier",
      "temperature",
      "top_logprobs",
      "top_p",
      "truncation",
      "user",
    ]) {
      assert.equal(unsupported in observed.body, false, unsupported);
    }
    assert.equal(result.outputs[0]?.type, "text");
  });

  void it("handles split frames, split UTF-8, comments, and multiple frames per chunk", async () => {
    const wire =
      ": comment\n\n" +
      sseEvent("response.created", apiResponse("in_progress"), 0) +
      sseEvent("response.completed", apiResponse("completed"), 1);
    const bytes = new TextEncoder().encode(wire);
    const marker = new TextEncoder().encode("café");
    let markerIndex = -1;
    for (let index = 0; index <= bytes.length - marker.length; index += 1) {
      if (marker.every((value, offset) => bytes[index + offset] === value)) {
        markerIndex = index;
        break;
      }
    }
    assert.ok(markerIndex > 0);
    const split = markerIndex + marker.length - 1;
    const fixture = withFetch(() =>
      Promise.resolve(
        streamResponse([bytes.slice(0, 7), bytes.slice(7, split), bytes.slice(split)]),
      ),
    );
    const result = await fixture.provider.createResponse(fixture.request);
    assert.deepEqual(result.outputs, [{ type: "text", text: "café" }]);
  });

  void it("parses the SSE body even when an intermediary supplies a non-SSE content type", async () => {
    const wire =
      sseEvent("response.created", apiResponse("in_progress"), 0) +
      sseEvent("response.completed", apiResponse("completed"), 1);
    const fixture = withFetch(() =>
      Promise.resolve(streamResponse(encoded(wire), { "content-type": "application/json" })),
    );

    const result = await fixture.provider.createResponse(fixture.request);
    assert.deepEqual(result.outputs, [{ type: "text", text: "café" }]);
  });

  void it("does not accept a non-SSE JSON body as a completed response", async () => {
    const fixture = withFetch(() =>
      Promise.resolve(Response.json(apiResponse("completed"), { status: 200 })),
    );

    const error = await providerError(fixture.provider.createResponse(fixture.request));
    assert.equal(error.code, "PROVIDER_STREAM_ERROR");
    assert.equal(error.requestAccepted, true);
    assert.equal(error.retryable, false);
  });

  void it("requires response.completed and distinguishes failed, incomplete, error, EOF, and malformed SSE", async () => {
    const created = sseEvent("response.created", apiResponse("in_progress"), 0);
    const cases = [
      {
        wire: created + sseEvent("response.failed", apiResponse("failed"), 1),
        code: "PROVIDER_RESPONSE_FAILED",
        providerCode: "subscription_sharing_usage_limit_exceeded",
      },
      {
        wire: created + sseEvent("response.incomplete", apiResponse("incomplete"), 1),
        code: "PROVIDER_RESPONSE_INCOMPLETE",
        providerCode: "max_output_tokens",
      },
      {
        wire:
          created +
          `event: error\ndata: ${JSON.stringify({ type: "error", code: "safe_code", message: "private", param: "tools[0]", sequence_number: 1 })}\n\n`,
        code: "PROVIDER_STREAM_ERROR",
        providerCode: "safe_code",
      },
      { wire: created, code: "PROVIDER_STREAM_INTERRUPTED", providerCode: undefined },
      {
        wire: `${created}event: broken\ndata: {not-json}\n\n`,
        code: "PROVIDER_STREAM_MALFORMED",
        providerCode: undefined,
      },
    ] as const;
    for (const item of cases) {
      const fixture = withFetch(() => Promise.resolve(streamResponse(encoded(item.wire))));
      const error = await providerError(fixture.provider.createResponse(fixture.request));
      assert.equal(error.code, item.code);
      assert.equal(error.providerCode, item.providerCode);
      assert.equal(error.providerResponseId, "response-1");
      assert.equal(error.requestAccepted, true);
      assert.equal(error.retryable, false);
      assert.doesNotMatch(error.message, /private|oauth-test-credential|not-json/);
    }
  });

  void it("does not retry HTTP or ambiguous transport failures and exposes only safe diagnostics", async () => {
    let httpCalls = 0;
    const httpFixture = withFetch(() => {
      httpCalls += 1;
      return Promise.resolve(
        Response.json(
          {
            error: {
              code: "subscription_sharing_unsupported_capability",
              type: "invalid_request_error",
              param: "tools[0]",
              message: "private body detail",
            },
          },
          { status: 400, headers: { "x-request-id": "req-safe-2" } },
        ),
      );
    });
    const httpError = await providerError(httpFixture.provider.createResponse(httpFixture.request));
    assert.equal(httpCalls, 1);
    assert.equal(httpError.code, "PROVIDER_HTTP_ERROR");
    assert.equal(httpError.httpStatus, 400);
    assert.equal(httpError.providerCode, "subscription_sharing_unsupported_capability");
    assert.equal(httpError.providerParam, "tools[0]");
    assert.equal(httpError.requestId, "req-safe-2");
    assert.equal(httpError.requestAccepted, false);
    assert.doesNotMatch(httpError.message, /private|oauth-test-credential/);

    let unavailableCalls = 0;
    const unavailableFixture = withFetch(() => {
      unavailableCalls += 1;
      return Promise.resolve(Response.json({ error: { code: "server_error" } }, { status: 503 }));
    });
    const unavailableError = await providerError(
      unavailableFixture.provider.createResponse(unavailableFixture.request),
    );
    assert.equal(unavailableCalls, 1);
    assert.equal(unavailableError.httpStatus, 503);
    assert.equal(unavailableError.requestAccepted, true);
    assert.equal(unavailableError.retryable, false);

    let connectionCalls = 0;
    const connectionFixture = withFetch(() => {
      connectionCalls += 1;
      return Promise.reject(new Error("private transport detail"));
    });
    const connectionError = await providerError(
      connectionFixture.provider.createResponse(connectionFixture.request),
    );
    assert.equal(connectionCalls, 1);
    assert.equal(connectionError.requestAccepted, true);
    assert.equal(connectionError.retryable, false);
    assert.doesNotMatch(connectionError.message, /private|oauth-test-credential/);
  });

  void it("invalidates stale readiness and requires reconnect after HTTP 401 or 403", async () => {
    for (const status of [401, 403]) {
      const invalidated: Array<{ worldId: string; authorizationId: string | undefined }> = [];
      let calls = 0;
      const plan = new ChatGptPlanResponsesProvider(
        () =>
          Promise.resolve({
            accessToken: "oauth-test-credential",
            model: "eligible-model",
            authorizationId: "authorization-generation-1",
          }),
        undefined,
        () => {
          calls += 1;
          return Promise.resolve(Response.json({ error: { code: "invalid_token" } }, { status }));
        },
        (worldId, authorizationId) => {
          invalidated.push({ worldId, authorizationId });
          return Promise.resolve();
        },
      );
      const error = await providerError(
        plan.createResponse({ ...request, tools: [...AI_DM_BOOTSTRAP_TOOLS] }),
      );
      assert.equal(calls, 1);
      assert.equal(error.code, "PROVIDER_RECONNECT_REQUIRED");
      assert.equal(error.requestAccepted, false);
      assert.equal(error.retryable, false);
      assert.deepEqual(invalidated, [
        { worldId: "world-1", authorizationId: "authorization-generation-1" },
      ]);
    }
  });

  void it("rejects invalid tools and oversized requests before dispatch", async () => {
    let calls = 0;
    const providerFetch: typeof fetch = () => {
      calls += 1;
      return Promise.reject(new Error("must not dispatch"));
    };
    const fixtures: AiDmProviderRequest[] = [
      {
        ...request,
        tools: [
          {
            name: "duplicate",
            description: "one",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
              additionalProperties: false,
            },
            strict: true,
          },
          {
            name: "duplicate",
            description: "two",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
              additionalProperties: false,
            },
            strict: true,
          },
        ],
      },
      {
        ...request,
        tools: [{ name: "bad.name", description: "bad", inputSchema: {}, strict: false }],
      },
      {
        ...request,
        tools: [
          {
            name: "bad_schema",
            description: "bad",
            inputSchema: {
              type: "object",
              properties: { optional: { type: "string" } },
              required: [],
              additionalProperties: false,
            },
            strict: true,
          },
        ],
      },
      {
        ...request,
        tools: [
          {
            name: "bad_root_schema",
            description: "bad",
            inputSchema: { type: "string" },
            strict: true,
          },
        ],
      },
      { ...request, instructions: "x".repeat(1024 * 1024), tools: [] },
    ];
    for (const invalid of fixtures) {
      const fixture = withFetch(providerFetch, invalid);
      const error = await providerError(fixture.provider.createResponse(fixture.request));
      assert.equal(error.requestAccepted, false);
      assert.equal(error.retryable, false);
    }
    assert.equal(calls, 0);
  });

  void it("classifies pre-dispatch caller abort without invoking OAuth or fetch", async () => {
    let authorized = false;
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const plan = new ChatGptPlanResponsesProvider(
      () => {
        authorized = true;
        return Promise.resolve({ accessToken: "never", model: "never" });
      },
      undefined,
      () => {
        calls += 1;
        return Promise.reject(new Error("never"));
      },
    );
    const error = await providerError(
      plan.createResponse({ ...request, signal: controller.signal }),
    );
    assert.equal(error.code, "PROVIDER_ABORTED");
    assert.equal(error.requestAccepted, false);
    assert.equal(authorized, false);
    assert.equal(calls, 0);
  });
});

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  buildResponseParams,
  CodexLbClient,
  customModelInfo,
  lmStudioModelInfo,
  modelInfo,
  openRouterModelInfo,
  openRouterMessages,
  responseText,
  type ResponseRequest,
} from "../src/model/codex-lb.js";

const request: ResponseRequest = {
  model: "coordinator-model",
  instructions: "test",
  input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }] as ResponseInputItem[],
  tools: [],
  promptCacheKey: "cache-key",
  reasoningEffort: "medium",
  supportsReasoning: true,
  supportsParallelToolCalls: true,
  verbosity: "low",
  fast: true,
  previousResponseId: "resp_previous",
};

test("LM Studio response profile uses stateless replay and omits codex-only fields", () => {
  const withReasoning: ResponseRequest = {
    ...request,
    input: [
      ...request.input,
      { type: "reasoning", id: "rs_native", summary: [], content: [], encrypted_content: "opaque" } as unknown as ResponseInputItem,
    ],
  };
  const params = buildResponseParams("lm-studio", withReasoning);
  assert.equal(params.store, false);
  assert.equal("previous_response_id" in params, false);
  assert.deepEqual(params.text, { format: { type: "text" } });
  assert.equal("include" in params, false);
  assert.equal("prompt_cache_key" in params, false);
  assert.equal("service_tier" in params, false);
  assert.equal(params.input.some((item) => item.type === "reasoning"), false);

  const withoutParallel = buildResponseParams("lm-studio", { ...request, supportsParallelToolCalls: false });
  assert.equal("parallel_tool_calls" in withoutParallel, false);

  const codex = buildResponseParams("codex-lb", withReasoning) as Record<string, unknown>;
  assert.equal(codex.store, false);
  assert.deepEqual(codex.text, { verbosity: "low" });
  assert.equal(codex.prompt_cache_key, "cache-key");
  assert.equal(codex.service_tier, "priority");
  assert.equal((codex.input as ResponseInputItem[]).some((item) => item.type === "reasoning"), true);
});

test("codex-lb converts foreign unanchored replay into a portable transcript", () => {
  const { previousResponseId: _previousResponseId, ...unanchored } = request;
  const params = buildResponseParams("codex-lb", {
    ...unanchored,
    input: [
      {
        id: "msg_compact_foreign",
        type: "message",
        role: "user",
        status: "completed",
        content: [{ type: "input_text", text: "checkpoint context" }],
      },
      {
        id: "reasoning_foreign",
        type: "reasoning",
        status: "completed",
        summary: [{ type: "summary_text", text: "private plan" }],
        content: [],
      },
      {
        id: "msg_foreign",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "assistant result" }],
      },
      {
        id: "msg_refusal_foreign",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "refusal", refusal: "declined detail" }],
      },
      {
        id: "call_00_foreign",
        type: "function_call",
        call_id: "call_foreign",
        name: "lookup",
        arguments: "{}",
        status: "completed",
      },
      { type: "function_call_output", call_id: "call_foreign", output: "tool result" },
      { role: "user", content: "string-form context" },
      {
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "auto" },
          { type: "input_file", file_data: "data:text/plain;base64,QQ==", filename: "context.txt" },
        ],
      },
    ] as unknown as ResponseInputItem[],
  });
  assert.equal(params.input.length, 1);
  const replay = params.input[0] as unknown as Record<string, unknown>;
  assert.equal(replay.role, "user");
  assert.equal("id" in replay, false);
  assert.equal("status" in replay, false);
  assert.match(JSON.stringify(replay), /Portable conversation replay/);
  assert.match(JSON.stringify(replay), /checkpoint context/);
  assert.match(JSON.stringify(replay), /assistant result/);
  assert.match(JSON.stringify(replay), /ASSISTANT TOOL CALL lookup/);
  assert.match(JSON.stringify(replay), /call_foreign/);
  assert.match(JSON.stringify(replay), /TOOL RESULT call_foreign/);
  assert.match(JSON.stringify(replay), /REFUSAL: declined detail/);
  assert.match(JSON.stringify(replay), /string-form context/);
  assert.doesNotMatch(JSON.stringify(replay), /private plan/);
  const replayContent = replay.content as Array<Record<string, unknown>>;
  assert.deepEqual(replayContent.map((part) => part.type), ["input_text", "input_image", "input_file"]);
});

test("codex-lb preserves native unanchored replay items", () => {
  const { previousResponseId: _previousResponseId, ...unanchored } = request;
  const nativeInput = [
    ...request.input,
    {
      id: "msg_compact_native",
      type: "message",
      role: "user",
      status: "completed",
      content: [{ type: "input_text", text: "native compact context" }],
    },
    { type: "compaction", encrypted_content: "native compact payload" },
    { id: "rs_native", type: "reasoning", summary: [], encrypted_content: "opaque" },
    {
      id: "msg_native",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "native result" }],
    },
    { id: "fc_native", type: "function_call", call_id: "call_native", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "call_native", output: "result" },
  ] as unknown as ResponseInputItem[];
  const params = buildResponseParams("codex-lb", { ...unanchored, input: nativeInput });
  assert.deepEqual(params.input, nativeInput);
});

test("codex-lb compaction canonicalizes foreign replay before transport", async (t) => {
  let body: Record<string, unknown> | undefined;
  const server = createServer((req, response) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      body = JSON.parse(raw) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "compact_native",
        object: "response.compaction",
        output: [{ id: "cmp_native", type: "compaction_summary", encrypted_content: "opaque" }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.provider = "codex-lb";
  config.gateway.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  config.gateway.apiKeyEnv = "LOOKING_GLASS_CODEX_PORTABLE_TEST_KEY";
  process.env.LOOKING_GLASS_CODEX_PORTABLE_TEST_KEY = "portable-test-key";
  t.after(() => { delete process.env.LOOKING_GLASS_CODEX_PORTABLE_TEST_KEY; });

  await new CodexLbClient(config).compact({
    model: "coordinator-model",
    instructions: "Keep context",
    input: [{
      id: "msg_compact_foreign",
      type: "message",
      role: "user",
      status: "completed",
      content: [{ type: "input_text", text: "portable checkpoint" }],
    }] as unknown as ResponseInputItem[],
    promptCacheKey: "portable",
    fast: false,
  });
  assert.equal((body?.input as ResponseInputItem[]).length, 1);
  assert.match(JSON.stringify(body?.input), /Portable conversation replay/);
  assert.equal(JSON.stringify(body?.input).includes("msg_compact_foreign"), false);
});

test("custom Responses profile is stateless and omits gateway-specific fields", () => {
  const params = buildResponseParams("custom", {
    ...request,
    input: [
      ...request.input,
      { type: "reasoning", id: "reasoning", summary: [], content: [] } as unknown as ResponseInputItem,
    ],
  });
  assert.equal(params.store, false);
  assert.deepEqual(params.text, { format: { type: "text" } });
  assert.equal("previous_response_id" in params, false);
  assert.equal("prompt_cache_key" in params, false);
  assert.equal("include" in params, false);
  assert.equal("service_tier" in params, false);
  assert.equal(params.input.some((item) => item.type === "reasoning"), false);
});

test("custom model metadata is conservative when the catalog omits capabilities", () => {
  const model = customModelInfo({ id: "custom-model" });
  assert.equal(model.name, "custom-model");
  assert.equal(model.contextWindow, 32_768);
  assert.equal(model.maxOutputTokens, null);
  assert.equal(model.supportsReasoning, false);
  assert.equal(model.supportsImages, false);
  assert.equal(model.supportsParallelToolCalls, false);
  assert.equal(model.supportsFast, false);
});

test("codex-compatible metadata retains minimal and extended effort levels", () => {
  const model = modelInfo({
    id: "reasoning-model",
    metadata: {
      supported_reasoning_levels: ["none", "minimal", "low", "xhigh", "max", "ultra"]
        .map((effort) => ({ effort })),
      default_reasoning_level: "minimal",
    },
  });
  assert.deepEqual(model.reasoningEfforts, ["none", "minimal", "low", "xhigh", "max", "ultra"]);
  assert.equal(model.defaultReasoningEffort, "minimal");

  const disabled = modelInfo({
    id: "non-reasoning-model",
    capabilities: { supports_reasoning: false },
    metadata: {
      supported_reasoning_levels: [{ effort: "high" }],
      default_reasoning_level: "high",
    },
  });
  assert.equal(disabled.supportsReasoning, false);
  assert.deepEqual(disabled.reasoningEfforts, ["none"]);
  assert.equal(disabled.defaultReasoningEffort, "none");

  const mismatchedDefault = modelInfo({
    id: "mismatched-default",
    metadata: {
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
      default_reasoning_level: "xhigh",
    },
  });
  assert.deepEqual(mismatchedDefault.reasoningEfforts, ["low", "high"]);
  assert.equal(mismatchedDefault.defaultReasoningEffort, "low");
});

test("OpenCode Go enriches its sparse catalog with model-specific capabilities", async (t) => {
  const server = createServer((request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/v1/models");
    assert.equal(request.headers.authorization, "Bearer catalog-test-key");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.provider = "opencode-go";
  config.gateway.protocol = "chat";
  config.gateway.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  config.gateway.apiKeyEnv = "LOOKING_GLASS_OPENCODE_CATALOG_TEST_KEY";
  process.env.LOOKING_GLASS_OPENCODE_CATALOG_TEST_KEY = "catalog-test-key";
  t.after(() => { delete process.env.LOOKING_GLASS_OPENCODE_CATALOG_TEST_KEY; });
  const models = await new CodexLbClient(config).models();
  assert.deepEqual(models.map((model) => model.id), ["deepseek-v4-flash"]);
  assert.equal(models[0]?.name, "deepseek-v4-flash");
  assert.equal(models[0]?.contextWindow, 1_000_000);
  assert.equal(models[0]?.maxOutputTokens, 384_000);
  assert.equal(models[0]?.supportsReasoning, true);
  assert.equal(models[0]?.defaultReasoningEffort, "high");
  assert.deepEqual(models[0]?.reasoningEfforts, ["low", "high", "max"]);
});

test("OpenCode Go requires its configured API key when used", async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(500);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.provider = "opencode-go";
  config.gateway.protocol = "chat";
  config.gateway.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  config.gateway.apiKeyEnv = "LOOKING_GLASS_MISSING_OPENCODE_TEST_KEY";
  delete process.env.LOOKING_GLASS_MISSING_OPENCODE_TEST_KEY;
  const client = new CodexLbClient(config);
  await assert.rejects(() => client.models(), /Missing OpenCode Go API key/);
  await assert.rejects(() => client.stream(request), /Missing OpenCode Go API key/);
  await assert.rejects(() => client.compact({
    model: request.model,
    instructions: request.instructions,
    input: request.input,
    promptCacheKey: request.promptCacheKey,
    fast: request.fast,
  }), /Missing OpenCode Go API key/);
  assert.equal(requests, 0);
});

test("OpenCode Go reports metadata-only Chat streams as empty provider responses", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      `data: ${JSON.stringify({ model: "glm-5.2" })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.provider = "opencode-go";
  config.gateway.protocol = "chat";
  config.gateway.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  config.gateway.apiKeyEnv = "LOOKING_GLASS_OPENCODE_EMPTY_TEST_KEY";
  process.env.LOOKING_GLASS_OPENCODE_EMPTY_TEST_KEY = "empty-test-key";
  t.after(() => { delete process.env.LOOKING_GLASS_OPENCODE_EMPTY_TEST_KEY; });

  await assert.rejects(
    () => new CodexLbClient(config).stream({
      ...request,
      model: "glm-5.2",
      reasoningEffort: "max",
      supportsParallelToolCalls: false,
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "empty_response");
      assert.equal((error as { kind?: string }).kind, "protocol");
      assert.equal((error as { retryable?: boolean }).retryable, false);
      assert.match((error as Error).message, /empty completion stream/);
      return true;
    },
  );
});

test("custom Responses profile uses the Responses endpoint", async (t) => {
  let path = "";
  let body: Record<string, unknown> | undefined;
  const server = createServer((req, response) => {
    path = req.url ?? "";
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => {
      body = JSON.parse(text) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_custom", status: "in_progress", model: request.model, output: [] } })}\n\n`,
        `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { id: "msg_custom", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "CUSTOM_RESPONSES_OK", annotations: [], logprobs: [] }] } })}\n\n`,
        `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_custom", status: "completed", model: request.model, output: [] } })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.provider = "custom";
  config.gateway.protocol = "responses";
  config.gateway.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const result = await new CodexLbClient(config).stream(request, {});
  assert.equal(path, "/v1/responses");
  assert.equal(result.output_text, "CUSTOM_RESPONSES_OK");
  assert.equal(body?.store, false);
  assert.equal("previous_response_id" in (body ?? {}), false);
  assert.equal("prompt_cache_key" in (body ?? {}), false);
});

test("LM Studio streams use a long-lived dispatcher without changing codex-lb", async (t) => {
  const requests: Array<RequestInit & { dispatcher?: unknown }> = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit): Promise<Response> => {
    requests.push((init ?? {}) as RequestInit & { dispatcher?: unknown });
    return new Response([
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_dispatcher", status: "in_progress", model: request.model, output: [] } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { id: "msg_dispatcher", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "DISPATCHER_OK", annotations: [], logprobs: [] }] } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_dispatcher", status: "completed", model: request.model, output: [] } })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  });

  const lmConfig = structuredClone(DEFAULT_CONFIG);
  lmConfig.gateway.provider = "lm-studio";
  const lmClient = new CodexLbClient(lmConfig);
  t.after(() => lmClient.close());
  const { previousResponseId: _lmPreviousResponseId, ...unanchoredRequest } = request;
  const lmResult = await lmClient.stream(unanchoredRequest);
  assert.equal(lmResult.output_text, "DISPATCHER_OK");
  assert.ok(requests[0]?.dispatcher);

  const codexClient = new CodexLbClient(structuredClone(DEFAULT_CONFIG));
  t.after(() => codexClient.close());
  const codexResult = await codexClient.stream(unanchoredRequest);
  assert.equal(codexResult.output_text, "DISPATCHER_OK");
  assert.equal(requests[1]?.dispatcher, undefined);
});

test("Responses incomplete events preserve a bounded reason and status", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_incomplete", status: "in_progress", output: [] } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.incomplete", response: { id: "resp_incomplete", incomplete_details: { reason: "max_output_tokens" } } })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.provider = "custom";
  config.gateway.protocol = "responses";
  config.gateway.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  await assert.rejects(() => new CodexLbClient(config).stream(request, {}), (error: unknown) => {
    assert.equal((error as { responseStatus?: string }).responseStatus, "incomplete");
    assert.equal((error as { incompleteReason?: string }).incompleteReason, "max_output_tokens");
    return true;
  });
});

test("custom chat profile uses the Chat Completions path and parses basic SSE", async (t) => {
  let path = "";
  let body: Record<string, unknown> | undefined;
  const server = createServer((req, response) => {
    path = req.url ?? "";
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => {
      body = JSON.parse(text) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        `data: ${JSON.stringify({ id: "chat_custom", choices: [{ delta: { content: "CUSTOM_OK" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.provider = "custom";
  config.gateway.protocol = "chat";
  config.gateway.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const result = await new CodexLbClient(config).stream(request, {});
  assert.equal(path, "/v1/chat/completions");
  assert.equal(result.output_text, "CUSTOM_OK");
  assert.equal("reasoning" in (body ?? {}), false);
  assert.equal("stream_options" in (body ?? {}), false);
});

test("OpenCode Go Chat replays reasoning only when the selected model supports it", () => {
  const priorInput = [
    { type: "reasoning", id: "reasoning_prior", summary: [{ type: "summary_text", text: "prior plan" }], content: [] },
    { type: "function_call", call_id: "call_prior", name: "lookup", arguments: "{}" },
  ] as unknown as ResponseInputItem[];
  const supported = buildResponseParams("opencode-go", {
    ...request,
    model: "deepseek-v4-flash",
    input: priorInput,
    reasoningEffort: "high",
  }) as unknown as Record<string, unknown>;
  assert.equal(supported.reasoning_effort, "high");
  const supportedMessages = supported.messages as Array<Record<string, unknown>>;
  assert.equal(supportedMessages.find((message) => message.role === "assistant")?.reasoning_content, "prior plan");

  const unsupported = buildResponseParams("opencode-go", {
    ...request,
    model: "deepseek-v4-flash",
    input: priorInput,
    reasoningEffort: "high",
    supportsReasoning: false,
  }) as unknown as Record<string, unknown>;
  assert.equal("reasoning_effort" in unsupported, false);
  const unsupportedMessages = unsupported.messages as Array<Record<string, unknown>>;
  assert.equal("reasoning_content" in (unsupportedMessages.find((message) => message.role === "assistant") ?? {}), false);
});

test("OpenCode Go Responses omits controls and prior reasoning when reasoning is unsupported", () => {
  const params = buildResponseParams("opencode-go", {
    ...request,
    model: "gpt-5.6-luna",
    supportsReasoning: false,
    input: [
      ...request.input,
      { type: "reasoning", id: "prior", summary: [], content: [], encrypted_content: "opaque" } as unknown as ResponseInputItem,
    ],
  }) as unknown as Record<string, unknown>;
  assert.equal("reasoning" in params, false);
  assert.equal("include" in params, false);
  assert.equal((params.input as ResponseInputItem[]).some((item) => item.type === "reasoning"), false);
});

test("OpenCode Go Chat models transmit supported reasoning effort and compact without it", async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, response) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      assert.equal(req.url, "/v1/chat/completions");
      if (body.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          `data: ${JSON.stringify({ id: "opencode_chat", model: "deepseek-v4-flash", choices: [{ delta: {
            content: "before",
            reasoning_content: "thinking",
            tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "{}" } }],
          } }] })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "opencode_compact",
        choices: [{ message: { content: "checkpoint" } }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.provider = "opencode-go";
  config.gateway.protocol = "chat";
  config.gateway.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  config.gateway.apiKeyEnv = "LOOKING_GLASS_OPENCODE_STREAM_TEST_KEY";
  process.env.LOOKING_GLASS_OPENCODE_STREAM_TEST_KEY = "stream-test-key";
  t.after(() => { delete process.env.LOOKING_GLASS_OPENCODE_STREAM_TEST_KEY; });
  const client = new CodexLbClient(config);
  const { previousResponseId: _previousResponseId, ...unanchoredRequest } = request;
  const streamed = await client.stream({
    ...unanchoredRequest,
    model: "deepseek-v4-flash",
    reasoningEffort: "high",
  });
  assert.equal(streamed.output_text, "before");
  assert.equal(streamed.output.some((item) => item.type === "reasoning"), true);
  assert.equal(streamed.output.some((item) => item.type === "function_call"), true);
  const streamBody = bodies[0] ?? {};
  assert.equal(streamBody.model, "deepseek-v4-flash");
  assert.equal(streamBody.stream, true);
  assert.equal(streamBody.reasoning_effort, "high");
  assert.equal("reasoning" in streamBody, false);
  assert.equal("stream_options" in streamBody, false);
  assert.equal("transforms" in streamBody, false);

  const compacted = await client.compact({
    model: "deepseek-v4-flash",
    instructions: "Keep context",
    input: [
      ...request.input,
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "result" },
    ] as ResponseInputItem[],
    promptCacheKey: "k",
    fast: false,
  });
  const compactBody = bodies[1] ?? {};
  assert.equal(compactBody.stream, false);
  assert.equal(compactBody.max_tokens, 8_192);
  assert.equal("reasoning" in compactBody, false);
  assert.equal("stream_options" in compactBody, false);
  assert.equal("transforms" in compactBody, false);
  assert.equal((compactBody.messages as Array<Record<string, unknown>>).some((message) => message.role === "tool"), true);
  assert.deepEqual(compacted.usage, { input_tokens: 7, output_tokens: 3, total_tokens: 10 });
});

test("OpenCode Go generates oversized Chat checkpoints in bounded transcript chunks", async (t) => {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, response) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      const part = bodies.length;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: `compact_part_${part}`,
        choices: [{ message: { content: `summary ${part}` } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.provider = "opencode-go";
  config.gateway.protocol = "chat";
  config.gateway.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  config.gateway.apiKeyEnv = "LOOKING_GLASS_OPENCODE_CHUNK_TEST_KEY";
  process.env.LOOKING_GLASS_OPENCODE_CHUNK_TEST_KEY = "chunk-test-key";
  t.after(() => { delete process.env.LOOKING_GLASS_OPENCODE_CHUNK_TEST_KEY; });

  const compacted = await new CodexLbClient(config).compact({
    model: "future-model",
    instructions: "Keep durable context",
    input: [{ role: "user", content: [{ type: "input_text", text: "x".repeat(16_384 * 31 + 1) }] }] as ResponseInputItem[],
    promptCacheKey: "chunk-test",
    fast: false,
  });
  assert.equal(bodies.length, 32);
  let aggregateMaxTokens = 0;
  for (const [index, body] of bodies.entries()) {
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 256);
    assert.ok(typeof body.max_tokens === "number" && body.max_tokens >= 1 && body.max_tokens <= 8_192);
    aggregateMaxTokens += body.max_tokens as number;
    const messages = body.messages as Array<Record<string, unknown>>;
    assert.deepEqual(messages.map((message) => message.role), ["system", "user"]);
    assert.match(String(messages[0]?.content), new RegExp(`part ${index + 1} of 32`));
    assert.ok(String(messages[1]?.content).length < 17_000);
  }
  assert.equal(aggregateMaxTokens, 8_192);
  assert.match(JSON.stringify(compacted.output), /Checkpoint part 1 of 32/);
  assert.match(JSON.stringify(compacted.output), /summary 32/);
  assert.deepEqual(compacted.usage, { input_tokens: 320, output_tokens: 64, total_tokens: 384 });
});

test("OpenCode Go routes GPT 5.6 Luna through Responses with extended effort levels", async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const paths: string[] = [];
  const server = createServer((req, response) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      paths.push(req.url ?? "");
      assert.equal(req.headers.authorization, "Bearer luna-test-key");
      if (body.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_luna", status: "in_progress", model: "gpt-5.6-luna", output: [] } })}\n\n`,
          `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { id: "msg_luna", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "LUNA_OK", annotations: [], logprobs: [] }] } })}\n\n`,
          `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_luna", status: "completed", model: "gpt-5.6-luna", output: [] } })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "resp_luna_compact",
        status: "completed",
        output: [{ id: "msg_luna_compact", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "luna checkpoint" }] }],
        usage: { input_tokens: 9, output_tokens: 2, total_tokens: 11 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.provider = "opencode-go";
  config.gateway.protocol = "chat";
  config.gateway.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  config.gateway.apiKeyEnv = "LOOKING_GLASS_OPENCODE_LUNA_TEST_KEY";
  process.env.LOOKING_GLASS_OPENCODE_LUNA_TEST_KEY = "luna-test-key";
  t.after(() => { delete process.env.LOOKING_GLASS_OPENCODE_LUNA_TEST_KEY; });
  const client = new CodexLbClient(config);
  const streamed = await client.stream({
    ...request,
    model: "gpt-5.6-luna",
    reasoningEffort: "xhigh",
    supportsParallelToolCalls: false,
    input: [
      ...request.input,
      {
        type: "reasoning",
        id: "old_reasoning",
        summary: [{ type: "summary_text", text: "prior thought" }],
        content: [],
        encrypted_content: "opaque-reasoning",
      } as unknown as ResponseInputItem,
    ],
  });
  assert.equal(streamed.output_text, "LUNA_OK");
  assert.equal(paths[0], "/v1/responses");
  assert.deepEqual(bodies[0]?.reasoning, { effort: "xhigh", summary: "auto" });
  assert.equal((bodies[0]?.input as ResponseInputItem[]).some((item) => item.type === "reasoning"), true);
  assert.deepEqual(bodies[0]?.include, ["reasoning.encrypted_content"]);
  assert.equal("previous_response_id" in (bodies[0] ?? {}), false);

  const compacted = await client.compact({
    model: "gpt-5.6-luna",
    instructions: "Keep context",
    input: request.input,
    promptCacheKey: "k",
    fast: false,
  });
  assert.equal(paths[1], "/v1/responses");
  assert.equal("reasoning" in (bodies[1] ?? {}), false);
  assert.equal((compacted.output as Array<Record<string, unknown>>)[0]?.type, "message");
});

test("OpenCode Go routes Qwen through Anthropic Messages with bounded thinking budgets", async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, response) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      assert.equal(req.url, "/v1/messages");
      assert.equal(req.headers["x-api-key"], "messages-test-key");
      assert.equal(req.headers["anthropic-version"], "2023-06-01");
      if (body.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_qwen", model: "qwen3.7-max", usage: { input_tokens: 5 } } })}\n\n`,
          `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking" } })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "qwen-signature" } })}\n\n`,
          `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
          `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text" } })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "QWEN_OK" } })}\n\n`,
          `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
          `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } })}\n\n`,
          `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
        ].join(""));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "msg_qwen_compact",
        content: [{ type: "text", text: "qwen checkpoint" }],
        usage: { input_tokens: 8, output_tokens: 2 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.provider = "opencode-go";
  config.gateway.protocol = "chat";
  config.gateway.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  config.gateway.apiKeyEnv = "LOOKING_GLASS_OPENCODE_MESSAGES_TEST_KEY";
  process.env.LOOKING_GLASS_OPENCODE_MESSAGES_TEST_KEY = "messages-test-key";
  t.after(() => { delete process.env.LOOKING_GLASS_OPENCODE_MESSAGES_TEST_KEY; });
  const client = new CodexLbClient(config);
  const streamed = await client.stream({
    ...request,
    model: "qwen3.7-max",
    reasoningEffort: "high",
    supportsParallelToolCalls: false,
  });
  assert.equal(streamed.output_text, "QWEN_OK");
  assert.deepEqual(bodies[0]?.thinking, { type: "enabled", budget_tokens: 32_768 });
  assert.equal(bodies[0]?.max_tokens, 65_536);

  const compacted = await client.compact({
    model: "qwen3.7-max",
    instructions: "Keep context",
    input: request.input,
    promptCacheKey: "k",
    fast: false,
  });
  assert.equal(bodies[1]?.stream, false);
  assert.equal(bodies[1]?.max_tokens, 8_192);
  assert.equal("thinking" in (bodies[1] ?? {}), false);
  assert.deepEqual(compacted.usage, { input_tokens: 8, output_tokens: 2, total_tokens: 10 });
});

test("LM Studio tool schemas omit long maxLength bounds without changing source tools", () => {
  const parameters = {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", maxLength: 64 },
            prompt: { type: "string", minLength: 1, maxLength: 32_000 },
            boundary: { type: "string", maxLength: 2_000 },
          },
        },
      },
    },
  };
  const tool: ResponseRequest["tools"][number] = {
    type: "function",
    name: "run_agents",
    description: "Run agents",
    parameters,
    strict: true,
  };
  const tools = [tool];
  const before = structuredClone(tools);

  const lmStudio = buildResponseParams("lm-studio", { ...request, tools });
  assert.deepEqual(tools, before);
  const lmStudioParameters = lmStudio.tools[0]?.parameters;
  assert.ok(lmStudioParameters);
  const tasks = (lmStudioParameters.properties as Record<string, Record<string, unknown>>).tasks;
  const items = tasks?.items as Record<string, unknown>;
  const properties = items.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.id?.maxLength, 64);
  const prompt = properties.prompt as Record<string, unknown>;
  assert.equal("maxLength" in prompt, false);
  assert.equal("maxLength" in properties.boundary!, false);

  const codex = buildResponseParams("codex-lb", { ...request, tools });
  const codexParameters = codex.tools[0]?.parameters;
  assert.ok(codexParameters);
  const codexTasks = (codexParameters.properties as Record<string, Record<string, unknown>>).tasks;
  const codexItems = codexTasks?.items as Record<string, unknown>;
  const codexProperties = codexItems.properties as Record<string, Record<string, unknown>>;
  assert.equal(codexProperties.prompt?.maxLength, 32_000);
});

test("maps LM Studio native model metadata", () => {
  const model = lmStudioModelInfo({
    type: "llm",
    key: "coordinator-model",
    display_name: "Coordinator Model",
    max_context_length: 262_144,
    loaded_instances: [{ config: { context_length: 131_072 } }],
    capabilities: {
      vision: true,
      trained_for_tool_use: true,
      reasoning: { allowed_options: ["off", "on"], default: "on" },
    },
  });
  assert.equal(model.id, "coordinator-model");
  assert.equal(model.name, "Coordinator Model");
  assert.equal(model.contextWindow, 131_072);
  assert.equal(model.supportsReasoning, true);
  assert.deepEqual(model.reasoningEfforts, ["none", "medium"]);
  assert.equal(model.defaultReasoningEffort, "medium");
  assert.equal(model.supportsImages, true);
  assert.equal(model.supportsParallelToolCalls, true);
  assert.equal(model.priority, 0);
});

test("defaults to the codex-lb gateway profile", () => {
  assert.equal(DEFAULT_CONFIG.gateway.provider, "codex-lb");
  assert.deepEqual(DEFAULT_CONFIG.gateways, []);
});

test("extracts text from LM Studio message output when output_text is omitted", () => {
  assert.equal(responseText({
    output_text: "",
    output: [{
      id: "message",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "LM_OK", annotations: [], logprobs: [] }],
    }],
  } as Parameters<typeof responseText>[0]), "LM_OK");
});

test("raw response streaming ignores gateway metadata and rebuilds missing terminal output", async (t) => {
  const events = [
    {
      type: "response.created",
      response: { id: "resp_raw", status: "in_progress", model: "test-model", output: [] },
    },
    {
      type: "response.metadata",
      response_id: "resp_raw",
      metadata: { moderation: { allowed: true } },
    },
    { type: "response.output_text.delta", delta: "RAW_OK" },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "msg_raw",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "RAW_OK", annotations: [], logprobs: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_raw",
        status: "completed",
        model: "test-model",
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    },
  ];
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address() as AddressInfo;
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.baseURL = `http://127.0.0.1:${address.port}/v1`;
  const client = new CodexLbClient(config);
  const deltas: string[] = [];
  const seen: string[] = [];
  const { previousResponseId: _previousResponseId, ...unanchored } = request;
  const result = await client.stream({
    ...unanchored,
    model: "test-model",
  }, {
    onTextDelta: (delta) => deltas.push(delta),
    onEvent: (event) => seen.push(event.type),
  });
  assert.equal(result.id, "resp_raw");
  assert.equal(result.output_text, "RAW_OK");
  assert.equal(result.output.length, 1);
  assert.deepEqual(deltas, ["RAW_OK"]);
  assert.ok(seen.includes("response.metadata"));
});

test("LM Studio preserves safe reasoning summaries for the transcript", async (t) => {
  const events = [
    {
      type: "response.created",
      response: { id: "resp_lm_reasoning", status: "in_progress", model: "test-model", output: [] },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "reasoning_lm",
        type: "reasoning",
        status: "completed",
        summary: [{ type: "summary_text", text: "**Checking the workspace**", encrypted_content: "summary secret" }],
        encrypted_content: "internal reasoning",
      },
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: {
        id: "message_lm",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "done", annotations: [], logprobs: [] }],
      },
    },
    {
      type: "response.completed",
      response: { id: "resp_lm_reasoning", status: "completed", model: "test-model" },
    },
  ];
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address() as AddressInfo;
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.provider = "lm-studio";
  config.gateway.baseURL = `http://127.0.0.1:${address.port}/v1`;
  const { previousResponseId: _previousResponseId, ...unanchored } = request;
  const client = new CodexLbClient(config);
  t.after(() => client.close());
  const result = await client.stream({ ...unanchored, model: "test-model" });
  const reasoning = result.output.find((item) => item.type === "reasoning") as { summary?: unknown[]; encrypted_content?: unknown } | undefined;
  assert.deepEqual(reasoning?.summary, [{ type: "summary_text", text: "**Checking the workspace**" }]);
  assert.equal(reasoning?.encrypted_content, undefined);
});

test("maps OpenRouter free metadata and replays Responses tool items as chat messages", () => {
  const model = openRouterModelInfo({
    id: "demo/model:free",
    name: "Demo",
    description: "demo model",
    context_length: 64_000,
    max_completion_tokens: 4_000,
    pricing: { prompt: "0", completion: "0" },
    architecture: { input_modalities: ["text", "image"] },
    supported_parameters: ["tools", "parallel_tool_calls", "reasoning"],
  });
  assert.equal(model.isFree, true);
  assert.equal(model.contextWindow, 64_000);
  assert.equal(model.maxOutputTokens, 4_000);
  assert.equal(model.supportsReasoning, true);
  assert.equal(model.supportsImages, true);
  assert.equal(model.supportsParallelToolCalls, true);
  const messages = openRouterMessages("instructions", [
    { role: "developer", content: [{ type: "input_text", text: "developer" }] },
    { role: "user", content: [{ type: "input_text", text: "call it" }] },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"x":1}' },
    { type: "function_call_output", call_id: "call_1", output: "result" },
  ] as ResponseInputItem[]);
  assert.deepEqual(messages.map((item) => item.role), ["system", "system", "user", "assistant", "tool"]);
  assert.equal((messages[3]?.tool_calls as Array<{ id: string }>)[0]?.id, "call_1");
  assert.equal(messages[4]?.tool_call_id, "call_1");
});

test("OpenRouter chat content parts remain valid and tool calls preserve assistant text", () => {
  const messages = openRouterMessages("", [
    { role: "assistant", content: [{ type: "output_text", text: "before tool" }] },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
    { role: "user", content: [
      { type: "input_text", text: "look" },
      { type: "input_image", image_url: "https://images.invalid/a.png" },
    ] },
  ] as ResponseInputItem[]);

  assert.equal(messages[0]?.role, "assistant");
  assert.deepEqual(messages[0]?.content, [{ type: "text", text: "before tool" }]);
  assert.equal((messages[0]?.tool_calls as Array<{ id: string }>)[0]?.id, "call_1");
  assert.deepEqual(messages[1]?.content, [
    { type: "text", text: "look" },
    { type: "image_url", image_url: { url: "https://images.invalid/a.png" } },
  ]);
});

test("OpenRouter replays refusal output without dropping its text", () => {
  const messages = openRouterMessages("", [
    { role: "assistant", content: [{ type: "refusal", refusal: "I cannot help with that." }] },
  ] as ResponseInputItem[]);
  assert.deepEqual(messages, [{
    role: "assistant",
    content: [{ type: "text", text: "I cannot help with that." }],
  }]);
});

test("OpenRouter reasoning requires the standard reasoning parameter", () => {
  const model = openRouterModelInfo({ id: "demo/model", supported_parameters: ["include_reasoning"] });
  assert.equal(model.supportsReasoning, false);
  assert.equal(model.defaultReasoningEffort, "none");
});

test("OpenRouter uses advertised model-specific effort levels including minimal", () => {
  const model = openRouterModelInfo({
    id: "demo/reasoning-model",
    supported_parameters: ["reasoning", "reasoning_effort"],
    reasoning: {
      mandatory: true,
      supported_efforts: ["xhigh", "high", "medium", "low", "minimal", "none"],
      default_effort: "minimal",
    },
  });
  assert.deepEqual(model.reasoningEfforts, ["xhigh", "high", "medium", "low", "minimal"]);
  assert.equal(model.defaultReasoningEffort, "minimal");

  const unrestricted = openRouterModelInfo({
    id: "demo/unrestricted-reasoning",
    supported_parameters: ["reasoning"],
    reasoning: { supported_efforts: null },
  });
  assert.deepEqual(unrestricted.reasoningEfforts, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

  const omitted = openRouterModelInfo({
    id: "demo/omitted-reasoning-efforts",
    supported_parameters: ["reasoning", "reasoning_effort"],
    reasoning: {},
  });
  assert.deepEqual(omitted.reasoningEfforts, ["low", "medium", "high"]);
  const params = buildResponseParams("openrouter", { ...request, reasoningEffort: "none" }) as Record<string, unknown>;
  assert.deepEqual(params.reasoning, { effort: "none" });
});

test("lists and sorts OpenRouter catalog models with free pricing markers", async (t) => {
  const server = createServer((_req, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [
      { id: "paid/model", name: "Paid", pricing: { prompt: "0.000001", completion: "0.000002" } },
      { id: "free/model", name: "Free", pricing: { prompt: "0", completion: "0" } },
    ] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.provider = "openrouter";
  config.gateway.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const models = await new CodexLbClient(config).models();
  assert.deepEqual(models.map((model) => model.id), ["free/model", "paid/model"]);
  assert.equal(models[0]?.isFree, true);
  assert.equal(models[1]?.isFree, false);
});

test("OpenRouter simple stream and stateless tool follow-up use Chat Completions", async (t) => {
  const bodies: Record<string, unknown>[] = [];
  let calls = 0;
  const server = createServer((req, response) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      bodies.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (calls++ === 0) {
        response.write(`data: ${JSON.stringify({ id: "chat_1", model: "demo", choices: [{ delta: { content: "before", tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "{}" } }] } }] })}\n\n`);
      } else {
        response.write(`data: ${JSON.stringify({ id: "chat_2", model: "demo", choices: [{ delta: { content: "done" } }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.provider = "openrouter";
  config.gateway.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const client = new CodexLbClient(config);
  const { previousResponseId: _firstPreviousResponseId, ...unanchoredRequest } = request;
  const firstEvents: Array<{ type?: string; output_index?: number }> = [];
  const first = await client.stream(unanchoredRequest, {
    onEvent: (event) => firstEvents.push(event as unknown as { type?: string; output_index?: number }),
  });
  assert.equal(first.output.some((item) => item.type === "function_call"), true);
  assert.equal(firstEvents.find((event) => event.type === "response.function_call_arguments.done")?.output_index, 1);
  const second = await client.stream({
    ...request,
    input: [
      ...request.input,
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "result" },
    ] as ResponseInputItem[],
  }, {});
  assert.equal(second.output_text, "done");
  const secondMessages = bodies[1]?.messages as Array<Record<string, unknown>>;
  assert.equal(secondMessages.some((message) => message.role === "tool" && message.tool_call_id === "call_1"), true);
});

test("OpenRouter refusal deltas become assistant refusal output", async (t) => {
  const server = createServer((_req, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({
      id: "chat_refusal",
      model: "demo",
      choices: [{ delta: { refusal: "I cannot help with that." } }],
    })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.provider = "openrouter";
  config.gateway.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const result = await new CodexLbClient(config).stream({ ...request });
  const refusal = result.output.find((item) => item.type === "message") as { content?: unknown[] } | undefined;
  assert.deepEqual(refusal?.content, [{ type: "refusal", refusal: "I cannot help with that." }]);
  assert.equal(result.output_text, "");
});

test("OpenRouter finish reasons preserve incomplete responses", async (t) => {
  const server = createServer((_req, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({
      id: "chat_incomplete",
      model: "demo",
      choices: [{ finish_reason: "length", delta: {} }],
    })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.provider = "openrouter";
  config.gateway.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const result = await new CodexLbClient(config).stream({ ...request });
  assert.equal(result.status, "incomplete");
  assert.deepEqual((result as unknown as { incomplete_details?: unknown }).incomplete_details, {
    reason: "max_output_tokens",
  });
});

test("OpenRouter compaction requests a durable checkpoint and normalizes usage", async (t) => {
  let body: Record<string, unknown> | undefined;
  const server = createServer((req, response) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      body = JSON.parse(raw) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "compact_1",
        choices: [{ message: { content: [{ type: "text", text: "checkpoint" }] } }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.provider = "openrouter";
  config.gateway.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const result = await new CodexLbClient(config).compact({
    model: "demo",
    instructions: "Keep context",
    input: [
      ...request.input,
      { type: "function_call", call_id: "compact_call", name: "inspect", arguments: "{}" },
      { type: "function_call_output", call_id: "compact_call", output: "inspection result" },
    ] as ResponseInputItem[],
    promptCacheKey: "k",
    fast: false,
  });
  const messages = body?.messages as Array<Record<string, unknown>>;
  const system = messages[0];
  assert.match(String(system?.content), /durable checkpoint/);
  assert.deepEqual(body?.transforms, ["middle-out"]);
  assert.equal(body?.max_tokens, 8_192);
  assert.equal(JSON.stringify(messages).includes("Conversation transcript:"), false);
  assert.equal(messages.some((message) => message.role === "assistant" && Array.isArray(message.tool_calls)), true);
  assert.equal(messages.some((message) => message.role === "tool" && message.tool_call_id === "compact_call"), true);
  assert.match(String(messages.at(-1)?.content), /checkpoint now/);
  assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 3, total_tokens: 10 });
  assert.match(JSON.stringify(result.output), /checkpoint/);
});

test("OpenRouter HTTP and compact diagnostics preserve provider, status, and nested detail", async (t) => {
  let first = true;
  const server = createServer((_req, response) => {
    if (first) {
      first = false;
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "quota detail", code: "quota_code", type: "rate_limit" } }));
      return;
    }
    response.writeHead(503, { "content-type": "text/plain" });
    response.end("upstream unavailable");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.provider = "openrouter";
  config.gateway.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const client = new CodexLbClient(config);
  const { previousResponseId: _errorPreviousResponseId, ...unanchoredRequest } = request;
  await assert.rejects(() => client.stream(unanchoredRequest), (error: unknown) => {
    assert.match((error as Error).message, /openrouter stream failed with HTTP 429.*quota detail/);
    assert.equal((error as { code?: string }).code, "quota_code");
    return true;
  });
  await assert.rejects(() => client.compact({
    model: "demo", instructions: "", input: request.input, promptCacheKey: "k", fast: false,
  }), (error: unknown) => {
    assert.match((error as Error).message, /openrouter compact failed with HTTP 503.*upstream unavailable/);
    return true;
  });
});

test("OpenRouter streamed errors and malformed or incomplete SSE are normalized", async (t) => {
  let calls = 0;
  const server = createServer((_req, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (calls++ === 0) {
      response.end(`data: ${JSON.stringify({ error: { message: "stream quota", code: "stream_quota", type: "rate_limit" } })}\n\ndata: [DONE]\n\n`);
    } else if (calls === 2) {
      response.end("data: {not-json}\n\n");
    } else {
      response.end(`data: ${JSON.stringify({ id: "incomplete", choices: [{ delta: { content: "partial" } }] })}\n\n`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.provider = "openrouter";
  config.gateway.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const client = new CodexLbClient(config);
  const { previousResponseId: _streamErrorPreviousResponseId, ...unanchoredRequest } = request;
  await assert.rejects(() => client.stream(unanchoredRequest), (error: unknown) => {
    assert.match((error as Error).message, /openrouter stream failed: stream quota/);
    assert.equal((error as { code?: string }).code, "stream_quota");
    return true;
  });
  await assert.rejects(() => client.stream(unanchoredRequest), (error: unknown) => {
    assert.match((error as Error).message, /openrouter stream failed: malformed provider response/);
    assert.equal((error as { code?: string }).code, "malformed_response_event");
    return true;
  });
  await assert.rejects(() => client.stream(unanchoredRequest), (error: unknown) => {
    assert.match((error as Error).message, /openrouter stream failed: response stream ended without \[DONE\]/);
    assert.equal((error as { code?: string }).code, "stream_incomplete");
    return true;
  });
});

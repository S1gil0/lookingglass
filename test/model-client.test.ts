import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  buildResponseParams,
  CodexLbClient,
  lmStudioModelInfo,
  openRouterModelInfo,
  openRouterMessages,
  responseText,
  type ResponseRequest,
} from "../src/model/codex-lb.js";

const request: ResponseRequest = {
  model: "qwen/qwen3.6-35b-a3b",
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
      { type: "reasoning", id: "reasoning", summary: [], content: [] } as unknown as ResponseInputItem,
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
    key: "qwen/qwen3.6-35b-a3b",
    display_name: "Qwen3.6 35B A3B",
    max_context_length: 262_144,
    loaded_instances: [{ config: { context_length: 131_072 } }],
    capabilities: {
      vision: true,
      trained_for_tool_use: true,
      reasoning: { allowed_options: ["off", "on"], default: "on" },
    },
  });
  assert.equal(model.id, "qwen/qwen3.6-35b-a3b");
  assert.equal(model.name, "Qwen3.6 35B A3B");
  assert.equal(model.contextWindow, 131_072);
  assert.equal(model.supportsReasoning, true);
  assert.deepEqual(model.reasoningEfforts, ["none", "medium"]);
  assert.equal(model.defaultReasoningEffort, "medium");
  assert.equal(model.supportsImages, true);
  assert.equal(model.supportsParallelToolCalls, true);
  assert.equal(model.priority, 0);
});

test("defaults to the LM Studio gateway profile", () => {
  assert.equal(DEFAULT_CONFIG.gateway.provider, "lm-studio");
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

test("OpenRouter reasoning requires the standard reasoning parameter", () => {
  const model = openRouterModelInfo({ id: "demo/model", supported_parameters: ["include_reasoning"] });
  assert.equal(model.supportsReasoning, false);
  assert.equal(model.defaultReasoningEffort, "none");
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
    model: "demo", instructions: "Keep context", input: request.input, promptCacheKey: "k", fast: false,
  });
  const system = (body?.messages as Array<Record<string, unknown>>)?.[0];
  assert.match(String(system?.content), /durable checkpoint/);
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

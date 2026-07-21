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

  const codex = buildResponseParams("codex-lb", withReasoning) as Record<string, unknown>;
  assert.equal(codex.store, false);
  assert.deepEqual(codex.text, { verbosity: "low" });
  assert.equal(codex.prompt_cache_key, "cache-key");
  assert.equal(codex.service_tier, "priority");
  assert.equal((codex.input as ResponseInputItem[]).some((item) => item.type === "reasoning"), true);
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

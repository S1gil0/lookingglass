import assert from "node:assert/strict";
import test from "node:test";
import {
  anthropicMessageText,
  anthropicMessageUsage,
  buildAnthropicMessagesParams,
  parseAnthropicMessagesStream,
  type AnthropicMessagesRequest,
} from "../src/model/anthropic-messages.js";
import type { ResponseInputItem } from "openai/resources/responses/responses";

const request: AnthropicMessagesRequest = {
  model: "qwen3.7-plus",
  instructions: "Be concise.",
  input: [
    { role: "user", content: [{ type: "input_text", text: "hello" }, { type: "input_image", image_url: "https://example.test/a.png" }] },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"x":1}' },
    { type: "function_call_output", call_id: "call_1", output: "found" },
    { type: "reasoning", id: "reasoning_1", summary: [], content: [] },
    { type: "compaction", id: "compact_1", encrypted_content: "opaque" },
  ] as ResponseInputItem[],
  tools: [{ type: "function", name: "lookup", description: "Look up a value", parameters: { type: "object" }, strict: null }],
  reasoningEffort: "high",
};

test("builds Anthropic Messages params from Responses input", () => {
  const params = buildAnthropicMessagesParams(request);
  assert.equal(params.system, "Be concise.");
  assert.deepEqual(params.thinking, { type: "enabled", budget_tokens: 32_768 });
  assert.equal(params.max_tokens, 65_536);
  assert.deepEqual(params.tools, [{ name: "lookup", description: "Look up a value", input_schema: { type: "object" } }]);
  assert.deepEqual(params.messages, [
    { role: "user", content: [
      { type: "text", text: "hello" },
      { type: "image", source: { type: "url", url: "https://example.test/a.png" } },
    ] },
    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: { x: 1 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "found" }] },
  ]);
  assert.equal("thinking" in buildAnthropicMessagesParams(request, { includeReasoning: false }), false);
  assert.equal("thinking" in buildAnthropicMessagesParams({ ...request, supportsReasoning: false }), false);
});

test("replays signed Anthropic thinking with its assistant tool call", () => {
  const signedInput = [
    {
      type: "reasoning",
      id: "reasoning_prior",
      summary: [{ type: "summary_text", text: "prior plan" }],
      content: [],
      encrypted_content: "signed-thinking",
    } as unknown as ResponseInputItem,
    { type: "function_call", call_id: "call_prior", name: "lookup", arguments: '{"x":2}' },
    { type: "function_call_output", call_id: "call_prior", output: "done" },
  ] as ResponseInputItem[];
  const params = buildAnthropicMessagesParams({
    ...request,
    input: signedInput,
  });
  assert.deepEqual(params.messages, [
    { role: "assistant", content: [
      { type: "thinking", thinking: "prior plan", signature: "signed-thinking" },
      { type: "tool_use", id: "call_prior", name: "lookup", input: { x: 2 } },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_prior", content: "done" }] },
  ]);
  const disabled = buildAnthropicMessagesParams({
    ...request,
    input: signedInput,
    supportsReasoning: false,
  });
  assert.equal("thinking" in disabled, false);
  assert.equal(disabled.messages.some((message) => message.role === "assistant"
    && message.content.some((block) => block.type === "thinking")), false);
});

test("parses Anthropic stream into Responses output and events", async () => {
  const events: Array<{ type?: string; delta?: string }> = [];
  const body = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", model: "qwen3.7-max", usage: { input_tokens: 7 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed-plan" } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "done" } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call_1", name: "lookup", input: {} } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"x":1}' } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 2 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join("");
  const response = await parseAnthropicMessagesStream(
    new Response(body, { headers: { "content-type": "text/event-stream" } }),
    { onEvent: (event) => events.push(event as unknown as { type?: string; delta?: string }) },
    { provider: "opencode-go", operation: "stream" },
  );
  assert.equal(response.status, "completed");
  assert.equal(response.output_text, "done");
  assert.deepEqual(response.usage, { input_tokens: 7, output_tokens: 4, total_tokens: 11 });
  assert.equal(response.output.some((item) => item.type === "reasoning"), true);
  const reasoning = response.output.find((item) => item.type === "reasoning") as unknown as { encrypted_content?: string };
  assert.equal(reasoning.encrypted_content, "signed-plan");
  assert.equal(response.output.some((item) => item.type === "function_call"), true);
  assert.ok(events.some((event) => event.type === "response.output_text.delta" && event.delta === "done"));
});

test("rejects Anthropic streams that stop with an open content block", async () => {
  const body = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_bad", model: "qwen3.7-max" } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join("");
  await assert.rejects(
    () => parseAnthropicMessagesStream(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
      {},
      { provider: "opencode-go", operation: "stream" },
    ),
    (error: unknown) => {
      assert.equal((error as { kind?: string }).kind, "protocol");
      assert.equal((error as { code?: string }).code, "malformed_response");
      return true;
    },
  );
});

test("finishes and cancels the transport as soon as message_stop arrives", async () => {
  let cancelled = false;
  const body = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_done", model: "qwen3.7-max" } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(body)); },
    cancel() { cancelled = true; },
  });
  const response = await parseAnthropicMessagesStream(
    new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    {},
    { provider: "opencode-go", operation: "stream" },
  );
  assert.equal(response.output_text, "done");
  assert.equal(cancelled, true);
});

test("normalizes non-stream Anthropic messages payloads", () => {
  const payload = {
    content: [{ type: "text", text: "checkpoint" }],
    usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 3 },
  };
  assert.equal(anthropicMessageText(payload), "checkpoint");
  assert.deepEqual(anthropicMessageUsage(payload), { input_tokens: 12, output_tokens: 3, total_tokens: 15 });
});
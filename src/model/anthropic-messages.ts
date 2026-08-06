import type {
  FunctionTool,
  Response,
  ResponseInputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import type { ProviderErrorContext } from "../errors.js";
import { providerError, providerHttpError } from "../errors.js";
import { openCodeGoProfile, openCodeGoReasoningParams } from "./opencode-go.js";
import type { ReasoningEffort } from "../types.js";

/** The small part of the model request needed by this wire adapter. */
export interface AnthropicMessagesRequest {
  model: string;
  instructions: string;
  input: ResponseInputItem[];
  tools: FunctionTool[];
  reasoningEffort: ReasoningEffort;
  supportsReasoning?: boolean;
}

export type ResponseRequest = AnthropicMessagesRequest;

export interface AnthropicMessagesParams {
  model: string;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  max_tokens: number;
  stream: true;
  thinking?: Record<string, unknown>;
}

export interface AnthropicMessagesOptions {
  maxTokens?: number;
  includeReasoning?: boolean;
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type AnthropicTextBlock = { type: "text"; text: string };
export type AnthropicImageBlock = {
  type: "image";
  source: { type: "url"; url: string };
};
export type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};
export type AnthropicThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature: string;
};
export type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<AnthropicTextBlock | AnthropicImageBlock>;
};

export type AnthropicMessage =
  | { role: "user"; content: Array<AnthropicTextBlock | AnthropicImageBlock | AnthropicToolResultBlock> }
  | { role: "assistant"; content: Array<AnthropicTextBlock | AnthropicThinkingBlock | AnthropicToolUseBlock> };

/** The callbacks intentionally use the same event surface as the Responses client. */
export interface StreamCallbacks {
  onTextDelta?(delta: string): void;
  onEvent?(event: ResponseStreamEvent): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function imageBlock(value: unknown): AnthropicImageBlock | undefined {
  if (!isRecord(value) || value.type !== "input_image") return undefined;
  const url = stringValue(value.image_url);
  return url ? { type: "image", source: { type: "url", url } } : undefined;
}

function textBlock(value: unknown): AnthropicTextBlock | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type !== "input_text" && value.type !== "output_text" && value.type !== "text" && value.type !== "refusal") {
    return undefined;
  }
  const text = stringValue(value.text) ?? stringValue(value.refusal);
  return text === undefined ? undefined : { type: "text", text };
}

function contentBlocks(value: unknown, allowImages: boolean): Array<AnthropicTextBlock | AnthropicImageBlock> {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) {
    const text = textBlock(value);
    return text ? [text] : [];
  }
  const blocks: Array<AnthropicTextBlock | AnthropicImageBlock> = [];
  for (const item of value) {
    const text = textBlock(item);
    if (text) {
      blocks.push(text);
      continue;
    }
    if (allowImages) {
      const image = imageBlock(item);
      if (image) blocks.push(image);
    }
  }
  return blocks;
}

function functionArguments(argumentsText: unknown): unknown {
  if (typeof argumentsText !== "string" || argumentsText.trim() === "") return {};
  try {
    return JSON.parse(argumentsText) as unknown;
  } catch (error) {
    throw new Error(`function_call arguments were not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function toolResultContent(value: unknown): string | Array<AnthropicTextBlock | AnthropicImageBlock> {
  if (typeof value === "string") return value;
  const blocks = contentBlocks(value, true);
  return blocks.length > 0 ? blocks : "";
}

function reasoningSummaryText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "").join("");
}

function appendMessage(messages: AnthropicMessage[], message: AnthropicMessage): void {
  const previous = messages.at(-1);
  if (!previous || previous.role !== message.role) {
    messages.push(message);
    return;
  }
  if (previous.role === "user" && message.role === "user") previous.content.push(...message.content);
  else if (previous.role === "assistant" && message.role === "assistant") previous.content.push(...message.content);
}

/** Lower Responses input items to Anthropic Messages, including signed prior thinking. */
export function buildAnthropicMessagesParams(
  request: AnthropicMessagesRequest,
  options: AnthropicMessagesOptions = {},
): AnthropicMessagesParams {
  const systemParts = request.instructions ? [request.instructions] : [];
  const messages: AnthropicMessage[] = [];

  for (const raw of request.input) {
    if (!isRecord(raw)) continue;
    const type = stringValue(raw.type);

    if (type === "reasoning") {
      const thinking = reasoningSummaryText(raw.summary);
      const signature = stringValue(raw.encrypted_content);
      if (request.supportsReasoning !== false && thinking && signature) {
        appendMessage(messages, { role: "assistant", content: [{ type: "thinking", thinking, signature }] });
      }
      continue;
    }
    if (type === "compaction" || type === "compaction_trigger") continue;

    if (type === "function_call") {
      const callId = stringValue(raw.call_id) ?? stringValue(raw.id);
      const name = stringValue(raw.name);
      if (!callId || !name) continue;
      appendMessage(messages, {
        role: "assistant",
        content: [{ type: "tool_use", id: callId, name, input: functionArguments(raw.arguments) }],
      });
      continue;
    }

    if (type === "function_call_output") {
      const callId = stringValue(raw.call_id);
      if (!callId) continue;
      appendMessage(messages, {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: callId, content: toolResultContent(raw.output) }],
      });
      continue;
    }

    const role = stringValue(raw.role);
    if (type !== "message" && role !== "system" && role !== "developer" && role !== "user" && role !== "assistant") continue;
    const content = raw.content;
    if (role === "system" || role === "developer") {
      for (const block of contentBlocks(content, false)) {
        if (block.type === "text") systemParts.push(block.text);
      }
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;

    if (role === "assistant") {
      const blocks = contentBlocks(content, false).filter((block): block is AnthropicTextBlock => block.type === "text");
      if (blocks.length > 0) appendMessage(messages, { role, content: blocks });
    } else {
      const blocks = contentBlocks(content, true);
      if (blocks.length > 0) appendMessage(messages, { role, content: blocks });
    }
  }

  const profile = openCodeGoProfile(request.model);
  const configuredMaxTokens = options.maxTokens;
  const maxTokens = typeof configuredMaxTokens === "number" && Number.isFinite(configuredMaxTokens) && configuredMaxTokens > 0
    ? Math.max(1, Math.floor(configuredMaxTokens))
    : (profile.maxOutputTokens && profile.maxOutputTokens > 0 ? profile.maxOutputTokens : 4_096);
  const tools = request.tools.length === 0 ? undefined : request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    input_schema: tool.parameters ?? {},
  }));

  const params: AnthropicMessagesParams = {
    model: request.model,
    messages,
    max_tokens: maxTokens,
    stream: true,
    ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
    ...(tools ? { tools } : {}),
    ...(options.includeReasoning === false || request.supportsReasoning === false
      ? {}
      : openCodeGoReasoningParams(request.model, request.reasoningEffort)),
  };
  return params;
}

function boundedJsonValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw Object.assign(new Error(`malformed Anthropic stream event JSON: ${error instanceof Error ? error.message : String(error)}`), {
      code: "malformed_response_event",
    });
  }
}

async function boundedResponseText(response: globalThis.Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let total = 0;
  try {
    while (total < 64 * 1024) {
      const next = await reader.read();
      if (next.done) break;
      const value = next.value ?? new Uint8Array();
      const take = Math.min(value.byteLength, 64 * 1024 - total);
      if (take > 0) {
        result += decoder.decode(value.slice(0, take), { stream: take < value.byteLength });
        total += take;
      }
      if (take < value.byteLength) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return result;
}

function protocolFailure(error: unknown, context: ProviderErrorContext): never {
  throw providerError(error, { ...context, protocol: true });
}

interface StreamBlock {
  type: "text" | "thinking" | "tool_use";
  id?: string;
  name?: string;
  text: string;
  signature: string;
  arguments: string;
  initialInput?: unknown;
  stopped: boolean;
}

interface StreamState {
  id: string;
  model: string;
  blocks: Map<number, StreamBlock>;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  stopReason?: string;
  sawStart: boolean;
  sawStop: boolean;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function applyUsage(state: StreamState, value: unknown): void {
  if (!isRecord(value)) return;
  const input = nonNegativeNumber(value.input_tokens);
  const output = nonNegativeNumber(value.output_tokens);
  const creation = nonNegativeNumber(value.cache_creation_input_tokens);
  const read = nonNegativeNumber(value.cache_read_input_tokens);
  if (input !== undefined) state.inputTokens = input;
  if (output !== undefined) state.outputTokens = output;
  if (creation !== undefined) state.cacheCreationInputTokens = creation;
  if (read !== undefined) state.cacheReadInputTokens = read;
}

function streamUsage(state: StreamState): Record<string, number> | undefined {
  if (state.inputTokens === undefined && state.outputTokens === undefined
    && state.cacheCreationInputTokens === undefined && state.cacheReadInputTokens === undefined) return undefined;
  const inputTokens = (state.inputTokens ?? 0) + (state.cacheCreationInputTokens ?? 0) + (state.cacheReadInputTokens ?? 0);
  const outputTokens = state.outputTokens ?? 0;
  return { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
}

function responseEvent(callbacks: StreamCallbacks, event: Record<string, unknown>): void {
  callbacks.onEvent?.(event as unknown as ResponseStreamEvent);
}

function malformed(context: ProviderErrorContext, message: string): never {
  return protocolFailure({ code: "malformed_response", message }, context);
}

function blockAt(state: StreamState, index: unknown, expected?: StreamBlock["type"]): StreamBlock {
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    throw new Error("Anthropic stream content block had an invalid index");
  }
  const block = state.blocks.get(index);
  if (!block) throw new Error("Anthropic stream content block delta had no matching start");
  if (expected && block.type !== expected) throw new Error("Anthropic stream content block type changed");
  return block;
}

function canonicalOutput(state: StreamState, context: ProviderErrorContext): { output: unknown[]; text: string; toolIndices: Array<{ outputIndex: number; arguments: string }> } {
  const blocks = [...state.blocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => block);
  const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
  const tools = blocks.filter((block) => block.type === "tool_use");
  const output: unknown[] = [];
  for (const [index, reasoning] of blocks.filter((block) => block.type === "thinking").entries()) {
    if (!reasoning.text) continue;
    output.push({
      id: `reasoning_${state.id}_${index}`,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: reasoning.text }],
      content: [],
      ...(reasoning.signature ? { encrypted_content: reasoning.signature } : {}),
    });
  }
  if (text) output.push({
    id: `msg_${state.id}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
  });
  const toolIndices: Array<{ outputIndex: number; arguments: string }> = [];
  for (const tool of tools) {
    const argumentsText = tool.arguments || (tool.initialInput === undefined ? "{}" : JSON.stringify(tool.initialInput));
    try {
      JSON.parse(argumentsText);
    } catch (error) {
      return protocolFailure(Object.assign(new Error(`Anthropic tool input was not valid JSON: ${error instanceof Error ? error.message : String(error)}`), {
        code: "malformed_response",
      }), context);
    }
    const callId = tool.id ?? `call_${state.id}_${toolIndices.length}`;
    const outputIndex = output.length;
    output.push({ id: callId, type: "function_call", call_id: callId, name: tool.name ?? "", arguments: argumentsText, status: "completed" });
    toolIndices.push({ outputIndex, arguments: argumentsText });
  }
  return { output, text, toolIndices };
}

/**
 * Parse an Anthropic Messages SSE response into Responses-compatible events and
 * a final Response. Anthropic has no [DONE] sentinel; message_stop is required.
 */
export async function parseAnthropicMessagesStream(
  httpResponse: globalThis.Response,
  callbacks: StreamCallbacks = {},
  context: ProviderErrorContext,
): Promise<Response> {
  if (!httpResponse.ok) {
    let payload: unknown = "";
    try {
      const text = await boundedResponseText(httpResponse);
      if (text.trim()) {
        try { payload = JSON.parse(text) as unknown; } catch { payload = text; }
      } else payload = text;
    } catch (error) {
      throw providerError(error, context);
    }
    throw providerHttpError(httpResponse.status, payload, context);
  }
  if (!httpResponse.body) return protocolFailure({ code: "malformed_response", message: "response had no body" }, context);

  const state: StreamState = {
    id: "",
    model: "",
    blocks: new Map(),
    sawStart: false,
    sawStop: false,
  };
  const reader = httpResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let data: string[] = [];

  const processEvent = (payloadText: string): void => {
    if (!payloadText.trim()) return;
    const parsed = boundedJsonValue(payloadText);
    if (!isRecord(parsed)) malformed(context, "Anthropic stream event was not an object");
    const type = eventName || stringValue(parsed.type);
    if (!type) malformed(context, "Anthropic stream event had no type");

    if (type === "message_start") {
      if (state.sawStart) malformed(context, "Anthropic stream contained duplicate message_start");
      const message = parsed.message;
      if (!isRecord(message) || typeof message.id !== "string" || typeof message.model !== "string") {
        malformed(context, "Anthropic message_start was missing id or model");
      }
      state.id = message.id;
      state.model = message.model;
      state.sawStart = true;
      applyUsage(state, message.usage);
      responseEvent(callbacks, { type: "response.created", response: { id: state.id, status: "in_progress", model: state.model, output: [] } });
      return;
    }
    if (type === "error") {
      throw providerError(parsed.error ?? parsed, context);
    }
    if (!state.sawStart) malformed(context, `Anthropic stream emitted ${type} before message_start`);
    if (type === "content_block_start") {
      if (typeof parsed.index !== "number" || !Number.isInteger(parsed.index) || parsed.index < 0 || !isRecord(parsed.content_block)) {
        malformed(context, "Anthropic content_block_start was malformed");
      }
      const block = parsed.content_block;
      const blockType = stringValue(block.type);
      if (blockType !== "text" && blockType !== "thinking" && blockType !== "tool_use") {
        malformed(context, `Anthropic stream contained an unknown content block ${blockType ?? ""}`);
      }
      if (state.blocks.has(parsed.index)) malformed(context, "Anthropic stream repeated a content block index");
      const blockId = stringValue(block.id);
      const blockName = stringValue(block.name);
      if (blockType === "tool_use" && (!blockId || !blockName)) {
        malformed(context, "Anthropic tool_use block was missing id or name");
      }
      const streamBlock: StreamBlock = {
        type: blockType,
        text: blockType === "text" ? (stringValue(block.text) ?? "") : blockType === "thinking" ? (stringValue(block.thinking) ?? "") : "",
        signature: blockType === "thinking" ? (stringValue(block.signature) ?? "") : "",
        arguments: "",
        stopped: false,
        ...(blockId ? { id: blockId } : {}),
        ...(blockName ? { name: blockName } : {}),
        ...(blockType === "tool_use" && block.input !== undefined ? { initialInput: block.input } : {}),
      };
      state.blocks.set(parsed.index, streamBlock);
      if (streamBlock.text) {
        if (streamBlock.type === "text") {
          callbacks.onTextDelta?.(streamBlock.text);
          responseEvent(callbacks, { type: "response.output_text.delta", delta: streamBlock.text });
        } else {
          responseEvent(callbacks, { type: "response.reasoning_summary_text.delta", delta: streamBlock.text });
        }
      }
      return;
    }
    if (type === "content_block_delta") {
      const block = (() => {
        try { return blockAt(state, parsed.index); } catch (error) { return protocolFailure(error, context); }
      })();
      if (block.stopped) malformed(context, "Anthropic stream emitted a delta after content_block_stop");
      if (!isRecord(parsed.delta)) malformed(context, "Anthropic content_block_delta was missing delta");
      const deltaType = stringValue(parsed.delta.type);
      if (deltaType === "text_delta") {
        if (block.type !== "text") malformed(context, "Anthropic text delta targeted a non-text block");
        if (typeof parsed.delta.text !== "string") malformed(context, "Anthropic text delta was not text");
        block.text += parsed.delta.text;
        callbacks.onTextDelta?.(parsed.delta.text);
        responseEvent(callbacks, { type: "response.output_text.delta", delta: parsed.delta.text });
      } else if (deltaType === "thinking_delta") {
        if (block.type !== "thinking") malformed(context, "Anthropic thinking delta targeted a non-thinking block");
        if (typeof parsed.delta.thinking !== "string") malformed(context, "Anthropic thinking delta was not text");
        block.text += parsed.delta.thinking;
        responseEvent(callbacks, { type: "response.reasoning_summary_text.delta", delta: parsed.delta.thinking });
      } else if (deltaType === "input_json_delta") {
        if (block.type !== "tool_use") malformed(context, "Anthropic tool delta targeted a non-tool block");
        if (typeof parsed.delta.partial_json !== "string") malformed(context, "Anthropic tool delta was missing partial_json");
        block.arguments += parsed.delta.partial_json;
        responseEvent(callbacks, { type: "response.function_call_arguments.delta", delta: parsed.delta.partial_json });
      } else if (deltaType === "signature_delta") {
        if (block.type !== "thinking") malformed(context, "Anthropic signature delta targeted a non-thinking block");
        if (typeof parsed.delta.signature !== "string") malformed(context, "Anthropic signature delta was not text");
        block.signature += parsed.delta.signature;
      } else {
        malformed(context, `Anthropic stream contained an unknown content delta ${deltaType ?? ""}`);
      }
      return;
    }
    if (type === "content_block_stop") {
      const block = (() => {
        try { return blockAt(state, parsed.index); } catch (error) { return protocolFailure(error, context); }
      })();
      if (block.stopped) malformed(context, "Anthropic stream repeated content_block_stop");
      block.stopped = true;
      return;
    }
    if (type === "message_delta") {
      if (isRecord(parsed.delta)) {
        if (parsed.delta.stop_reason !== undefined && parsed.delta.stop_reason !== null && typeof parsed.delta.stop_reason !== "string") {
          malformed(context, "Anthropic stop_reason was not text");
        }
        if (typeof parsed.delta.stop_reason === "string") state.stopReason = parsed.delta.stop_reason;
      }
      applyUsage(state, parsed.usage);
      return;
    }
    if (type === "message_stop") {
      if (state.sawStop) malformed(context, "Anthropic stream contained duplicate message_stop");
      if ([...state.blocks.values()].some((block) => !block.stopped)) {
        malformed(context, "Anthropic stream ended with an open content block");
      }
      state.sawStop = true;
      return;
    }
    // Anthropic may add ping/metadata events. They carry no response content.
  };

  const flush = (): void => {
    if (data.length > 0) processEvent(data.join("\n"));
    data = [];
    eventName = "";
  };

  try {
    while (true) {
      let next: { done: boolean; value?: Uint8Array };
      try { next = await reader.read(); } catch (error) { throw providerError(error, context); }
      buffer += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") flush();
        else if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        else if (!line.startsWith(":")) malformed(context, "Anthropic stream contained an invalid SSE line");
        if (state.sawStop) break;
        newline = buffer.indexOf("\n");
      }
      if (state.sawStop) {
        buffer = "";
        data = [];
        try { await reader.cancel(); } catch { /* the completed response is already available */ }
        break;
      }
      if (next.done) break;
    }
    if (buffer || data.length > 0) {
      if (buffer) {
        const line = buffer.replace(/\r$/, "");
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        else if (line.startsWith("event:")) malformed(context, "Anthropic stream ended inside an SSE event");
        else if (!line.startsWith(":")) malformed(context, "Anthropic stream ended with an invalid SSE line");
      }
      flush();
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* preserve the original protocol/provider error */ }
    if (isRecord(error) && typeof error.kind === "string") throw error;
    throw providerError(error, { ...context, protocol: true });
  } finally {
    try { reader.releaseLock(); } catch { /* stream implementations may release automatically */ }
  }

  if (!state.sawStart || !state.sawStop) {
    return protocolFailure({ code: "stream_incomplete", message: "Anthropic stream ended without message_stop" }, context);
  }
  const canonical = canonicalOutput(state, context);
  const incompleteReason = state.stopReason === "max_tokens" ? "max_output_tokens"
    : state.stopReason === "refusal" ? "content_filter" : undefined;
  if (canonical.output.length === 0 && !incompleteReason) return protocolFailure({ code: "malformed_response", message: "response contained no output" }, context);
  const response = {
    id: state.id,
    object: "response",
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    status: incompleteReason ? "incomplete" : "completed",
    output: canonical.output,
    output_text: canonical.text,
    ...(incompleteReason ? { incomplete_details: { reason: incompleteReason } } : {}),
    ...(streamUsage(state) ? { usage: streamUsage(state) } : {}),
  } as unknown as Response;
  for (const [index, item] of canonical.output.entries()) {
    responseEvent(callbacks, { type: "response.output_item.done", output_index: index, item });
  }
  for (const tool of canonical.toolIndices) {
    responseEvent(callbacks, { type: "response.function_call_arguments.done", output_index: tool.outputIndex, arguments: tool.arguments });
  }
  responseEvent(callbacks, { type: incompleteReason ? "response.incomplete" : "response.completed", response });
  return response;
}

/** Extract visible text from a non-streaming Anthropic Messages response. */
export function anthropicMessageText(payload: unknown): string {
  if (!isRecord(payload)) return "";
  if (typeof payload.output_text === "string" && payload.output_text !== "") return payload.output_text;
  if (!Array.isArray(payload.content)) return "";
  return payload.content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

/** Normalize Anthropic's split/cached usage counters to OpenAI Responses usage. */
export function anthropicMessageUsage(payload: unknown): Record<string, number> | undefined {
  if (!isRecord(payload)) return undefined;
  const usage = isRecord(payload.usage) ? payload.usage : payload;
  const hasUsage = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
    .some((key) => usage[key] !== undefined);
  if (!hasUsage) return undefined;
  const inputTokens = (nonNegativeNumber(usage.input_tokens) ?? 0)
    + (nonNegativeNumber(usage.cache_creation_input_tokens) ?? 0)
    + (nonNegativeNumber(usage.cache_read_input_tokens) ?? 0);
  const outputTokens = nonNegativeNumber(usage.output_tokens) ?? 0;
  return { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
}
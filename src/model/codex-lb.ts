import { providerError, providerHttpError, type ProviderErrorContext } from "../errors.js";
import type {
  FunctionTool,
  Response,
  ResponseInputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import { Agent } from "undici";
import type { GatewayProtocol, GatewayProvider, GlassConfig, ModelInfo, ReasoningEffort, Verbosity } from "../types.js";
import {
  anthropicMessageText,
  anthropicMessageUsage,
  buildAnthropicMessagesParams,
  parseAnthropicMessagesStream,
} from "./anthropic-messages.js";
import { openCodeGoModelInfo, openCodeGoProfile, openCodeGoReasoningParams } from "./opencode-go.js";

interface ErrorDetail {
  code?: string;
  param?: string;
  message?: string;
  type?: string;
  error?: ErrorDetail;
}

interface ModelMetadata {
  display_name?: string;
  description?: string;
  context_window?: number;
  input_context_window?: number | null;
  max_output_tokens?: number | null;
  supported_reasoning_levels?: Array<{ effort: string; description?: string }>;
  default_reasoning_level?: string | null;
  default_verbosity?: string | null;
  supports_parallel_tool_calls?: boolean;
  supported_in_api?: boolean;
  priority?: number;
  additional_speed_tiers?: string[];
  service_tiers?: Array<{ id?: string; name?: string }>;
}

interface RawModel {
  id: string;
  name?: string;
  description?: string | null;
  metadata?: ModelMetadata | null;
  capabilities?: {
    context_length?: number;
    max_output_tokens?: number | null;
    supports_reasoning?: boolean;
    supports_images?: boolean;
    supports_tool_use?: boolean;
  };
  context_length?: number;
  max_output_tokens?: number | null;
  supports_reasoning?: boolean;
  supports_images?: boolean;
}

interface LmStudioModel {
  type: string;
  key: string;
  display_name?: string;
  description?: string | null;
  max_context_length?: number;
  loaded_instances?: Array<{ config?: { context_length?: number } }>;
  capabilities?: {
    vision?: boolean;
    trained_for_tool_use?: boolean;
    reasoning?: { allowed_options?: string[]; default?: string };
  };
}

interface LmStudioModelsResponse {
  models?: LmStudioModel[];
}

export interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string | null;
  context_length?: number | null;
  max_completion_tokens?: number | null;
  max_output_tokens?: number | null;
  architecture?: {
    modality?: string | null;
    input_modalities?: string[] | null;
    output_modalities?: string[] | null;
  } | null;
  pricing?: { prompt?: string | number | null; completion?: string | number | null } | null;
  supported_parameters?: string[] | null;
  reasoning?: {
    mandatory?: boolean | null;
    default_enabled?: boolean | null;
    supports_max_tokens?: boolean | null;
    supported_efforts?: string[] | null;
    default_effort?: string | null;
  } | null;
  top_provider?: { context_length?: number | null; max_completion_tokens?: number | null } | null;
}

interface RawResponseEvent {
  type?: string;
  delta?: string;
  output_index?: number;
  item?: unknown;
  response?: Record<string, unknown>;
  error?: unknown;
}

export interface StreamCallbacks {
  onTextDelta?(delta: string): void;
  onEvent?(event: ResponseStreamEvent): void;
}

export interface ResponseRequest {
  model: string;
  instructions: string;
  input: ResponseInputItem[];
  tools: FunctionTool[];
  promptCacheKey: string;
  reasoningEffort: ReasoningEffort;
  supportsReasoning: boolean;
  supportsParallelToolCalls: boolean;
  verbosity: Verbosity;
  fast: boolean;
  previousResponseId?: string;
  signal?: AbortSignal;
}

export interface CompactRequest {
  model: string;
  instructions: string;
  input: ResponseInputItem[];
  promptCacheKey: string;
  fast: boolean;
  signal?: AbortSignal;
}

interface ResponseParams {
  input: ResponseInputItem[];
  tools: FunctionTool[];
  [key: string]: unknown;
}

// Current llama.cpp grammar generation can emit invalid GBNF for nested string
// maxLength constraints at or above 2000. Keep the original schemas for local
// validation and only relax the cloned schema sent to LM Studio.
function omitLmStudioLongMaxLengths(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) omitLmStudioLongMaxLengths(item);
    return;
  }
  if (!value || typeof value !== "object") return;

  const object = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(object)) {
    if (key === "maxLength" && typeof child === "number" && child >= 2_000) {
      delete object[key];
      continue;
    }
    omitLmStudioLongMaxLengths(child);
  }
}

function lmStudioTools(tools: FunctionTool[]): FunctionTool[] {
  return tools.map((tool) => {
    const parameters = tool.parameters === null ? null : structuredClone(tool.parameters);
    if (parameters !== null) omitLmStudioLongMaxLengths(parameters);
    return { ...tool, parameters };
  });
}

export function buildResponseParams(provider: GatewayProvider, request: ResponseRequest, protocol: GatewayProtocol = "responses"): ResponseParams {
  if (provider === "openrouter") return buildOpenRouterParams(request) as unknown as ResponseParams;
  if (provider === "opencode-go" && openCodeGoProfile(request.model).protocol === "responses") {
    return {
      model: request.model,
      instructions: request.instructions,
      input: request.input.filter((item) => item.type !== "compaction"
        && (request.supportsReasoning || item.type !== "reasoning")),
      tools: request.tools,
      ...(request.supportsParallelToolCalls ? { parallel_tool_calls: true } : {}),
      ...(request.supportsReasoning ? openCodeGoReasoningParams(request.model, request.reasoningEffort) : {}),
      ...(request.supportsReasoning ? { include: ["reasoning.encrypted_content"] } : {}),
      store: false,
      text: { verbosity: request.verbosity },
    };
  }
  if (provider === "opencode-go" || (provider === "custom" && protocol === "chat")) {
    return {
      ...buildCustomChatParams(request, provider === "opencode-go" && request.supportsReasoning),
      ...(provider === "opencode-go" && request.supportsReasoning
        ? openCodeGoReasoningParams(request.model, request.reasoningEffort)
        : {}),
    } as unknown as ResponseParams;
  }
  const common = {
    model: request.model,
    instructions: request.instructions,
    input: provider === "lm-studio" || provider === "custom"
      ? request.input.filter((item) => item.type !== "reasoning")
      : provider === "codex-lb" && !request.previousResponseId
        ? portableCodexReplayInput(request.input)
        : request.input,
    tools: provider === "lm-studio" ? lmStudioTools(request.tools) : request.tools,
    ...(request.supportsParallelToolCalls ? { parallel_tool_calls: true } : {}),
    ...(request.supportsReasoning ? {
      reasoning: {
        // codex-lb advertises "ultra" before the public SDK type includes it.
        effort: request.reasoningEffort as Exclude<ReasoningEffort, "ultra">,
        summary: "auto" as const,
      },
    } : {}),
    ...(provider === "codex-lb" && request.previousResponseId
      ? { previous_response_id: request.previousResponseId }
      : {}),
  };
  if (provider === "lm-studio") {
    return { ...common, store: false, text: { format: { type: "text" as const } } } as ResponseParams;
  }
  if (provider === "custom") {
    return { ...common, store: false, text: { format: { type: "text" as const } } } as ResponseParams;
  }
  return {
    ...common,
    store: false,
    prompt_cache_key: request.promptCacheKey,
    include: ["reasoning.encrypted_content" as const],
    text: { verbosity: request.verbosity },
    ...(request.fast ? { service_tier: "priority" as const } : {}),
  } as ResponseParams;
}

function detailFrom(value: unknown): ErrorDetail {
  if (!value || typeof value !== "object") return {};
  const outer = value as ErrorDetail;
  return outer.error && typeof outer.error === "object" ? outer.error : outer;
}

async function* responseEvents(response: globalThis.Response, context?: ProviderErrorContext): AsyncGenerator<RawResponseEvent> {
  if (!response.body) throw providerError({ code: "malformed_response", message: "response had no body" }, { ...(context ?? { provider: "provider", operation: "stream" }), protocol: true });
  const streamReader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const parseResponseEvent = (): RawResponseEvent | null => {
    const payload = data.join("\n");
    data = [];
    if (!payload || payload === "[DONE]") return null;
    try {
      const event = JSON.parse(payload) as unknown;
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        throw new Error("event is not an object");
      }
      return event as RawResponseEvent;
    } catch (error) {
      throw providerError(Object.assign(new Error(`Malformed response stream event: ${error instanceof Error ? error.message : String(error)}`), {
        code: "malformed_response_event",
      }), { ...(context ?? { provider: "provider", operation: "stream" }), protocol: true });
    }
  };
  while (true) {
    const chunk = context ? await readStreamChunk(streamReader, context) : await streamReader.read();
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line === "") {
        const event = parseResponseEvent();
        if (event) yield event;
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).trimStart());
      }
      newline = buffer.indexOf("\n");
    }
    if (chunk.done) break;
  }
  if (buffer.startsWith("data:")) data.push(buffer.slice(5).trimStart());
  const event = parseResponseEvent();
  if (event) yield event;
}

export function isStaleResponseError(value: unknown, requestWasAnchored: boolean): boolean {
  const detail = detailFrom(value);
  const directMessage = value instanceof Error ? value.message : "";
  const status = value && typeof value === "object" && "status" in value
    ? (value as { status?: unknown }).status
    : undefined;
  if ([
    "previous_response_not_found",
    "codex_previous_response_stale",
    "previous_response_owner_unavailable",
    "turn_state_owner_unavailable",
    "previous_response_first_event_timeout",
    "malformed_response",
    "malformed_response_event",
  ].includes(detail.code ?? "")) return true;
  if (
    detail.code === "invalid_request_error" &&
    detail.param === "previous_response_id" &&
    /previous response.*not found/i.test(detail.message ?? "")
  ) return true;
  return requestWasAnchored && (
    detail.code === "stream_incomplete"
    || /previous response owner account is unavailable/i.test(detail.message ?? "")
    || /rsp\.output is not iterable/i.test(directMessage)
    || status === 502
  );
}

function asEffort(value: string | null | undefined): ReasoningEffort | null {
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value ?? "")
    ? value as ReasoningEffort
    : null;
}

function lmStudioEffort(value: string | null | undefined): ReasoningEffort | null {
  if (value === "off") return "none";
  if (value === "on") return "medium";
  return asEffort(value);
}

function asVerbosity(value: string | null | undefined): Verbosity {
  return ["low", "medium", "high"].includes(value ?? "") ? value as Verbosity : "low";
}

export function modelInfo(raw: RawModel): ModelInfo {
  const metadata = raw.metadata ?? {};
  const advertisedEfforts = (metadata.supported_reasoning_levels ?? [])
    .map((entry) => asEffort(entry.effort))
    .filter((effort): effort is ReasoningEffort => effort !== null);
  const efforts = [...new Set(advertisedEfforts)];
  const supportsReasoning = raw.capabilities?.supports_reasoning ?? raw.supports_reasoning ?? efforts.length > 0;
  const reasoningEfforts: ReasoningEffort[] = supportsReasoning
    ? efforts.length > 0 ? efforts : ["low", "medium", "high"]
    : ["none"];
  const advertisedDefault = asEffort(metadata.default_reasoning_level);
  const defaultReasoningEffort = advertisedDefault && reasoningEfforts.includes(advertisedDefault)
    ? advertisedDefault
    : reasoningEfforts.includes("medium") ? "medium" : reasoningEfforts[0] ?? "none";
  const contextWindow = metadata.input_context_window ?? metadata.context_window ?? raw.capabilities?.context_length
    ?? raw.context_length ?? 128_000;
  const supportsFast = metadata.additional_speed_tiers?.includes("fast") === true
    || metadata.service_tiers?.some((tier) => tier.id === "priority") === true;
  return {
    id: raw.id,
    name: metadata.display_name ?? raw.id,
    description: metadata.description ?? "",
    contextWindow,
    maxOutputTokens: metadata.max_output_tokens ?? raw.capabilities?.max_output_tokens ?? raw.max_output_tokens ?? null,
    reasoningEfforts,
    defaultReasoningEffort,
    defaultVerbosity: asVerbosity(metadata.default_verbosity),
    supportsReasoning,
    supportsImages: raw.capabilities?.supports_images ?? raw.supports_images ?? false,
    supportsParallelToolCalls: metadata.supports_parallel_tool_calls ?? true,
    supportsFast,
    priority: metadata.priority ?? 1_000,
  };
}

/** Metadata for providers whose catalog does not advertise capabilities reliably. */
export function customModelInfo(raw: RawModel): ModelInfo {
  const name = typeof raw.name === "string" && raw.name.trim()
    ? raw.name
    : typeof raw.metadata?.display_name === "string" && raw.metadata.display_name.trim()
      ? raw.metadata.display_name
      : raw.id;
  const description = typeof raw.description === "string"
    ? raw.description
    : typeof raw.metadata?.description === "string" ? raw.metadata.description : "";
  const contextWindow = [raw.context_length, raw.metadata?.context_window, raw.capabilities?.context_length]
    .find((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0) ?? 32_768;
  const maxOutputTokens = [raw.max_output_tokens, raw.metadata?.max_output_tokens, raw.capabilities?.max_output_tokens]
    .find((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0) ?? null;
  return {
    id: raw.id,
    name,
    description,
    contextWindow,
    maxOutputTokens,
    reasoningEfforts: ["none"],
    defaultReasoningEffort: "none",
    defaultVerbosity: "low",
    supportsReasoning: false,
    supportsImages: false,
    supportsParallelToolCalls: false,
    supportsFast: false,
    priority: 1_000,
  };
}

export function lmStudioModelInfo(raw: LmStudioModel): ModelInfo {
  const supportsReasoning = raw.capabilities?.reasoning !== undefined;
  const efforts = (raw.capabilities?.reasoning?.allowed_options ?? [])
    .map((value) => lmStudioEffort(value))
    .filter((value): value is ReasoningEffort => value !== null);
  return {
    id: raw.key,
    name: raw.display_name ?? raw.key,
    description: raw.description ?? "",
    contextWindow: raw.loaded_instances?.[0]?.config?.context_length ?? raw.max_context_length ?? 128_000,
    maxOutputTokens: null,
    reasoningEfforts: efforts.length > 0 ? efforts : ["medium"],
    defaultReasoningEffort: lmStudioEffort(raw.capabilities?.reasoning?.default) ?? efforts[0] ?? "medium",
    defaultVerbosity: "low",
    supportsReasoning,
    supportsImages: raw.capabilities?.vision ?? false,
    supportsParallelToolCalls: raw.capabilities?.trained_for_tool_use ?? false,
    supportsFast: false,
    priority: raw.loaded_instances?.length ? 0 : 1_000,
  };
}

function numericPrice(value: string | number | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function openRouterModelInfo(raw: OpenRouterModel): ModelInfo {
  const supported = new Set(raw.supported_parameters ?? []);
  const architecture = raw.architecture ?? {};
  const pricing = raw.pricing ?? {};
  const isFree = raw.id.toLowerCase().endsWith(":free")
    || (numericPrice(pricing.prompt) === 0 && numericPrice(pricing.completion) === 0);
  const advertisesReasoning = supported.has("reasoning") || supported.has("reasoning_effort");
  const advertisedEfforts = raw.reasoning?.supported_efforts;
  const mappedEfforts = advertisedEfforts === null
    ? (["none", "minimal", "low", "medium", "high", "xhigh", "max"] satisfies ReasoningEffort[])
    : Array.isArray(advertisedEfforts)
      ? advertisedEfforts.map((effort) => asEffort(effort)).filter((effort): effort is ReasoningEffort => effort !== null)
      : advertisesReasoning ? (["low", "medium", "high"] satisfies ReasoningEffort[]) : [];
  const efforts = raw.reasoning?.mandatory ? mappedEfforts.filter((effort) => effort !== "none") : mappedEfforts;
  const supportsReasoning = advertisesReasoning && efforts.length > 0;
  const advertisedDefault = asEffort(raw.reasoning?.default_effort);
  const defaultReasoningEffort = advertisedDefault && efforts.includes(advertisedDefault)
    ? advertisedDefault
    : efforts.includes("medium") ? "medium"
      : efforts.includes("high") ? "high"
        : efforts[0] ?? "none";
  const supportsImages = (architecture.input_modalities ?? []).some((value) => /image/i.test(value));
  const supportsTools = supported.has("tools") || supported.has("tool_choice")
    || supported.has("parallel_tool_calls") || supported.has("function_calling");
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    description: raw.description ?? "",
    contextWindow: raw.context_length ?? raw.top_provider?.context_length ?? 128_000,
    maxOutputTokens: raw.max_completion_tokens ?? raw.top_provider?.max_completion_tokens
      ?? raw.max_output_tokens ?? null,
    reasoningEfforts: supportsReasoning ? efforts : ["none"],
    defaultReasoningEffort: supportsReasoning ? defaultReasoningEffort : "none",
    defaultVerbosity: "low",
    supportsReasoning,
    supportsImages,
    supportsParallelToolCalls: supportsTools && supported.has("parallel_tool_calls"),
    supportsFast: false,
    priority: isFree ? 0 : 1_000,
    isFree,
  };
}

export function responseText(response: Pick<Response, "output" | "output_text">): string {
  if (response.output_text) return response.output_text;
  const parts: string[] = [];
  for (const item of response.output) {
    if (item.type !== "message") continue;
    for (const content of item.content) {
      if (content.type === "output_text") parts.push(content.text);
    }
  }
  return parts.join("");
}

function redactLmStudioReasoning(response: Response): Response {
  const output: Response["output"] = [];
  for (const item of response.output) {
    if (item.type !== "reasoning") {
      output.push(item);
      continue;
    }
    const record = item as unknown as Record<string, unknown>;
    const summary = Array.isArray(record.summary)
      ? record.summary.flatMap((part) => {
        if (!part || typeof part !== "object") return [];
        const summaryPart = part as Record<string, unknown>;
        return summaryPart.type === "summary_text" && typeof summaryPart.text === "string"
          ? [{ type: "summary_text", text: summaryPart.text }]
          : [];
      })
      : [];
    if (summary.length > 0) {
      const safeRecord: Record<string, unknown> = {
        id: record.id,
        type: "reasoning",
        ...(typeof record.status === "string" ? { status: record.status } : {}),
        summary,
      };
      output.push(safeRecord as unknown as Response["output"][number]);
    }
  }
  return {
    ...response,
    output,
  };
}

function compactTranscript(input: ResponseInputItem[]): string {
  const lines: string[] = [];
  for (const item of input) {
    if (item.type === "reasoning") continue;
    if (item.type === "function_call") {
      lines.push(`ASSISTANT TOOL CALL ${item.name} [${item.call_id}]: ${item.arguments}`);
      continue;
    }
    if (item.type === "function_call_output") {
      lines.push(`TOOL RESULT ${item.call_id}: ${typeof item.output === "string" ? item.output : JSON.stringify(item.output)}`);
      continue;
    }
    const message = item as unknown as { role?: string; content?: unknown };
    if (!message.role) continue;
    if (typeof message.content === "string") {
      if (message.content) lines.push(`${message.role.toUpperCase()}: ${message.content}`);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    const text = message.content.map((content: unknown) => {
      if (!content || typeof content !== "object") return "";
      const part = content as { type?: string; text?: string; refusal?: string };
      if ((part.type === "input_text" || part.type === "output_text" || part.type === "text") && part.text) return part.text;
      if (part.type === "refusal" && part.refusal) return `REFUSAL: ${part.refusal}`;
      if (part.type === "input_image") return "[IMAGE ATTACHMENT PRESERVED BELOW]";
      if (part.type === "input_file") return "[FILE ATTACHMENT PRESERVED BELOW]";
      return "";
    }).filter(Boolean).join("\n");
    if (text) lines.push(`${message.role.toUpperCase()}: ${text}`);
  }
  return lines.join("\n\n");
}

export function requiresPortableCodexReplay(input: ResponseInputItem[]): boolean {
  if (input.some((item) => item.type === "compaction")) return false;
  return input.some((item) => {
    const record = item as unknown as Record<string, unknown>;
    if (item.type === "reasoning") {
      return typeof record.encrypted_content !== "string" || record.encrypted_content.length === 0;
    }
    if (item.type === "function_call" && typeof record.id === "string") {
      return !record.id.startsWith("fc_");
    }
    const message = item as unknown as { role?: string; id?: unknown; status?: unknown };
    return message.role === "user" && (typeof message.id === "string" || typeof message.status === "string");
  });
}

function portableReplayAttachments(input: ResponseInputItem[]): unknown[] {
  return input.flatMap((item) => {
    const content = (item as unknown as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return [];
      const type = (part as { type?: unknown }).type;
      return type === "input_image" || type === "input_file" ? [structuredClone(part)] : [];
    });
  });
}

function portableCodexReplayInput(input: ResponseInputItem[]): ResponseInputItem[] {
  if (!requiresPortableCodexReplay(input)) return input;
  const transcript = compactTranscript(input);
  const attachments = portableReplayAttachments(input);
  return [{
    role: "user",
    content: [{
      type: "input_text",
      text: transcript
        ? `Portable conversation replay generated by Looking Glass:\n\n${transcript}`
        : "Portable conversation replay generated by Looking Glass. Refer to the preserved attachments below.",
    }, ...attachments],
  } as unknown as ResponseInputItem];
}

const MAX_COMPACTION_CHUNKS = 32;
const MAX_COMPACTION_OUTPUT_TOKENS = 8_192;

function chunkTranscript(transcript: string, maxChars: number): string[] {
  const limit = Math.max(16_384, Math.floor(maxChars));
  if (transcript.length <= limit) return [transcript];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < transcript.length) {
    if (chunks.length >= MAX_COMPACTION_CHUNKS) {
      throw Object.assign(new Error("conversation is too large for bounded checkpoint generation"), {
        code: "compaction_input_too_large",
      });
    }
    let end = Math.min(transcript.length, offset + limit);
    if (end < transcript.length) {
      const boundary = transcript.lastIndexOf("\n\n", end);
      if (boundary > offset + Math.floor(limit / 2)) end = boundary;
      if (/^[\uDC00-\uDFFF]$/.test(transcript[end] ?? "")) end -= 1;
    }
    const chunk = transcript.slice(offset, end).trim();
    if (chunk) chunks.push(chunk);
    offset = end;
    while (transcript.startsWith("\n", offset)) offset += 1;
  }
  return chunks;
}

function combinedUsage(values: Array<Record<string, number> | undefined>): Record<string, number> | undefined {
  const present = values.filter((value): value is Record<string, number> => value !== undefined);
  if (present.length === 0) return undefined;
  const inputTokens = present.reduce((sum, value) => sum + (value.input_tokens ?? 0), 0);
  const outputTokens = present.reduce((sum, value) => sum + (value.output_tokens ?? 0), 0);
  return { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
}

function lmStudioModelsURL(baseURL: string): string {
  const url = new URL(baseURL);
  url.pathname = `${url.pathname.replace(/\/?v1\/?$/, "")}/api/v1/models`.replace(/\/+/g, "/");
  return url.toString();
}

type OpenRouterChatMessage = Record<string, unknown>;

function chatContent(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts: unknown[] = (value as unknown[]).flatMap((part: unknown): unknown[] => {
    if (!part || typeof part !== "object") return [];
    const item = part as Record<string, unknown>;
    if ((item.type === "input_text" || item.type === "output_text" || item.type === "text")
      && typeof item.text === "string") return [{ type: "text", text: item.text }];
    if (item.type === "refusal" && typeof item.refusal === "string") {
      return [{ type: "text", text: item.refusal }];
    }
    if (item.type === "input_image" && typeof item.image_url === "string") {
      return [{ type: "image_url", image_url: { url: item.image_url } }];
    }
    return [];
  });
  return parts.length === 1 && typeof parts[0] === "string" ? parts[0] : parts;
}

function reasoningSummaryText(item: Record<string, unknown>): string {
  if (!Array.isArray(item.summary)) return "";
  return item.summary.map((part) => part && typeof part === "object"
    && typeof (part as Record<string, unknown>).text === "string"
    ? (part as Record<string, string>).text : "").join("");
}

export function openRouterMessages(
  instructions: string,
  input: ResponseInputItem[],
  includeReasoningContent = false,
): OpenRouterChatMessage[] {
  const messages: OpenRouterChatMessage[] = [];
  let pendingReasoning = "";
  if (instructions.trim()) messages.push({ role: "system", content: instructions });
  for (const raw of input) {
    const item = raw as unknown as Record<string, unknown>;
    if (item.type === "reasoning") {
      if (includeReasoningContent) pendingReasoning += reasoningSummaryText(item);
      continue;
    }
    if (item.type === "compaction") continue;
    if (item.type === "function_call") {
      const previous = messages.at(-1);
      const call = {
        id: typeof item.call_id === "string" ? item.call_id : String(item.id ?? "call_unknown"),
        type: "function",
        function: {
          name: typeof item.name === "string" ? item.name : "tool",
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      };
      if (previous?.role === "assistant") {
        if (Array.isArray(previous.tool_calls)) previous.tool_calls.push(call);
        else previous.tool_calls = [call];
        if (pendingReasoning) previous.reasoning_content = pendingReasoning;
      } else messages.push({
        role: "assistant",
        content: null,
        tool_calls: [call],
        ...(pendingReasoning ? { reasoning_content: pendingReasoning } : {}),
      });
      pendingReasoning = "";
      continue;
    }
    if (item.type === "function_call_output") {
      pendingReasoning = "";
      messages.push({
        role: "tool",
        tool_call_id: typeof item.call_id === "string" ? item.call_id : String(item.id ?? "call_unknown"),
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      });
      continue;
    }
    const role = item.role === "developer" ? "system"
      : item.role === "assistant" ? "assistant" : item.role === "system" ? "system" : "user";
    messages.push({
      role,
      content: chatContent(item.content),
      ...(role === "assistant" && pendingReasoning ? { reasoning_content: pendingReasoning } : {}),
    });
    pendingReasoning = "";
  }
  return messages;
}

export function buildOpenRouterParams(request: ResponseRequest): Record<string, unknown> {
  const tools = request.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    },
  }));
  return {
    model: request.model,
    messages: openRouterMessages(request.instructions, request.input),
    ...(tools.length > 0
      ? { tools, ...(request.supportsParallelToolCalls ? { parallel_tool_calls: true } : {}) }
      : {}),
    ...(request.supportsReasoning ? { reasoning: { effort: request.reasoningEffort } } : {}),
  };
}

export function buildCustomChatParams(
  request: ResponseRequest,
  includeReasoningContent = false,
): Record<string, unknown> {
  const tools = request.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    },
  }));
  return {
    model: request.model,
    messages: openRouterMessages(request.instructions, request.input, includeReasoningContent),
    ...(tools.length > 0
      ? { tools, ...(request.supportsParallelToolCalls ? { parallel_tool_calls: true } : {}) }
      : {}),
  };
}

const MAX_HTTP_ERROR_BYTES = 64 * 1024;

async function boundedText(response: globalThis.Response, limit = MAX_HTTP_ERROR_BYTES): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < limit) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = next.value ?? new Uint8Array();
    const take = Math.min(chunk.byteLength, limit - total);
    if (take > 0) chunks.push(chunk.slice(0, take));
    total += take;
    if (take < chunk.byteLength) {
      await reader.cancel();
      break;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function boundedResponseText(response: globalThis.Response, context: ProviderErrorContext): Promise<string> {
  try {
    return await boundedText(response);
  } catch (error) {
    throw providerError(error, context);
  }
}

function parseJsonBody(text: string): unknown {
  if (!text.trim()) return "";
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

function normalizedUsage(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const numberValue = (...keys: string[]): number => {
    for (const key of keys) {
      const candidate = usage[key];
      if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) return candidate;
    }
    return 0;
  };
  const inputTokens = numberValue("input_tokens", "prompt_tokens");
  const outputTokens = numberValue("output_tokens", "completion_tokens");
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: numberValue("total_tokens") || inputTokens + outputTokens,
  };
}

function requestContext(provider: string, operation: string, apiKey: string, signal?: AbortSignal, timeoutSignal?: AbortSignal): ProviderErrorContext {
  return {
    provider,
    operation,
    configuredSecrets: [apiKey],
    ...(signal ? { callerSignal: signal } : {}),
    ...(timeoutSignal ? { timeoutSignal } : {}),
  };
}

async function readJsonResponse(response: globalThis.Response, context: ProviderErrorContext): Promise<unknown> {
  let text: string;
  try {
    text = response.ok ? await response.text() : await boundedText(response);
  } catch (error) {
    throw providerError(error, context);
  }
  if (!response.ok) throw providerHttpError(response.status, parseJsonBody(text), context);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw providerError(Object.assign(new Error("response was not valid JSON"), { cause: error }), {
      ...context,
      protocol: true,
    });
  }
}

function objectPayload(payload: unknown, context: ProviderErrorContext, message: string): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw providerError({ code: "malformed_response", message }, { ...context, protocol: true });
  }
  return payload as Record<string, unknown>;
}

async function readStreamChunk(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
  context: ProviderErrorContext,
): Promise<{ done: boolean; value?: Uint8Array }> {
  try {
    return await reader.read();
  } catch (error) {
    throw providerError(error, context);
  }
}

async function* openRouterEvents(response: globalThis.Response, context: ProviderErrorContext): AsyncGenerator<unknown> {
  if (!response.body) throw providerError({ code: "malformed_response", message: "response had no body" }, { ...context, protocol: true });
  const streamReader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let ended = false;
  const emit = (): unknown | null => {
    const payload = data.join("\n").trim();
    data = [];
    if (!payload) return null;
    if (payload === "[DONE]") return { done: true };
    try { return JSON.parse(payload) as unknown; }
    catch (error) {
      throw providerError(Object.assign(new Error("malformed SSE event JSON"), {
        cause: error,
        code: "malformed_response_event",
      }), { ...context, protocol: true });
    }
  };
  try {
    while (true) {
      const chunk = await readStreamChunk(streamReader, context);
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          const event = emit();
          if (event) {
            if (typeof event === "object" && event !== null && "done" in event) ended = true;
            yield event;
          }
        } else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        newline = buffer.indexOf("\n");
      }
      if (chunk.done) break;
    }
    if (buffer.startsWith("data:")) data.push(buffer.slice(5).trimStart());
    const event = emit();
    if (event) {
      if (typeof event === "object" && event !== null && "done" in event) ended = true;
      yield event;
    }
    if (!ended) throw providerError({ code: "stream_incomplete", message: "response stream ended without [DONE]" }, context);
  } finally {
    try {
      await streamReader.cancel();
    } catch {
      // The stream may already be closed by the fetch implementation.
    }
    streamReader.releaseLock();
  }
}

export class CodexLbClient {
  private apiKey: string;
  private readonly lmStudioAgent: Agent | undefined;

  constructor(private readonly config: GlassConfig) {
    const configuredApiKey = process.env[config.gateway.apiKeyEnv] ?? "";
    this.apiKey = configuredApiKey || "local-looking-glass";
    if (config.gateway.provider === "lm-studio") {
      // Local model prefill and token generation can leave the connection quiet
      // for longer than Undici's 300-second headers/body defaults. The request
      // AbortSignal remains the overall finite deadline for this client.
      this.lmStudioAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
    }
  }

  private requireOpenCodeApiKey(): void {
    if (this.config.gateway.provider !== "opencode-go") return;
    const configuredApiKey = process.env[this.config.gateway.apiKeyEnv] ?? "";
    if (configuredApiKey.trim() === "") {
      throw new Error(`Missing OpenCode Go API key in ${this.config.gateway.apiKeyEnv}`);
    }
    this.apiKey = configuredApiKey;
  }

  private fetchOptions(init: RequestInit): RequestInit {
    // Node's fetch types use the bundled Undici version, while the direct
    // dependency can have a different set of structurally incompatible types.
    return this.lmStudioAgent
      ? ({ ...init, dispatcher: this.lmStudioAgent } as unknown as RequestInit)
      : init;
  }

  close(): void {
    void this.lmStudioAgent?.close();
  }

  supportsResponseContinuity(): boolean {
    return this.config.gateway.provider === "codex-lb";
  }

  async models(signal?: AbortSignal): Promise<ModelInfo[]> {
    this.requireOpenCodeApiKey();
    const provider = this.config.gateway.provider;
    const timeout = AbortSignal.timeout(this.config.gateway.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const context = requestContext(provider, "models", this.apiKey, signal, timeout);
    if (this.config.gateway.provider === "lm-studio") {
      try {
        const response = await fetch(lmStudioModelsURL(this.config.gateway.baseURL), this.fetchOptions({
          headers: { authorization: `Bearer ${this.apiKey}` },
          signal: requestSignal,
        }));
        const nativeContext = { ...context, operation: "models (native catalog)" };
        const payload = objectPayload(
          await readJsonResponse(response, nativeContext),
          nativeContext,
          "model catalog returned an invalid payload",
        ) as LmStudioModelsResponse;
        const models = (Array.isArray(payload.models) ? payload.models : [])
          .filter((model) => model && typeof model === "object" && model.type === "llm" && typeof model.key === "string")
          .map(lmStudioModelInfo)
          .sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name));
        if (models.length > 0) return models;
      } catch (error) {
        if (signal?.aborted) throw error;
        // Older LM Studio versions and restricted tokens may only expose /v1/models.
      }
    }
    let response: globalThis.Response;
    try {
      response = await fetch(`${this.config.gateway.baseURL.replace(/\/$/, "")}/models`, this.fetchOptions({
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: requestSignal,
      }));
    } catch (error) {
      throw providerError(error, context);
    }
    const payload = objectPayload(
      await readJsonResponse(response, context),
      context,
      "model catalog returned an invalid payload",
    ) as { data?: RawModel[] };
    if (payload.data !== undefined && !Array.isArray(payload.data)) {
      throw providerError({ code: "malformed_response", message: "model catalog data was not an array" }, { ...context, protocol: true });
    }
    const models = (payload.data ?? []).filter((model) => model && typeof model === "object" && typeof model.id === "string");
    if (provider === "opencode-go") {
      return models
        .map((model) => openCodeGoModelInfo(model))
        .sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name));
    }
    if (provider === "custom") {
      return models
        .map((model) => customModelInfo(model as unknown as RawModel))
        .sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name));
    }
    if (provider === "openrouter") {
      return models
        .map((model) => openRouterModelInfo(model as unknown as OpenRouterModel))
        .sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name));
    }
    return models
      .filter((model) => model.metadata?.supported_in_api !== false)
      .map(modelInfo)
      .sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name));
  }

  private async anthropicMessagesStream(request: ResponseRequest, callbacks: StreamCallbacks): Promise<Response> {
    const timeout = AbortSignal.timeout(this.config.gateway.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const context = requestContext("opencode-go", "stream", this.apiKey, request.signal, timeout);
    let http: globalThis.Response;
    try {
      http = await fetch(`${this.config.gateway.baseURL.replace(/\/$/, "")}/messages`, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(buildAnthropicMessagesParams(request)),
        signal,
      });
    } catch (error) {
      throw providerError(error, context);
    }
    return parseAnthropicMessagesStream(http, callbacks, context);
  }

  private async openRouterStream(
    request: ResponseRequest,
    callbacks: StreamCallbacks,
    provider: "openrouter" | "custom" | "opencode-go" = "openrouter",
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(this.config.gateway.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const context = requestContext(provider, "stream", this.apiKey, request.signal, timeout);
    let http: globalThis.Response;
    try {
      http = await fetch(`${this.config.gateway.baseURL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(provider === "custom" || provider === "opencode-go"
          ? {
              ...buildCustomChatParams(request, provider === "opencode-go" && request.supportsReasoning),
              ...(provider === "opencode-go" && request.supportsReasoning
                ? openCodeGoReasoningParams(request.model, request.reasoningEffort)
                : {}),
              stream: true,
            }
          : { ...buildOpenRouterParams(request), stream: true, stream_options: { include_usage: true } }),
        signal,
      });
    } catch (error) {
      throw providerError(error, context);
    }
    if (!http.ok) {
      const text = await boundedResponseText(http, context);
      throw providerHttpError(http.status, parseJsonBody(text), context);
    }
    const outputText: string[] = [];
    const reasoningText: string[] = [];
    const refusalText: string[] = [];
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    let id = "";
    let model = request.model;
    let usage: Record<string, unknown> | undefined;
    let finishReason: string | undefined;
    callbacks.onEvent?.({ type: "response.created", response: { id: "", status: "in_progress", model, output: [] } } as unknown as ResponseStreamEvent);
    for await (const raw of openRouterEvents(http, context)) {
      if (!raw || typeof raw !== "object") continue;
      if ((raw as { done?: boolean }).done) break;
      const event = raw as Record<string, unknown>;
      if (event.error !== undefined) throw providerError(event.error, context);
      if (typeof event.id === "string") id ||= event.id;
      if (typeof event.model === "string") model = event.model;
      if (event.usage && typeof event.usage === "object") usage = event.usage as Record<string, unknown>;
      const choices = Array.isArray(event.choices) ? event.choices : [];
      for (const choice of choices) {
        if (!choice || typeof choice !== "object") continue;
        const choiceRecord = choice as Record<string, unknown>;
        if (typeof choiceRecord.finish_reason === "string") finishReason = choiceRecord.finish_reason;
        const delta = choiceRecord.delta;
        if (!delta || typeof delta !== "object") continue;
        const item = delta as Record<string, unknown>;
        const text = typeof item.content === "string" ? item.content : "";
        if (text) {
          outputText.push(text);
          callbacks.onTextDelta?.(text);
          callbacks.onEvent?.({ type: "response.output_text.delta", delta: text } as unknown as ResponseStreamEvent);
        }
        const refusal = typeof item.refusal === "string" ? item.refusal : "";
        if (refusal) refusalText.push(refusal);
        const detailReasoning = Array.isArray(item.reasoning_details)
          ? item.reasoning_details.map((detail) => detail && typeof detail === "object"
            && typeof (detail as Record<string, unknown>).text === "string"
            ? (detail as Record<string, string>).text : "").join("")
          : "";
        const reasoning = typeof item.reasoning === "string" ? item.reasoning
          : typeof item.reasoning_content === "string" ? item.reasoning_content : detailReasoning;
        if (reasoning) {
          reasoningText.push(reasoning);
          callbacks.onEvent?.({ type: "response.reasoning_summary_text.delta", delta: reasoning } as unknown as ResponseStreamEvent);
        }
        if (Array.isArray(item.tool_calls)) {
          for (const tool of item.tool_calls) {
            if (!tool || typeof tool !== "object") continue;
            const call = tool as Record<string, unknown>;
            const index = typeof call.index === "number" ? call.index : toolCalls.size;
            const fn = call.function && typeof call.function === "object" ? call.function as Record<string, unknown> : {};
            const current = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
            if (typeof call.id === "string") current.id = call.id;
            if (typeof fn.name === "string") current.name += fn.name;
            if (typeof fn.arguments === "string") current.arguments += fn.arguments;
            toolCalls.set(index, current);
            if (typeof fn.arguments === "string") callbacks.onEvent?.({
              type: "response.function_call_arguments.delta", delta: fn.arguments,
            } as unknown as ResponseStreamEvent);
          }
        }
      }
    }
    id ||= `chatcmpl_${Date.now().toString(36)}`;
    const output: unknown[] = [];
    if (reasoningText.length > 0) output.push({
      id: `reasoning_${id}`, type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: reasoningText.join("") }], content: [],
    });
    if (outputText.length > 0) output.push({
      id: `msg_${id}`, type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: outputText.join(""), annotations: [], logprobs: [] }],
    });
    if (refusalText.length > 0) output.push({
      id: `refusal_${id}`, type: "message", role: "assistant", status: "completed",
      content: [{ type: "refusal", refusal: refusalText.join("") }],
    });
    const callOutputIndices = new Map<number, number>();
    for (const [index, call] of [...toolCalls.entries()].sort(([left], [right]) => left - right)) {
      callOutputIndices.set(index, output.length);
      output.push({ id: call.id || `call_${id}_${index}`, type: "function_call", call_id: call.id || `call_${id}_${index}`, name: call.name, arguments: call.arguments, status: "completed" });
    }
    const incompleteReason = finishReason === "length" ? "max_output_tokens"
      : finishReason === "content_filter" ? "content_filter" : undefined;
    if (output.length === 0 && !incompleteReason) {
      throw providerError({
        code: "empty_response",
        message: "provider returned an empty completion stream",
      }, { ...context, protocol: true });
    }
    for (const [index, item] of output.entries()) callbacks.onEvent?.({ type: "response.output_item.done", output_index: index, item } as unknown as ResponseStreamEvent);
    for (const [index, call] of [...toolCalls.entries()].sort(([left], [right]) => left - right)) {
      callbacks.onEvent?.({
        type: "response.function_call_arguments.done", output_index: callOutputIndices.get(index), arguments: call.arguments,
      } as unknown as ResponseStreamEvent);
    }
    const response = {
      id, object: "response", created: Math.floor(Date.now() / 1000), model,
      status: incompleteReason ? "incomplete" : "completed", output,
      output_text: outputText.join(""),
      ...(incompleteReason ? { incomplete_details: { reason: incompleteReason } } : {}),
      ...(usage ? { usage: {
        input_tokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
        output_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
        total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens
          : (typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0)
            + (typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0),
      } } : {}),
    } as unknown as Response;
    callbacks.onEvent?.({
      type: incompleteReason ? "response.incomplete" : "response.completed",
      response,
    } as unknown as ResponseStreamEvent);
    return response;
  }

  async stream(request: ResponseRequest, callbacks: StreamCallbacks = {}): Promise<Response> {
    this.requireOpenCodeApiKey();
    if (this.config.gateway.provider === "openrouter") return this.openRouterStream(request, callbacks);
    if (this.config.gateway.provider === "opencode-go") {
      const protocol = openCodeGoProfile(request.model).protocol;
      if (protocol === "chat") return this.openRouterStream(request, callbacks, "opencode-go");
      if (protocol === "messages") return this.anthropicMessagesStream(request, callbacks);
    }
    if (this.config.gateway.provider === "custom" && this.config.gateway.protocol === "chat") {
      return this.openRouterStream(request, callbacks, "custom");
    }
    const params = buildResponseParams(this.config.gateway.provider, request);
    const timeout = AbortSignal.timeout(this.config.gateway.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const context = requestContext(this.config.gateway.provider, "stream", this.apiKey, request.signal, timeout);
    let http: globalThis.Response;
    try {
      http = await fetch(`${this.config.gateway.baseURL}/responses`, this.fetchOptions({
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({ ...params, stream: true }),
        signal,
      }));
    } catch (error) {
      throw providerError(error, context);
    }
    if (!http.ok) {
      throw providerHttpError(http.status, parseJsonBody(await boundedResponseText(http, context)), context);
    }

    let created: Record<string, unknown> = {};
    let terminal: Record<string, unknown> | null = null;
    let terminalType: string | undefined;
    let streamedError: unknown = null;
    let sawTerminal = false;
    const output = new Map<number, unknown>();
    for await (const event of responseEvents(http, context)) {
      callbacks.onEvent?.(event as ResponseStreamEvent);
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        callbacks.onTextDelta?.(event.delta);
      }
      if (event.type === "response.created" && event.response) created = event.response;
      if ((event.type === "response.output_item.added" || event.type === "response.output_item.done")
        && Number.isInteger(event.output_index) && event.item !== undefined) {
        output.set(event.output_index as number, event.item);
      }
      if (["response.completed", "response.done", "response.failed", "response.incomplete"].includes(event.type ?? "")) {
        sawTerminal = true;
        terminalType = event.type;
        terminal = event.response ?? {};
      }
      if (event.type === "error") streamedError = event.error ?? event;
      if (event.type === "response.failed") streamedError = event.response?.error ?? event;
      if (event.type === "response.incomplete") streamedError = event.response?.incomplete_details ?? event;
      // Gateway extension events such as response.metadata are intentionally ignored.
    }
    if (!sawTerminal) {
      if (streamedError) {
        throw providerError(streamedError, context);
      }
      throw providerError({ code: "stream_incomplete", message: "response stream ended without a terminal event" }, context);
    }
    const combined = { ...created, ...(terminal ?? {}) };
    const terminalOutput = Array.isArray(combined.output) ? combined.output : [];
    const canonicalOutput = terminalOutput.length > 0
      ? terminalOutput
      : [...output.entries()].sort(([left], [right]) => left - right).map(([, item]) => item);
    const status = terminalType === "response.incomplete" ? "incomplete"
      : terminalType === "response.failed" ? "failed"
        : typeof combined.status === "string" ? combined.status
          : streamedError ? "failed" : "completed";
    if (streamedError || status === "failed" || status === "incomplete") {
      throw providerError(streamedError ?? combined.error ?? combined.incomplete_details ?? { message: `Response ${status}` }, {
        ...context,
        responseStatus: status,
      });
    }
    if (typeof combined.id !== "string" || !combined.id || canonicalOutput.length === 0) {
      throw providerError({ code: "malformed_response", message: "response stream returned an invalid completed response" }, {
        ...context,
        protocol: true,
      });
    }
    const canonical = {
      ...combined,
      id: combined.id,
      status,
      output: canonicalOutput,
      output_text: "",
    } as unknown as Response;
    canonical.output_text = responseText(canonical);
    return this.config.gateway.provider === "lm-studio" ? redactLmStudioReasoning(canonical) : canonical;
  }

  private async anthropicMessagesCompact(request: CompactRequest): Promise<Record<string, unknown>> {
    const transcript = compactTranscript(request.input);
    const timeout = AbortSignal.timeout(this.config.gateway.timeoutMs);
    const context = requestContext("opencode-go", "compact", this.apiKey, request.signal, timeout);
    if (!transcript) throw providerError({ code: "malformed_response", message: "compaction received no semantic transcript" }, {
      ...context,
      protocol: true,
    });
    const profile: ResponseRequest = {
      model: request.model,
      instructions: [
        request.instructions,
        "Create a dense, durable checkpoint of the supplied conversation.",
        "Preserve user requirements, decisions, relevant facts, file paths, code changes, tool outcomes, unresolved work, and safety constraints.",
        "Do not continue the task, call tools, or add commentary. Return only the checkpoint text.",
      ].filter((part) => part.trim()).join(" "),
      input: [{
        role: "user",
        content: [{ type: "input_text", text: `Conversation transcript:\n\n${transcript}` }],
      }],
      tools: [],
      promptCacheKey: request.promptCacheKey,
      reasoningEffort: "none",
      supportsReasoning: false,
      supportsParallelToolCalls: false,
      verbosity: "low",
      fast: false,
      ...(request.signal ? { signal: request.signal } : {}),
    };
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let http: globalThis.Response;
    try {
      const body = { ...buildAnthropicMessagesParams(profile, { maxTokens: 8_192, includeReasoning: false }), stream: false };
      http = await fetch(`${this.config.gateway.baseURL.replace(/\/$/, "")}/messages`, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw providerError(error, context);
    }
    const payload = await readJsonResponse(http, context);
    const summary = anthropicMessageText(payload).trim();
    if (!summary) throw providerError({ code: "malformed_response", message: "compaction returned no checkpoint text" }, {
      ...context,
      protocol: true,
    });
    const object = payload as Record<string, unknown>;
    const id = typeof object.id === "string" ? object.id : `msg_${Date.now().toString(36)}`;
    const usage = anthropicMessageUsage(payload);
    return {
      id: `compact_${id}`,
      object: "response.compaction",
      output: [{
        id: `msg_compact_${id}`,
        type: "message",
        role: "user",
        status: "completed",
        content: [{ type: "input_text", text: `Conversation checkpoint generated by Looking Glass:\n${summary}` }],
      }],
      ...(usage ? { usage } : {}),
    };
  }

  async compact(request: CompactRequest): Promise<Record<string, unknown>> {
    this.requireOpenCodeApiKey();
    const openCodeProtocol = this.config.gateway.provider === "opencode-go"
      ? openCodeGoProfile(request.model).protocol
      : undefined;
    if (openCodeProtocol === "messages") return this.anthropicMessagesCompact(request);
    if (this.config.gateway.provider === "openrouter"
      || openCodeProtocol === "chat"
      || (this.config.gateway.provider === "custom" && this.config.gateway.protocol === "chat")) {
      const chatProvider = this.config.gateway.provider;
      const semanticInput = request.input.filter((item) => item.type !== "reasoning" && item.type !== "compaction");
      if (semanticInput.length === 0) throw providerError({ code: "malformed_response", message: "compaction received no semantic transcript" }, {
        ...requestContext(chatProvider, "compact", this.apiKey, request.signal), protocol: true,
      });
      const checkpointInstructions = [
        request.instructions,
        "Create a dense, durable checkpoint of the supplied conversation.",
        "Preserve user requirements, decisions, relevant facts, file paths, code changes, tool outcomes, unresolved work, and safety constraints.",
        "Do not continue the task, call tools, or add commentary. Return only the checkpoint text.",
      ].filter((part) => part.trim()).join(" ");
      const transcript = compactTranscript(request.input);
      const openCodeProfile = openCodeProtocol === "chat" ? openCodeGoProfile(request.model) : undefined;
      const chunkChars = openCodeProfile
        ? Math.max(16_384, Math.floor(Math.max(8_192, openCodeProfile.contextWindow - 32_000) * 2))
        : Number.POSITIVE_INFINITY;
      const transcriptChunks = chunkTranscript(transcript, chunkChars);
      const maxTokens = transcriptChunks.length === 1
        ? MAX_COMPACTION_OUTPUT_TOKENS
        : Math.max(1, Math.floor(MAX_COMPACTION_OUTPUT_TOKENS / transcriptChunks.length));
      const messageSets: OpenRouterChatMessage[][] = transcriptChunks.length === 1
        ? [(() => {
            const messages = openRouterMessages(checkpointInstructions, request.input);
            messages.push({
              role: "user",
              content: "Create the durable conversation checkpoint now. Return only the checkpoint text.",
            });
            return messages;
          })()]
        : transcriptChunks.map((chunk, index) => [{
            role: "system",
            content: `${checkpointInstructions} This is transcript part ${index + 1} of ${transcriptChunks.length}; produce a self-contained checkpoint for this part.`,
          }, {
            role: "user",
            content: `Conversation transcript part ${index + 1} of ${transcriptChunks.length}:\n\n${chunk}`,
          }]);
      const summaries: string[] = [];
      const usages: Array<Record<string, number> | undefined> = [];
      const ids: string[] = [];
      for (const messages of messageSets) {
        const timeout = AbortSignal.timeout(this.config.gateway.timeoutMs);
        const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
        const context = requestContext(chatProvider, "compact", this.apiKey, request.signal, timeout);
        let http: globalThis.Response;
        try {
          http = await fetch(`${this.config.gateway.baseURL.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({
              model: request.model,
              messages,
              ...(chatProvider === "openrouter" ? { transforms: ["middle-out"] } : {}),
              max_tokens: maxTokens,
              stream: false,
            }),
            signal,
          });
        } catch (error) {
          throw providerError(error, context);
        }
        const payload = objectPayload(await readJsonResponse(http, context), context, "compaction returned an invalid payload");
        const choices = Array.isArray(payload.choices) ? payload.choices : [];
        const first = choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : {};
        const message = first.message && typeof first.message === "object" ? first.message as Record<string, unknown> : {};
        const summaryValue = typeof message.content === "string" ? message.content : chatContent(message.content);
        const summary = typeof summaryValue === "string"
          ? summaryValue.trim()
          : Array.isArray(summaryValue)
            ? summaryValue.map((part) => part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string"
              ? (part as Record<string, string>).text : "").join("\n").trim()
            : "";
        if (!summary) throw providerError({ code: "malformed_response", message: "compaction returned no checkpoint text" }, { ...context, protocol: true });
        summaries.push(summary);
        usages.push(normalizedUsage(payload.usage));
        if (typeof payload.id === "string") ids.push(payload.id);
      }
      const summary = summaries.length === 1
        ? summaries[0] ?? ""
        : summaries.map((part, index) => `Checkpoint part ${index + 1} of ${summaries.length}:\n${part}`).join("\n\n");
      const id = ids[0] ?? `compact_${Date.now().toString(36)}`;
      const usage = combinedUsage(usages);
      return {
        id: `compact_${id}`,
        object: "response.compaction",
        output: [{
          id: `msg_compact_${id}`, type: "message", role: "user", status: "completed",
          content: [{ type: "input_text", text: `Conversation checkpoint generated by Looking Glass:\n${summary}` }],
        }],
        ...(usage ? { usage } : {}),
      };
    }
    if (this.config.gateway.provider === "lm-studio"
      || openCodeProtocol === "responses"
      || (this.config.gateway.provider === "custom" && this.config.gateway.protocol === "responses")) {
      const responseProvider = this.config.gateway.provider;
      const transcript = compactTranscript(request.input);
      const compactContext = requestContext(responseProvider, "compact", this.apiKey, request.signal);
      if (!transcript) throw providerError({ code: "malformed_response", message: "compaction received no semantic transcript" }, {
        ...compactContext, protocol: true,
      });
      const profile: ResponseRequest = {
        model: request.model,
        instructions: [
          request.instructions,
          "Create a dense, durable checkpoint of the supplied conversation.",
          "Preserve user requirements, decisions, relevant facts, file paths, code changes, tool outcomes, unresolved work, and safety constraints.",
          "Do not continue the task, call tools, or add commentary. Return only the checkpoint text.",
        ].join(" "),
        input: [{
          role: "user",
          content: [{
            type: "input_text",
            text: `Conversation transcript:\n\n${transcript}`,
          }],
        }],
        tools: [],
        promptCacheKey: request.promptCacheKey,
        reasoningEffort: "none",
        supportsReasoning: responseProvider === "lm-studio",
        supportsParallelToolCalls: false,
        verbosity: "high",
        fast: false,
        ...(request.signal ? { signal: request.signal } : {}),
      };
      const timeout = AbortSignal.timeout(this.config.gateway.timeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      const context = requestContext(responseProvider, "compact", this.apiKey, request.signal, timeout);
      let http: globalThis.Response;
      try {
        http = await fetch(`${this.config.gateway.baseURL.replace(/\/$/, "")}/responses`, this.fetchOptions({
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(buildResponseParams(responseProvider, profile, "responses")),
          signal,
        }));
      } catch (error) {
        throw providerError(error, context);
      }
      const payload = await readJsonResponse(http, context);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw providerError({ code: "malformed_response", message: "compaction returned an invalid payload" }, { ...context, protocol: true });
      }
      const response = payload as Response;
      if (!Array.isArray(response.output)) {
        throw providerError({ code: "malformed_response", message: "compaction response did not contain output items" }, {
          ...context, protocol: true,
        });
      }
      const summary = responseText(response).trim();
      if (!summary) throw providerError({ code: "malformed_response", message: "compaction returned no checkpoint text" }, {
        ...context, protocol: true,
      });
      return {
        id: `compact_${response.id}`,
        object: "response.compaction",
        output: [{
          id: `msg_compact_${response.id}`,
          type: "message",
          role: "user",
          status: "completed",
          content: [{
            type: "input_text",
            text: `Conversation checkpoint generated by Looking Glass:\n${summary}`,
          }],
        }],
        usage: response.usage,
      };
    }
    const body = {
      model: request.model,
      instructions: request.instructions,
      input: portableCodexReplayInput(request.input),
      prompt_cache_key: request.promptCacheKey,
      ...(request.fast ? { service_tier: "priority" } : {}),
    };
    const timeout = AbortSignal.timeout(this.config.gateway.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const context = requestContext(this.config.gateway.provider, "compact", this.apiKey, request.signal, timeout);
    let response: globalThis.Response;
    try {
      response = await fetch(`${this.config.gateway.baseURL}/responses/compact`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw providerError(error, context);
    }
    const payload = await readJsonResponse(response, context);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw providerError({ code: "malformed_response", message: "compaction returned an invalid payload" }, { ...context, protocol: true });
    }
    const output = (payload as Record<string, unknown>).output;
    if (!Array.isArray(output) || output.length === 0
      || output.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
      throw providerError({ code: "malformed_response", message: "compaction response did not contain valid output items" }, { ...context, protocol: true });
    }
    return payload as Record<string, unknown>;
  }
}

export function chooseModel(models: ModelInfo[], configured: string | null): ModelInfo {
  if (models.length === 0) throw new Error("Gateway returned no usable models");
  if (configured) {
    const match = models.find((model) => model.id === configured);
    if (!match) throw new Error(`Configured model is not available: ${configured}`);
    return match;
  }
  return models[0] as ModelInfo;
}

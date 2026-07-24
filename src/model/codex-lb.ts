import OpenAI from "openai";
import { redactSensitiveText } from "../security.js";
import type {
  FunctionTool,
  Response,
  ResponseInputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import type { GatewayProvider, GlassConfig, ModelInfo, ReasoningEffort, Verbosity } from "../types.js";

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
  onReasoningDelta?(delta: string): void;
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

export function buildResponseParams(provider: GatewayProvider, request: ResponseRequest) {
  const common = {
    model: request.model,
    instructions: request.instructions,
    input: provider === "lm-studio"
      ? request.input.filter((item) => item.type !== "reasoning")
      : request.input,
    tools: provider === "lm-studio" ? lmStudioTools(request.tools) : request.tools,
    parallel_tool_calls: true,
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
    return { ...common, store: false, text: { format: { type: "text" as const } } };
  }
  return {
    ...common,
    store: false,
    prompt_cache_key: request.promptCacheKey,
    include: ["reasoning.encrypted_content" as const],
    text: { verbosity: request.verbosity },
    ...(request.fast ? { service_tier: "priority" as const } : {}),
  };
}

function detailFrom(value: unknown): ErrorDetail {
  if (!value || typeof value !== "object") return {};
  const outer = value as ErrorDetail;
  return outer.error && typeof outer.error === "object" ? outer.error : outer;
}

async function* responseEvents(response: globalThis.Response): AsyncGenerator<RawResponseEvent> {
  if (!response.body) throw new Error("Response stream had no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const parse = (): RawResponseEvent | null => {
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
      throw Object.assign(new Error(`Malformed response stream event: ${error instanceof Error ? error.message : String(error)}`), {
        code: "malformed_response_event",
      });
    }
  };
  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line === "") {
        const event = parse();
        if (event) yield event;
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).trimStart());
      }
      newline = buffer.indexOf("\n");
    }
    if (chunk.done) break;
  }
  if (buffer.startsWith("data:")) data.push(buffer.slice(5).trimStart());
  const event = parse();
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
  return ["none", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value ?? "")
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
  const efforts = (metadata.supported_reasoning_levels ?? [])
    .map((entry) => asEffort(entry.effort))
    .filter((effort): effort is ReasoningEffort => effort !== null);
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
    reasoningEfforts: efforts.length > 0 ? efforts : ["low", "medium", "high"],
    defaultReasoningEffort: asEffort(metadata.default_reasoning_level) ?? "medium",
    defaultVerbosity: asVerbosity(metadata.default_verbosity),
    supportsReasoning: raw.capabilities?.supports_reasoning ?? raw.supports_reasoning ?? efforts.length > 0,
    supportsImages: raw.capabilities?.supports_images ?? raw.supports_images ?? false,
    supportsParallelToolCalls: metadata.supports_parallel_tool_calls ?? true,
    supportsFast,
    priority: metadata.priority ?? 1_000,
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
  return {
    ...response,
    output: response.output.filter((item) => item.type !== "reasoning"),
  };
}

function compactTranscript(input: ResponseInputItem[]): string {
  const lines: string[] = [];
  for (const item of input) {
    if (item.type === "reasoning") continue;
    if (item.type === "function_call") {
      lines.push(`ASSISTANT TOOL CALL ${item.name}: ${item.arguments}`);
      continue;
    }
    if (item.type === "function_call_output") {
      lines.push(`TOOL RESULT ${item.call_id}: ${typeof item.output === "string" ? item.output : JSON.stringify(item.output)}`);
      continue;
    }
    const message = item as unknown as { role?: string; content?: unknown };
    if (!message.role || !Array.isArray(message.content)) continue;
    const text = message.content.map((content: unknown) => {
      if (!content || typeof content !== "object") return "";
      const part = content as { type?: string; text?: string };
      if ((part.type === "input_text" || part.type === "output_text") && part.text) return part.text;
      return "";
    }).filter(Boolean).join("\n");
    if (text) lines.push(`${message.role.toUpperCase()}: ${text}`);
  }
  return lines.join("\n\n");
}

function lmStudioModelsURL(baseURL: string): string {
  const url = new URL(baseURL);
  url.pathname = `${url.pathname.replace(/\/?v1\/?$/, "")}/api/v1/models`.replace(/\/+/g, "/");
  return url.toString();
}

export class CodexLbClient {
  private readonly client: OpenAI;
  private readonly apiKey: string;

  constructor(private readonly config: GlassConfig) {
    this.apiKey = process.env[config.gateway.apiKeyEnv] || "local-looking-glass";
    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: config.gateway.baseURL,
      maxRetries: 0,
      timeout: config.gateway.timeoutMs,
    });
  }

  supportsResponseContinuity(): boolean {
    return this.config.gateway.provider === "codex-lb";
  }

  private safeErrorMessage(message: string): string {
    return redactSensitiveText(message, [this.apiKey]);
  }

  async models(signal?: AbortSignal): Promise<ModelInfo[]> {
    if (this.config.gateway.provider === "lm-studio") {
      try {
        const timeout = AbortSignal.timeout(this.config.gateway.timeoutMs);
        const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const response = await fetch(lmStudioModelsURL(this.config.gateway.baseURL), {
          headers: { authorization: `Bearer ${this.apiKey}` },
          signal: requestSignal,
        });
        if (!response.ok) throw new Error(`LM Studio model metadata failed with HTTP ${response.status}`);
        const payload = await response.json() as LmStudioModelsResponse;
        const models = (payload.models ?? [])
          .filter((model) => model.type === "llm")
          .map(lmStudioModelInfo)
          .sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name));
        if (models.length > 0) return models;
      } catch (error) {
        if (signal?.aborted) throw error;
        // Older LM Studio versions and restricted tokens may only expose /v1/models.
      }
    }
    const page = await this.client.models.list(signal ? { signal } : undefined);
    return (page.data as RawModel[])
      .filter((model) => model.metadata?.supported_in_api !== false)
      .map(modelInfo)
      .sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name));
  }

  async stream(request: ResponseRequest, callbacks: StreamCallbacks = {}): Promise<Response> {
    const params = buildResponseParams(this.config.gateway.provider, request);
    const timeout = AbortSignal.timeout(this.config.gateway.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const http = await fetch(`${this.config.gateway.baseURL}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({ ...params, stream: true }),
      signal,
    });
    if (!http.ok) {
      const text = await http.text();
      let payload: unknown = text;
      try {
        payload = JSON.parse(text);
      } catch {
        // Preserve non-JSON gateway errors as their response text.
      }
      const detail = detailFrom(payload);
      const message = this.safeErrorMessage(detail.message ?? (text || `Response failed with HTTP ${http.status}`));
      throw Object.assign(new Error(message), detail, {
        status: http.status,
      });
    }

    let created: Record<string, unknown> = {};
    let terminal: Record<string, unknown> | null = null;
    let streamedError: unknown = null;
    let sawTerminal = false;
    const output = new Map<number, unknown>();
    for await (const event of responseEvents(http)) {
      callbacks.onEvent?.(event as ResponseStreamEvent);
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        callbacks.onTextDelta?.(event.delta);
      }
      if (event.type === "response.reasoning_summary_text.delta" && typeof event.delta === "string") {
        callbacks.onReasoningDelta?.(event.delta);
      }
      if (event.type === "response.created" && event.response) created = event.response;
      if ((event.type === "response.output_item.added" || event.type === "response.output_item.done")
        && Number.isInteger(event.output_index) && event.item !== undefined) {
        output.set(event.output_index as number, event.item);
      }
      if (["response.completed", "response.done", "response.failed", "response.incomplete"].includes(event.type ?? "")) {
        sawTerminal = true;
        terminal = event.response ?? {};
      }
      if (event.type === "error") streamedError = event.error ?? event;
      if (event.type === "response.failed") streamedError = event.response?.error ?? event;
      if (event.type === "response.incomplete") streamedError = event.response?.incomplete_details ?? event;
      // Gateway extension events such as response.metadata are intentionally ignored.
    }
    if (!sawTerminal) {
      if (streamedError) {
        const detail = detailFrom(streamedError);
        throw Object.assign(new Error(this.safeErrorMessage(detail.message ?? "Response stream failed")), detail);
      }
      throw Object.assign(new Error("Response stream ended without a terminal event"), { code: "stream_incomplete" });
    }
    const combined = { ...created, ...(terminal ?? {}) };
    const terminalOutput = Array.isArray(combined.output) ? combined.output : [];
    const canonicalOutput = terminalOutput.length > 0
      ? terminalOutput
      : [...output.entries()].sort(([left], [right]) => left - right).map(([, item]) => item);
    const status = typeof combined.status === "string"
      ? combined.status
      : streamedError ? "failed" : "completed";
    if (streamedError || status === "failed" || status === "incomplete") {
      const detail = detailFrom(streamedError ?? combined.error ?? combined.incomplete_details);
      throw Object.assign(new Error(this.safeErrorMessage(detail.message ?? `Response ${status}`)), detail, { responseStatus: status });
    }
    if (typeof combined.id !== "string" || !combined.id || canonicalOutput.length === 0) {
      throw Object.assign(new Error("Response stream returned an invalid completed response"), {
        code: "malformed_response",
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

  async compact(request: CompactRequest): Promise<Record<string, unknown>> {
    if (this.config.gateway.provider === "lm-studio") {
      const transcript = compactTranscript(request.input);
      if (!transcript) throw new Error("LM Studio compaction received no semantic transcript");
      const profile: ResponseRequest = {
        model: request.model,
        instructions: [
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
        supportsReasoning: true,
        verbosity: "high",
        fast: false,
        ...(request.signal ? { signal: request.signal } : {}),
      };
      const response = await this.client.responses.create(
        buildResponseParams("lm-studio", profile),
        request.signal ? { signal: request.signal } : undefined,
      ) as Response;
      const summary = responseText(response).trim();
      if (!summary) throw new Error("LM Studio compaction returned no checkpoint text");
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
      input: request.input,
      prompt_cache_key: request.promptCacheKey,
      ...(request.fast ? { service_tier: "priority" } : {}),
    };
    const timeout = AbortSignal.timeout(this.config.gateway.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const response = await fetch(`${this.config.gateway.baseURL}/responses/compact`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    const payload = await response.json() as unknown;
    if (!response.ok) {
      const detail = detailFrom(payload);
      throw Object.assign(new Error(this.safeErrorMessage(detail.message ?? `Compaction failed with HTTP ${response.status}`)), detail, {
        status: response.status,
      });
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Compaction returned an invalid payload");
    }
    const output = (payload as Record<string, unknown>).output;
    if (!Array.isArray(output) || output.length === 0
      || output.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
      throw new Error("Compaction response did not contain valid output items");
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

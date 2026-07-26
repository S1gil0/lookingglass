import type {
  Response,
  ResponseFunctionToolCall,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import { randomUUID } from "node:crypto";
import type { CodexLbClient } from "../model/codex-lb.js";
import { isStaleResponseError } from "../model/codex-lb.js";
import type { ArtifactStore } from "../storage/artifact-store.js";
import type { SessionStore } from "../storage/session-store.js";
import type { GatewayProvider, GlassConfig, ModelInfo, SessionRecord } from "../types.js";
import type { SessionPromptReservation } from "../scheduler/types.js";
import type { ApprovalDecision, ApprovalRequest, QuestionRequest, ToolContext, ToolResult } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { ToolDeniedError, ToolPreflightError, toolApprovalSignature } from "../tools/registry.js";
import { projectContext } from "./context.js";
import { configuredCredentialValues, redactSensitiveText, redactSensitiveValue } from "../security.js";
import type {
  StoredErrorPayload,
  StoredResponsePayload,
  StoredToolResultPayload,
  StoredUserPayload,
} from "./types.js";

export interface ToolExecutionNotice {
  callId: string;
  name: string;
  summary: string;
  output?: string;
  failed?: boolean;
}

export interface EngineInteraction {
  approve(request: ApprovalRequest): Promise<ApprovalDecision>;
  ask(request: QuestionRequest): Promise<string>;
}

export interface EngineCallbacks {
  onResponseStart?(round: number): void;
  onTextDelta?(delta: string): void;
  onReasoningSummary?(summary: string): void;
  onStatus?(status: string): void;
  onWarning?(message: string): void;
  onToolStart?(notice: ToolExecutionNotice): void;
  onToolProgress?(notice: ToolExecutionNotice): void;
  onToolFinish?(notice: ToolExecutionNotice): void;
  onTurnComplete?(metrics: TurnMetrics): void;
}

export interface TurnOptions {
  signal: AbortSignal;
  interaction: EngineInteraction;
  callbacks?: EngineCallbacks;
  modelInfo: ModelInfo;
  readOnly?: boolean;
  automated?: boolean;
  authorizationSessionId?: string;
}

export interface TurnResult {
  response: Response;
  text: string;
  toolCalls: number;
  compacted: boolean;
  metrics?: TurnMetrics;
}

export interface TurnMetrics {
  modelRounds: number;
  toolCalls: number;
  leafAgents: number;
  compactions: number;
  responseStatus: string;
  refusalNotice?: string;
  incompleteReason?: string;
  durationMs: number;
}

export type TurnCompleteMetrics = TurnMetrics;

interface TurnMetricsState {
  modelRounds: number;
  toolCalls: number;
  leafAgents: number;
  compactions: number;
  responseStatus?: string;
  refusalNotice?: string;
  incompleteReason?: string;
}

function userItem(text: string): ResponseInputItem {
  return { role: "user", content: [{ type: "input_text", text }] };
}

function functionCalls(response: Response): ResponseFunctionToolCall[] {
  return response.output.filter(
    (item): item is ResponseFunctionToolCall => item.type === "function_call",
  );
}

function responseReasoningSummary(response: Response): string | undefined {
  const summaries = (response.output as unknown[]).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (record.type !== "reasoning" || !Array.isArray(record.summary)) return [];
    return record.summary.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const summary = part as Record<string, unknown>;
      return summary.type === "summary_text" && typeof summary.text === "string" ? [summary.text] : [];
    });
  });
  const text = summaries.join("\n").trim();
  return text || undefined;
}

function toolOutputItem(callId: string, output: string): ResponseInputItem {
  return { type: "function_call_output", call_id: callId, output };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

function errorField(error: unknown, field: string): string | undefined {
  if (!error || typeof error !== "object" || !(field in error)) return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function boundedNotice(value: string, secrets: readonly string[], limit = 512): string {
  const sanitized = redactSensitiveText(value, secrets)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.length <= limit ? sanitized : `${sanitized.slice(0, Math.max(0, limit - 1))}…`;
}

/** Extract only bounded assistant refusal content; reasoning and encrypted fields are ignored. */
export function extractRefusalNotice(response: Pick<Response, "output">, secrets: readonly string[] = []): string | undefined {
  for (const item of response.output as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const message = item as { type?: unknown; role?: unknown; content?: unknown };
    if (message.type !== "message" || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const content of message.content) {
      if (!content || typeof content !== "object") continue;
      const part = content as { type?: unknown; refusal?: unknown };
      if (part.type !== "refusal" || typeof part.refusal !== "string") continue;
      const notice = boundedNotice(part.refusal, secrets);
      if (notice) return notice;
    }
  }
  return undefined;
}

function extractIncompleteReason(response: Response, secrets: readonly string[]): string | undefined {
  const record = response as unknown as Record<string, unknown>;
  const details = record.incomplete_details ?? record.incompleteDetails;
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const reason = (details as Record<string, unknown>).reason;
  return typeof reason === "string" ? boundedNotice(reason, secrets, 128) || undefined : undefined;
}

function failedResponseStatus(error: unknown): string {
  const status = errorField(error, "responseStatus");
  if (status && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(status)) return status;
  return errorField(error, "incompleteReason") ? "incomplete" : "failed";
}

function isContextOverflowError(error: unknown): boolean {
  const code = errorCode(error)?.toLowerCase();
  if (code && ["context_length_exceeded", "context_window_exceeded", "max_tokens_exceeded", "prompt_too_long"].includes(code)) {
    return true;
  }
  const message = errorMessage(error).toLowerCase();
  return /context (?:length|window).*(?:exceed|maximum|limit)|prompt.*(?:too long|token limit)|maximum context length/.test(message);
}

function utf8Prefix(value: string, maxBytes: number): string {
  const data = Buffer.from(value);
  let end = Math.min(data.length, Math.max(0, maxBytes));
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      return decoder.decode(data.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

export class ConversationEngine {
  private readonly operationOwner = randomUUID();

  constructor(
    private readonly config: GlassConfig,
    private readonly workspace: string,
    private readonly store: SessionStore,
    private readonly artifacts: ArtifactStore,
    private readonly clientOrResolver: CodexLbClient | ((provider: GatewayProvider) => CodexLbClient),
    private readonly tools: ToolRegistry,
    private readonly instructions: string,
  ) {}

  private clientFor(provider: GatewayProvider): CodexLbClient {
    return typeof this.clientOrResolver === "function"
      ? this.clientOrResolver(provider)
      : this.clientOrResolver;
  }

  private toolSummary(name: string, args: unknown): string {
    try {
      return this.tools.get(name)?.summarize(args) ?? name;
    } catch {
      return name;
    }
  }

  private toolDefinitions(session: SessionRecord): ReturnType<ToolRegistry["definitions"]> {
    const definitions = this.tools.definitions();
    return session.agentsEnabled ? definitions : definitions.filter((tool) => tool.name !== "run_agents");
  }

  private boundReplayOutput(sessionId: string, name: string, output: string, limit: number): string {
    if (Buffer.byteLength(output) <= limit) return output;
    const artifact = this.artifacts.save(sessionId, `${name}-replay-output`, output, { tool: name, replay: true });
    const suffix = `\n\n[Replayed output truncated. Full output: ${artifact.uri}]`;
    return Buffer.byteLength(suffix) >= limit
      ? utf8Prefix(`[Truncated: ${artifact.uri}]`, limit)
      : `${utf8Prefix(output, limit - Buffer.byteLength(suffix))}${suffix}`;
  }

  async turn(sessionId: string, text: string, options: TurnOptions): Promise<TurnResult> {
    return this.runTurn(sessionId, text, options);
  }

  async turnReserved(
    sessionId: string,
    text: string,
    options: TurnOptions,
    reservation: SessionPromptReservation,
  ): Promise<TurnResult> {
    return this.runTurn(sessionId, text, options, reservation);
  }

  private async runTurn(
    sessionId: string,
    text: string,
    options: TurnOptions,
    reservation?: SessionPromptReservation,
  ): Promise<TurnResult> {
    const startedAt = Date.now();
    const state: TurnMetricsState = {
      modelRounds: 0,
      toolCalls: 0,
      leafAgents: 0,
      compactions: 0,
    };
    try {
      const result = await this.withOperationLease(sessionId, "turn", options.signal, async (signal, executionToken) => {
        return this.turnLocked(sessionId, text, { ...options, signal }, executionToken, state);
      }, reservation);
      const metrics = this.completeMetrics(state, startedAt, state.responseStatus ?? result.response.status ?? "completed");
      this.notifyTurnComplete(options.callbacks, metrics);
      return { ...result, metrics };
    } catch (error) {
      state.responseStatus = failedResponseStatus(error);
      const incompleteReason = errorField(error, "incompleteReason");
      if (incompleteReason) state.incompleteReason = boundedNotice(
        incompleteReason,
        configuredCredentialValues(this.config),
        128,
      );
      const metrics = this.completeMetrics(state, startedAt, state.responseStatus);
      this.notifyTurnComplete(options.callbacks, metrics);
      throw error;
    }
  }

  private completeMetrics(state: TurnMetricsState, startedAt: number, responseStatus: string): TurnMetrics {
    return {
      modelRounds: state.modelRounds,
      toolCalls: state.toolCalls,
      leafAgents: state.leafAgents,
      compactions: state.compactions,
      responseStatus,
      ...(state.refusalNotice ? { refusalNotice: state.refusalNotice } : {}),
      ...(state.incompleteReason ? { incompleteReason: state.incompleteReason } : {}),
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  }

  private notifyTurnComplete(callbacks: EngineCallbacks | undefined, metrics: TurnMetrics): void {
    try {
      callbacks?.onTurnComplete?.(metrics);
    } catch {
      // Visualization callbacks are observers and must never affect turn execution.
    }
  }

  private async turnLocked(
    sessionId: string,
    text: string,
    options: TurnOptions,
    executionToken: string,
    metrics: TurnMetricsState,
  ): Promise<TurnResult> {
    this.store.reconcileToolCallEvents(sessionId, executionToken);
    if (this.store.hasUnanchoredContext(sessionId) && this.store.get(sessionId)?.lastResponseId) {
      if (!this.store.resetContinuityFenced(sessionId, executionToken)) {
        throw new Error("Session operation lease was lost during continuity recovery");
      }
    }
    const session = this.requireSession(sessionId);
    const client = this.clientFor(session.provider);
    const secrets = configuredCredentialValues(this.config);
    const firstInput = userItem(text);
    const storedText = redactSensitiveText(text, secrets);
    if (!this.store.appendUserAndSetTitleFenced<StoredUserPayload>(
      sessionId, executionToken, storedText, { item: userItem(storedText) },
    )) {
      throw new Error("Session operation lease was lost before recording the user message");
    }

    const responseContinuity = client.supportsResponseContinuity?.() !== false;
    let previousResponseId = responseContinuity ? session.lastResponseId ?? undefined : undefined;
    let pendingInput: ResponseInputItem[] = previousResponseId
      ? [firstInput]
      : projectContext(this.store, sessionId).input;
    let response: Response | null = null;
    let toolCallCount = 0;
    let compacted = false;

    try {
      for (let round = 0; round < this.config.tools.maxToolRounds; round += 1) {
        metrics.modelRounds += 1;
        options.callbacks?.onStatus?.(round === 0 ? "Thinking" : `Tool round ${round}`);
        options.callbacks?.onResponseStart?.(round);
        const request = await this.requestWithRecovery(
          this.requireSession(sessionId),
          pendingInput,
          previousResponseId,
          options,
          executionToken,
          metrics,
        );
        response = request.response;
        const reasoningSummary = responseReasoningSummary(response);
        const status = response.status;
        metrics.responseStatus = typeof status === "string"
          && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(status)
          ? status
          : "completed";
        const refusalNotice = extractRefusalNotice(response, secrets);
        if (refusalNotice) metrics.refusalNotice = refusalNotice;
        const incompleteReason = extractIncompleteReason(response, secrets);
        if (incompleteReason) metrics.incompleteReason = incompleteReason;
        compacted = request.compacted || compacted;
        const payload: StoredResponsePayload = {
          response: {
            id: response.id,
            status: response.status ?? null,
            output: redactSensitiveValue(response.output as unknown[], secrets),
            usage: response.usage ? {
              input_tokens: response.usage.input_tokens,
              output_tokens: response.usage.output_tokens,
              total_tokens: response.usage.total_tokens,
            } : null,
          },
        };
        if (!this.store.appendResponseAndSetContinuityFenced(sessionId, executionToken, payload, response.id)) {
          throw new Error("Session operation lease was lost before recording the response");
        }
        if (reasoningSummary) options.callbacks?.onReasoningSummary?.(reasoningSummary);

        const calls = functionCalls(response);
        if (calls.length === 0 || response.status === "incomplete" || response.status === "failed") {
          if (calls.length === 0 && response.status !== "incomplete" && response.status !== "failed" && session.kind !== "agent") {
            try {
              compacted = await this.autoCompact(sessionId, response, options.modelInfo, options, executionToken, metrics)
                || compacted;
            } catch (error) {
              if (options.signal.aborted) throw error;
              const message = `Context compaction deferred: ${errorMessage(error)}`;
              options.callbacks?.onWarning?.(message);
              this.store.appendEventFenced(sessionId, executionToken, "error", {
                message,
                code: "compaction_deferred",
                recoverable: true,
              } satisfies StoredErrorPayload);
            }
          }
          options.callbacks?.onStatus?.("Ready");
          return { response, text: response.output_text, toolCalls: toolCallCount, compacted };
        }

        toolCallCount += calls.length;
        metrics.toolCalls += calls.length;
        const outputs = await this.executeCalls(sessionId, calls, options, executionToken, metrics);
        if (await this.shouldCompact(sessionId, response, options.modelInfo)) {
          await this.compactLocked(sessionId, options, executionToken, metrics);
          compacted = true;
          pendingInput = projectContext(this.store, sessionId).input;
          previousResponseId = undefined;
        } else if (responseContinuity) {
          pendingInput = outputs;
          previousResponseId = response.id;
        } else {
          pendingInput = projectContext(this.store, sessionId).input;
          previousResponseId = undefined;
        }
      }
      throw new Error(`Stopped after ${this.config.tools.maxToolRounds} tool rounds`);
    } catch (error) {
      const code = errorCode(error);
      const payload: StoredErrorPayload = {
        message: redactSensitiveText(errorMessage(error), secrets),
        ...(code ? { code } : {}),
        recoverable: true,
      };
      this.store.appendEventFenced(sessionId, executionToken, "error", payload);
      throw error;
    }
  }

  async compactNow(sessionId: string, options: Pick<TurnOptions, "signal" | "callbacks">): Promise<void> {
    return this.withOperationLease(sessionId, "compact", options.signal, async (signal, executionToken) => {
      return this.compactLocked(sessionId, { ...options, signal }, executionToken);
    });
  }

  private async compactLocked(
    sessionId: string,
    options: Pick<TurnOptions, "signal" | "callbacks">,
    executionToken: string,
    metrics?: TurnMetricsState,
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    const context = projectContext(this.store, sessionId);
    if (context.input.length === 0) return;
    options.callbacks?.onStatus?.("Compacting context");
    const compact = await this.clientFor(session.provider).compact({
      model: session.model,
      instructions: this.instructions,
      input: context.input,
      promptCacheKey: session.promptCacheKey,
      fast: session.fast,
      signal: options.signal,
    });
    const usage = compact.usage;
    const inputTokens = usage && typeof usage === "object" && !Array.isArray(usage)
      && typeof (usage as Record<string, unknown>).input_tokens === "number"
      ? (usage as { input_tokens: number }).input_tokens
      : null;
    if (!this.store.saveCheckpointAndResetContinuityFenced(
      sessionId, executionToken, context.latestSequence, compact, inputTokens,
    )) {
      throw new Error("Session operation lease was lost before saving the compacted context");
    }
    if (metrics) metrics.compactions += 1;
    options.callbacks?.onStatus?.("Context compacted");
  }

  private async requestWithRecovery(
    session: SessionRecord,
    input: ResponseInputItem[],
    previousResponseId: string | undefined,
    options: TurnOptions,
    executionToken: string,
    metrics: TurnMetricsState,
  ): Promise<{ response: Response; compacted: boolean }> {
    const client = this.clientFor(session.provider);
    const anchorAbort = new AbortController();
    let anchorTimedOut = false;
    let firstEventTimer: NodeJS.Timeout | undefined;
    const clearFirstEventTimer = (): void => {
      if (firstEventTimer) clearTimeout(firstEventTimer);
      firstEventTimer = undefined;
    };
    if (previousResponseId) {
      firstEventTimer = setTimeout(() => {
        anchorTimedOut = true;
        anchorAbort.abort();
      }, 30_000);
      firstEventTimer.unref();
    }
    try {
      const streamed = await client.stream({
        model: session.model,
        instructions: this.instructions,
        input,
        tools: this.toolDefinitions(session),
        promptCacheKey: session.promptCacheKey,
        reasoningEffort: session.reasoningEffort,
        supportsReasoning: options.modelInfo.supportsReasoning,
        supportsParallelToolCalls: options.modelInfo.supportsParallelToolCalls,
        verbosity: session.verbosity,
        fast: session.fast,
        ...(previousResponseId ? { previousResponseId } : {}),
        signal: previousResponseId ? AbortSignal.any([options.signal, anchorAbort.signal]) : options.signal,
      }, {
        ...options.callbacks,
        onEvent: clearFirstEventTimer,
      });
      return { response: streamed, compacted: false };
    } catch (error) {
      const recoveryError = anchorTimedOut
        ? Object.assign(new Error("Previous response produced no stream event within 30 seconds"), {
            code: "previous_response_first_event_timeout",
          })
        : error;
      if (isContextOverflowError(recoveryError) && !options.signal.aborted) {
        options.callbacks?.onStatus?.("Recovering context overflow");
        await this.compactLocked(session.id, options, executionToken, metrics);
        const recoverySession = this.requireSession(session.id);
        const streamed = await client.stream({
          model: recoverySession.model,
          instructions: this.instructions,
          input: projectContext(this.store, session.id).input,
          tools: this.toolDefinitions(recoverySession),
          promptCacheKey: recoverySession.promptCacheKey,
          reasoningEffort: recoverySession.reasoningEffort,
          supportsReasoning: options.modelInfo.supportsReasoning,
          supportsParallelToolCalls: options.modelInfo.supportsParallelToolCalls,
          verbosity: recoverySession.verbosity,
          fast: recoverySession.fast,
          signal: options.signal,
        }, options.callbacks);
        return { response: streamed, compacted: true };
      }
      if (!previousResponseId || !isStaleResponseError(recoveryError, true) || options.signal.aborted) throw recoveryError;
      options.callbacks?.onStatus?.("Recovering conversation context");
      const context = projectContext(this.store, session.id);
      const recoverySession = this.store.resetContinuityFenced(session.id, executionToken);
      if (!recoverySession) throw new Error("Session operation lease was lost during stale-anchor recovery");
      const streamed = await client.stream({
        model: recoverySession.model,
        instructions: this.instructions,
        input: context.input,
        tools: this.toolDefinitions(recoverySession),
        promptCacheKey: recoverySession.promptCacheKey,
        reasoningEffort: recoverySession.reasoningEffort,
        supportsReasoning: options.modelInfo.supportsReasoning,
        supportsParallelToolCalls: options.modelInfo.supportsParallelToolCalls,
        verbosity: recoverySession.verbosity,
        fast: recoverySession.fast,
        signal: options.signal,
      }, options.callbacks);
      return { response: streamed, compacted: false };
    } finally {
      clearFirstEventTimer();
    }
  }

  private async executeCalls(
    sessionId: string,
    calls: ResponseFunctionToolCall[],
    options: TurnOptions,
    executionToken: string,
    metrics: TurnMetricsState,
  ): Promise<ResponseInputItem[]> {
    const modelOutputBytes = Math.max(1, Math.floor(this.config.tools.maxOutputBytes / Math.max(1, calls.length)));
    const readOnly = calls.every((call) => {
      const tool = this.tools.get(call.name);
      return tool?.risk === "read" && call.name !== "ask_user";
    });
    if (readOnly) {
      const settled = await Promise.allSettled(
        calls.map((call) => this.executeCall(sessionId, call, options, executionToken, modelOutputBytes, metrics)),
      );
      const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
      return settled.map((result) => (result as PromiseFulfilledResult<ResponseInputItem>).value);
    }
    const outputs: ResponseInputItem[] = [];
    for (const call of calls) {
      outputs.push(await this.executeCall(sessionId, call, options, executionToken, modelOutputBytes, metrics));
    }
    return outputs;
  }

  private async executeCall(
    sessionId: string,
    call: ResponseFunctionToolCall,
    options: TurnOptions,
    executionToken: string,
    modelOutputBytes: number,
    metrics: TurnMetricsState,
  ): Promise<ResponseInputItem> {
    let args: unknown;
    try {
      args = this.tools.parseArguments(call.name, call.arguments);
    } catch (error) {
      args = { raw_arguments: call.arguments };
      const storedArgs = redactSensitiveValue(args, configuredCredentialValues(this.config));
      const claim = this.store.beginToolCall(sessionId, call.call_id, call.name, storedArgs, executionToken);
      if (!claim.acquired) {
        const output = claim.record.output ?? claim.record.error ?? "Tool call failed";
        return toolOutputItem(call.call_id, this.boundReplayOutput(sessionId, call.name, output, modelOutputBytes));
      }
      const output = `Tool argument error: ${errorMessage(error)}`;
      return this.persistToolOutput(
        sessionId, call, executionToken, "failed", output, output, undefined, true, options,
      );
    }

    const storedArgs = redactSensitiveValue(args, configuredCredentialValues(this.config));
    let claim = this.store.beginToolCall(sessionId, call.call_id, call.name, storedArgs, executionToken);
    let record = claim.record;
    if (!claim.acquired && (record.name !== call.name
      || toolApprovalSignature(record.name, record.arguments) !== toolApprovalSignature(call.name, storedArgs))) {
      return toolOutputItem(call.call_id, "Tool call ID was reused with a different name or arguments; execution was blocked.");
    }
    if (record.state === "completed" || record.state === "failed" || record.state === "denied") {
      const output = record.output ?? record.error ?? `Previous ${record.state} tool call has no result`;
      return toolOutputItem(call.call_id, this.boundReplayOutput(sessionId, call.name, output, modelOutputBytes));
    }
    if (!claim.acquired && record.state === "unknown") {
      if (record.name !== call.name
        || toolApprovalSignature(record.name, record.arguments) !== toolApprovalSignature(call.name, args)) {
        return toolOutputItem(
          call.call_id,
          "Tool was not rerun because its name or arguments changed after the previous outcome became unknown.",
        );
      }
      const authorizationSessionId = options.authorizationSessionId ?? sessionId;
      const signature = toolApprovalSignature(`uncertain-rerun:${call.name}`, record.arguments);
      const remembered = this.store.hasCommandApproval(authorizationSessionId, signature);
      const unrestricted = this.requireSession(sessionId).approvalMode === "unrestricted";
      if (options.automated && !remembered && !unrestricted) {
        return toolOutputItem(
          call.call_id,
          "Tool was not rerun because its previous outcome is unknown and no remembered approval exists.",
        );
      }
      const rerun = remembered || unrestricted ? "once" : await options.interaction.approve({
        tool: call.name,
        risk: "critical",
        summary: `Rerun uncertain tool call ${call.name}`,
        details: [
          "Looking Glass stopped before recording whether this tool completed. Rerunning may repeat side effects.",
          `Original arguments:\n${JSON.stringify(record.arguments, null, 2)}`,
        ].join("\n\n"),
        canAlwaysApprove: true,
      });
      options.signal.throwIfAborted();
      if (rerun === "always") this.store.registerCommandApproval(authorizationSessionId, signature);
      if (rerun !== "once" && rerun !== "always") {
        return toolOutputItem(
          call.call_id,
          this.boundReplayOutput(
            sessionId,
            call.name,
            record.output ?? "Tool was not rerun because its previous outcome is unknown.",
            modelOutputBytes,
          ),
        );
      }
      claim = this.store.resetUnknownToolCall(sessionId, call.call_id, executionToken);
      if (!claim.acquired) throw new Error(`Uncertain tool call was claimed by another process: ${call.call_id}`);
    } else if (!claim.acquired) {
      throw new Error(`Tool call is already running: ${call.call_id}`);
    }

    const tool = this.tools.get(call.name);
    const summary = this.toolSummary(call.name, storedArgs);
    options.callbacks?.onToolStart?.({ callId: call.call_id, name: call.name, summary });

    if (call.name === "run_agents" && !this.requireSession(sessionId).agentsEnabled) {
      const output = "Agents are disabled for this session. Use /agents on to enable delegation.";
      return this.persistToolOutput(
        sessionId, call, executionToken, "denied", output, output, undefined, true, options, "tool_denied",
      );
    }

    const context: ToolContext = {
      workspace: this.workspace,
      sessionId,
      ...(options.authorizationSessionId ? { authorizationSessionId: options.authorizationSessionId } : {}),
      callId: call.call_id,
      config: this.config,
      approvalMode: this.requireSession(sessionId).approvalMode,
      artifacts: this.artifacts,
      sessions: this.store,
      signal: options.signal,
      ...(options.readOnly !== undefined ? { readOnly: options.readOnly } : {}),
      ...(options.automated !== undefined ? { automated: options.automated } : {}),
      modelOutputBytes,
      reportProgress: (message) => options.callbacks?.onToolProgress?.({
        callId: call.call_id,
        name: call.name,
        summary,
        output: message,
      }),
      approve: options.interaction.approve,
      ask: options.interaction.ask,
    };

    try {
      if (!this.store.assertOperationToken(sessionId, executionToken)) {
        throw new Error("Session operation lease was lost before tool execution");
      }
      options.signal.throwIfAborted();
      const result = await this.tools.execute(call.name, args, context);
      if (call.name === "run_agents") {
        const attempted = result.metadata?.agentTasksAttempted;
        if (typeof attempted === "number" && Number.isFinite(attempted) && attempted > 0) {
          metrics.leafAgents += Math.floor(attempted);
        }
      }
      if (options.signal.aborted) {
        this.persistUnknownToolOutput(sessionId, call, executionToken, options);
        throw new Error("Tool execution was interrupted; its outcome is unknown");
      }
      return this.persistToolOutput(
        sessionId, call, executionToken, "completed", result.output, null, result, false, options,
      );
    } catch (error) {
      if (options.signal.aborted) {
        if (this.store.getToolCall(sessionId, call.call_id)?.state === "started") {
          this.persistUnknownToolOutput(sessionId, call, executionToken, options);
        }
        throw error;
      }
      if (error instanceof ToolDeniedError) {
        const output = error.message;
        return this.persistToolOutput(
          sessionId, call, executionToken, "denied", output, output, undefined, true, options, "tool_denied",
        );
      }
      if (error instanceof ToolPreflightError) {
        const output = `Tool preflight error: ${error.message}`;
        return this.persistToolOutput(
          sessionId, call, executionToken, "failed", output, output, undefined, true, options,
        );
      }
      const output = `Tool error: ${errorMessage(error)}`;
      if (tool && tool.risk !== "read") {
        this.persistUnknownToolOutput(sessionId, call, executionToken, options, output);
        throw error;
      }
      return this.persistToolOutput(
        sessionId, call, executionToken, "failed", output, output, undefined, true, options,
      );
    }
  }

  private persistToolOutput(
    sessionId: string,
    call: ResponseFunctionToolCall,
    executionToken: string,
    state: "completed" | "denied" | "failed",
    output: string,
    error: string | null,
    result: ToolResult | undefined,
    failed: boolean,
    options: TurnOptions,
    kind: "tool_result" | "tool_denied" = "tool_result",
  ): ResponseInputItem {
    const secrets = configuredCredentialValues(this.config);
    output = redactSensitiveText(output, secrets);
    error = error === null ? null : redactSensitiveText(error, secrets);
    const item = toolOutputItem(call.call_id, output);
    const payload: StoredToolResultPayload = {
      name: call.name,
      callId: call.call_id,
      item,
      output,
      ...(result?.artifactUri ? { artifactUri: result.artifactUri } : {}),
      ...(result?.truncated ? { truncated: true } : {}),
    };
    this.store.finishToolCallWithEvent(
      sessionId, call.call_id, executionToken, state, output, error, kind, payload,
    );
    options.callbacks?.onToolFinish?.({
      callId: call.call_id,
      name: call.name,
      summary: this.toolSummary(call.name, this.store.getToolCall(sessionId, call.call_id)?.arguments),
      output,
      failed,
    });
    return item;
  }

  private persistUnknownToolOutput(
    sessionId: string,
    call: ResponseFunctionToolCall,
    executionToken: string,
    options: TurnOptions,
    detail = "Tool execution was interrupted; its side effects may have occurred.",
  ): void {
    const output = redactSensitiveText(detail, configuredCredentialValues(this.config));
    const item = toolOutputItem(call.call_id, output);
    const payload: StoredToolResultPayload = {
      name: call.name,
      callId: call.call_id,
      item,
      output,
    };
    this.store.markToolCallUnknownWithEvent(sessionId, call.call_id, executionToken, payload);
    options.callbacks?.onToolFinish?.({
      callId: call.call_id,
      name: call.name,
      summary: call.name,
      output,
      failed: true,
    });
  }

  private async autoCompact(
    sessionId: string,
    response: Response,
    model: ModelInfo,
    options: TurnOptions,
    executionToken: string,
    metrics: TurnMetricsState,
  ): Promise<boolean> {
    if (!await this.shouldCompact(sessionId, response, model)) return false;
    await this.compactLocked(sessionId, options, executionToken, metrics);
    return true;
  }

  private async shouldCompact(sessionId: string, response: Response, model: ModelInfo): Promise<boolean> {
    const checkpointSequence = this.store.latestCheckpoint(sessionId)?.throughSequence ?? 0;
    const semanticGrowth = this.store.semanticEventCount(sessionId, checkpointSequence);
    const reserve = Math.max(20_000, model.maxOutputTokens ?? 0);
    const usableTokens = Math.max(1, model.contextWindow - reserve);
    const threshold = usableTokens * 0.8;
    const providerTokens = response.usage?.input_tokens ?? 0;
    const context = projectContext(this.store, sessionId).input;
    const estimatedTokens = Math.ceil((
      this.instructions.length
      + JSON.stringify(this.toolDefinitions(this.requireSession(sessionId))).length
      + JSON.stringify(context).length
    ) / 4) + 2_000;
    if (providerTokens > 0) {
      const providerTruncatedReplay = this.clientFor(this.requireSession(sessionId).provider)
        .supportsResponseContinuity?.() === false
        && estimatedTokens >= usableTokens;
      return semanticGrowth >= 2 && (providerTokens >= threshold || providerTruncatedReplay);
    }
    return estimatedTokens >= usableTokens;
  }

  private async withOperationLease<T>(
    sessionId: string,
    kind: "turn" | "compact",
    callerSignal: AbortSignal,
    operation: (signal: AbortSignal, token: string) => Promise<T>,
    reservation?: SessionPromptReservation,
  ): Promise<T> {
    callerSignal.throwIfAborted();
    const owner = reservation?.owner ?? this.operationOwner;
    const token = reservation?.token ?? randomUUID();
    const leaseMs = 30_000;
    if (reservation) {
      if (!this.store.assertOperationLease(sessionId, owner, token)) {
        throw new Error("Reserved session operation lease is unavailable or expired");
      }
    } else if (!this.store.acquireOperationLease(sessionId, owner, token, kind, Date.now(), leaseMs)) {
      throw new Error("Session is busy with another turn or compaction");
    }
    const leaseAbort = new AbortController();
    const signal = AbortSignal.any([callerSignal, leaseAbort.signal]);
    let leaseError: Error | null = null;
    const heartbeat = setInterval(() => {
      try {
        if (!this.store.renewOperationLease(sessionId, owner, token, Date.now(), leaseMs)) {
          leaseError = new Error("Session operation lease was lost");
          leaseAbort.abort();
        }
      } catch (error) {
        leaseError = new Error(`Session operation heartbeat failed: ${errorMessage(error)}`);
        leaseAbort.abort();
      }
    }, Math.floor(leaseMs / 3));
    heartbeat.unref();
    try {
      const result = await operation(signal, token);
      if (leaseError || !this.store.assertOperationLease(sessionId, owner, token)) {
        throw leaseError ?? new Error("Session operation lease expired before completion");
      }
      return result;
    } catch (error) {
      if (leaseError) throw leaseError;
      throw error;
    } finally {
      clearInterval(heartbeat);
      this.store.releaseOperationLease(sessionId, owner, token);
    }
  }

  private requireSession(id: string): SessionRecord {
    const session = this.store.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    return session;
  }
}

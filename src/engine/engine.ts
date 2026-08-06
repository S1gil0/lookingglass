import type {
  Response,
  ResponseFunctionToolCall,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import { randomUUID } from "node:crypto";
import type { CodexLbClient } from "../model/codex-lb.js";
import { isStaleResponseError, requiresPortableCodexReplay } from "../model/codex-lb.js";
import type { ArtifactStore } from "../storage/artifact-store.js";
import type { OperationLeaseState, SessionStore } from "../storage/session-store.js";
import type { GatewayProvider, GlassConfig, ModelInfo, SessionRecord } from "../types.js";
import type { SessionPromptReservation } from "../scheduler/types.js";
import type { ApprovalDecision, ApprovalRequest, QuestionRequest, ToolContext, ToolResult } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { ToolDeniedError, ToolPreflightError, toolApprovalSignature } from "../tools/registry.js";
import { formatTaskPlanInstructions } from "../task-plan.js";
import { projectContext } from "./context.js";
import { configuredCredentialValues, redactSensitiveText, redactSensitiveValue } from "../security.js";
import { isTransientProviderError } from "../errors.js";
import {
  abortableRetryDelay,
  AutomatedTurnTimeoutError,
  composeRetryBudgetSignal,
  createRetryBudget,
  markRetryAttempt,
  retryBudgetCanRetry,
  retryBudgetError,
  retryBudgetExpired,
  waitForTransientRetry,
  type RetryDelay,
} from "../retry.js";
import type {
  StoredErrorPayload,
  StoredResponsePayload,
  StoredUserPayload,
} from "./types.js";

const OPERATION_LEASE_MS = 30_000;
const OPERATION_HEARTBEAT_MS = Math.max(1, Math.floor(OPERATION_LEASE_MS / 3));

export type SessionOperationLeaseLossPhase =
  | "reserved operation assertion"
  | "operation acquisition"
  | "heartbeat renewal"
  | "final assertion"
  | "continuity recovery"
  | "recording the user message"
  | "recording the response"
  | "saving compacted context"
  | "stale-anchor recovery"
  | "tool execution assertion"
  | "tool reconciliation"
  | "tool state persistence";

export interface SessionOperationLeaseLossDiagnostic {
  phase: SessionOperationLeaseLossPhase;
  kind: Exclude<OperationLeaseState["kind"], "active">;
  leaseMs: number;
  heartbeatMs: number;
  leaseDurationMs: number | null;
  renewalAgeMs: number | null;
  expiryOffsetMs: number | null;
}

/** Format only safe lease classification and timing data for operator-facing errors. */
export function formatOperationLeaseLoss(diagnostic: SessionOperationLeaseLossDiagnostic): string {
  const timing = [
    `lease duration ${diagnostic.leaseMs}ms`,
    `heartbeat every ${diagnostic.heartbeatMs}ms`,
    ...(diagnostic.leaseDurationMs !== null && diagnostic.leaseDurationMs !== diagnostic.leaseMs
      ? [`observed duration ${diagnostic.leaseDurationMs}ms`]
      : []),
    ...(diagnostic.renewalAgeMs !== null ? [`last renewal ${diagnostic.renewalAgeMs}ms ago`] : []),
  ].join("; ");
  const detail = diagnostic.kind === "expired"
    ? `the same lease expired ${Math.max(0, -(diagnostic.expiryOffsetMs ?? 0))}ms ago`
    : diagnostic.kind === "missing"
      ? "the lease row is missing"
      : "lease ownership changed and the previous lease was replaced";
  return `Session operation lease lost during ${diagnostic.phase}: ${detail} (${timing}). Retry the operation.`;
}

export class SessionOperationLeaseError extends Error {
  readonly code = "session_operation_lease_lost";

  constructor(readonly diagnostic: SessionOperationLeaseLossDiagnostic) {
    super(formatOperationLeaseLoss(diagnostic));
    this.name = "SessionOperationLeaseError";
  }
}

function formatLeaseUnavailable(phase: SessionOperationLeaseLossPhase): string {
  return `Session operation lease could not be verified during ${phase}; the operation stopped to preserve lease fencing `
    + `(lease duration ${OPERATION_LEASE_MS}ms; heartbeat every ${OPERATION_HEARTBEAT_MS}ms). Retry the operation.`;
}

function isStoreLeaseLoss(error: unknown): boolean {
  return /^Session operation lease was lost\b/u.test(errorMessage(error));
}

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
  providerRetries?: number;
  termination?: string;
  errorCode?: string;
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
  providerRetries: number;
  termination?: string;
  errorCode?: string;
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
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u.test(value) ? value : undefined;
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
    private readonly delay: RetryDelay = abortableRetryDelay,
  ) {}

  private clientFor(provider: GatewayProvider): CodexLbClient {
    return typeof this.clientOrResolver === "function"
      ? this.clientOrResolver(provider)
      : this.clientOrResolver;
  }

  private instructionsFor(session: SessionRecord): string {
    if (session.kind === "agent") return this.instructions;
    return `${this.instructions}\n\n${formatTaskPlanInstructions(this.store.latestTaskPlan(session.id))}`;
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
      providerRetries: 0,
    };
    try {
      const result = await this.withOperationLease(sessionId, "turn", options.signal, async (signal, executionToken) => {
        return this.turnLocked(sessionId, text, { ...options, signal }, executionToken, state);
      }, reservation);
      state.termination = "completed";
      const metrics = this.completeMetrics(state, startedAt, state.responseStatus ?? result.response.status ?? "completed");
      this.notifyTurnComplete(options.callbacks, metrics);
      return { ...result, metrics };
    } catch (error) {
      state.responseStatus = failedResponseStatus(error);
      const code = errorCode(error);
      if (code) state.errorCode = code;
      state.termination = state.errorCode === "automated_turn_timeout"
        ? "timed_out"
        : options.signal.aborted
          ? "cancelled"
          : state.errorCode === "automated_provider_retry_exhausted"
            ? "retry_exhausted"
            : "failed";
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
      ...(state.providerRetries > 0 ? { providerRetries: state.providerRetries } : { providerRetries: 0 }),
      ...(state.termination ? { termination: state.termination } : {}),
      ...(state.errorCode ? { errorCode: state.errorCode } : {}),
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
    try {
      this.store.reconcileToolCallEvents(sessionId, executionToken);
    } catch (error) {
      if (isStoreLeaseLoss(error)) {
        throw this.operationLeaseError(sessionId, executionToken, "tool reconciliation");
      }
      throw this.operationLeaseUnavailableError("tool reconciliation");
    }
    if (this.store.hasUnanchoredContext(sessionId) && this.store.get(sessionId)?.lastResponseId) {
      if (!this.store.resetContinuityFenced(sessionId, executionToken)) {
        throw this.operationLeaseError(sessionId, executionToken, "continuity recovery");
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
      throw this.operationLeaseError(sessionId, executionToken, "recording the user message");
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
          throw this.operationLeaseError(sessionId, executionToken, "recording the response");
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
      if (!(error instanceof SessionOperationLeaseError)
        && errorCode(error) !== "session_operation_lease_unavailable"
        && isStoreLeaseLoss(error)) {
        throw this.operationLeaseError(sessionId, executionToken, "tool state persistence");
      }
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

  async compactNow(sessionId: string, options: Pick<TurnOptions, "signal" | "callbacks" | "automated">): Promise<void> {
    return this.withOperationLease(sessionId, "compact", options.signal, async (signal, executionToken) => {
      return this.compactLocked(sessionId, { ...options, signal }, executionToken);
    });
  }

  private async compactLocked(
    sessionId: string,
    options: Pick<TurnOptions, "signal" | "callbacks" | "automated">,
    executionToken: string,
    metrics?: TurnMetricsState,
    essential = true,
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    const context = projectContext(this.store, sessionId);
    if (context.input.length === 0) return;
    const retryBudget = createRetryBudget(options.automated
      ? {
          maxAttempts: this.config.automation.providerRetryMaxAttempts,
          maxElapsedMs: this.config.automation.providerRetryMaxElapsedMs,
        }
      : undefined);
    const budgetSignal = composeRetryBudgetSignal(options.signal, retryBudget);
    let compact: Awaited<ReturnType<CodexLbClient["compact"]>>;
    try {
      while (true) {
        options.signal.throwIfAborted();
        if (budgetSignal.signal.aborted) throw retryBudgetError(retryBudget);
        if (!retryBudgetCanRetry(retryBudget)) {
          throw retryBudgetError(retryBudget);
        }
        const attempt = markRetryAttempt(retryBudget);
        options.callbacks?.onStatus?.("Compacting context");
        try {
          compact = await this.clientFor(session.provider).compact({
            model: session.model,
            instructions: this.instructionsFor(session),
            input: context.input,
            promptCacheKey: session.promptCacheKey,
            fast: session.fast,
            signal: budgetSignal.signal,
          });
          budgetSignal.signal.throwIfAborted();
          if (retryBudgetExpired(retryBudget)) throw retryBudgetError(retryBudget);
          break;
        } catch (error) {
          if (options.signal.aborted) throw options.signal.reason ?? error;
          if (budgetSignal.signal.aborted) throw retryBudgetError(retryBudget);
          if (isStoreLeaseLoss(error) || errorCode(error) === "session_operation_lease_lost") throw error;
          if (!isTransientProviderError(error)) throw error;
          if (!essential) throw error;
          if (!retryBudgetCanRetry(retryBudget)) throw retryBudgetError(retryBudget);
          retryBudget.retries += 1;
          if (metrics) metrics.providerRetries += 1;
          await this.waitForRetry(options.callbacks, options.signal, attempt, retryBudget);
        }
      }
    } finally {
      budgetSignal.dispose();
    }
    const usage = compact.usage;
    const inputTokens = usage && typeof usage === "object" && !Array.isArray(usage)
      && typeof (usage as Record<string, unknown>).input_tokens === "number"
      ? (usage as { input_tokens: number }).input_tokens
      : null;
    if (!this.store.saveCheckpointAndResetContinuityFenced(
      sessionId, executionToken, context.latestSequence, compact, inputTokens,
    )) {
      throw this.operationLeaseError(sessionId, executionToken, "saving compacted context");
    }
    if (metrics) metrics.compactions += 1;
    options.callbacks?.onStatus?.("Context compacted");
  }

  private async waitForRetry(
    callbacks: EngineCallbacks | undefined,
    signal: AbortSignal,
    attempt: number,
    budget?: ReturnType<typeof createRetryBudget>,
  ): Promise<void> {
    await waitForTransientRetry(
      signal,
      attempt,
      callbacks?.onStatus,
      this.delay,
      budget
        ? {
            maxAttempts: budget.maxAttempts,
            maxElapsedMs: budget.maxElapsedMs,
            startedAt: budget.startedAt,
          }
        : undefined,
    );
  }

  private async requestWithRecovery(
    session: SessionRecord,
    input: ResponseInputItem[],
    previousResponseId: string | undefined,
    options: TurnOptions,
    executionToken: string,
    metrics: TurnMetricsState,
  ): Promise<{ response: Response; compacted: boolean }> {
    let currentSession = session;
    let currentInput = input;
    let currentPreviousResponseId = previousResponseId;
    let compacted = false;
    let contextRecoveryUsed = false;
    let staleRecoveryUsed = false;
    const retryBudget = createRetryBudget(options.automated
      ? {
          maxAttempts: this.config.automation.providerRetryMaxAttempts,
          maxElapsedMs: this.config.automation.providerRetryMaxElapsedMs,
        }
      : undefined);
    const budgetSignal = composeRetryBudgetSignal(options.signal, retryBudget);
    let visibleText = false;

    const streamAttempt = async (): Promise<Response> => {
      const anchorAbort = new AbortController();
      let anchorTimedOut = false;
      let firstEventTimer: NodeJS.Timeout | undefined;
      const clearFirstEventTimer = (): void => {
        if (firstEventTimer) clearTimeout(firstEventTimer);
        firstEventTimer = undefined;
      };
      if (currentPreviousResponseId) {
        firstEventTimer = setTimeout(() => {
          anchorTimedOut = true;
          anchorAbort.abort();
        }, 30_000);
        firstEventTimer.unref();
      }
      try {
        return await this.clientFor(currentSession.provider).stream({
          model: currentSession.model,
          instructions: this.instructionsFor(currentSession),
          input: currentInput,
          tools: this.toolDefinitions(currentSession),
          promptCacheKey: currentSession.promptCacheKey,
          reasoningEffort: currentSession.reasoningEffort,
          supportsReasoning: options.modelInfo.supportsReasoning,
          supportsParallelToolCalls: options.modelInfo.supportsParallelToolCalls,
          verbosity: currentSession.verbosity,
          fast: currentSession.fast,
          ...(currentPreviousResponseId ? { previousResponseId: currentPreviousResponseId } : {}),
          signal: currentPreviousResponseId
            ? AbortSignal.any([budgetSignal.signal, anchorAbort.signal])
            : budgetSignal.signal,
        }, {
          ...options.callbacks,
          onTextDelta: (delta) => {
            if (delta.length > 0) visibleText = true;
            options.callbacks?.onTextDelta?.(delta);
          },
          onEvent: clearFirstEventTimer,
        });
      } catch (error) {
        if (anchorTimedOut) {
          throw Object.assign(new Error("Previous response produced no stream event within 30 seconds"), {
            code: "previous_response_first_event_timeout",
          });
        }
        throw error;
      } finally {
        clearFirstEventTimer();
      }
    };

    try {
      while (true) {
        options.signal.throwIfAborted();
        if (budgetSignal.signal.aborted) throw retryBudgetError(retryBudget);
        if (!retryBudgetCanRetry(retryBudget)) {
          throw retryBudgetError(retryBudget);
        }
        markRetryAttempt(retryBudget);
        try {
          const streamed = await streamAttempt();
          budgetSignal.signal.throwIfAborted();
          if (retryBudgetExpired(retryBudget)) throw retryBudgetError(retryBudget);
          return { response: streamed, compacted };
        } catch (error) {
          if (options.signal.aborted) throw options.signal.reason ?? error;
          if (budgetSignal.signal.aborted) throw retryBudgetError(retryBudget);
          if (isStoreLeaseLoss(error) || errorCode(error) === "session_operation_lease_lost") throw error;
          const estimatedTokens = this.estimatedRequestTokens(currentSession, currentInput);
          const oversizedUnanchoredReplay = currentPreviousResponseId === undefined
            && estimatedTokens >= this.usableContextTokens(options.modelInfo);
          const oversizedEmptyReplay = errorCode(error) === "empty_response"
            && this.clientFor(currentSession.provider).supportsResponseContinuity?.() === false
            && oversizedUnanchoredReplay;
          const oversizedRejectedReplay = errorCode(error) === "upstream_rejected_input"
            && currentSession.provider === "codex-lb"
            && currentPreviousResponseId === undefined
            && estimatedTokens >= Math.max(1, options.modelInfo.contextWindow);
          const portableRejectedReplay = errorCode(error) === "upstream_rejected_input"
            && currentSession.provider === "codex-lb"
            && currentPreviousResponseId === undefined
            && requiresPortableCodexReplay(currentInput);
          if (!visibleText && (isContextOverflowError(error) || oversizedEmptyReplay
            || oversizedRejectedReplay || portableRejectedReplay)
            && !contextRecoveryUsed && !options.signal.aborted) {
            contextRecoveryUsed = true;
            options.callbacks?.onStatus?.(portableRejectedReplay
              ? "Recovering migrated conversation context"
              : oversizedEmptyReplay || oversizedRejectedReplay
                ? "Recovering oversized local context"
                : "Recovering context overflow");
            await this.compactLocked(session.id, options, executionToken, metrics);
            currentSession = this.requireSession(session.id);
            currentInput = projectContext(this.store, session.id).input;
            currentPreviousResponseId = undefined;
            compacted = true;
            continue;
          }
          if (!visibleText && currentPreviousResponseId
            && !staleRecoveryUsed
            && isStaleResponseError(error, true)
            && !options.signal.aborted) {
            staleRecoveryUsed = true;
            options.callbacks?.onStatus?.("Recovering conversation context");
            const context = projectContext(this.store, session.id);
            const recoverySession = this.store.resetContinuityFenced(session.id, executionToken);
            if (!recoverySession) throw this.operationLeaseError(session.id, executionToken, "stale-anchor recovery");
            currentSession = recoverySession;
            currentInput = context.input;
            currentPreviousResponseId = undefined;
            continue;
          }
          if (!visibleText && !options.signal.aborted && isTransientProviderError(error)) {
            if (!retryBudgetCanRetry(retryBudget)) throw retryBudgetError(retryBudget);
            retryBudget.retries += 1;
            metrics.providerRetries += 1;
            await this.waitForRetry(options.callbacks, options.signal, retryBudget.attempts, retryBudget);
            continue;
          }
          throw error;
        }
      }
    } finally {
      budgetSignal.dispose();
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
    if (readOnly && !calls.some((call) => call.name === "task_plan")) {
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
      executionToken,
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
      let tokenCheck;
      try {
        tokenCheck = this.store.assertOperationTokenChecked(sessionId, executionToken);
      } catch {
        throw this.operationLeaseUnavailableError("tool execution assertion");
      }
      if (!tokenCheck.ok) {
        throw this.operationLeaseErrorFromState("tool execution assertion", tokenCheck.state);
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
        const interruption = options.signal.reason instanceof Error
          ? options.signal.reason
          : new Error("Tool execution was interrupted; its outcome is unknown");
        if (interruption instanceof AutomatedTurnTimeoutError) {
          Object.assign(interruption, { uncertainSideEffects: true });
        }
        this.persistUnknownToolOutput(sessionId, call, executionToken, options);
        throw interruption;
      }
      return this.persistToolOutput(
        sessionId, call, executionToken, "completed", result.output, null, result, false, options,
      );
    } catch (error) {
      if (error instanceof SessionOperationLeaseError
        || errorCode(error) === "session_operation_lease_unavailable") throw error;
      if (isStoreLeaseLoss(error)) {
        throw this.operationLeaseError(sessionId, executionToken, "tool state persistence");
      }
      if (options.signal.aborted) {
        if (error instanceof AutomatedTurnTimeoutError
          && this.store.getToolCall(sessionId, call.call_id)?.state === "started") {
          // The tool may have crossed its side-effect boundary before the
          // deadline reached durable reconciliation. Preserve that uncertainty
          // for scheduled runners instead of claiming a clean timeout.
          Object.assign(error, { uncertainSideEffects: true });
        }
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
    const payload = {
      name: call.name,
      callId: call.call_id,
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
    const payload = {
      name: call.name,
      callId: call.call_id,
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
    await this.compactLocked(sessionId, options, executionToken, metrics, false);
    return true;
  }

  private async shouldCompact(sessionId: string, response: Response, model: ModelInfo): Promise<boolean> {
    const checkpointSequence = this.store.latestCheckpoint(sessionId)?.throughSequence ?? 0;
    const semanticGrowth = this.store.semanticEventCount(sessionId, checkpointSequence);
    const usableTokens = this.usableContextTokens(model);
    const threshold = usableTokens * 0.8;
    const providerTokens = response.usage?.input_tokens ?? 0;
    const session = this.requireSession(sessionId);
    const estimatedTokens = this.estimatedRequestTokens(session, projectContext(this.store, sessionId).input);
    if (providerTokens > 0) {
      const providerTruncatedReplay = this.clientFor(session.provider)
        .supportsResponseContinuity?.() === false
        && estimatedTokens >= usableTokens;
      return semanticGrowth >= 2 && (providerTokens >= threshold || providerTruncatedReplay);
    }
    return estimatedTokens >= usableTokens;
  }

  private usableContextTokens(model: ModelInfo): number {
    return Math.max(1, model.contextWindow - Math.max(20_000, model.maxOutputTokens ?? 0));
  }

  private estimatedRequestTokens(session: SessionRecord, input: ResponseInputItem[]): number {
    return Math.ceil((
      this.instructionsFor(session).length
      + JSON.stringify(this.toolDefinitions(session)).length
      + JSON.stringify(input).length
    ) / 4) + 2_000;
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
    const leaseMs = OPERATION_LEASE_MS;
    if (reservation) {
      let check;
      try {
        check = this.store.assertOperationLeaseChecked(sessionId, owner, token);
      } catch {
        throw this.operationLeaseUnavailableError("reserved operation assertion");
      }
      if (!check.ok) {
        throw this.operationLeaseErrorFromState("reserved operation assertion", check.state);
      }
    } else {
      let acquired: boolean;
      try {
        acquired = this.store.acquireOperationLease(sessionId, owner, token, kind, Date.now(), leaseMs);
      } catch {
        throw this.operationLeaseUnavailableError("operation acquisition");
      }
      if (!acquired) throw new Error("Session is busy with another turn or compaction");
    }
    const leaseAbort = new AbortController();
    const signal = AbortSignal.any([callerSignal, leaseAbort.signal]);
    let leaseError: Error | null = null;
    const heartbeat = setInterval(() => {
      try {
        const check = this.store.renewOperationLeaseChecked(sessionId, owner, token, Date.now(), leaseMs);
        if (!check.ok && !leaseError) {
          leaseError = this.operationLeaseErrorFromState("heartbeat renewal", check.state);
          leaseAbort.abort();
        }
      } catch {
        // Do not surface database/provider exception text here: it may contain
        // connection details or credentials. Stopping is still mandatory.
        if (!leaseError) {
          leaseError = this.operationLeaseUnavailableError("heartbeat renewal");
          leaseAbort.abort();
        }
      }
    }, OPERATION_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      const result = await operation(signal, token);
      if (leaseError) throw leaseError;
      let finalCheck;
      try {
        finalCheck = this.store.assertOperationLeaseChecked(sessionId, owner, token);
      } catch {
        throw this.operationLeaseUnavailableError("final assertion");
      }
      if (!finalCheck.ok) {
        throw this.operationLeaseErrorFromState("final assertion", finalCheck.state);
      }
      return result;
    } catch (error) {
      if (leaseError) throw leaseError;
      throw error;
    } finally {
      clearInterval(heartbeat);
      try {
        this.store.releaseOperationLease(sessionId, owner, token);
      } catch {
        // Cleanup is best effort. The row remains fenced and expires naturally;
        // never replace the operation result with raw database diagnostics.
      }
    }
  }

  private operationLeaseErrorFromState(
    phase: SessionOperationLeaseLossPhase,
    state: OperationLeaseState,
  ): SessionOperationLeaseError {
    // This helper is only called for failed checks. Keep the guard defensive
    // so a future caller cannot format an "active" state as a loss.
    const kind = state.kind === "active" ? "missing" : state.kind;
    return new SessionOperationLeaseError({
      phase,
      kind,
      leaseMs: OPERATION_LEASE_MS,
      heartbeatMs: OPERATION_HEARTBEAT_MS,
      leaseDurationMs: state.leaseDurationMs,
      renewalAgeMs: state.renewalAgeMs,
      expiryOffsetMs: state.expiryOffsetMs,
    });
  }

  private operationLeaseUnavailableError(phase: SessionOperationLeaseLossPhase): Error {
    const error = new Error(formatLeaseUnavailable(phase));
    Object.assign(error, { code: "session_operation_lease_unavailable" });
    return error;
  }

  private operationLeaseError(
    sessionId: string,
    executionToken: string,
    phase: SessionOperationLeaseLossPhase,
  ): Error {
    try {
      const check = this.store.assertOperationTokenChecked(sessionId, executionToken);
      if (!check.ok) return this.operationLeaseErrorFromState(phase, check.state);
    } catch {
      // Fall through to a safe, non-classified diagnostic. The original
      // fenced write already stopped, so never turn an inspection failure into
      // permission to continue.
    }
    return this.operationLeaseUnavailableError(phase);
  }

  private requireSession(id: string): SessionRecord {
    const session = this.store.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    return session;
  }
}

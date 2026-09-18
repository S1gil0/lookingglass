import { providerError } from "../errors.js";

export type CompactionStage = "prepare" | "model" | "native" | "semantic" | "checkpoint";

export interface CompactionFailure {
  stage: CompactionStage;
  kind: string;
  code?: string;
  status?: number;
  part?: number;
  attempt?: number;
}

// Provider error strings can contain request bodies or credentials, even in
// fields called "code". Persist classifications, never arbitrary provider text.
const SAFE_CODES = new Set([
  "empty_response", "malformed_response", "compaction_part_retry_exhausted",
  "compaction_input_too_large", "responses_compact_input_too_large",
  "automated_provider_retry_exhausted", "checkpoint_conversion_unavailable",
  "compaction_pending_tools", "nonportable_compaction", "model_not_found",
  "compaction_repair_source_unavailable", "compaction_repair_incomplete",
  "invalid_api_key", "unauthorized", "forbidden", "invalid_request_error",
  "context_length_exceeded", "context_window_exceeded", "max_tokens_exceeded", "prompt_too_long",
  "rate_limit_exceeded", "insufficient_quota", "server_error", "internal_server_error",
  "service_unavailable", "overloaded_error", "request_timeout", "timeout",
  "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);
const SAFE_KINDS = new Set([
  "timeout", "cancelled", "refused", "dns", "network", "protocol", "availability",
  "auth", "invalid_request", "context_overflow", "unsupported", "generic",
]);

export function compactionFailure(
  error: unknown,
  stage: CompactionStage,
  position: { part?: number; attempt?: number } = {},
): CompactionFailure {
  const normalized = providerError(error, { provider: "compaction", operation: stage });
  const detail = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const kind = typeof detail.kind === "string" && SAFE_KINDS.has(detail.kind) ? detail.kind : normalized.kind ?? "generic";
  const code = normalized.code;
  const status = normalized.status;
  return {
    stage,
    kind,
    ...(code && SAFE_CODES.has(code) ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(Number.isInteger(position.part) && position.part! > 0 && position.part! <= 32 ? { part: position.part! } : {}),
    ...(Number.isInteger(position.attempt) && position.attempt! > 0 && position.attempt! <= 128 ? { attempt: position.attempt! } : {}),
  };
}

export function formatCompactionFailure(failure: CompactionFailure): string {
  const reason = failure.code === "automated_provider_retry_exhausted"
    ? "remote time/retry budget exhausted"
    : failure.code === "compaction_repair_source_unavailable" ? "repair source history is missing or incomplete"
    : failure.code === "compaction_repair_incomplete" ? "repair produced a degraded summary; previous checkpoint kept"
    : failure.code ?? failure.kind;
  return `${failure.stage}: ${reason}${failure.status !== undefined ? ` (HTTP ${failure.status})` : ""}`;
}

/** Bounded operation-local diagnostics; not part of model replay. */
export class CompactionDiagnostics {
  readonly startedAt = Date.now();
  stage: CompactionStage = "prepare";
  attempts = 0;
  private failureCount = 0;
  private readonly failures: CompactionFailure[] = [];
  private readonly recorded = new WeakSet<object>();

  record(error: unknown, stage = this.stage, position: { part?: number; attempt?: number } = {}): void {
    if (error && typeof error === "object") {
      if (this.recorded.has(error)) return;
      this.recorded.add(error);
    }
    this.failureCount += 1;
    this.failures.push(compactionFailure(error, stage, position));
    if (this.failures.length > 16) this.failures.shift();
  }

  summary(): string {
    const latest = this.failures.at(-1);
    if (!latest) return "no remote failure classification was reported";
    const underlying = this.failures.findLast((failure) => failure.stage === "semantic"
      && failure.code !== "compaction_part_retry_exhausted" && failure.code !== "automated_provider_retry_exhausted");
    return formatCompactionFailure(latest)
      + (underlying && underlying !== latest ? `; last part failure: ${formatCompactionFailure(underlying)}` : "");
  }

  snapshot(): Record<string, unknown> {
    return {
      attempts: this.attempts,
      duration_ms: Math.max(0, Date.now() - this.startedAt),
      failure_count: this.failureCount,
      failures: this.failures.map((failure) => ({ ...failure })),
    };
  }
}
import { isTransientProviderError } from "./errors.js";

export type RetryDelay = (milliseconds: number, signal: AbortSignal) => Promise<void> | void;

export interface ProviderRetryBudgetOptions {
  /** Maximum provider attempts, including the initial request. */
  maxAttempts: number;
  /** Maximum wall-clock time for one logical provider operation. */
  maxElapsedMs: number;
}

export interface RetryBudgetState extends ProviderRetryBudgetOptions {
  readonly startedAt: number;
  attempts: number;
  retries: number;
}

/** A safe, bounded error emitted when an automated provider operation gives up. */
export class AutomatedProviderRetryExhaustedError extends Error {
  readonly code = "automated_provider_retry_exhausted";

  constructor(
    readonly attempt: number,
    readonly maxAttempts: number,
    readonly elapsedMs: number,
    readonly maxElapsedMs: number,
  ) {
    super(
      `Automated provider retry budget exhausted after attempt ${attempt}/${maxAttempts}; `
      + `elapsed ${elapsedMs}/${maxElapsedMs}ms.`,
    );
    this.name = "AutomatedProviderRetryExhaustedError";
  }
}

/** A safe, bounded error used as the reason for automated turn deadlines. */
export class AutomatedTurnTimeoutError extends Error {
  readonly code = "automated_turn_timeout";

  constructor(readonly timeoutMs: number, readonly uncertainSideEffects = false) {
    super(`Automated turn timed out after ${timeoutMs}ms.`);
    this.name = "AutomatedTurnTimeoutError";
  }
}

export function transientRetryDelay(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.min(Math.max(0, attempt - 1), 30));
}

function displayLimit(value: number): string {
  return Number.isFinite(value) ? String(value) : "∞";
}

export function createRetryBudget(
  options?: ProviderRetryBudgetOptions,
  startedAt = Date.now(),
): RetryBudgetState {
  return {
    maxAttempts: options?.maxAttempts ?? Number.POSITIVE_INFINITY,
    maxElapsedMs: options?.maxElapsedMs ?? Number.POSITIVE_INFINITY,
    startedAt,
    attempts: 0,
    retries: 0,
  };
}

export function markRetryAttempt(state: RetryBudgetState): number {
  state.attempts += 1;
  return state.attempts;
}

export function retryBudgetElapsed(state: RetryBudgetState, now = Date.now()): number {
  return Math.max(0, now - state.startedAt);
}

export function retryBudgetCanRetry(state: RetryBudgetState, now = Date.now()): boolean {
  return state.attempts < state.maxAttempts && retryBudgetElapsed(state, now) < state.maxElapsedMs;
}

export function retryBudgetExpired(state: RetryBudgetState, now = Date.now()): boolean {
  return retryBudgetElapsed(state, now) >= state.maxElapsedMs;
}

export function retryBudgetError(state: RetryBudgetState, now = Date.now()): AutomatedProviderRetryExhaustedError {
  return new AutomatedProviderRetryExhaustedError(
    Math.max(1, state.attempts),
    state.maxAttempts,
    retryBudgetElapsed(state, now),
    state.maxElapsedMs,
  );
}

export interface RetryBudgetSignal {
  signal: AbortSignal;
  dispose(): void;
}

/** Compose a provider operation signal with its finite elapsed-time budget. */
export function composeRetryBudgetSignal(
  callerSignal: AbortSignal,
  state: RetryBudgetState,
): RetryBudgetSignal {
  if (!Number.isFinite(state.maxElapsedMs)) {
    return { signal: callerSignal, dispose: () => undefined };
  }
  const deadline = new AbortController();
  const remaining = Math.max(0, state.maxElapsedMs - retryBudgetElapsed(state));
  const timer = setTimeout(() => deadline.abort(retryBudgetError(state)), remaining);
  const signal = AbortSignal.any([callerSignal, deadline.signal]);
  return {
    signal,
    dispose: () => clearTimeout(timer),
  };
}

export interface RetryWaitOptions extends ProviderRetryBudgetOptions {
  startedAt: number;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Operation aborted");
}

/**
 * Wait for a transient retry without losing caller cancellation. When a
 * bounded budget is supplied, the wait is also capped by its remaining wall
 * clock and reports the same safe exhaustion error as the retry loop.
 */
export async function waitForTransientRetry(
  signal: AbortSignal,
  attempt: number,
  onStatus?: (status: string) => void,
  delay: RetryDelay = abortableRetryDelay,
  budget?: RetryWaitOptions,
): Promise<void> {
  const milliseconds = transientRetryDelay(attempt);
  const maxAttempts = budget?.maxAttempts ?? Number.POSITIVE_INFINITY;
  const boundedBudget = budget !== undefined
    && (Number.isFinite(budget.maxAttempts) || Number.isFinite(budget.maxElapsedMs));
  const elapsed = budget ? Math.max(0, Date.now() - budget.startedAt) : 0;
  const remaining = boundedBudget ? budget.maxElapsedMs - elapsed : Number.POSITIVE_INFINITY;
  if (boundedBudget && (attempt >= maxAttempts || remaining <= 0)) {
    signal.throwIfAborted();
    throw new AutomatedProviderRetryExhaustedError(
      Math.max(1, attempt),
      maxAttempts,
      elapsed,
      budget.maxElapsedMs,
    );
  }
  const boundedMilliseconds = Number.isFinite(remaining)
    ? Math.max(0, Math.min(milliseconds, remaining))
    : milliseconds;
  const seconds = `${boundedMilliseconds / 1_000}s`;
  const nextAttempt = attempt + 1;
  const attemptLabel = `${nextAttempt}/${displayLimit(maxAttempts)}`;
  onStatus?.(boundedBudget
    ? `Waiting to retry provider (attempt ${attemptLabel}, max ${displayLimit(maxAttempts)}, delay ${seconds}). Press Ctrl+C to stop.`
    : `Waiting to retry provider (attempt ${attempt}, delay ${seconds}). Press Ctrl+C to stop.`);
  signal.throwIfAborted();

  // The injected delay is intentionally allowed to ignore its signal in
  // tests and adapters. Race it against both caller cancellation and the
  // remaining budget while making sure every listener/timer is cleaned up.
  let removeAbortListener: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  const waitAbort = Number.isFinite(remaining) ? new AbortController() : undefined;
  const waitSignal = waitAbort ? AbortSignal.any([signal, waitAbort.signal]) : signal;
  const aborted = new Promise<void>((_, reject) => {
    const onAbort = (): void => reject(abortReason(waitSignal));
    removeAbortListener = () => waitSignal.removeEventListener("abort", onAbort);
    waitSignal.addEventListener("abort", onAbort, { once: true });
    if (waitSignal.aborted) onAbort();
  });
  const deadline = Number.isFinite(remaining)
    ? new Promise<void>((_, reject) => {
        const exhaustion = new AutomatedProviderRetryExhaustedError(
          Math.max(1, attempt),
          maxAttempts,
          Math.max(0, Date.now() - (budget?.startedAt ?? Date.now())),
          budget?.maxElapsedMs ?? remaining,
        );
        timer = setTimeout(() => {
          waitAbort?.abort(exhaustion);
          reject(exhaustion);
        }, remaining);
      })
    : undefined;
  try {
    const waiting = Promise.resolve(delay(boundedMilliseconds, waitSignal));
    await Promise.race(deadline ? [waiting, aborted, deadline] : [waiting, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbortListener?.();
  }
  signal.throwIfAborted();
  onStatus?.(boundedBudget
    ? `Reconnecting to provider (attempt ${attemptLabel}, max ${displayLimit(maxAttempts)}, delay ${seconds}). Press Ctrl+C to stop.`
    : `Reconnecting to provider (attempt ${attempt}, delay ${seconds}). Press Ctrl+C to stop.`);
}

export interface TransientRetryRunOptions extends ProviderRetryBudgetOptions {
  onStatus?: (status: string) => void;
  onRetry?: (retryCount: number, state: RetryBudgetState) => void;
  delay?: RetryDelay;
  startedAt?: number;
}

/** Run one logical provider operation with transient-only retry semantics. */
export async function runWithTransientRetries<T>(
  operation: (signal: AbortSignal, attempt: number) => Promise<T>,
  signal: AbortSignal,
  options?: Partial<TransientRetryRunOptions>,
): Promise<T> {
  const budget = createRetryBudget(
    options?.maxAttempts === undefined && options?.maxElapsedMs === undefined
      ? undefined
      : {
          maxAttempts: options.maxAttempts ?? Number.POSITIVE_INFINITY,
          maxElapsedMs: options.maxElapsedMs ?? Number.POSITIVE_INFINITY,
        },
    options?.startedAt ?? Date.now(),
  );
  const delay = options?.delay ?? abortableRetryDelay;
  const operationBudget = composeRetryBudgetSignal(signal, budget);
  try {
    while (true) {
      signal.throwIfAborted();
      if (operationBudget.signal.aborted) throw retryBudgetError(budget);
      if (!retryBudgetCanRetry(budget)) throw retryBudgetError(budget);
      const attempt = markRetryAttempt(budget);
      try {
        const result = await operation(operationBudget.signal, attempt);
        signal.throwIfAborted();
        if (operationBudget.signal.aborted || retryBudgetExpired(budget)) throw retryBudgetError(budget);
        return result;
      } catch (error) {
        // The caller/lease signal always wins over a provider failure and over
        // the retry budget. Never turn cancellation into an exhaustion error.
        if (signal.aborted) throw abortReason(signal);
        if (operationBudget.signal.aborted) throw retryBudgetError(budget);
        if (!isTransientProviderError(error)) throw error;
        if (!retryBudgetCanRetry(budget)) throw retryBudgetError(budget);
        budget.retries += 1;
        options?.onRetry?.(budget.retries, budget);
        await waitForTransientRetry(
          signal,
          attempt,
          options?.onStatus,
          delay,
          budget,
        );
      }
    }
  } finally {
    operationBudget.dispose();
  }
}

export function abortableRetryDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export type RetryDelay = (milliseconds: number, signal: AbortSignal) => Promise<void> | void;

export function transientRetryDelay(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.min(Math.max(0, attempt - 1), 30));
}

export function abortableRetryDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("Operation aborted"));
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export async function waitForTransientRetry(
  signal: AbortSignal,
  attempt: number,
  onStatus?: (status: string) => void,
  delay: RetryDelay = abortableRetryDelay,
): Promise<void> {
  const milliseconds = transientRetryDelay(attempt);
  const seconds = `${milliseconds / 1_000}s`;
  onStatus?.(`Waiting to retry provider (attempt ${attempt}, delay ${seconds}). Press Ctrl+C to stop.`);
  signal.throwIfAborted();
  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<void>((_, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error("Operation aborted"));
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    await Promise.race([delay(milliseconds, signal), aborted]);
  } finally {
    removeAbortListener?.();
  }
  signal.throwIfAborted();
  onStatus?.(`Reconnecting to provider (attempt ${attempt}, delay ${seconds}). Press Ctrl+C to stop.`);
}
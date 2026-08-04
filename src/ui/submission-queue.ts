export interface SubmissionQueueTicket {
  readonly position: number;
  readonly queued: boolean;
  readonly promise: Promise<void>;
}

/** A value whose preparation starts before the queue worker reaches it. */
export interface PreparedSubmission<T> {
  readonly kind: "prepared";
  readonly ready: Promise<T>;
  readonly cancel: () => void;
}

export function prepareQueuedValue<T>(ready: Promise<T>, cancel: () => void = (): void => {}): PreparedSubmission<T> {
  return { kind: "prepared", ready, cancel };
}

interface PendingSubmission<T> {
  readonly value: T;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Run submitted work one item at a time, preserving submission order.
 *
 * The worker is deliberately allowed to reject each item's promise without
 * stopping the queue. Callers can therefore report an item error while later
 * submissions continue to drain.
 */
export class SubmissionQueue<T> {
  private readonly pending: PendingSubmission<T>[] = [];
  private readonly idleWaiters: (() => void)[] = [];
  private running = false;

  constructor(private readonly run: (value: T) => Promise<void> | void) {}

  get size(): number {
    return this.pending.length + (this.running ? 1 : 0);
  }

  get isRunning(): boolean {
    return this.running;
  }

  enqueue(value: T): SubmissionQueueTicket {
    const queued = this.running || this.pending.length > 0;
    const position = this.pending.length + (this.running ? 1 : 0) + 1;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.pending.push({ value, resolve, reject });
    void this.drain();
    return { position, queued, promise };
  }

  whenIdle(): Promise<void> {
    if (!this.running && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const item = this.pending.shift()!;
        try {
          await this.run(item.value);
          item.resolve();
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.running = false;
      if (this.pending.length > 0) void this.drain();
      else {
        const waiters = this.idleWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    }
  }
}
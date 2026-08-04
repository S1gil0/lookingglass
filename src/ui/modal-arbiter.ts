export interface ModalPresentation {
  close(): void;
}

export type OpenModal<T> = (finish: (value: T) => void) => ModalPresentation;

interface PendingModal<T> {
  readonly open: OpenModal<T>;
  readonly cancelValue: T;
  readonly resolve: (value: T) => void;
  settled: boolean;
  presentation?: ModalPresentation;
  finish?: (value: T) => void;
}

/**
 * Serialize interactive overlays without letting a newly requested modal
 * replace one that is already visible. Requests are FIFO, and shutdown
 * settles both the visible request and all requests waiting behind it.
 */
export class ModalArbiter {
  private readonly pending: PendingModal<unknown>[] = [];
  private current: PendingModal<unknown> | null = null;
  private closed = false;

  get hasVisibleModal(): boolean {
    return this.current !== null;
  }

  request<T>(open: OpenModal<T>, cancelValue: T): Promise<T> {
    if (this.closed) return Promise.resolve(cancelValue);
    return new Promise<T>((resolve) => {
      const item: PendingModal<unknown> = {
        open: open as OpenModal<unknown>,
        cancelValue,
        resolve: resolve as (value: unknown) => void,
        settled: false,
      };
      this.pending.push(item);
      this.pump();
    });
  }

  /** Cancel the currently visible modal while retaining the arbiter queue. */
  cancelCurrent(): void {
    const current = this.current;
    if (!current || !current.finish) return;
    current.finish(current.cancelValue);
  }

  /** Stop accepting modals and settle every visible or waiting request. */
  cancelAll(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelCurrent();
    const waiting = this.pending.splice(0);
    for (const item of waiting) this.settle(item, item.cancelValue);
  }

  private pump(): void {
    if (this.closed || this.current || this.pending.length === 0) return;
    const item = this.pending.shift()!;
    this.current = item;
    const finish = (value: unknown): void => {
      this.settle(item, value);
      if (this.current === item) this.current = null;
      this.pump();
    };
    item.finish = finish as (value: unknown) => void;
    try {
      const presentation = item.open(finish);
      item.presentation = presentation;
      if (item.settled) item.presentation.close();
    } catch {
      finish(item.cancelValue);
    }
  }

  private settle(item: PendingModal<unknown>, value: unknown): void {
    if (item.settled) return;
    item.settled = true;
    try {
      item.presentation?.close();
    } catch {
      // Overlay cleanup must not strand the queue or a shutdown waiter.
    }
    item.resolve(value);
  }
}
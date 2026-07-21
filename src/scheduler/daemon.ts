import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { CommandRunner, SessionPromptRunner } from "./runner.js";
import { SchedulerStore } from "./store.js";
import type { SessionPromptHandler } from "./types.js";

export interface SchedulerDaemonOptions {
  pollIntervalMs: number;
  leaseMs: number;
  maxConcurrentCommands: number;
  materializeBatchSize?: number;
  owner?: string;
  bootId?: string;
  sessionPromptHandler?: SessionPromptHandler;
  sensitiveEnvKeys?: string[];
}

export interface SchedulerTickResult {
  materialized: number;
  claimed: number;
}

function positiveInteger(value: number, name: string, maximum = 2_147_483_647): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

export class SchedulerDaemon {
  readonly owner: string;
  readonly bootId: string;
  private readonly runner: CommandRunner;
  private readonly sessionPromptRunner: SessionPromptRunner | undefined;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly maxConcurrentCommands: number;
  private readonly materializeBatchSize: number;
  private readonly running = new Set<Promise<void>>();
  private commandSignal: AbortSignal | undefined;
  private commandAbort: AbortController | undefined;
  private firstWorkerError: unknown;
  private hasWorkerError = false;

  constructor(
    private readonly store: SchedulerStore,
    options: SchedulerDaemonOptions,
  ) {
    this.pollIntervalMs = positiveInteger(options.pollIntervalMs, "pollIntervalMs");
    this.leaseMs = positiveInteger(options.leaseMs, "leaseMs");
    this.maxConcurrentCommands = positiveInteger(options.maxConcurrentCommands, "maxConcurrentCommands", 1_000);
    this.materializeBatchSize = positiveInteger(options.materializeBatchSize ?? 100, "materializeBatchSize", 10_000);
    this.owner = options.owner ?? `${hostname()}:${process.pid}`;
    this.bootId = options.bootId ?? randomUUID();
    this.runner = new CommandRunner(store, options.sensitiveEnvKeys);
    this.sessionPromptRunner = options.sessionPromptHandler
      ? new SessionPromptRunner(store, options.sessionPromptHandler, options.sensitiveEnvKeys)
      : undefined;
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.running.size > 0 || this.commandAbort) throw new Error("Scheduler daemon is already running");
    this.firstWorkerError = undefined;
    this.hasWorkerError = false;
    const startedAt = Date.now();
    if (!this.store.acquireLease(this.owner, this.bootId, startedAt, this.leaseMs)) {
      throw new Error("Another scheduler daemon holds the lease");
    }
    const internalAbort = new AbortController();
    this.commandAbort = internalAbort;
    this.commandSignal = AbortSignal.any([signal, internalAbort.signal]);
    const heartbeatInterval = Math.max(1, Math.floor(this.leaseMs / 3));
    let nextPoll = startedAt;
    let nextHeartbeat = startedAt + heartbeatInterval;
    let loopError: unknown;
    let hasLoopError = false;
    let cleanupError: unknown;
    let hasCleanupError = false;
    try {
      while (!this.commandSignal.aborted) {
        const now = Date.now();
        if (now >= nextHeartbeat) {
          if (!this.store.renewLease(this.owner, this.bootId, now, this.leaseMs)) {
            internalAbort.abort();
            throw new Error("Scheduler daemon lost its lease");
          }
          nextHeartbeat = now + heartbeatInterval;
        }
        if (now >= nextPoll) {
          await this.tick();
          nextPoll = Date.now() + this.pollIntervalMs;
        }
        await wait(Math.max(1, Math.min(nextPoll, nextHeartbeat) - Date.now()), this.commandSignal);
      }
    } catch (error) {
      loopError = error;
      hasLoopError = true;
    } finally {
      internalAbort.abort();
      try {
        await this.settleWorkersWithLease();
      } catch (error) {
        cleanupError = error;
        hasCleanupError = true;
      }
      try {
        this.store.releaseLease(this.owner, this.bootId);
      } catch (error) {
        cleanupError = error;
        hasCleanupError = true;
      } finally {
        this.commandSignal = undefined;
        this.commandAbort = undefined;
      }
    }
    if (this.hasWorkerError) throw this.firstWorkerError;
    if (hasLoopError) throw loopError;
    if (hasCleanupError) throw cleanupError;
  }

  async tick(now?: number): Promise<SchedulerTickResult> {
    if (this.hasWorkerError) throw this.firstWorkerError;
    const materialized = this.store.materialize(now ?? Date.now(), this.materializeBatchSize);
    const available = this.maxConcurrentCommands - this.running.size;
    if (available <= 0) return { materialized: materialized.length, claimed: 0 };
    const claimNow = now ?? Date.now();
    const commandClaims = this.store.claimCommands(this.owner, this.bootId, claimNow, this.leaseMs, available);
    for (const claim of commandClaims) {
      let task: Promise<void>;
      task = this.runner.run(claim, this.commandSignal)
        .then(() => undefined)
        .catch((error: unknown) => this.captureWorkerError(error))
        .finally(() => this.running.delete(task));
      this.running.add(task);
    }
    const sessionAvailable = available - commandClaims.length;
    const sessionClaims = this.sessionPromptRunner && sessionAvailable > 0
      ? this.store.claimSessionPrompts(this.owner, this.bootId, claimNow, this.leaseMs, sessionAvailable)
      : [];
    for (const claim of sessionClaims) {
      let task: Promise<void>;
      task = this.sessionPromptRunner!.run(claim, this.commandSignal)
        .then(() => undefined)
        .catch((error: unknown) => this.captureWorkerError(error))
        .finally(() => this.running.delete(task));
      this.running.add(task);
    }
    return { materialized: materialized.length, claimed: commandClaims.length + sessionClaims.length };
  }

  async waitForIdle(): Promise<void> {
    await this.settleWorkers();
    if (this.hasWorkerError) throw this.firstWorkerError;
  }

  private captureWorkerError(error: unknown): void {
    if (!this.hasWorkerError) {
      this.firstWorkerError = error;
      this.hasWorkerError = true;
    }
    this.commandAbort?.abort();
  }

  private async settleWorkers(): Promise<void> {
    await Promise.all([...this.running]);
  }

  private async settleWorkersWithLease(): Promise<void> {
    const heartbeatInterval = Math.max(1, Math.floor(this.leaseMs / 3));
    while (this.running.size > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all([...this.running]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, heartbeatInterval);
          timer.unref();
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (this.running.size > 0) {
        const now = Date.now();
        if (!this.store.renewLease(this.owner, this.bootId, now, this.leaseMs)) {
          throw new Error("Scheduler daemon lost its lease while stopping command workers");
        }
      }
    }
  }
}

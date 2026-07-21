import { spawn } from "node:child_process";
import { taskkillExecutable } from "./shell.js";

export interface ProcessResult {
  stdout: Buffer;
  stderr: Buffer;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export interface ProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  captureBytes: number;
  signal?: AbortSignal;
  /** Defaults to detached on POSIX (for process-group cancellation) and attached on Windows. */
  detached?: boolean;
  /** Override the host platform in tests without changing process.platform. */
  platform?: NodeJS.Platform;
  /** Injectable spawn implementation for testing process-tree termination. */
  spawnProcess?: typeof spawn;
  /** Override SystemRoot in tests without changing the host platform. */
  systemRoot?: string;
}

function appendBounded(chunks: Buffer[], chunk: Buffer, currentBytes: number, limit: number): void {
  const remaining = limit - currentBytes;
  if (remaining <= 0) return;
  chunks.push(chunk.subarray(0, remaining));
}

export function runProcess(command: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  if (options.signal?.aborted) {
    return Promise.reject(options.signal.reason ?? new Error("Process execution was aborted before start"));
  }
  const platform = options.platform ?? process.platform;
  const spawnProcess = options.spawnProcess ?? spawn;
  const windows = platform === "win32";
  const detached = options.detached ?? !windows;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: windows,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let terminating = false;
    let killTimer: NodeJS.Timeout | undefined;
    let fallbackTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const complete = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        stdoutBytes,
        stderrBytes,
        stdoutTruncated: stdoutBytes > options.captureBytes,
        stderrTruncated: stderrBytes > options.captureBytes,
        exitCode,
        // Windows taskkill has no POSIX signal equivalent.
        signal: windows ? null : signal,
        timedOut,
      });
    };

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        process.kill(-(child.pid), signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // The process already exited.
        }
      }
    };

    const fallbackWindowsKill = (): void => {
      if (settled) return;
      try {
        // taskkill can be unavailable or can lose a race with process exit.
        // Falling back to the direct child handle prevents cancellation from
        // waiting forever when taskkill reports failure.
        if (!child.kill()) {
          complete(null, null);
          return;
        }
      } catch {
        complete(null, null);
        return;
      }
      fallbackTimer = setTimeout(() => complete(null, null), 1_000);
    };

    // Windows Job Objects are intentionally not used: this harness supports
    // older Windows hosts and does not assign a job to arbitrary children.
    // taskkill is only sent during timeout/abort termination, never from a
    // normal close handler, because a recycled PID could target another job.
    const terminateWindowsTree = (): void => {
      if (settled) return;
      if (!child.pid) {
        fallbackWindowsKill();
        return;
      }
      try {
        // Do not use a shell here: the command and PID are not shell text.
        const killer = spawnProcess(taskkillExecutable(options.systemRoot), ["/PID", String(child.pid), "/T", "/F"], {
          detached: false,
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        });
        killer.once("error", fallbackWindowsKill);
        killer.once("close", (exitCode, signal) => {
          if (exitCode !== 0 || signal !== null) fallbackWindowsKill();
        });
      } catch {
        fallbackWindowsKill();
      }
    };

    const terminate = (): void => {
      if (settled || terminating) return;
      terminating = true;
      if (windows) terminateWindowsTree();
      else signalGroup("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) {
          if (windows) fallbackWindowsKill();
          else signalGroup("SIGKILL");
        }
      }, 5_000);
      killTimer.unref();
    };

    child.stdout.on("data", (value: Buffer) => {
      appendBounded(stdout, value, Math.min(stdoutBytes, options.captureBytes), options.captureBytes);
      stdoutBytes += value.byteLength;
    });
    child.stderr.on("data", (value: Buffer) => {
      appendBounded(stderr, value, Math.min(stderrBytes, options.captureBytes), options.captureBytes);
      stderrBytes += value.byteLength;
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      if (!windows && detached) signalGroup("SIGKILL");
      complete(exitCode, signal);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timeout.unref();

    const onAbort = (): void => terminate();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) terminate();
  });
}

import { spawn } from "node:child_process";

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
  detached?: boolean;
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
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: options.detached ?? true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let terminating = false;
    let killTimer: NodeJS.Timeout | undefined;

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

    const terminate = (): void => {
      if (settled || terminating) return;
      terminating = true;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) signalGroup("SIGKILL");
      }, 5_000);
      killTimer.unref();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timeout.unref();

    const onAbort = (): void => terminate();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) terminate();

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
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      if (options.detached ?? true) signalGroup("SIGKILL");
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        stdoutBytes,
        stderrBytes,
        stdoutTruncated: stdoutBytes > options.captureBytes,
        stderrTruncated: stderrBytes > options.captureBytes,
        exitCode,
        signal,
        timedOut,
      });
    });
  });
}

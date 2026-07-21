import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { runProcess } from "../tools/process.js";
import { resolveWorkspacePath } from "../tools/paths.js";
import { shellEnvironment } from "../tools/safety.js";
import { shellDefinition } from "../tools/shell.js";
import type {
  ClaimedCommand,
  ClaimedSessionPrompt,
  CommandCompletion,
  Occurrence,
  SessionPromptCompletion,
  SessionPromptHandler,
} from "./types.js";
import { sessionPromptReservation } from "./types.js";
import { SchedulerStore } from "./store.js";
import type { ApprovalMode } from "../types.js";
import { redactSensitiveText } from "../security.js";

export function scheduledSessionReadOnly(approvalMode: ApprovalMode): boolean {
  return approvalMode !== "unrestricted";
}

function failedCompletion(error: unknown): CommandCompletion {
  const message = error instanceof Error ? error.message : String(error);
  return {
    state: "failed",
    exitCode: null,
    signal: null,
    reason: `Failed to start command: ${message}`,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

const SCHEDULED_CWD_ROOT_LIMITATION =
  "the scheduler schema stores no workspace root, so containment against the original workspace cannot be verified";

/**
 * Validate the launch directory again after a claim is acquired. Command
 * jobs currently persist only an absolute cwd, not the workspace that owned
 * it, so resolveWorkspacePath can only provide the existing path model's
 * lexical/realpath checks against that cwd. The limitation is deliberately
 * included in failures rather than silently implying workspace containment.
 */
function revalidateScheduledCwd(cwd: string): string {
  if (cwd.includes("\0")) throw new Error(`Scheduled command cwd contains a NUL byte; ${SCHEDULED_CWD_ROOT_LIMITATION}`);
  if (!isAbsolute(cwd)) throw new Error(`Scheduled command cwd is no longer absolute: ${cwd}; ${SCHEDULED_CWD_ROOT_LIMITATION}`);
  try {
    const resolved = resolveWorkspacePath(cwd, ".");
    if (!statSync(resolved).isDirectory()) {
      throw new Error(`Scheduled command cwd is not a directory: ${cwd}`);
    }
    return resolved;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Scheduled command cwd is not a usable directory: ${cwd}; ${detail}; ${SCHEDULED_CWD_ROOT_LIMITATION}`);
  }
}

export class CommandRunner {
  constructor(
    private readonly store: SchedulerStore,
    private readonly sensitiveEnvKeys: readonly string[] = [],
  ) {}

  async run(claim: ClaimedCommand, signal?: AbortSignal): Promise<Occurrence> {
    const { job, occurrence } = claim;
    const token = occurrence.claimToken;
    const started = this.store.startClaimedCommand(
      occurrence.id,
      token,
      occurrence.claimOwner,
      occurrence.claimBootId,
    );
    if (!started) throw new Error("Scheduler command lost its lease or claim before start");
    if (started.state !== "running") return started;

    let completion: CommandCompletion;
    if (signal?.aborted) {
      completion = {
        state: "cancelled",
        exitCode: null,
        signal: null,
        reason: "Scheduler daemon stopped before the command started",
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    } else {
      try {
        const shell = shellDefinition();
        // Keep this immediately before the one spawn performed by
        // runProcess. A cwd can disappear or be replaced after scheduling.
        const cwd = revalidateScheduledCwd(job.cwd);
        const result = await runProcess(shell.executable, shell.args(job.command), {
          cwd,
          env: shellEnvironment({ ...process.env, ...job.env }, this.sensitiveEnvKeys),
          timeoutMs: job.timeoutMs ?? 1,
          captureBytes: job.outputBytes ?? 0,
          ...(signal ? { signal } : {}),
          detached: true,
        });
        const state = signal?.aborted
          ? "unknown"
          : result.timedOut
            ? "timed_out"
            : result.exitCode === 0 && result.signal === null
              ? "succeeded"
              : "failed";
        let reason: string | null = null;
        if (state === "unknown") reason = "Scheduler daemon stopped while the command was running; its outcome is unknown";
        else if (state === "timed_out") reason = `Command exceeded its ${job.timeoutMs ?? 0}ms timeout`;
        else if (state === "failed" && result.signal) reason = `Command terminated by ${result.signal}`;
        else if (state === "failed") reason = `Command exited with code ${result.exitCode ?? "unknown"}`;
        const secrets = this.sensitiveEnvKeys
          .map((key) => process.env[key])
          .filter((value): value is string => typeof value === "string" && value.length >= 8);
        completion = {
          state,
          exitCode: result.exitCode,
          signal: result.signal,
          reason,
          stdout: Buffer.from(redactSensitiveText(result.stdout.toString("utf8"), secrets)),
          stderr: Buffer.from(redactSensitiveText(result.stderr.toString("utf8"), secrets)),
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
        };
      } catch (error) {
        completion = failedCompletion(error);
      }
    }
    const finished = this.store.finishCommand(
      occurrence.id,
      token,
      occurrence.claimOwner,
      occurrence.claimBootId,
      completion,
    );
    if (!finished) throw new Error("Scheduler command result could not be persisted after lease or claim loss");
    return finished;
  }
}

export class SessionPromptRunner {
  constructor(
    private readonly store: SchedulerStore,
    private readonly handler: SessionPromptHandler,
    private readonly sensitiveEnvKeys: readonly string[] = [],
  ) {}

  async run(claim: ClaimedSessionPrompt, signal?: AbortSignal): Promise<Occurrence> {
    const { job, occurrence } = claim;
    const token = occurrence.claimToken;
    const started = this.store.startClaimedSessionPrompt(
      occurrence.id,
      token,
      occurrence.claimOwner,
      occurrence.claimBootId,
    );
    if (!started) throw new Error("Scheduler session prompt lost its lease or claim before start");
    if (started.state !== "running") return started;

    const reservation = sessionPromptReservation(
      occurrence.claimOwner,
      occurrence.claimBootId,
      occurrence.claimToken,
    );
    const handlerSignal = signal ?? new AbortController().signal;
    let completion: SessionPromptCompletion;
    try {
      if (handlerSignal.aborted) {
        completion = {
          state: "cancelled",
          reason: "Scheduler daemon stopped before the session prompt started",
        };
      } else {
        try {
          const secrets = this.sensitiveEnvKeys
            .map((key) => process.env[key])
            .filter((value): value is string => typeof value === "string" && value.length >= 8);
          const output = redactSensitiveText(await this.handler(job, handlerSignal, reservation), secrets);
          completion = handlerSignal.aborted
            ? {
                state: "unknown",
                reason: "Scheduler daemon stopped while the session prompt was running; its outcome is unknown",
              }
            : { state: "succeeded", output, reason: null };
        } catch (error) {
          const secrets = this.sensitiveEnvKeys
            .map((key) => process.env[key])
            .filter((value): value is string => typeof value === "string" && value.length >= 8);
          const message = redactSensitiveText(error instanceof Error ? error.message : String(error), secrets);
          completion = handlerSignal.aborted
            ? {
                state: "unknown",
                error: message,
                reason: "Scheduler daemon stopped while the session prompt was running; its outcome is unknown",
              }
            : {
                state: "failed",
                error: message,
                reason: `Session prompt failed: ${message}`,
              };
        }
      }
    } finally {
      this.store.releaseSessionPromptReservation(job.sessionId, reservation.owner, reservation.token);
    }

    const finished = this.store.finishSessionPrompt(
      occurrence.id,
      token,
      occurrence.claimOwner,
      occurrence.claimBootId,
      completion,
    );
    if (!finished) throw new Error("Scheduler session prompt result could not be persisted after lease or claim loss");
    return finished;
  }
}

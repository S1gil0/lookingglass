export type JobKind = "reminder" | "command" | "session_prompt";
export type ScheduleKind = "once" | "cron";
export type OccurrenceState =
  | "pending"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "skipped"
  | "unknown";

export interface SchedulerJob {
  id: string;
  kind: JobKind;
  scheduleKind: ScheduleKind;
  schedule: string;
  timezone: string;
  message: string | null;
  command: string | null;
  sessionId: string | null;
  prompt: string | null;
  cwd: string | null;
  env: Record<string, string>;
  startGraceMs: number | null;
  timeoutMs: number | null;
  outputBytes: number | null;
  enabled: boolean;
  blockedReason: string | null;
  suspendedBySession: boolean;
  nextDue: number | null;
  createdAt: number;
}

export interface CreateReminderInput {
  message: string;
  scheduleKind: ScheduleKind;
  schedule: string;
  timezone: string;
}

export interface CreateCommandInput {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  scheduleKind: ScheduleKind;
  schedule: string;
  timezone: string;
  startGraceMs: number;
  timeoutMs: number;
  outputBytes: number;
}

export interface CreateSessionPromptInput {
  sessionId: string;
  prompt: string;
  scheduleKind: ScheduleKind;
  schedule: string;
  timezone: string;
  startGraceMs: number;
  outputBytes: number;
}

export interface Occurrence {
  id: number;
  jobId: string;
  scheduledAt: number;
  state: OccurrenceState;
  claimToken: string | null;
  claimOwner: string | null;
  claimBootId: string | null;
  claimLeaseExpiresAt: number | null;
  createdAt: number;
  claimedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  reason: string | null;
  stdout: Buffer;
  stderr: Buffer;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface InboxRecord {
  id: number;
  kind: "reminder" | "command_result";
  jobId: string;
  occurrenceId: number;
  message: string;
  createdAt: number;
  acknowledgedAt: number | null;
  occurrence: Occurrence;
}

export interface DaemonLease {
  owner: string;
  bootId: string;
  acquiredAt: number;
  renewedAt: number;
  expiresAt: number;
}

export interface ClaimedCommand {
  job: SchedulerJob & { kind: "command"; command: string; cwd: string };
  occurrence: Occurrence & {
    state: "claimed";
    claimToken: string;
    claimOwner: string;
    claimBootId: string;
    claimLeaseExpiresAt: number;
  };
}

export interface ClaimedSessionPrompt {
  job: SchedulerJob & {
    kind: "session_prompt";
    sessionId: string;
    prompt: string;
    cwd: string;
  };
  occurrence: Occurrence & {
    state: "claimed";
    claimToken: string;
    claimOwner: string;
    claimBootId: string;
    claimLeaseExpiresAt: number;
  };
}

export interface CommandCompletion {
  state: Extract<OccurrenceState, "succeeded" | "failed" | "timed_out" | "cancelled" | "unknown">;
  exitCode: number | null;
  signal: string | null;
  reason: string | null;
  stdout: Buffer;
  stderr: Buffer;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface SessionPromptCompletion {
  state: Extract<OccurrenceState, "succeeded" | "failed" | "cancelled" | "unknown">;
  output?: string;
  result?: string;
  error?: string | null;
  reason?: string | null;
}

export interface SessionPromptReservation {
  owner: string;
  token: string;
}

export function sessionPromptReservation(
  owner: string,
  bootId: string,
  claimToken: string,
): SessionPromptReservation {
  return {
    owner: `scheduler:${owner}:${bootId}`,
    token: `session-prompt:${claimToken}`,
  };
}

export type SessionPromptHandler = (
  job: ClaimedSessionPrompt["job"],
  signal: AbortSignal,
  reservation: SessionPromptReservation,
) => Promise<string>;

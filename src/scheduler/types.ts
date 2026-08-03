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

export const DEFAULT_SESSION_PROMPT_TIMEOUT_MS = 2 * 60 * 60_000;

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
  deletedAt: number | null;
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
  /** Optional for compatibility with callers predating persisted prompt deadlines. */
  timeoutMs?: number;
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
  state: Extract<OccurrenceState, "succeeded" | "failed" | "timed_out" | "cancelled" | "unknown">;
  output?: string;
  result?: string;
  error?: string | null;
  reason?: string | null;
  code?: string;
}

export type SchedulerRetentionMode = "dry-run" | "apply";

/**
 * Scheduler retention is intentionally independent for each kind of row. An
 * omitted duration disables that part of maintenance; zero means eligible at
 * the supplied maintenance time.
 */
export interface SchedulerRetentionPolicy {
  outputRetentionMs?: number;
  occurrenceRetentionMs?: number;
  acknowledgedInboxRetentionMs?: number;
  deletedJobRetentionMs?: number;
  minOccurrencesPerJob?: number;
  batchSize?: number;
}

/**
 * Aggregate-only scheduler maintenance output. It contains no row ids or
 * scheduler payloads so it is safe to expose to diagnostics and the CLI.
 */
export interface SchedulerRetentionReport {
  mode: SchedulerRetentionMode;
  dryRun: boolean;
  now: number;
  policy: SchedulerRetentionPolicy;
  terminalClaimsScrubbed: number;
  stdoutScrubbed: number;
  stderrScrubbed: number;
  stdoutBytes: number;
  stderrBytes: number;
  outputBytes: number;
  inboxDeleted: number;
  inboxBytes: number;
  occurrencesDeleted: number;
  jobsDeleted: number;
  batchLimited: boolean;
}

export interface SchedulerJobStats {
  total: number;
  enabled: number;
  blocked: number;
  deleted: number;
}

export interface SchedulerOccurrenceStats {
  total: number;
  pending: number;
  claimed: number;
  running: number;
  terminal: number;
  unknown: number;
}

export interface SchedulerInboxStats {
  total: number;
  unread: number;
  acknowledged: number;
}

export interface SchedulerLeaseStats {
  /** Number of rows in the singleton scheduler daemon lease table. */
  daemon: number;
  /** Number of session-operation lease rows (tokens are never returned). */
  sessionOperations: number;
  total: number;
  active: number;
  stale: number;
}

export interface SchedulerQueueAges {
  pendingMs: number | null;
  claimedMs: number | null;
  runningMs: number | null;
}

export interface SchedulerOutputStats {
  stdoutBytes: number;
  stderrBytes: number;
  bytes: number;
  stdoutStoredBytes: number;
  stderrStoredBytes: number;
  storedBytes: number;
  stdoutTruncated: number;
  stderrTruncated: number;
  truncated: number;
}

/**
 * Aggregate scheduler state. The fields deliberately describe only counts,
 * ages, and byte metadata; no claims, messages, commands, prompts, env, or
 * output content are included.
 */
export interface SchedulerStats {
  jobs: SchedulerJobStats;
  occurrences: SchedulerOccurrenceStats;
  inbox: SchedulerInboxStats;
  leases: SchedulerLeaseStats;
  staleClaims: number;
  terminalClaims: number;
  queueAges: SchedulerQueueAges;
  output: SchedulerOutputStats;
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

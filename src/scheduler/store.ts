import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { GlassDatabase } from "../storage/database.js";
import { initialDue, nextCronDue, rejectNul } from "./schedule.js";
import { DEFAULT_SESSION_PROMPT_TIMEOUT_MS, sessionPromptReservation } from "./types.js";
import type {
  ClaimedCommand,
  ClaimedSessionPrompt,
  CommandCompletion,
  CreateCommandInput,
  CreateReminderInput,
  CreateSessionPromptInput,
  DaemonLease,
  InboxRecord,
  JobKind,
  Occurrence,
  OccurrenceState,
  ScheduleKind,
  SchedulerJob,
  SchedulerRetentionMode,
  SchedulerRetentionPolicy,
  SchedulerRetentionReport,
  SchedulerStats,
  SessionPromptCompletion,
} from "./types.js";

const MAX_DURATION_MS = 2_147_483_647;
const MAX_SESSION_PROMPT_TIMEOUT_MS = MAX_DURATION_MS - 1;
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 512;
const MAX_INBOX_MESSAGE_BYTES = 2 * 1024;
const DEFAULT_MAINTENANCE_BATCH_SIZE = 100;
const MAX_MAINTENANCE_BATCH_SIZE = 100_000;
const SESSION_PROMPT_COMMAND_SENTINEL = ":";

const TERMINAL_STATES: readonly OccurrenceState[] = [
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "skipped",
  "unknown",
];
const RETAINABLE_TERMINAL_STATES: readonly OccurrenceState[] = [
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "skipped",
];

interface JobRow {
  id: string;
  kind: Exclude<JobKind, "session_prompt">;
  schedule_kind: ScheduleKind;
  schedule: string;
  timezone: string;
  message: string | null;
  command_text: string | null;
  session_id: string | null;
  prompt: string | null;
  cwd: string | null;
  env_json: string | null;
  start_grace_ms: number | null;
  timeout_ms: number | null;
  output_bytes: number | null;
  enabled: number;
  blocked_reason: string | null;
  suspended_by_session: number;
  next_due: number | null;
  created_at: number;
  deleted_at: number | null;
}

interface OccurrenceRow {
  id: number;
  job_id: string;
  scheduled_at: number;
  state: OccurrenceState;
  claim_token: string | null;
  claim_owner: string | null;
  claim_boot_id: string | null;
  claim_lease_expires_at: number | null;
  created_at: number;
  claimed_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  exit_code: number | null;
  signal: string | null;
  reason: string | null;
  stdout: Buffer | null;
  stderr: Buffer | null;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_truncated: number;
  stderr_truncated: number;
}

interface InboxRow {
  id: number;
  kind: "reminder" | "command_result";
  job_id: string;
  occurrence_id: number;
  message: string;
  created_at: number;
  acknowledged_at: number | null;
}

interface LeaseRow {
  owner: string;
  boot_id: string;
  acquired_at: number;
  renewed_at: number;
  expires_at: number;
}

interface RetentionOutputRow {
  id: number;
  stdout_stored_bytes: number | null;
  stderr_stored_bytes: number | null;
}

interface RetentionInboxRow {
  id: number;
  message_bytes: number;
}

interface RetentionOccurrenceRow {
  id: number;
  stdout_bytes: number;
  stderr_bytes: number;
}

interface RetentionPlan {
  output: RetentionOutputRow[];
  inbox: RetentionInboxRow[];
  occurrences: RetentionOccurrenceRow[];
  terminalClaims: number;
  jobs: number;
  batchLimited: boolean;
}

interface MaintenanceCounts {
  terminalClaimsScrubbed: number;
  stdoutScrubbed: number;
  stderrScrubbed: number;
  stdoutBytes: number;
  stderrBytes: number;
  inboxDeleted: number;
  inboxBytes: number;
  occurrencesDeleted: number;
  jobsDeleted: number;
}

function finiteInteger(name: string, value: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

function validateNow(now: number): void {
  finiteInteger("now", now, 0);
}

function sqlStateList(states: readonly OccurrenceState[]): string {
  return states.map((state) => `'${state}'`).join(", ");
}

function sanitizedText(value: string): string {
  if (typeof value !== "string") throw new Error("Diagnostic text must be a string");
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "�");
}

function boundedText(value: string, maximumBytes: number): string {
  return boundedUtf8(sanitizedText(value), maximumBytes).buffer.toString("utf8");
}

function boundedReason(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return boundedText(value, MAX_DIAGNOSTIC_BYTES);
}

function terminalClaimPredicate(alias = ""): string {
  const prefix = alias.length > 0 ? `${alias}.` : "";
  return `(${prefix}claim_token IS NOT NULL OR ${prefix}claim_owner IS NOT NULL
    OR ${prefix}claim_boot_id IS NOT NULL OR ${prefix}claim_lease_expires_at IS NOT NULL)`;
}

function knownTerminalStatePredicate(alias = ""): string {
  const prefix = alias.length > 0 ? `${alias}.` : "";
  return `${prefix}state IN (${sqlStateList(RETAINABLE_TERMINAL_STATES)})`;
}

function jobFromRow(row: JobRow): SchedulerJob {
  const env = row.env_json ? JSON.parse(row.env_json) as Record<string, string> : {};
  const sessionPrompt = row.kind === "command" && row.session_id !== null && row.prompt !== null;
  return {
    id: row.id,
    kind: sessionPrompt ? "session_prompt" : row.kind,
    scheduleKind: row.schedule_kind,
    schedule: row.schedule,
    timezone: row.timezone,
    message: row.message,
    command: row.command_text,
    sessionId: row.session_id,
    prompt: row.prompt,
    cwd: row.cwd,
    env,
    startGraceMs: row.start_grace_ms,
    timeoutMs: row.timeout_ms,
    outputBytes: row.output_bytes,
    enabled: row.enabled === 1,
    blockedReason: row.blocked_reason,
    suspendedBySession: row.suspended_by_session === 1,
    nextDue: row.next_due,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  };
}

function occurrenceFromRow(row: OccurrenceRow): Occurrence {
  return {
    id: row.id,
    jobId: row.job_id,
    scheduledAt: row.scheduled_at,
    state: row.state,
    claimToken: row.claim_token,
    claimOwner: row.claim_owner,
    claimBootId: row.claim_boot_id,
    claimLeaseExpiresAt: row.claim_lease_expires_at,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    signal: row.signal,
    reason: row.reason,
    stdout: row.stdout ?? Buffer.alloc(0),
    stderr: row.stderr ?? Buffer.alloc(0),
    stdoutBytes: row.stdout_bytes,
    stderrBytes: row.stderr_bytes,
    stdoutTruncated: row.stdout_truncated === 1,
    stderrTruncated: row.stderr_truncated === 1,
  };
}

function leaseFromRow(row: LeaseRow): DaemonLease {
  return {
    owner: row.owner,
    bootId: row.boot_id,
    acquiredAt: row.acquired_at,
    renewedAt: row.renewed_at,
    expiresAt: row.expires_at,
  };
}

function validateIdentity(value: string, field: string): void {
  rejectNul(value, field);
  if (value.length === 0) throw new Error(`${field} must not be empty`);
}

function validateEnvironment(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    validateIdentity(key, "environment variable name");
    if (key.includes("=")) throw new Error("Environment variable names must not contain '='");
    if (typeof value !== "string") throw new Error(`Environment variable ${key} must be a string`);
    rejectNul(value, `environment variable ${key}`);
  }
}

function resultInboxMessage(job: SchedulerJob, state: OccurrenceState, reason: string | null): string {
  const subject = job.kind === "session_prompt" ? "Session turn" : "Command";
  const bounded = boundedReason(reason);
  return bounded ? `${subject} ${state}: ${bounded}` : `${subject} ${state}`;
}

function boundedUtf8(value: string, maximumBytes: number): { buffer: Buffer; bytes: number; truncated: boolean } {
  const full = Buffer.from(value, "utf8");
  if (full.byteLength <= maximumBytes) return { buffer: full, bytes: full.byteLength, truncated: false };
  let end = maximumBytes;
  if (end > 0) {
    let sequenceStart = end - 1;
    while (sequenceStart > 0 && (full[sequenceStart]! & 0xc0) === 0x80) sequenceStart -= 1;
    const lead = full[sequenceStart]!;
    const sequenceBytes = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    if (sequenceStart + sequenceBytes > end) end = sequenceStart;
  }
  return { buffer: full.subarray(0, end), bytes: full.byteLength, truncated: true };
}

const RETENTION_POLICY_KEYS = new Set<keyof SchedulerRetentionPolicy>([
  "outputRetentionMs",
  "occurrenceRetentionMs",
  "acknowledgedInboxRetentionMs",
  "deletedJobRetentionMs",
  "minOccurrencesPerJob",
  "batchSize",
]);

function validateRetentionPolicy(policy: SchedulerRetentionPolicy): SchedulerRetentionPolicy {
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("Scheduler retention policy must be an object");
  }
  for (const key of Object.keys(policy) as Array<keyof SchedulerRetentionPolicy>) {
    if (!RETENTION_POLICY_KEYS.has(key)) throw new Error(`Unknown scheduler retention policy field: ${key}`);
  }
  for (const key of RETENTION_POLICY_KEYS) {
    const value = policy[key];
    if (value !== undefined) {
      finiteInteger(key, value, 0, key === "batchSize" ? MAX_MAINTENANCE_BATCH_SIZE : Number.MAX_SAFE_INTEGER);
    }
  }
  if (policy.batchSize === 0) throw new Error("batchSize must be at least 1");
  return { ...policy };
}

function maintenanceCounts(): MaintenanceCounts {
  return {
    terminalClaimsScrubbed: 0,
    stdoutScrubbed: 0,
    stderrScrubbed: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    inboxDeleted: 0,
    inboxBytes: 0,
    occurrencesDeleted: 0,
    jobsDeleted: 0,
  };
}

function validateCommandCompletion(completion: CommandCompletion): void {
  if (completion === null || typeof completion !== "object") {
    throw new Error("Command completion must be an object");
  }
  if (!RETAINABLE_TERMINAL_STATES.includes(completion.state) && completion.state !== "unknown") {
    throw new Error(`Invalid command completion state: ${String(completion.state)}`);
  }
  if (!Buffer.isBuffer(completion.stdout)) throw new Error("Command stdout must be a Buffer");
  if (!Buffer.isBuffer(completion.stderr)) throw new Error("Command stderr must be a Buffer");
  finiteInteger("stdoutBytes", completion.stdoutBytes, 0);
  finiteInteger("stderrBytes", completion.stderrBytes, 0);
  if (completion.exitCode !== null && !Number.isSafeInteger(completion.exitCode)) {
    throw new Error("exitCode must be an integer or null");
  }
  if (completion.signal !== null && typeof completion.signal !== "string") {
    throw new Error("signal must be a string or null");
  }
  if (completion.stdoutTruncated !== true && completion.stdoutTruncated !== false) {
    throw new Error("stdoutTruncated must be a boolean");
  }
  if (completion.stderrTruncated !== true && completion.stderrTruncated !== false) {
    throw new Error("stderrTruncated must be a boolean");
  }
  boundedReason(completion.reason);
}

export class SchedulerStore {
  constructor(
    private readonly db: GlassDatabase,
    private sessionPromptTimeoutMs = DEFAULT_SESSION_PROMPT_TIMEOUT_MS,
  ) {
    finiteInteger("sessionPromptTimeoutMs", sessionPromptTimeoutMs, 1, MAX_SESSION_PROMPT_TIMEOUT_MS);
  }

  setSessionPromptTimeout(timeoutMs: number): void {
    finiteInteger("sessionPromptTimeoutMs", timeoutMs, 1, MAX_SESSION_PROMPT_TIMEOUT_MS);
    this.sessionPromptTimeoutMs = timeoutMs;
  }

  createReminder(input: CreateReminderInput, now = Date.now()): SchedulerJob {
    validateNow(now);
    rejectNul(input.message, "message");
    if (input.message.length === 0) throw new Error("message must not be empty");
    const nextDue = initialDue(input.scheduleKind, input.schedule, input.timezone, now);
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO scheduler_jobs(
        id, kind, schedule_kind, schedule, timezone, message, enabled, next_due, created_at
      ) VALUES (?, 'reminder', ?, ?, ?, ?, 1, ?, ?)
    `).run(id, input.scheduleKind, input.schedule, input.timezone, input.message, nextDue, now);
    return this.requireJob(id);
  }

  createCommand(input: CreateCommandInput, now = Date.now()): SchedulerJob {
    validateNow(now);
    rejectNul(input.command, "command");
    rejectNul(input.cwd, "cwd");
    if (input.command.length === 0) throw new Error("command must not be empty");
    if (!isAbsolute(input.cwd)) throw new Error("Command cwd must be absolute");
    let cwdIsDirectory = false;
    try {
      cwdIsDirectory = statSync(input.cwd).isDirectory();
    } catch {
      throw new Error(`Command cwd does not exist: ${input.cwd}`);
    }
    if (!cwdIsDirectory) throw new Error(`Command cwd is not a directory: ${input.cwd}`);
    finiteInteger("startGraceMs", input.startGraceMs, 0, MAX_DURATION_MS);
    finiteInteger("timeoutMs", input.timeoutMs, 1, MAX_DURATION_MS);
    finiteInteger("outputBytes", input.outputBytes, 0, MAX_OUTPUT_BYTES);
    if (input.env !== undefined && (input.env === null || typeof input.env !== "object" || Array.isArray(input.env))) {
      throw new Error("env must be an object of string overrides");
    }
    const env = input.env ?? {};
    validateEnvironment(env);
    const nextDue = initialDue(input.scheduleKind, input.schedule, input.timezone, now);
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO scheduler_jobs(
        id, kind, schedule_kind, schedule, timezone, command_text, cwd, env_json,
        start_grace_ms, timeout_ms, output_bytes, enabled, next_due, created_at
      ) VALUES (?, 'command', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id,
      input.scheduleKind,
      input.schedule,
      input.timezone,
      input.command,
      input.cwd,
      JSON.stringify(env),
      input.startGraceMs,
      input.timeoutMs,
      input.outputBytes,
      nextDue,
      now,
    );
    return this.requireJob(id);
  }

  createSessionPrompt(input: CreateSessionPromptInput, now = Date.now()): SchedulerJob {
    validateNow(now);
    validateIdentity(input.sessionId, "sessionId");
    rejectNul(input.prompt, "prompt");
    if (input.prompt.trim().length === 0) throw new Error("prompt must not be empty");
    finiteInteger("startGraceMs", input.startGraceMs, 0, MAX_DURATION_MS);
    const timeoutMs = input.timeoutMs ?? this.sessionPromptTimeoutMs;
    finiteInteger("timeoutMs", timeoutMs, 1, MAX_SESSION_PROMPT_TIMEOUT_MS);
    finiteInteger("outputBytes", input.outputBytes, 0, MAX_OUTPUT_BYTES);
    const nextDue = initialDue(input.scheduleKind, input.schedule, input.timezone, now);
    const id = randomUUID();
    const create = this.db.transaction(() => {
      const session = this.db.prepare(`
        SELECT workspace, persistent FROM sessions WHERE id = ?
      `).get(input.sessionId) as { workspace: string; persistent: number } | undefined;
      if (!session) throw new Error(`Session not found: ${input.sessionId}`);
      if (session.persistent !== 1) throw new Error("Session must be persistent before scheduling prompts");
      this.db.prepare(`
        INSERT INTO scheduler_jobs(
          id, kind, schedule_kind, schedule, timezone, command_text, cwd, env_json,
          start_grace_ms, timeout_ms, output_bytes, enabled, next_due, created_at,
          session_id, prompt
        ) VALUES (?, 'command', ?, ?, ?, ?, ?, '{}', ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(
        id,
        input.scheduleKind,
        input.schedule,
        input.timezone,
        SESSION_PROMPT_COMMAND_SENTINEL,
        session.workspace,
        input.startGraceMs,
        timeoutMs,
        input.outputBytes,
        nextDue,
        now,
        input.sessionId,
        input.prompt,
      );
      return this.requireJob(id);
    });
    return create.immediate();
  }

  listJobs(includeDeleted = false): SchedulerJob[] {
    const rows = (includeDeleted
      ? this.db.prepare("SELECT * FROM scheduler_jobs ORDER BY created_at DESC, id").all()
      : this.db.prepare(`
          SELECT * FROM scheduler_jobs
          WHERE blocked_reason IS NULL OR blocked_reason <> 'deleted'
          ORDER BY created_at DESC, id
        `).all()) as JobRow[];
    return rows.map(jobFromRow);
  }

  listJobsForSession(sessionId: string): SchedulerJob[] {
    validateIdentity(sessionId, "sessionId");
    const rows = this.db.prepare(`
      SELECT * FROM scheduler_jobs
      WHERE kind = 'command' AND session_id = ? AND prompt IS NOT NULL
        AND (blocked_reason IS NULL OR blocked_reason <> 'deleted')
      ORDER BY created_at DESC, id
    `).all(sessionId) as JobRow[];
    return rows.map(jobFromRow);
  }

  setSessionJobsEnabled(sessionId: string, enabled: boolean, now = Date.now()): SchedulerJob[] {
    validateIdentity(sessionId, "sessionId");
    if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
    validateNow(now);
    const update = this.db.transaction(() => {
      if (enabled && !this.isPersistentSession(sessionId)) {
        throw new Error("Session must be persistent before enabling scheduled prompts");
      }
      const rows = this.db.prepare(`
        SELECT * FROM scheduler_jobs
        WHERE kind = 'command' AND session_id = ? AND prompt IS NOT NULL
          AND (blocked_reason IS NULL OR blocked_reason <> 'deleted')
        ORDER BY created_at DESC, id
      `).all(sessionId) as JobRow[];
      if (!enabled) {
        for (const row of rows) {
          if (row.enabled === 1) {
            this.db.prepare("UPDATE scheduler_jobs SET enabled = 0, suspended_by_session = 1 WHERE id = ?").run(row.id);
            this.cancelUnstarted(row.id, "Session prompt scheduling disabled", now);
          }
        }
      } else {
        for (const row of rows) {
          const job = jobFromRow(row);
          if (!job.suspendedBySession) continue;
          if (job.blockedReason !== null) continue;
          if (job.scheduleKind === "once") {
            if (job.nextDue !== null) {
              this.db.prepare("UPDATE scheduler_jobs SET enabled = 1, suspended_by_session = 0 WHERE id = ?").run(job.id);
            } else {
              this.db.prepare("UPDATE scheduler_jobs SET suspended_by_session = 0 WHERE id = ?").run(job.id);
            }
            continue;
          }
          const nextDue = job.nextDue === null || job.nextDue <= now
            ? nextCronDue(job.schedule, job.timezone, now)
            : job.nextDue;
          this.db.prepare("UPDATE scheduler_jobs SET enabled = 1, suspended_by_session = 0, next_due = ? WHERE id = ?")
            .run(nextDue, job.id);
        }
      }
      return this.listJobsForSession(sessionId);
    });
    return update.immediate();
  }

  getJob(id: string): SchedulerJob | null {
    const row = this.db.prepare("SELECT * FROM scheduler_jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? jobFromRow(row) : null;
  }

  pauseJob(id: string, now = Date.now()): SchedulerJob {
    validateNow(now);
    const pause = this.db.transaction(() => {
      this.requireJob(id);
      this.db.prepare("UPDATE scheduler_jobs SET enabled = 0, suspended_by_session = 0 WHERE id = ?").run(id);
      this.cancelUnstarted(id, "Job paused", now);
      return this.requireJob(id);
    });
    return pause.immediate();
  }

  resumeJob(id: string): SchedulerJob {
    const resume = this.db.transaction(() => {
      const job = this.requireJob(id);
      if (job.blockedReason) throw new Error(`Job is blocked: ${job.blockedReason}`);
      if (job.nextDue === null) throw new Error("Job has no future occurrence");
      if (job.kind === "session_prompt" && !this.isPersistentSession(job.sessionId)) {
        throw new Error("Session must be persistent before resuming scheduled prompts");
      }
      this.db.prepare("UPDATE scheduler_jobs SET enabled = 1, suspended_by_session = 0 WHERE id = ?").run(id);
      return this.requireJob(id);
    });
    return resume.immediate();
  }

  acknowledgeUnknown(id: string, now = Date.now()): SchedulerJob {
    validateNow(now);
    const acknowledge = this.db.transaction(() => {
      const job = this.requireJob(id);
      if (!job.blockedReason) return job;
      if (!/unknown outcome/i.test(job.blockedReason)) {
        throw new Error(`Job is blocked for another reason: ${job.blockedReason}`);
      }
      let nextDue = job.nextDue;
      if (job.scheduleKind === "cron" && (nextDue === null || nextDue <= now)) {
        nextDue = nextCronDue(job.schedule, job.timezone, now);
      }
      const canEnable = job.scheduleKind === "cron"
        && (job.kind !== "session_prompt" || this.isPersistentSession(job.sessionId));
      this.db.prepare(`
        UPDATE scheduler_jobs
        SET blocked_reason = NULL, enabled = ?, suspended_by_session = ?, next_due = ?
        WHERE id = ?
      `).run(canEnable ? 1 : 0, job.kind === "session_prompt" && !canEnable ? 1 : 0, nextDue, id);
      return this.requireJob(id);
    });
    return acknowledge.immediate();
  }

  deleteJob(id: string, now = Date.now()): SchedulerJob {
    validateNow(now);
    const remove = this.db.transaction(() => {
      this.requireJob(id);
      this.db.prepare(`
        UPDATE scheduler_jobs
        SET enabled = 0, suspended_by_session = 0, blocked_reason = 'deleted',
            deleted_at = COALESCE(deleted_at, ?)
        WHERE id = ?
      `).run(now, id);
      this.cancelUnstarted(id, "Job deleted", now);
      return this.requireJob(id);
    });
    return remove.immediate();
  }

  listInbox(options: { unackedOnly?: boolean; limit?: number } = {}): InboxRecord[] {
    const limit = options.limit ?? 100;
    finiteInteger("limit", limit, 1, 10_000);
    const rows = (options.unackedOnly ?? true)
      ? this.db.prepare(`
          SELECT * FROM scheduler_inbox
          WHERE acknowledged_at IS NULL
          ORDER BY created_at DESC, id DESC LIMIT ?
        `).all(limit) as InboxRow[]
      : this.db.prepare(`
          SELECT * FROM scheduler_inbox
          ORDER BY created_at DESC, id DESC LIMIT ?
        `).all(limit) as InboxRow[];
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      jobId: row.job_id,
      occurrenceId: row.occurrence_id,
      message: row.message,
      createdAt: row.created_at,
      acknowledgedAt: row.acknowledged_at,
      occurrence: this.requireOccurrence(row.occurrence_id),
    }));
  }

  listInboxForJobs(
    jobIds: string[],
    options: { unackedOnly?: boolean; limit?: number } = {},
  ): InboxRecord[] {
    const limit = options.limit ?? 100;
    finiteInteger("limit", limit, 1, 10_000);
    if (jobIds.length === 0) return [];
    for (const id of jobIds) validateIdentity(id, "job id");
    const rows: InboxRow[] = [];
    for (let offset = 0; offset < jobIds.length; offset += 500) {
      const chunk = jobIds.slice(offset, offset + 500);
      const placeholders = chunk.map(() => "?").join(", ");
      const unread = options.unackedOnly ?? true ? "AND acknowledged_at IS NULL" : "";
      rows.push(...this.db.prepare(`
        SELECT * FROM scheduler_inbox
        WHERE job_id IN (${placeholders}) ${unread}
        ORDER BY created_at DESC, id DESC LIMIT ?
      `).all(...chunk, limit) as InboxRow[]);
    }
    return rows
      .sort((left, right) => right.created_at - left.created_at || right.id - left.id)
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        jobId: row.job_id,
        occurrenceId: row.occurrence_id,
        message: row.message,
        createdAt: row.created_at,
        acknowledgedAt: row.acknowledged_at,
        occurrence: this.requireOccurrence(row.occurrence_id),
      }));
  }

  getInbox(id: number): InboxRecord | null {
    finiteInteger("inbox id", id, 1);
    const row = this.db.prepare("SELECT * FROM scheduler_inbox WHERE id = ?").get(id) as InboxRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      jobId: row.job_id,
      occurrenceId: row.occurrence_id,
      message: row.message,
      createdAt: row.created_at,
      acknowledgedAt: row.acknowledged_at,
      occurrence: this.requireOccurrence(row.occurrence_id),
    };
  }

  ackInbox(id: number, now = Date.now()): boolean {
    finiteInteger("inbox id", id, 1);
    validateNow(now);
    return this.db.prepare(`
      UPDATE scheduler_inbox SET acknowledged_at = ?
      WHERE id = ? AND acknowledged_at IS NULL
    `).run(now, id).changes === 1;
  }

  listRuns(jobId?: string, limit = 100): Occurrence[] {
    finiteInteger("limit", limit, 1, 10_000);
    const rows = jobId
      ? this.db.prepare(`
          SELECT * FROM scheduler_occurrences
          WHERE job_id = ? ORDER BY scheduled_at DESC, id DESC LIMIT ?
        `).all(jobId, limit) as OccurrenceRow[]
      : this.db.prepare(`
          SELECT * FROM scheduler_occurrences
          ORDER BY scheduled_at DESC, id DESC LIMIT ?
        `).all(limit) as OccurrenceRow[];
    return rows.map(occurrenceFromRow);
  }

  runNow(jobId: string, now = Date.now()): Occurrence {
    validateNow(now);
    const run = this.db.transaction(() => {
      const job = this.requireJob(jobId);
      if (job.blockedReason) throw new Error(`Job is blocked: ${job.blockedReason}`);
      if (!job.enabled) throw new Error("Job must be enabled before it can run now");
      if (job.kind === "session_prompt" && !this.isPersistentSession(job.sessionId)) {
        throw new Error("Session must be persistent to run scheduled prompts");
      }
      const latest = this.db.prepare(`
        SELECT MAX(scheduled_at) AS scheduled_at FROM scheduler_occurrences WHERE job_id = ?
      `).get(jobId) as { scheduled_at: number | null };
      const scheduledAt = latest.scheduled_at !== null && latest.scheduled_at >= now
        ? latest.scheduled_at + 1
        : now;
      if (job.kind === "reminder") {
        const occurrenceId = this.insertOccurrence(job.id, scheduledAt, "succeeded", now, now, null);
        this.insertInbox("reminder", job, occurrenceId, job.message ?? "", now);
        return this.requireOccurrence(occurrenceId);
      }

      const active = this.hasActiveOccurrence(job.id);
      const state: OccurrenceState = active ? "skipped" : "pending";
      const reason = active ? "A previous occurrence is still active" : null;
      const occurrenceId = this.insertOccurrence(job.id, scheduledAt, state, now, state === "skipped" ? now : null, reason);
      if (state === "skipped") {
        this.insertInbox("command_result", job, occurrenceId, resultInboxMessage(job, state, reason), now);
      }
      return this.requireOccurrence(occurrenceId);
    });
    return run.immediate();
  }

  materialize(now = Date.now(), batchSize = 100): Occurrence[] {
    validateNow(now);
    finiteInteger("batchSize", batchSize, 1, 10_000);
    const materializeDue = this.db.transaction(() => {
      const created: Occurrence[] = [];
      for (let index = 0; index < batchSize; index += 1) {
        const row = this.db.prepare(`
          SELECT * FROM scheduler_jobs
          WHERE enabled = 1 AND blocked_reason IS NULL AND next_due IS NOT NULL AND next_due <= ?
            AND (session_id IS NULL OR EXISTS (
              SELECT 1 FROM sessions s WHERE s.id = scheduler_jobs.session_id AND s.persistent = 1
            ))
          ORDER BY next_due, created_at, id LIMIT 1
        `).get(now) as JobRow | undefined;
        if (!row) break;
        const job = jobFromRow(row);
        const scheduledAt = job.nextDue;
        if (scheduledAt === null) break;

        let state: OccurrenceState;
        let reason: string | null = null;
        if (job.kind === "reminder") {
          state = "succeeded";
        } else if (now - scheduledAt > (job.startGraceMs ?? 0)) {
          state = "skipped";
          reason = job.kind === "session_prompt"
            ? "Occurrence exceeded its session prompt start grace period"
            : "Occurrence exceeded its command start grace period";
        } else if (this.hasActiveOccurrence(job.id)) {
          state = "skipped";
          reason = "A previous occurrence is still active";
        } else {
          state = "pending";
        }

        const terminalAt = state === "pending" ? null : now;
        const insert = this.db.prepare(`
          INSERT OR IGNORE INTO scheduler_occurrences(
            job_id, scheduled_at, state, created_at, started_at, finished_at, reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(job.id, scheduledAt, state, now, terminalAt, terminalAt, boundedReason(reason));
        if (insert.changes === 1) {
          const occurrenceId = Number(insert.lastInsertRowid);
          if (job.kind === "reminder") {
            this.insertInbox("reminder", job, occurrenceId, job.message ?? "", now);
          } else if (state === "skipped") {
            this.insertInbox("command_result", job, occurrenceId, resultInboxMessage(job, state, reason), now);
          }
          created.push(this.requireOccurrence(occurrenceId));
        }

        if (job.scheduleKind === "once") {
          this.db.prepare("UPDATE scheduler_jobs SET enabled = ?, next_due = NULL WHERE id = ?")
            .run(job.kind !== "reminder" && state === "pending" ? 1 : 0, job.id);
        } else {
          let nextDue = nextCronDue(job.schedule, job.timezone, scheduledAt);
          let skippedCursors = 0;
          while (nextDue <= now && skippedCursors < 10_000) {
            nextDue = nextCronDue(job.schedule, job.timezone, nextDue);
            skippedCursors += 1;
          }
          if (nextDue <= now) nextDue = nextCronDue(job.schedule, job.timezone, now);
          this.db.prepare("UPDATE scheduler_jobs SET next_due = ? WHERE id = ?").run(nextDue, job.id);
        }
      }
      return created;
    });
    return materializeDue.immediate();
  }

  tick(now = Date.now(), batchSize = 100): Occurrence[] {
    return this.materialize(now, batchSize);
  }

  acquireLease(owner: string, bootId: string, now = Date.now(), leaseMs = 20_000): boolean {
    validateIdentity(owner, "owner");
    validateIdentity(bootId, "bootId");
    validateNow(now);
    finiteInteger("leaseMs", leaseMs, 1, MAX_DURATION_MS);
    const acquire = this.db.transaction(() => {
      const current = this.db.prepare("SELECT * FROM scheduler_daemon_lease WHERE singleton = 1").get() as LeaseRow | undefined;
      if (current && current.expires_at > now && (current.owner !== owner || current.boot_id !== bootId)) return false;
      if (current && current.expires_at <= now) this.recoverInterrupted(now);
      if (current) {
        this.db.prepare(`
          UPDATE scheduler_daemon_lease
          SET owner = ?, boot_id = ?, acquired_at = ?, renewed_at = ?, expires_at = ?
          WHERE singleton = 1
        `).run(owner, bootId, now, now, now + leaseMs);
      } else {
        this.db.prepare(`
          INSERT INTO scheduler_daemon_lease(singleton, owner, boot_id, acquired_at, renewed_at, expires_at)
          VALUES (1, ?, ?, ?, ?, ?)
        `).run(owner, bootId, now, now, now + leaseMs);
      }
      return true;
    });
    return acquire.immediate();
  }

  renewLease(owner: string, bootId: string, now = Date.now(), leaseMs = 20_000): boolean {
    validateIdentity(owner, "owner");
    validateIdentity(bootId, "bootId");
    validateNow(now);
    finiteInteger("leaseMs", leaseMs, 1, MAX_DURATION_MS);
    const renew = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE scheduler_daemon_lease SET renewed_at = ?, expires_at = ?
        WHERE singleton = 1 AND owner = ? AND boot_id = ? AND expires_at > ?
      `).run(now, now + leaseMs, owner, bootId, now);
      if (result.changes !== 1) return false;
      this.db.prepare(`
        UPDATE scheduler_occurrences SET claim_lease_expires_at = ?
        WHERE state IN ('claimed', 'running') AND claim_owner = ? AND claim_boot_id = ?
      `).run(now + leaseMs, owner, bootId);
      const reservationOwner = sessionPromptReservation(owner, bootId, "").owner;
      this.db.prepare(`
        UPDATE session_operation_leases SET renewed_at = ?, expires_at = ?
        WHERE owner = ? AND token IN (
          SELECT 'session-prompt:' || claim_token
          FROM scheduler_occurrences
          WHERE state IN ('claimed', 'running')
            AND claim_owner = ? AND claim_boot_id = ? AND claim_token IS NOT NULL
        )
      `).run(now, now + leaseMs, reservationOwner, owner, bootId);
      return true;
    });
    return renew.immediate();
  }

  releaseLease(owner: string, bootId: string, now = Date.now()): boolean {
    validateNow(now);
    const release = this.db.transaction(() => this.db.prepare(`
      UPDATE scheduler_daemon_lease SET renewed_at = ?, expires_at = ?
      WHERE singleton = 1 AND owner = ? AND boot_id = ?
    `).run(now, now, owner, bootId).changes === 1);
    return release.immediate();
  }

  getLease(): DaemonLease | null {
    const row = this.db.prepare("SELECT * FROM scheduler_daemon_lease WHERE singleton = 1").get() as LeaseRow | undefined;
    return row ? leaseFromRow(row) : null;
  }

  claimCommands(owner: string, bootId: string, now = Date.now(), leaseMs = 20_000, limit = 1): ClaimedCommand[] {
    validateIdentity(owner, "owner");
    validateIdentity(bootId, "bootId");
    validateNow(now);
    finiteInteger("leaseMs", leaseMs, 1, MAX_DURATION_MS);
    finiteInteger("limit", limit, 1, 1_000);
    const claim = this.db.transaction(() => {
      const lease = this.db.prepare(`
        SELECT expires_at FROM scheduler_daemon_lease
        WHERE singleton = 1 AND owner = ? AND boot_id = ? AND expires_at > ?
      `).get(owner, bootId, now) as { expires_at: number } | undefined;
      if (!lease) return [];

      const overdue = this.db.prepare(`
        UPDATE scheduler_occurrences
        SET state = 'skipped', started_at = ?, finished_at = ?,
            reason = 'Occurrence exceeded its command start grace period',
            claim_token = NULL, claim_owner = NULL, claim_boot_id = NULL,
            claim_lease_expires_at = NULL
        WHERE state = 'pending' AND id IN (
          SELECT o.id FROM scheduler_occurrences o
           JOIN scheduler_jobs j ON j.id = o.job_id
           WHERE o.state = 'pending' AND j.kind = 'command'
             AND j.session_id IS NULL
             AND o.scheduled_at + j.start_grace_ms < ?
        )
        RETURNING id, job_id
      `).all(now, now, now) as { id: number; job_id: string }[];
      for (const row of overdue) {
        const job = this.requireCommandJob(row.job_id);
        this.disableCompletedOneShot(job.id);
        this.insertInbox(
          "command_result",
          job,
          row.id,
          resultInboxMessage(job, "skipped", "Occurrence exceeded its command start grace period"),
          now,
        );
      }

      const rows = this.db.prepare(`
        SELECT o.* FROM scheduler_occurrences o
        JOIN scheduler_jobs j ON j.id = o.job_id
        WHERE o.state = 'pending' AND j.kind = 'command'
          AND j.session_id IS NULL
          AND j.enabled = 1 AND j.blocked_reason IS NULL
        ORDER BY o.scheduled_at, o.id LIMIT ?
      `).all(limit) as OccurrenceRow[];
      const claimed: ClaimedCommand[] = [];
      for (const row of rows) {
        const token = randomUUID();
        const claimExpiresAt = Math.min(now + leaseMs, lease.expires_at);
        const result = this.db.prepare(`
          UPDATE scheduler_occurrences
          SET state = 'claimed', claim_token = ?, claim_owner = ?, claim_boot_id = ?,
              claim_lease_expires_at = ?, claimed_at = ?
          WHERE id = ? AND state = 'pending'
            AND EXISTS (
              SELECT 1 FROM scheduler_jobs j
              WHERE j.id = scheduler_occurrences.job_id AND j.kind = 'command'
                AND j.session_id IS NULL
                AND j.enabled = 1 AND j.blocked_reason IS NULL
            )
        `).run(token, owner, bootId, claimExpiresAt, now, row.id);
        if (result.changes !== 1) continue;
        const occurrence = this.requireOccurrence(row.id);
        const job = this.requireCommandJob(row.job_id);
        if (
          occurrence.state !== "claimed"
          || occurrence.claimToken === null
          || occurrence.claimOwner === null
          || occurrence.claimBootId === null
          || occurrence.claimLeaseExpiresAt === null
        ) {
          throw new Error("Claim transition did not persist");
        }
        claimed.push({
          job,
          occurrence: {
            ...occurrence,
            state: "claimed",
            claimToken: occurrence.claimToken,
            claimOwner: occurrence.claimOwner,
            claimBootId: occurrence.claimBootId,
            claimLeaseExpiresAt: occurrence.claimLeaseExpiresAt,
          },
        });
      }
      return claimed;
    });
    return claim.immediate();
  }

  startClaimedCommand(
    occurrenceId: number,
    claimToken: string,
    owner: string,
    bootId: string,
    now = Date.now(),
  ): Occurrence | null {
    finiteInteger("occurrence id", occurrenceId, 1);
    validateIdentity(claimToken, "claimToken");
    validateIdentity(owner, "owner");
    validateIdentity(bootId, "bootId");
    validateNow(now);
    const start = this.db.transaction(() => {
      const lease = this.db.prepare(`
        SELECT expires_at FROM scheduler_daemon_lease
        WHERE singleton = 1 AND owner = ? AND boot_id = ? AND expires_at > ?
      `).get(owner, bootId, now) as { expires_at: number } | undefined;
      if (!lease) return null;

      const row = this.db.prepare(`
        SELECT o.* FROM scheduler_occurrences o
        WHERE o.id = ? AND EXISTS (
            SELECT 1 FROM scheduler_jobs j
            WHERE j.id = o.job_id AND j.kind = 'command' AND j.session_id IS NULL
          )
          AND (
            o.state IN ('cancelled', 'skipped')
            OR (
              o.claim_token = ? AND o.claim_owner = ? AND o.claim_boot_id = ?
              AND o.claim_lease_expires_at > ?
            )
          )
      `).get(occurrenceId, claimToken, owner, bootId, now) as OccurrenceRow | undefined;
      if (!row) return null;
      if (row.state === "cancelled" || row.state === "skipped") return occurrenceFromRow(row);
      if (row.state !== "claimed") return null;

      const job = this.requireCommandJob(row.job_id);
      if (!job.enabled || job.blockedReason !== null) {
        const reason = job.blockedReason === "deleted" ? "Job deleted" : "Job paused";
        const result = this.db.prepare(`
          UPDATE scheduler_occurrences
          SET state = 'cancelled', finished_at = ?, reason = ?,
              claim_token = NULL, claim_owner = NULL, claim_boot_id = NULL,
              claim_lease_expires_at = NULL
          WHERE id = ? AND state = 'claimed' AND claim_token = ?
            AND claim_owner = ? AND claim_boot_id = ? AND claim_lease_expires_at > ?
        `).run(now, reason, occurrenceId, claimToken, owner, bootId, now);
        if (result.changes !== 1) return null;
        this.disableCompletedOneShot(job.id);
        this.insertInbox(
          "command_result",
          job,
          occurrenceId,
          resultInboxMessage(job, "cancelled", reason),
          now,
        );
        return this.requireOccurrence(occurrenceId);
      }

      if (now - row.scheduled_at > (job.startGraceMs ?? 0)) {
        const reason = "Occurrence exceeded its command start grace period";
        const result = this.db.prepare(`
          UPDATE scheduler_occurrences
          SET state = 'skipped', started_at = ?, finished_at = ?, reason = ?,
              claim_token = NULL, claim_owner = NULL, claim_boot_id = NULL,
              claim_lease_expires_at = NULL
          WHERE id = ? AND state = 'claimed' AND claim_token = ?
            AND claim_owner = ? AND claim_boot_id = ? AND claim_lease_expires_at > ?
        `).run(now, now, reason, occurrenceId, claimToken, owner, bootId, now);
        if (result.changes !== 1) return null;
        this.disableCompletedOneShot(job.id);
        this.insertInbox(
          "command_result",
          job,
          occurrenceId,
          resultInboxMessage(job, "skipped", reason),
          now,
        );
        return this.requireOccurrence(occurrenceId);
      }

      const result = this.db.prepare(`
        UPDATE scheduler_occurrences SET state = 'running', started_at = ?
        WHERE id = ? AND state = 'claimed' AND claim_token = ?
          AND claim_owner = ? AND claim_boot_id = ? AND claim_lease_expires_at > ?
          AND scheduled_at + ? >= ?
          AND EXISTS (
            SELECT 1 FROM scheduler_jobs j
            WHERE j.id = scheduler_occurrences.job_id
              AND j.kind = 'command' AND j.session_id IS NULL
              AND j.enabled = 1 AND j.blocked_reason IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM scheduler_daemon_lease l
            WHERE l.singleton = 1 AND l.owner = ? AND l.boot_id = ? AND l.expires_at > ?
          )
      `).run(
        now,
        occurrenceId,
        claimToken,
        owner,
        bootId,
        now,
        job.startGraceMs ?? 0,
        now,
        owner,
        bootId,
        now,
      );
      return result.changes === 1 ? this.requireOccurrence(occurrenceId) : null;
    });
    return start.immediate();
  }

  releaseSessionPromptReservation(sessionId: string, owner: string, token: string): boolean {
    validateIdentity(sessionId, "sessionId");
    validateIdentity(owner, "reservation owner");
    validateIdentity(token, "reservation token");
    return this.db.prepare(`
      DELETE FROM session_operation_leases WHERE session_id = ? AND owner = ? AND token = ?
    `).run(sessionId, owner, token).changes === 1;
  }

  finishCommand(
    occurrenceId: number,
    claimToken: string,
    owner: string,
    bootId: string,
    completion: CommandCompletion,
    now = Date.now(),
  ): Occurrence | null {
    finiteInteger("occurrence id", occurrenceId, 1);
    validateIdentity(claimToken, "claimToken");
    validateIdentity(owner, "owner");
    validateIdentity(bootId, "bootId");
    validateNow(now);
    validateCommandCompletion(completion);
    const reason = boundedReason(completion.reason);
    const finish = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT j.* FROM scheduler_jobs j
        JOIN scheduler_occurrences o ON o.job_id = j.id
        JOIN scheduler_daemon_lease l ON l.singleton = 1
        WHERE o.id = ? AND o.state = 'running' AND o.claim_token = ?
          AND o.claim_owner = ? AND o.claim_boot_id = ? AND o.claim_lease_expires_at > ?
          AND j.kind = 'command' AND j.session_id IS NULL
          AND l.owner = ? AND l.boot_id = ? AND l.expires_at > ?
      `).get(occurrenceId, claimToken, owner, bootId, now, owner, bootId, now) as JobRow | undefined;
      if (!row) return null;
      const job = jobFromRow(row);
      const outputLimit = job.outputBytes ?? 0;
      const stdout = completion.stdout.subarray(0, outputLimit);
      const stderr = completion.stderr.subarray(0, outputLimit);
      const stdoutBytes = Math.max(completion.stdoutBytes, completion.stdout.byteLength);
      const stderrBytes = Math.max(completion.stderrBytes, completion.stderr.byteLength);
      const result = this.db.prepare(`
        UPDATE scheduler_occurrences
        SET state = ?, finished_at = ?, exit_code = ?, signal = ?, reason = ?,
            stdout = ?, stderr = ?, stdout_bytes = ?, stderr_bytes = ?,
            stdout_truncated = ?, stderr_truncated = ?,
            claim_token = NULL, claim_owner = NULL, claim_boot_id = NULL,
            claim_lease_expires_at = NULL
        WHERE id = ? AND state = 'running' AND claim_token = ?
          AND claim_owner = ? AND claim_boot_id = ? AND claim_lease_expires_at > ?
          AND EXISTS (
            SELECT 1 FROM scheduler_daemon_lease l
            WHERE l.singleton = 1 AND l.owner = ? AND l.boot_id = ? AND l.expires_at > ?
          )
      `).run(
        completion.state,
        now,
        completion.exitCode,
        completion.signal,
        reason,
        stdout,
        stderr,
        stdoutBytes,
        stderrBytes,
        completion.stdoutTruncated || stdoutBytes > outputLimit ? 1 : 0,
        completion.stderrTruncated || stderrBytes > outputLimit ? 1 : 0,
        occurrenceId,
        claimToken,
        owner,
        bootId,
        now,
        owner,
        bootId,
        now,
      );
      if (result.changes !== 1) return null;
      if (completion.state === "unknown") this.blockUnknownJob(job.id);
      else this.disableCompletedOneShot(job.id);
      this.insertInbox(
        "command_result",
        job,
        occurrenceId,
        resultInboxMessage(job, completion.state, completion.reason),
        now,
      );
      return this.requireOccurrence(occurrenceId);
    });
    return finish.immediate();
  }

  claimSessionPrompts(
    owner: string,
    bootId: string,
    now = Date.now(),
    leaseMs = 20_000,
    limit = 1,
  ): ClaimedSessionPrompt[] {
    validateIdentity(owner, "owner");
    validateIdentity(bootId, "bootId");
    validateNow(now);
    finiteInteger("leaseMs", leaseMs, 1, MAX_DURATION_MS);
    finiteInteger("limit", limit, 1, 1_000);
    const claim = this.db.transaction(() => {
      const lease = this.db.prepare(`
        SELECT expires_at FROM scheduler_daemon_lease
        WHERE singleton = 1 AND owner = ? AND boot_id = ? AND expires_at > ?
      `).get(owner, bootId, now) as { expires_at: number } | undefined;
      if (!lease) return [];

      const overdue = this.db.prepare(`
        UPDATE scheduler_occurrences
        SET state = 'skipped', started_at = ?, finished_at = ?,
            reason = 'Occurrence exceeded its session prompt start grace period',
            claim_token = NULL, claim_owner = NULL, claim_boot_id = NULL,
            claim_lease_expires_at = NULL
        WHERE state = 'pending' AND id IN (
          SELECT o.id FROM scheduler_occurrences o
          JOIN scheduler_jobs j ON j.id = o.job_id
          JOIN sessions s ON s.id = j.session_id
          WHERE o.state = 'pending' AND j.kind = 'command'
            AND j.session_id IS NOT NULL AND j.prompt IS NOT NULL
            AND j.enabled = 1 AND j.blocked_reason IS NULL AND s.persistent = 1
            AND o.scheduled_at + j.start_grace_ms < ?
        )
        RETURNING id, job_id
      `).all(now, now, now) as { id: number; job_id: string }[];
      for (const row of overdue) {
        const job = this.requireSessionPromptJob(row.job_id);
        this.disableCompletedOneShot(job.id);
        this.insertInbox(
          "command_result",
          job,
          row.id,
          resultInboxMessage(job, "skipped", "Occurrence exceeded its session prompt start grace period"),
          now,
        );
      }

      const rows = this.db.prepare(`
        SELECT o.* FROM scheduler_occurrences o
        JOIN scheduler_jobs j ON j.id = o.job_id
        JOIN sessions s ON s.id = j.session_id
        WHERE o.state = 'pending' AND j.kind = 'command'
          AND j.session_id IS NOT NULL AND j.prompt IS NOT NULL
          AND j.enabled = 1 AND j.blocked_reason IS NULL AND s.persistent = 1
          AND NOT EXISTS (
            SELECT 1 FROM session_operation_leases sol
            WHERE sol.session_id = j.session_id AND sol.expires_at > ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM scheduler_occurrences active
            JOIN scheduler_jobs active_job ON active_job.id = active.job_id
            WHERE active_job.session_id = j.session_id AND active.state IN ('claimed', 'running')
          )
        ORDER BY o.scheduled_at, o.id LIMIT ?
      `).all(now, limit) as OccurrenceRow[];
      const claimed: ClaimedSessionPrompt[] = [];
      for (const row of rows) {
        const token = randomUUID();
        const claimExpiresAt = Math.min(now + leaseMs, lease.expires_at);
        const result = this.db.prepare(`
          UPDATE scheduler_occurrences
          SET state = 'claimed', claim_token = ?, claim_owner = ?, claim_boot_id = ?,
              claim_lease_expires_at = ?, claimed_at = ?
          WHERE id = ? AND state = 'pending'
            AND EXISTS (
              SELECT 1 FROM scheduler_jobs j
              JOIN sessions s ON s.id = j.session_id
              WHERE j.id = scheduler_occurrences.job_id AND j.kind = 'command'
                AND j.session_id IS NOT NULL AND j.prompt IS NOT NULL
                AND j.enabled = 1 AND j.blocked_reason IS NULL AND s.persistent = 1
                AND NOT EXISTS (
                  SELECT 1 FROM session_operation_leases sol
                  WHERE sol.session_id = j.session_id AND sol.expires_at > ?
                )
                AND NOT EXISTS (
                  SELECT 1 FROM scheduler_occurrences active
                  JOIN scheduler_jobs active_job ON active_job.id = active.job_id
                  WHERE active_job.session_id = j.session_id
                    AND active.id <> scheduler_occurrences.id
                    AND active.state IN ('claimed', 'running')
                )
            )
        `).run(token, owner, bootId, claimExpiresAt, now, row.id, now);
        if (result.changes !== 1) continue;
        const occurrence = this.requireOccurrence(row.id);
        const job = this.requireSessionPromptJob(row.job_id);
        if (
          occurrence.state !== "claimed"
          || occurrence.claimToken === null
          || occurrence.claimOwner === null
          || occurrence.claimBootId === null
          || occurrence.claimLeaseExpiresAt === null
        ) {
          throw new Error("Session prompt claim transition did not persist");
        }
        claimed.push({
          job,
          occurrence: {
            ...occurrence,
            state: "claimed",
            claimToken: occurrence.claimToken,
            claimOwner: occurrence.claimOwner,
            claimBootId: occurrence.claimBootId,
            claimLeaseExpiresAt: occurrence.claimLeaseExpiresAt,
          },
        });
      }
      return claimed;
    });
    return claim.immediate();
  }

  startClaimedSessionPrompt(
    occurrenceId: number,
    claimToken: string,
    owner: string,
    bootId: string,
    now = Date.now(),
  ): Occurrence | null {
    finiteInteger("occurrence id", occurrenceId, 1);
    validateIdentity(claimToken, "claimToken");
    validateIdentity(owner, "owner");
    validateIdentity(bootId, "bootId");
    validateNow(now);
    const start = this.db.transaction(() => {
      const lease = this.db.prepare(`
        SELECT expires_at FROM scheduler_daemon_lease
        WHERE singleton = 1 AND owner = ? AND boot_id = ? AND expires_at > ?
      `).get(owner, bootId, now) as { expires_at: number } | undefined;
      if (!lease) return null;

      const row = this.db.prepare(`
        SELECT o.* FROM scheduler_occurrences o
        WHERE o.id = ? AND EXISTS (
            SELECT 1 FROM scheduler_jobs j
            WHERE j.id = o.job_id AND j.kind = 'command'
              AND j.session_id IS NOT NULL AND j.prompt IS NOT NULL
          )
          AND (
            o.state IN ('cancelled', 'skipped')
            OR (
              o.claim_token = ? AND o.claim_owner = ? AND o.claim_boot_id = ?
              AND o.claim_lease_expires_at > ?
            )
          )
      `).get(occurrenceId, claimToken, owner, bootId, now) as OccurrenceRow | undefined;
      if (!row) return null;
      if (row.state === "cancelled" || row.state === "skipped") return occurrenceFromRow(row);
      if (row.state !== "claimed") return null;

      const job = this.requireSessionPromptJob(row.job_id);
      const persistent = this.isPersistentSession(job.sessionId);
      if (!job.enabled || job.blockedReason !== null || !persistent) {
        const reason = job.blockedReason === "deleted"
          ? "Job deleted"
          : !persistent
            ? "Session is no longer persistent"
            : "Job paused";
        const result = this.db.prepare(`
          UPDATE scheduler_occurrences
          SET state = 'cancelled', finished_at = ?, reason = ?,
              claim_token = NULL, claim_owner = NULL, claim_boot_id = NULL,
              claim_lease_expires_at = NULL
          WHERE id = ? AND state = 'claimed' AND claim_token = ?
            AND claim_owner = ? AND claim_boot_id = ? AND claim_lease_expires_at > ?
        `).run(now, reason, occurrenceId, claimToken, owner, bootId, now);
        if (result.changes !== 1) return null;
        this.disableCompletedOneShot(job.id);
        this.insertInbox(
          "command_result",
          job,
          occurrenceId,
          resultInboxMessage(job, "cancelled", reason),
          now,
        );
        return this.requireOccurrence(occurrenceId);
      }

      const sessionBusy = this.db.prepare(`
        SELECT 1 FROM session_operation_leases WHERE session_id = ? AND expires_at > ?
      `).get(job.sessionId, now);
      if (sessionBusy) {
        const deferred = this.db.prepare(`
          UPDATE scheduler_occurrences
          SET state = 'pending', claim_token = NULL, claim_owner = NULL,
              claim_boot_id = NULL, claim_lease_expires_at = NULL, claimed_at = NULL
          WHERE id = ? AND state = 'claimed' AND claim_token = ?
            AND claim_owner = ? AND claim_boot_id = ?
        `).run(occurrenceId, claimToken, owner, bootId);
        return deferred.changes === 1 ? this.requireOccurrence(occurrenceId) : null;
      }

      if (now - row.scheduled_at > (job.startGraceMs ?? 0)) {
        const reason = "Occurrence exceeded its session prompt start grace period";
        const result = this.db.prepare(`
          UPDATE scheduler_occurrences
          SET state = 'skipped', started_at = ?, finished_at = ?, reason = ?,
              claim_token = NULL, claim_owner = NULL, claim_boot_id = NULL,
              claim_lease_expires_at = NULL
          WHERE id = ? AND state = 'claimed' AND claim_token = ?
            AND claim_owner = ? AND claim_boot_id = ? AND claim_lease_expires_at > ?
        `).run(now, now, reason, occurrenceId, claimToken, owner, bootId, now);
        if (result.changes !== 1) return null;
        this.disableCompletedOneShot(job.id);
        this.insertInbox(
          "command_result",
          job,
          occurrenceId,
          resultInboxMessage(job, "skipped", reason),
          now,
        );
        return this.requireOccurrence(occurrenceId);
      }

      const reservation = sessionPromptReservation(owner, bootId, claimToken);
      this.db.prepare(`
        DELETE FROM session_operation_leases WHERE session_id = ? AND expires_at <= ?
      `).run(job.sessionId, now);
      const reserved = this.db.prepare(`
        INSERT OR IGNORE INTO session_operation_leases(
          session_id, owner, token, kind, acquired_at, renewed_at, expires_at
        ) VALUES (?, ?, ?, 'turn', ?, ?, ?)
      `).run(job.sessionId, reservation.owner, reservation.token, now, now, lease.expires_at);
      if (reserved.changes !== 1) return null;

      const result = this.db.prepare(`
        UPDATE scheduler_occurrences SET state = 'running', started_at = ?
        WHERE id = ? AND state = 'claimed' AND claim_token = ?
          AND claim_owner = ? AND claim_boot_id = ? AND claim_lease_expires_at > ?
          AND scheduled_at + ? >= ?
          AND EXISTS (
            SELECT 1 FROM scheduler_jobs j
            JOIN sessions s ON s.id = j.session_id
            WHERE j.id = scheduler_occurrences.job_id AND j.kind = 'command'
              AND j.session_id IS NOT NULL AND j.prompt IS NOT NULL
              AND j.enabled = 1 AND j.blocked_reason IS NULL AND s.persistent = 1
          )
          AND EXISTS (
            SELECT 1 FROM scheduler_daemon_lease l
            WHERE l.singleton = 1 AND l.owner = ? AND l.boot_id = ? AND l.expires_at > ?
          )
      `).run(
        now,
        occurrenceId,
        claimToken,
        owner,
        bootId,
        now,
        job.startGraceMs ?? 0,
        now,
        owner,
        bootId,
        now,
      );
      if (result.changes !== 1) {
        this.releaseSessionPromptReservation(job.sessionId, reservation.owner, reservation.token);
        return null;
      }
      return this.requireOccurrence(occurrenceId);
    });
    return start.immediate();
  }

  finishSessionPrompt(
    occurrenceId: number,
    claimToken: string,
    owner: string,
    bootId: string,
    completion: SessionPromptCompletion,
    now = Date.now(),
  ): Occurrence | null {
    finiteInteger("occurrence id", occurrenceId, 1);
    validateIdentity(claimToken, "claimToken");
    validateIdentity(owner, "owner");
    validateIdentity(bootId, "bootId");
    validateNow(now);
    if (completion === null || typeof completion !== "object") {
      throw new Error("Session prompt completion must be an object");
    }
    if (!["succeeded", "failed", "timed_out", "cancelled", "unknown"].includes(completion.state)) {
      throw new Error(`Invalid session prompt completion state: ${String(completion.state)}`);
    }
    const output = completion.output ?? completion.result ?? "";
    const error = completion.error ?? "";
    if (typeof output !== "string") throw new Error("Session prompt output must be a string");
    if (typeof error !== "string") throw new Error("Session prompt error must be a string");
    const outputBytes = Buffer.byteLength(output);
    const sanitizedOutput = sanitizedText(output);
    const errorBytes = Buffer.byteLength(error);
    const boundedError = boundedText(error, MAX_DIAGNOSTIC_BYTES);
    const code = completion.code;
    if (code !== undefined && !/^[a-z][a-z0-9_]{0,63}$/u.test(code)) {
      throw new Error("Session prompt completion code is invalid");
    }
    const reasonDetail = completion.reason
      ?? (completion.state === "failed" && error ? error : null);
    const reason = boundedReason(code
      ? `[${code}]${reasonDetail ? ` ${reasonDetail}` : error ? ` ${error}` : ""}`
      : reasonDetail);
    const finish = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT j.* FROM scheduler_jobs j
        JOIN scheduler_occurrences o ON o.job_id = j.id
        JOIN scheduler_daemon_lease l ON l.singleton = 1
        WHERE o.id = ? AND o.state = 'running' AND o.claim_token = ?
          AND o.claim_owner = ? AND o.claim_boot_id = ? AND o.claim_lease_expires_at > ?
          AND j.kind = 'command' AND j.session_id IS NOT NULL AND j.prompt IS NOT NULL
          AND l.owner = ? AND l.boot_id = ? AND l.expires_at > ?
      `).get(occurrenceId, claimToken, owner, bootId, now, owner, bootId, now) as JobRow | undefined;
      if (!row) return null;
      const job = this.requireSessionPromptJob(row.id);
      const outputLimit = job.outputBytes ?? 0;
      const stdout = boundedUtf8(sanitizedOutput, outputLimit);
      const stderr = boundedUtf8(boundedError, outputLimit);
      const result = this.db.prepare(`
        UPDATE scheduler_occurrences
        SET state = ?, finished_at = ?, exit_code = NULL, signal = NULL, reason = ?,
            stdout = ?, stderr = ?, stdout_bytes = ?, stderr_bytes = ?,
            stdout_truncated = ?, stderr_truncated = ?,
            claim_token = NULL, claim_owner = NULL, claim_boot_id = NULL,
            claim_lease_expires_at = NULL
        WHERE id = ? AND state = 'running' AND claim_token = ?
          AND claim_owner = ? AND claim_boot_id = ? AND claim_lease_expires_at > ?
          AND EXISTS (
            SELECT 1 FROM scheduler_daemon_lease l
            WHERE l.singleton = 1 AND l.owner = ? AND l.boot_id = ? AND l.expires_at > ?
          )
      `).run(
        completion.state,
        now,
        reason,
        stdout.buffer,
        stderr.buffer,
        outputBytes,
        errorBytes,
        stdout.truncated || outputBytes > stdout.buffer.byteLength ? 1 : 0,
        stderr.truncated || errorBytes > stderr.buffer.byteLength ? 1 : 0,
        occurrenceId,
        claimToken,
        owner,
        bootId,
        now,
        owner,
        bootId,
        now,
      );
      if (result.changes !== 1) return null;
      const reservation = sessionPromptReservation(owner, bootId, claimToken);
      this.releaseSessionPromptReservation(job.sessionId, reservation.owner, reservation.token);
      if (completion.state === "unknown") this.blockUnknownJob(job.id);
      else this.disableCompletedOneShot(job.id);
      this.insertInbox(
        "command_result",
        job,
        occurrenceId,
        resultInboxMessage(job, completion.state, reason),
        now,
      );
      return this.requireOccurrence(occurrenceId);
    });
    return finish.immediate();
  }

  /**
   * Remove claim material left behind by an older scheduler version or an
   * interrupted terminal transition. Active rows are deliberately excluded.
   */
  scrubTerminalClaims(nowOrBatchSize = Date.now(), requestedBatchSize?: number): number {
    const batchSize = requestedBatchSize === undefined && nowOrBatchSize > MAX_MAINTENANCE_BATCH_SIZE
      ? MAX_MAINTENANCE_BATCH_SIZE
      : requestedBatchSize ?? nowOrBatchSize;
    if (requestedBatchSize !== undefined || nowOrBatchSize <= MAX_MAINTENANCE_BATCH_SIZE) {
      if (requestedBatchSize !== undefined) validateNow(nowOrBatchSize);
      finiteInteger("batchSize", batchSize, 1, MAX_MAINTENANCE_BATCH_SIZE);
    } else {
      validateNow(nowOrBatchSize);
    }
    const scrub = this.db.transaction(() => {
      const rows = this.db.prepare(`
        UPDATE scheduler_occurrences
        SET claim_token = NULL, claim_owner = NULL, claim_boot_id = NULL,
            claim_lease_expires_at = NULL
        WHERE id IN (
          SELECT id FROM scheduler_occurrences
          WHERE state IN (${sqlStateList(TERMINAL_STATES)})
            AND ${terminalClaimPredicate()}
          ORDER BY id LIMIT ?
        )
        RETURNING id
      `).all(batchSize) as Array<{ id: number }>;
      return rows.length;
    });
    return scrub.immediate();
  }

  getStats(now = Date.now()): SchedulerStats {
    validateNow(now);
    const jobs = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END), 0) AS enabled,
        COALESCE(SUM(CASE WHEN blocked_reason IS NOT NULL THEN 1 ELSE 0 END), 0) AS blocked,
        COALESCE(SUM(CASE WHEN blocked_reason = 'deleted' THEN 1 ELSE 0 END), 0) AS deleted
      FROM scheduler_jobs
    `).get() as { total: number; enabled: number; blocked: number; deleted: number };
    const occurrences = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
        COALESCE(SUM(CASE WHEN state = 'claimed' THEN 1 ELSE 0 END), 0) AS claimed,
        COALESCE(SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END), 0) AS running,
        COALESCE(SUM(CASE WHEN state NOT IN ('pending', 'claimed', 'running') THEN 1 ELSE 0 END), 0) AS terminal,
        COALESCE(SUM(CASE WHEN state = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown
      FROM scheduler_occurrences
    `).get() as {
      total: number;
      pending: number;
      claimed: number;
      running: number;
      terminal: number;
      unknown: number;
    };
    const inbox = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN acknowledged_at IS NULL THEN 1 ELSE 0 END), 0) AS unread,
        COALESCE(SUM(CASE WHEN acknowledged_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS acknowledged
      FROM scheduler_inbox
    `).get() as { total: number; unread: number; acknowledged: number };
    const lease = this.db.prepare(`
      SELECT COUNT(*) AS daemon,
        COALESCE(SUM(CASE WHEN expires_at > ? THEN 1 ELSE 0 END), 0) AS daemon_active,
        COALESCE(SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END), 0) AS daemon_stale
      FROM scheduler_daemon_lease
    `).get(now, now) as { daemon: number; daemon_active: number; daemon_stale: number };
    const operationLease = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN expires_at > ? THEN 1 ELSE 0 END), 0) AS active,
        COALESCE(SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END), 0) AS stale
      FROM session_operation_leases
    `).get(now, now) as { total: number; active: number; stale: number };
    const claimCounts = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN state IN ('claimed', 'running')
          AND (claim_lease_expires_at IS NULL OR claim_lease_expires_at <= ?) THEN 1 ELSE 0 END), 0) AS stale,
        COALESCE(SUM(CASE WHEN state IN (${sqlStateList(TERMINAL_STATES)})
          AND ${terminalClaimPredicate()} THEN 1 ELSE 0 END), 0) AS terminal
      FROM scheduler_occurrences
    `).get(now) as { stale: number; terminal: number };
    const queueAges = this.db.prepare(`
      SELECT
        MAX(CASE WHEN state = 'pending'
          THEN CASE WHEN scheduled_at <= ? THEN ? - scheduled_at ELSE 0 END END) AS pending_ms,
        MAX(CASE WHEN state = 'claimed'
          THEN CASE WHEN COALESCE(claimed_at, scheduled_at) <= ?
            THEN ? - COALESCE(claimed_at, scheduled_at) ELSE 0 END END) AS claimed_ms,
        MAX(CASE WHEN state = 'running'
          THEN CASE WHEN COALESCE(started_at, claimed_at, scheduled_at) <= ?
            THEN ? - COALESCE(started_at, claimed_at, scheduled_at) ELSE 0 END END) AS running_ms
      FROM scheduler_occurrences
    `).get(now, now, now, now, now, now) as {
      pending_ms: number | null;
      claimed_ms: number | null;
      running_ms: number | null;
    };
    const output = this.db.prepare(`
      SELECT
        COALESCE(SUM(stdout_bytes), 0) AS stdout_bytes,
        COALESCE(SUM(stderr_bytes), 0) AS stderr_bytes,
        COALESCE(SUM(length(stdout)), 0) AS stdout_stored_bytes,
        COALESCE(SUM(length(stderr)), 0) AS stderr_stored_bytes,
        COALESCE(SUM(CASE WHEN stdout_truncated = 1 THEN 1 ELSE 0 END), 0) AS stdout_truncated,
        COALESCE(SUM(CASE WHEN stderr_truncated = 1 THEN 1 ELSE 0 END), 0) AS stderr_truncated
      FROM scheduler_occurrences
    `).get() as {
      stdout_bytes: number;
      stderr_bytes: number;
      stdout_stored_bytes: number;
      stderr_stored_bytes: number;
      stdout_truncated: number;
      stderr_truncated: number;
    };
    const leases = {
      daemon: lease.daemon,
      sessionOperations: operationLease.total,
      total: lease.daemon + operationLease.total,
      active: lease.daemon_active + operationLease.active,
      stale: lease.daemon_stale + operationLease.stale,
    };
    const outputStats = {
      stdoutBytes: output.stdout_bytes,
      stderrBytes: output.stderr_bytes,
      bytes: output.stdout_bytes + output.stderr_bytes,
      stdoutStoredBytes: output.stdout_stored_bytes,
      stderrStoredBytes: output.stderr_stored_bytes,
      storedBytes: output.stdout_stored_bytes + output.stderr_stored_bytes,
      stdoutTruncated: output.stdout_truncated,
      stderrTruncated: output.stderr_truncated,
      truncated: output.stdout_truncated + output.stderr_truncated,
    };
    return {
      jobs,
      occurrences,
      inbox,
      leases,
      staleClaims: claimCounts.stale,
      terminalClaims: claimCounts.terminal,
      queueAges: {
        pendingMs: queueAges.pending_ms,
        claimedMs: queueAges.claimed_ms,
        runningMs: queueAges.running_ms,
      },
      output: outputStats,
    };
  }

  stats(now = Date.now()): SchedulerStats {
    return this.getStats(now);
  }

  getSchedulerStats(now = Date.now()): SchedulerStats {
    return this.getStats(now);
  }

  planSchedulerRetention(
    policy: SchedulerRetentionPolicy,
    now = Date.now(),
  ): SchedulerRetentionReport {
    const checkedPolicy = validateRetentionPolicy(policy);
    validateNow(now);
    return this.schedulerRetentionReport(checkedPolicy, now, "dry-run", this.buildSchedulerRetentionPlan(checkedPolicy, now));
  }

  previewSchedulerRetention(
    policy: SchedulerRetentionPolicy,
    now = Date.now(),
  ): SchedulerRetentionReport {
    return this.planSchedulerRetention(policy, now);
  }

  applySchedulerRetention(
    policy: SchedulerRetentionPolicy,
    now = Date.now(),
  ): SchedulerRetentionReport {
    const checkedPolicy = validateRetentionPolicy(policy);
    validateNow(now);
    const apply = this.db.transaction(() => {
      // Plan under the same immediate writer lock used for mutation. SQLite
      // integer row ids can be reused after deletion, so carrying a plan
      // across a concurrent writer boundary is unsafe.
      const plan = this.buildSchedulerRetentionPlan(checkedPolicy, now);
      const counts = maintenanceCounts();
      const batchSize = checkedPolicy.batchSize ?? DEFAULT_MAINTENANCE_BATCH_SIZE;
      counts.terminalClaimsScrubbed = this.scrubTerminalClaimsInTransaction(batchSize);

      if (checkedPolicy.outputRetentionMs !== undefined) {
        const outputCutoff = this.retentionCutoff(now, checkedPolicy.outputRetentionMs);
        for (const row of plan.output) {
          const base = `
            id = ? AND ${knownTerminalStatePredicate()}
            AND COALESCE(finished_at, created_at) <= ?
          `;
          const stdoutResult = this.db.prepare(`
            UPDATE scheduler_occurrences SET stdout = NULL
            WHERE ${base} AND stdout IS NOT NULL AND length(stdout) = ?
          `).run(row.id, outputCutoff, row.stdout_stored_bytes);
          if (stdoutResult.changes === 1) {
            counts.stdoutScrubbed += 1;
            counts.stdoutBytes += row.stdout_stored_bytes ?? 0;
          }
          const stderrResult = this.db.prepare(`
            UPDATE scheduler_occurrences SET stderr = NULL
            WHERE ${base} AND stderr IS NOT NULL AND length(stderr) = ?
          `).run(row.id, outputCutoff, row.stderr_stored_bytes);
          if (stderrResult.changes === 1) {
            counts.stderrScrubbed += 1;
            counts.stderrBytes += row.stderr_stored_bytes ?? 0;
          }
        }
      }

      if (checkedPolicy.acknowledgedInboxRetentionMs !== undefined) {
        const inboxCutoff = this.retentionCutoff(now, checkedPolicy.acknowledgedInboxRetentionMs);
        for (const row of plan.inbox) {
          const deleted = this.db.prepare(`
            DELETE FROM scheduler_inbox
            WHERE id = ? AND acknowledged_at IS NOT NULL AND acknowledged_at <= ?
              AND NOT EXISTS (
                SELECT 1 FROM scheduler_occurrences o
                WHERE o.id = scheduler_inbox.occurrence_id
                  AND o.state NOT IN (${sqlStateList(RETAINABLE_TERMINAL_STATES)})
              )
              AND length(CAST(message AS BLOB)) = ?
          `).run(row.id, inboxCutoff, row.message_bytes);
          if (deleted.changes === 1) {
            counts.inboxDeleted += 1;
            counts.inboxBytes += row.message_bytes;
          }
        }
      }

      if (checkedPolicy.occurrenceRetentionMs !== undefined) {
        const occurrenceCutoff = this.retentionCutoff(now, checkedPolicy.occurrenceRetentionMs);
        const minimum = checkedPolicy.minOccurrencesPerJob ?? 0;
        for (const row of plan.occurrences) {
          const deleted = this.db.prepare(`
            DELETE FROM scheduler_occurrences
            WHERE id = ? AND ${knownTerminalStatePredicate()}
              AND COALESCE(finished_at, created_at) <= ?
              AND NOT EXISTS (
                SELECT 1 FROM scheduler_inbox i WHERE i.occurrence_id = scheduler_occurrences.id
              )
              AND (
                SELECT COUNT(*) FROM scheduler_occurrences newer
                WHERE newer.job_id = scheduler_occurrences.job_id
                  AND newer.state IN (${sqlStateList(TERMINAL_STATES)})
                  AND (
                    newer.scheduled_at > scheduler_occurrences.scheduled_at
                    OR (newer.scheduled_at = scheduler_occurrences.scheduled_at
                      AND newer.id > scheduler_occurrences.id)
                  )
              ) >= ?
          `).run(row.id, occurrenceCutoff, minimum);
          if (deleted.changes === 1) counts.occurrencesDeleted += 1;
        }
      }

      if (checkedPolicy.deletedJobRetentionMs !== undefined) {
        const jobCutoff = this.retentionCutoff(now, checkedPolicy.deletedJobRetentionMs);
        const jobs = this.db.prepare(`
          SELECT id FROM scheduler_jobs
          WHERE blocked_reason = 'deleted' AND deleted_at IS NOT NULL AND deleted_at <= ?
            AND NOT EXISTS (SELECT 1 FROM scheduler_occurrences o WHERE o.job_id = scheduler_jobs.id)
            AND NOT EXISTS (SELECT 1 FROM scheduler_inbox i WHERE i.job_id = scheduler_jobs.id)
          ORDER BY deleted_at, id LIMIT ?
        `).all(jobCutoff, batchSize) as Array<{ id: string }>;
        for (const row of jobs) {
          const deleted = this.db.prepare(`
            DELETE FROM scheduler_jobs
            WHERE id = ? AND blocked_reason = 'deleted'
              AND deleted_at IS NOT NULL AND deleted_at <= ?
              AND NOT EXISTS (SELECT 1 FROM scheduler_occurrences o WHERE o.job_id = scheduler_jobs.id)
              AND NOT EXISTS (SELECT 1 FROM scheduler_inbox i WHERE i.job_id = scheduler_jobs.id)
          `).run(row.id, jobCutoff);
          if (deleted.changes === 1) counts.jobsDeleted += 1;
        }
      }
      return { counts, plan };
    });
    const { counts, plan } = apply.immediate();
    return this.schedulerRetentionReport(checkedPolicy, now, "apply", {
      ...plan,
      terminalClaims: counts.terminalClaimsScrubbed,
      output: [],
      inbox: [],
      occurrences: [],
      jobs: counts.jobsDeleted,
      batchLimited: plan.batchLimited,
    }, counts);
  }

  schedulerRetention(
    policy: SchedulerRetentionPolicy,
    mode: SchedulerRetentionMode = "dry-run",
    now = Date.now(),
  ): SchedulerRetentionReport {
    if (mode === "dry-run") return this.planSchedulerRetention(policy, now);
    if (mode === "apply") return this.applySchedulerRetention(policy, now);
    throw new Error("Scheduler retention mode must be dry-run or apply");
  }

  pruneScheduler(
    policy: SchedulerRetentionPolicy,
    now = Date.now(),
  ): SchedulerRetentionReport {
    return this.applySchedulerRetention(policy, now);
  }

  pruneSchedulerRetention(
    policy: SchedulerRetentionPolicy,
    now = Date.now(),
  ): SchedulerRetentionReport {
    return this.applySchedulerRetention(policy, now);
  }

  private cancelUnstarted(jobId: string, reason: string, now: number): void {
    const rows = this.db.prepare(`
      UPDATE scheduler_occurrences
      SET state = 'cancelled', finished_at = ?, reason = ?,
          claim_token = NULL, claim_owner = NULL, claim_boot_id = NULL,
          claim_lease_expires_at = NULL
      WHERE job_id = ? AND state IN ('pending', 'claimed')
      RETURNING id
    `).all(now, boundedReason(reason), jobId) as { id: number }[];
    const job = this.requireJob(jobId);
    if (job.kind === "reminder") return;
    for (const row of rows) {
      this.insertInbox("command_result", job, row.id, resultInboxMessage(job, "cancelled", reason), now);
    }
  }

  private recoverInterrupted(now: number): void {
    const interrupted = this.db.prepare(`
      UPDATE scheduler_occurrences
      SET state = 'unknown', finished_at = ?, reason = 'Daemon lease expired before the result was recorded',
          claim_token = NULL, claim_owner = NULL, claim_boot_id = NULL,
          claim_lease_expires_at = NULL
      WHERE state IN ('claimed', 'running')
      RETURNING id, job_id
    `).all(now) as { id: number; job_id: string }[];
    for (const row of interrupted) {
      const job = this.requireJob(row.job_id);
      if (job.kind !== "reminder") {
        this.insertInbox(
          "command_result",
          job,
          row.id,
          resultInboxMessage(job, "unknown", "Daemon lease expired before the result was recorded"),
          now,
        );
        this.blockUnknownJob(job.id);
      }
    }
  }

  private disableCompletedOneShot(jobId: string): void {
    this.db.prepare(`
      UPDATE scheduler_jobs SET enabled = 0
      WHERE id = ? AND schedule_kind = 'once' AND next_due IS NULL
    `).run(jobId);
  }

  private blockUnknownJob(jobId: string): void {
    this.db.prepare(`
      UPDATE scheduler_jobs
      SET enabled = 0, blocked_reason = CASE
        WHEN schedule_kind = 'cron' THEN 'An occurrence has an unknown outcome'
        ELSE blocked_reason
      END
      WHERE id = ?
    `).run(jobId);
  }

  private retentionCutoff(now: number, retentionMs: number): number {
    return Math.max(Number.MIN_SAFE_INTEGER, now - retentionMs);
  }

  private scrubTerminalClaimsInTransaction(batchSize: number): number {
    const rows = this.db.prepare(`
      UPDATE scheduler_occurrences
      SET claim_token = NULL, claim_owner = NULL, claim_boot_id = NULL,
          claim_lease_expires_at = NULL
      WHERE id IN (
        SELECT id FROM scheduler_occurrences
        WHERE state IN (${sqlStateList(TERMINAL_STATES)})
          AND ${terminalClaimPredicate()}
        ORDER BY id LIMIT ?
      )
      RETURNING id
    `).all(batchSize) as Array<{ id: number }>;
    return rows.length;
  }

  private buildSchedulerRetentionPlan(
    policy: SchedulerRetentionPolicy,
    now: number,
  ): RetentionPlan {
    const batchSize = policy.batchSize ?? DEFAULT_MAINTENANCE_BATCH_SIZE;
    let batchLimited = false;
    const output: RetentionOutputRow[] = [];
    if (policy.outputRetentionMs !== undefined) {
      const cutoff = this.retentionCutoff(now, policy.outputRetentionMs);
      const rows = this.db.prepare(`
        SELECT id, length(stdout) AS stdout_stored_bytes,
          length(stderr) AS stderr_stored_bytes
        FROM scheduler_occurrences
        WHERE ${knownTerminalStatePredicate()}
          AND COALESCE(finished_at, created_at) <= ?
          AND (stdout IS NOT NULL OR stderr IS NOT NULL)
        ORDER BY COALESCE(finished_at, created_at), id LIMIT ?
      `).all(cutoff, batchSize + 1) as RetentionOutputRow[];
      if (rows.length > batchSize) batchLimited = true;
      output.push(...rows.slice(0, batchSize));
    }

    const inbox: RetentionInboxRow[] = [];
    if (policy.acknowledgedInboxRetentionMs !== undefined) {
      const cutoff = this.retentionCutoff(now, policy.acknowledgedInboxRetentionMs);
      const rows = this.db.prepare(`
        SELECT i.id, length(CAST(i.message AS BLOB)) AS message_bytes
        FROM scheduler_inbox i
        JOIN scheduler_occurrences o ON o.id = i.occurrence_id
        WHERE i.acknowledged_at IS NOT NULL AND i.acknowledged_at <= ?
          AND o.state IN (${sqlStateList(RETAINABLE_TERMINAL_STATES)})
        ORDER BY i.acknowledged_at, i.id LIMIT ?
      `).all(cutoff, batchSize + 1) as RetentionInboxRow[];
      if (rows.length > batchSize) batchLimited = true;
      inbox.push(...rows.slice(0, batchSize));
    }

    const occurrences: RetentionOccurrenceRow[] = [];
    if (policy.occurrenceRetentionMs !== undefined) {
      const cutoff = this.retentionCutoff(now, policy.occurrenceRetentionMs);
      const minimum = policy.minOccurrencesPerJob ?? 0;
      const inboxProtection = policy.acknowledgedInboxRetentionMs === undefined
        ? `AND NOT EXISTS (
            SELECT 1 FROM scheduler_inbox i WHERE i.occurrence_id = o.id
          )`
        : `AND NOT EXISTS (
            SELECT 1 FROM scheduler_inbox i
            WHERE i.occurrence_id = o.id
              AND (i.acknowledged_at IS NULL OR i.acknowledged_at > ?)
          )`;
      const parameters: number[] = [cutoff];
      if (policy.acknowledgedInboxRetentionMs !== undefined) {
        parameters.push(this.retentionCutoff(now, policy.acknowledgedInboxRetentionMs));
      }
      parameters.push(minimum, batchSize + 1);
      const rows = this.db.prepare(`
        SELECT o.id, COALESCE(length(o.stdout), 0) AS stdout_bytes,
          COALESCE(length(o.stderr), 0) AS stderr_bytes
        FROM scheduler_occurrences o
        WHERE ${knownTerminalStatePredicate("o")}
          AND COALESCE(o.finished_at, o.created_at) <= ?
          ${inboxProtection}
          AND (
            SELECT COUNT(*) FROM scheduler_occurrences newer
            WHERE newer.job_id = o.job_id
              AND newer.state IN (${sqlStateList(TERMINAL_STATES)})
              AND (
                newer.scheduled_at > o.scheduled_at
                OR (newer.scheduled_at = o.scheduled_at AND newer.id > o.id)
              )
          ) >= ?
        ORDER BY COALESCE(o.finished_at, o.created_at), o.id LIMIT ?
      `).all(...parameters) as RetentionOccurrenceRow[];
      if (rows.length > batchSize) batchLimited = true;
      occurrences.push(...rows.slice(0, batchSize));
    }

    const claimCount = this.db.prepare(`
      SELECT COUNT(*) AS count FROM scheduler_occurrences
      WHERE state IN (${sqlStateList(TERMINAL_STATES)}) AND ${terminalClaimPredicate()}
    `).get() as { count: number };
    if (claimCount.count > batchSize) batchLimited = true;
    const terminalClaims = Math.min(claimCount.count, batchSize);

    let jobs = 0;
    if (policy.deletedJobRetentionMs !== undefined) {
      const cutoff = this.retentionCutoff(now, policy.deletedJobRetentionMs);
      const rows = this.db.prepare(`
        SELECT id FROM scheduler_jobs
        WHERE blocked_reason = 'deleted' AND deleted_at IS NOT NULL AND deleted_at <= ?
          AND NOT EXISTS (SELECT 1 FROM scheduler_occurrences o WHERE o.job_id = scheduler_jobs.id)
          AND NOT EXISTS (SELECT 1 FROM scheduler_inbox i WHERE i.job_id = scheduler_jobs.id)
        ORDER BY deleted_at, id LIMIT ?
      `).all(cutoff, batchSize + 1) as Array<{ id: string }>;
      if (rows.length > batchSize) batchLimited = true;
      jobs = Math.min(rows.length, batchSize);
    }
    return { output, inbox, occurrences, terminalClaims, jobs, batchLimited };
  }

  private schedulerRetentionReport(
    policy: SchedulerRetentionPolicy,
    now: number,
    mode: SchedulerRetentionMode,
    plan: RetentionPlan,
    applied?: MaintenanceCounts,
  ): SchedulerRetentionReport {
    const counts = applied ?? maintenanceCounts();
    if (applied === undefined) {
      counts.terminalClaimsScrubbed = plan.terminalClaims;
      counts.stdoutScrubbed = plan.output.reduce(
        (total, row) => total + (row.stdout_stored_bytes !== null ? 1 : 0),
        0,
      );
      counts.stderrScrubbed = plan.output.reduce(
        (total, row) => total + (row.stderr_stored_bytes !== null ? 1 : 0),
        0,
      );
      counts.stdoutBytes = plan.output.reduce((total, row) => total + (row.stdout_stored_bytes ?? 0), 0);
      counts.stderrBytes = plan.output.reduce((total, row) => total + (row.stderr_stored_bytes ?? 0), 0);
      counts.inboxDeleted = plan.inbox.length;
      counts.inboxBytes = plan.inbox.reduce((total, row) => total + row.message_bytes, 0);
      counts.occurrencesDeleted = plan.occurrences.length;
      counts.jobsDeleted = plan.jobs;
    }
    return {
      mode,
      dryRun: mode === "dry-run",
      now,
      policy: { ...policy },
      terminalClaimsScrubbed: counts.terminalClaimsScrubbed,
      stdoutScrubbed: counts.stdoutScrubbed,
      stderrScrubbed: counts.stderrScrubbed,
      stdoutBytes: counts.stdoutBytes,
      stderrBytes: counts.stderrBytes,
      outputBytes: counts.stdoutBytes + counts.stderrBytes,
      inboxDeleted: counts.inboxDeleted,
      inboxBytes: counts.inboxBytes,
      occurrencesDeleted: counts.occurrencesDeleted,
      jobsDeleted: counts.jobsDeleted,
      batchLimited: plan.batchLimited,
    };
  }

  private insertOccurrence(
    jobId: string,
    scheduledAt: number,
    state: OccurrenceState,
    createdAt: number,
    finishedAt: number | null,
    reason: string | null,
  ): number {
    const result = this.db.prepare(`
      INSERT INTO scheduler_occurrences(
        job_id, scheduled_at, state, created_at, started_at, finished_at, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(jobId, scheduledAt, state, createdAt, finishedAt, finishedAt, boundedReason(reason));
    return Number(result.lastInsertRowid);
  }

  private insertInbox(
    kind: "reminder" | "command_result",
    job: SchedulerJob,
    occurrenceId: number,
    message: string,
    now: number,
  ): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO scheduler_inbox(kind, job_id, occurrence_id, message, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(kind, job.id, occurrenceId, boundedText(message, MAX_INBOX_MESSAGE_BYTES), now);
  }

  private hasActiveOccurrence(jobId: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM scheduler_occurrences
      WHERE job_id = ? AND state IN ('pending', 'claimed', 'running') LIMIT 1
    `).get(jobId));
  }

  private requireJob(id: string): SchedulerJob {
    const job = this.getJob(id);
    if (!job) throw new Error(`Scheduler job not found: ${id}`);
    return job;
  }

  private requireCommandJob(id: string): SchedulerJob & { kind: "command"; command: string; cwd: string } {
    const job = this.requireJob(id);
    if (job.kind !== "command" || job.sessionId !== null || job.command === null || job.cwd === null) {
      throw new Error(`Scheduler job is not a command: ${id}`);
    }
    return { ...job, kind: "command", command: job.command, cwd: job.cwd };
  }

  private requireSessionPromptJob(id: string): ClaimedSessionPrompt["job"] {
    const job = this.requireJob(id);
    if (
      job.kind !== "session_prompt"
      || job.sessionId === null
      || job.prompt === null
      || job.cwd === null
    ) {
      throw new Error(`Scheduler job is not a session prompt: ${id}`);
    }
    return {
      ...job,
      kind: "session_prompt",
      sessionId: job.sessionId,
      prompt: job.prompt,
      cwd: job.cwd,
    };
  }

  private isPersistentSession(sessionId: string | null): boolean {
    if (sessionId === null) return false;
    return Boolean(this.db.prepare("SELECT 1 FROM sessions WHERE id = ? AND persistent = 1").get(sessionId));
  }

  private requireOccurrence(id: number): Occurrence {
    const row = this.db.prepare("SELECT * FROM scheduler_occurrences WHERE id = ?").get(id) as OccurrenceRow | undefined;
    if (!row) throw new Error(`Scheduler occurrence not found: ${id}`);
    return occurrenceFromRow(row);
  }
}

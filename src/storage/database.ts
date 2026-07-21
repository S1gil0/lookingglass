import Database from "better-sqlite3";
import { dirname } from "node:path";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { bashApprovalExecutable } from "../tools/safety.js";

const SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL,
  verbosity TEXT NOT NULL,
  fast INTEGER NOT NULL CHECK (fast IN (0, 1)),
  prompt_cache_key TEXT NOT NULL UNIQUE,
  last_response_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS sessions_workspace_updated
ON sessions(workspace, updated_at DESC);

CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'user', 'response', 'tool_started', 'tool_result',
    'tool_denied', 'error', 'note'
  )),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, sequence)
) STRICT;

CREATE INDEX IF NOT EXISTS session_events_ordered
ON session_events(session_id, sequence);

CREATE TABLE IF NOT EXISTS context_checkpoints (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  through_sequence INTEGER NOT NULL,
  compact_json TEXT NOT NULL CHECK (json_valid(compact_json)),
  input_tokens INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, through_sequence)
) STRICT;

CREATE INDEX IF NOT EXISTS context_checkpoints_latest
ON context_checkpoints(session_id, through_sequence DESC);

CREATE TABLE IF NOT EXISTS tool_calls (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  name TEXT NOT NULL,
  arguments_json TEXT NOT NULL CHECK (json_valid(arguments_json)),
  state TEXT NOT NULL CHECK (state IN (
    'started', 'completed', 'denied', 'failed', 'unknown'
  )),
  output_text TEXT,
  error_text TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY(session_id, call_id)
) STRICT;

CREATE INDEX IF NOT EXISTS tool_calls_state
ON tool_calls(state, started_at);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  file_path TEXT NOT NULL UNIQUE,
  byte_count INTEGER NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  created_at INTEGER NOT NULL
) STRICT;
`;

const SCHEDULER_SCHEMA = `
CREATE TABLE scheduler_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('reminder', 'command')),
  schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('once', 'cron')),
  schedule TEXT NOT NULL,
  timezone TEXT NOT NULL,
  message TEXT,
  command_text TEXT,
  cwd TEXT,
  env_json TEXT CHECK (env_json IS NULL OR json_valid(env_json)),
  start_grace_ms INTEGER,
  timeout_ms INTEGER,
  output_bytes INTEGER,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  blocked_reason TEXT,
  next_due INTEGER,
  created_at INTEGER NOT NULL,
  CHECK (
    (kind = 'reminder' AND message IS NOT NULL AND command_text IS NULL AND cwd IS NULL
      AND env_json IS NULL AND start_grace_ms IS NULL AND timeout_ms IS NULL AND output_bytes IS NULL)
    OR
    (kind = 'command' AND message IS NULL AND command_text IS NOT NULL AND cwd IS NOT NULL
      AND env_json IS NOT NULL AND start_grace_ms IS NOT NULL AND timeout_ms IS NOT NULL
      AND output_bytes IS NOT NULL)
  )
) STRICT;

CREATE INDEX scheduler_jobs_due
ON scheduler_jobs(enabled, next_due)
WHERE enabled = 1 AND blocked_reason IS NULL AND next_due IS NOT NULL;

CREATE TABLE scheduler_occurrences (
  id INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES scheduler_jobs(id),
  scheduled_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'claimed', 'running', 'succeeded', 'failed', 'timed_out',
    'cancelled', 'skipped', 'unknown'
  )),
  claim_token TEXT,
  claim_owner TEXT,
  claim_boot_id TEXT,
  claim_lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  exit_code INTEGER,
  signal TEXT,
  reason TEXT,
  stdout BLOB,
  stderr BLOB,
  stdout_bytes INTEGER NOT NULL DEFAULT 0 CHECK (stdout_bytes >= 0),
  stderr_bytes INTEGER NOT NULL DEFAULT 0 CHECK (stderr_bytes >= 0),
  stdout_truncated INTEGER NOT NULL DEFAULT 0 CHECK (stdout_truncated IN (0, 1)),
  stderr_truncated INTEGER NOT NULL DEFAULT 0 CHECK (stderr_truncated IN (0, 1)),
  UNIQUE(job_id, scheduled_at)
) STRICT;

CREATE INDEX scheduler_occurrences_job_runs
ON scheduler_occurrences(job_id, scheduled_at DESC);

CREATE INDEX scheduler_occurrences_pending
ON scheduler_occurrences(state, scheduled_at)
WHERE state = 'pending';

CREATE UNIQUE INDEX scheduler_occurrences_no_overlap
ON scheduler_occurrences(job_id)
WHERE state IN ('pending', 'claimed', 'running');

CREATE TABLE scheduler_inbox (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('reminder', 'command_result')),
  job_id TEXT NOT NULL REFERENCES scheduler_jobs(id),
  occurrence_id INTEGER NOT NULL UNIQUE REFERENCES scheduler_occurrences(id),
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  acknowledged_at INTEGER
) STRICT;

CREATE INDEX scheduler_inbox_unacked
ON scheduler_inbox(acknowledged_at, created_at DESC);

CREATE TABLE scheduler_daemon_lease (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  renewed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
`;

const SESSION_LEASE_SCHEMA = `
ALTER TABLE tool_calls ADD COLUMN execution_token TEXT;

CREATE TABLE session_operation_leases (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('turn', 'compact')),
  acquired_at INTEGER NOT NULL,
  renewed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX session_operation_leases_expiry
ON session_operation_leases(expires_at);
`;

const SESSION_AUTOMATION_SCHEMA = `
ALTER TABLE sessions ADD COLUMN show_reasoning INTEGER NOT NULL DEFAULT 0
CHECK (show_reasoning IN (0, 1));
ALTER TABLE sessions ADD COLUMN persistent INTEGER NOT NULL DEFAULT 0
CHECK (persistent IN (0, 1));

ALTER TABLE scheduler_jobs ADD COLUMN session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE;
ALTER TABLE scheduler_jobs ADD COLUMN prompt TEXT;

CREATE INDEX scheduler_jobs_session
ON scheduler_jobs(session_id, created_at DESC);
`;

const SESSION_SCHEDULE_STATE_SCHEMA = `
ALTER TABLE scheduler_jobs ADD COLUMN suspended_by_session INTEGER NOT NULL DEFAULT 0
CHECK (suspended_by_session IN (0, 1));

UPDATE scheduler_jobs
SET enabled = 0, suspended_by_session = 1
WHERE session_id IS NOT NULL AND enabled = 1 AND EXISTS (
  SELECT 1 FROM sessions s WHERE s.id = scheduler_jobs.session_id AND s.persistent = 0
);
`;

const SESSION_SCHEDULE_RECONCILIATION_SCHEMA = `
UPDATE scheduler_jobs
SET enabled = 0, suspended_by_session = 1
WHERE session_id IS NOT NULL AND enabled = 1 AND EXISTS (
  SELECT 1 FROM sessions s WHERE s.id = scheduler_jobs.session_id AND s.persistent = 0
);
`;

const SESSION_PROVIDER_SCHEMA = `
ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'codex-lb'
CHECK (provider IN ('codex-lb', 'lm-studio'));

CREATE INDEX sessions_workspace_provider_updated
ON sessions(workspace, provider, updated_at DESC);
`;

const SESSION_APPROVAL_SCHEMA = `
ALTER TABLE sessions ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'review'
CHECK (approval_mode IN ('review', 'code', 'unrestricted'));
`;

const SESSION_COMMAND_APPROVAL_SCHEMA = `
CREATE TABLE session_command_approvals (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  signature TEXT NOT NULL CHECK (length(signature) > 0),
  approved_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, signature)
) STRICT;
`;

const SESSION_AGENT_SCHEMA = `
ALTER TABLE sessions ADD COLUMN agent_provider TEXT
CHECK (agent_provider IS NULL OR agent_provider IN ('codex-lb', 'lm-studio'));
ALTER TABLE sessions ADD COLUMN agent_model TEXT
CHECK (agent_model IS NULL OR length(agent_model) > 0);
ALTER TABLE sessions ADD COLUMN agent_reasoning_effort TEXT;
ALTER TABLE sessions ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'interactive'
CHECK (session_kind IN ('interactive', 'agent'));
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE;

UPDATE sessions
SET agent_provider = provider,
    agent_model = model,
    agent_reasoning_effort = reasoning_effort;

CREATE INDEX sessions_parent_kind
ON sessions(parent_session_id, session_kind, created_at);
`;

const SESSION_AGENT_TOGGLE_SCHEMA = `
ALTER TABLE sessions ADD COLUMN agents_enabled INTEGER NOT NULL DEFAULT 1
CHECK (agents_enabled IN (0, 1));
`;

function migrateBashApprovalScopes(db: GlassDatabase): void {
  const rows = db.prepare(`
    SELECT session_id, signature, approved_at
    FROM session_command_approvals
    WHERE signature LIKE '["bash-exec",%'
       OR signature LIKE '["bash-executable",1,%'
  `).all() as { session_id: string; signature: string; approved_at: number }[];
  const register = db.prepare(`
    INSERT OR IGNORE INTO session_command_approvals(session_id, signature, approved_at)
    VALUES (?, ?, ?)
  `);
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.signature);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const executable = parsed[0] === "bash-exec" && typeof parsed[2] === "string"
      ? bashApprovalExecutable(parsed[2])
      : parsed[0] === "bash-executable" && parsed[1] === 1 && typeof parsed[3] === "string"
        ? parsed[3]
        : null;
    if (executable) {
      register.run(row.session_id, JSON.stringify(["bash-executable", 2, executable]), row.approved_at);
    }
  }
}

export type GlassDatabase = Database.Database;

export function openDatabase(path: string): GlassDatabase {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const previousUmask = process.umask(0o077);
  let db: GlassDatabase;
  try {
    db = new Database(path, { timeout: 5_000 });
    chmodSync(path, 0o600);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.pragma("wal_autocheckpoint = 1000");
    for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
      if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
    }
  } finally {
    process.umask(previousUmask);
  }

  const migrate = db.transaction(() => {
    db.exec(SESSION_SCHEMA);
    db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)").run(Date.now());
    const schedulerMigration = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 2").get();
    if (!schedulerMigration) {
      db.exec(SCHEDULER_SCHEMA);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (2, ?)").run(Date.now());
    }
    const sessionLeaseMigration = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 3").get();
    if (!sessionLeaseMigration) {
      db.exec(SESSION_LEASE_SCHEMA);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (3, ?)").run(Date.now());
    }
    const sessionAutomationMigration = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 4").get();
    if (!sessionAutomationMigration) {
      db.exec(SESSION_AUTOMATION_SCHEMA);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (4, ?)").run(Date.now());
    }
    const sessionScheduleStateMigration = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 5").get();
    if (!sessionScheduleStateMigration) {
      db.exec(SESSION_SCHEDULE_STATE_SCHEMA);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (5, ?)").run(Date.now());
    }
    const sessionScheduleReconciliation = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 6").get();
    if (!sessionScheduleReconciliation) {
      db.exec(SESSION_SCHEDULE_RECONCILIATION_SCHEMA);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (6, ?)").run(Date.now());
    }
    const sessionScheduleOccurrenceReconciliation = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 7").get();
    if (!sessionScheduleOccurrenceReconciliation) {
      const now = Date.now();
      db.prepare(`
        UPDATE scheduler_occurrences
        SET state = 'cancelled', finished_at = ?, reason = 'Session persistence is disabled'
        WHERE state IN ('pending', 'claimed') AND job_id IN (
          SELECT j.id FROM scheduler_jobs j
          JOIN sessions s ON s.id = j.session_id
          WHERE s.persistent = 0
        )
      `).run(now);
      db.exec(SESSION_SCHEDULE_RECONCILIATION_SCHEMA);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (7, ?)").run(now);
    }
    const sessionProviderMigration = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 8").get();
    if (!sessionProviderMigration) {
      db.exec(SESSION_PROVIDER_SCHEMA);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (8, ?)").run(Date.now());
    }
    const sessionApprovalMigration = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 9").get();
    if (!sessionApprovalMigration) {
      db.exec(SESSION_APPROVAL_SCHEMA);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (9, ?)").run(Date.now());
    }
    const sessionCommandApprovalMigration = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 10").get();
    if (!sessionCommandApprovalMigration) {
      db.exec(SESSION_COMMAND_APPROVAL_SCHEMA);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (10, ?)").run(Date.now());
    }
    const sessionAgentMigration = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 11").get();
    if (!sessionAgentMigration) {
      db.exec(SESSION_AGENT_SCHEMA);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (11, ?)").run(Date.now());
    }
    const sessionAgentToggleMigration = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 12").get();
    if (!sessionAgentToggleMigration) {
      db.exec(SESSION_AGENT_TOGGLE_SCHEMA);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (12, ?)").run(Date.now());
    }
    const bashApprovalScopeMigration = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 13").get();
    if (!bashApprovalScopeMigration) {
      migrateBashApprovalScopes(db);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (13, ?)").run(Date.now());
    }
  });
  migrate.immediate();
  return db;
}

export function checkpointDatabase(db: GlassDatabase): void {
  db.pragma("wal_checkpoint(PASSIVE)");
}

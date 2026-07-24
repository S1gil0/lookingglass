import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  CommandRunner,
  SchedulerDaemon,
  SchedulerStore,
  scheduledSessionReadOnly,
  SessionPromptRunner,
} from "../src/scheduler/index.js";
import type {
  CommandCompletion,
  CreateCommandInput,
  CreateSessionPromptInput,
} from "../src/scheduler/index.js";
import { openDatabase, type GlassDatabase } from "../src/storage/database.js";
import {
  checkEnvironmentUnsetCommand,
  failureCommand,
  outputCommand,
  outputEnvironmentCommand,
  sleepCommand,
  successCommand,
  truncatedOutputCommand,
  writeMarkerCommand,
} from "./helpers.js";

interface Fixture {
  db: GlassDatabase;
  root: string;
  store: SchedulerStore;
}

function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-scheduler-"));
  const db = openDatabase(join(root, "glass.db"));
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, root, store: new SchedulerStore(db) };
}

function commandInput(
  root: string,
  command: string,
  schedule: string,
  overrides: Partial<CreateCommandInput> = {},
): CreateCommandInput {
  return {
    command,
    cwd: root,
    scheduleKind: "once",
    schedule,
    timezone: "UTC",
    startGraceMs: 60_000,
    timeoutMs: 5_000,
    outputBytes: 1_024,
    ...overrides,
  };
}

function successfulCompletion(): CommandCompletion {
  return {
    state: "succeeded",
    exitCode: 0,
    signal: null,
    reason: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function createSession(db: GlassDatabase, workspace: string, persistent: boolean): string {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO sessions(
      id, workspace, title, model, reasoning_effort, verbosity, fast,
      show_reasoning, persistent, prompt_cache_key, created_at, updated_at
    ) VALUES (?, ?, 'Scheduled session', 'test-model', 'medium', 'low', 0, 0, ?, ?, ?, ?)
  `).run(id, workspace, persistent ? 1 : 0, randomUUID(), now, now);
  return id;
}

function sessionPromptInput(
  sessionId: string,
  prompt: string,
  schedule: string,
  overrides: Partial<CreateSessionPromptInput> = {},
): CreateSessionPromptInput {
  return {
    sessionId,
    prompt,
    scheduleKind: "once",
    schedule,
    timezone: "UTC",
    startGraceMs: 60_000,
    outputBytes: 1_024,
    ...overrides,
  };
}

test("installs current migrations and validates scheduler definitions", (t) => {
  const { db, root, store } = fixture(t);
  const now = Date.parse("2026-01-01T00:00:30Z");
  const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[];
  assert.deepEqual(versions.map((row) => row.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  const sessionId = createSession(db, root, true);
  const approval = db.prepare("SELECT approval_mode FROM sessions WHERE id = ?").get(sessionId) as { approval_mode: string };
  assert.equal(approval.approval_mode, "review");
  const agents = db.prepare("SELECT agents_enabled FROM sessions WHERE id = ?").get(sessionId) as { agents_enabled: number };
  assert.equal(agents.agents_enabled, 1);

  assert.throws(() => store.createReminder({
    message: "bad cron",
    scheduleKind: "cron",
    schedule: "0 0 0 * * *",
    timezone: "UTC",
  }, now), /exactly five fields/);
  assert.throws(() => store.createReminder({
    message: "bad timezone",
    scheduleKind: "cron",
    schedule: "0 9 * * *",
    timezone: "Not\/A_Zone",
  }, now), /Invalid timezone/);
  assert.throws(() => store.createReminder({
    message: "local time",
    scheduleKind: "once",
    schedule: "2026-01-02T10:00:00",
    timezone: "UTC",
  }, now), /Z or an explicit offset/);
  assert.throws(() => store.createReminder({
    message: "impossible date",
    scheduleKind: "once",
    schedule: "2026-02-30T10:00:00Z",
    timezone: "UTC",
  }, now), /Invalid one-shot schedule/);
  assert.throws(() => store.createCommand(commandInput(root, successCommand(), "2026-01-02T00:00:00Z", {
    cwd: "relative",
  }), now), /cwd must be absolute/);
  assert.throws(() => store.createCommand(commandInput(root, successCommand(), "2026-01-02T00:00:00Z", {
    cwd: join(root, "missing"),
  }), now), /does not exist/);
  assert.throws(() => store.createCommand(commandInput(root, "bad\0command", "2026-01-02T00:00:00Z"), now), /NUL/);
  assert.throws(() => store.createCommand(commandInput(root, successCommand(), "2026-01-02T00:00:00Z", {
    env: { BAD: "value\0tail" },
  }), now), /NUL/);
  assert.throws(() => store.createCommand(commandInput(root, successCommand(), "2026-01-02T00:00:00Z", {
    timeoutMs: Number.POSITIVE_INFINITY,
  }), now), /timeoutMs/);
  assert.throws(() => store.createCommand(commandInput(root, successCommand(), "2026-01-02T00:00:00Z", {
    outputBytes: -1,
  }), now), /outputBytes/);

  const job = store.createReminder({
    message: "morning",
    scheduleKind: "cron",
    schedule: "0 9 * * *",
    timezone: "America/New_York",
  }, now);
  assert.equal(job.schedule, "0 9 * * *");
  assert.equal(job.nextDue, Date.parse("2026-01-01T14:00:00Z"));
});

test("migration 13 promotes existing Bash approvals to leading executables", (t) => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-approval-migration-"));
  const path = join(root, "glass.db");
  let db = openDatabase(path);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const sessionId = createSession(db, root, false);
  const insert = db.prepare(`
    INSERT INTO session_command_approvals(session_id, signature, approved_at)
    VALUES (?, ?, ?)
  `);
  insert.run(sessionId, JSON.stringify(["bash-exec", 3, "cat > output <<'EOF'\nvalue\nEOF", root, 5_000]), 10);
  insert.run(sessionId, JSON.stringify(["bash-executable", 1, "shell", "git"]), 20);
  db.prepare("DELETE FROM schema_migrations WHERE version = 13").run();
  db.close();

  db = openDatabase(path);
  const signatures = db.prepare(`
    SELECT signature FROM session_command_approvals
    WHERE session_id = ? ORDER BY signature
  `).all(sessionId) as { signature: string }[];
  assert.ok(signatures.some((row) => row.signature === JSON.stringify(["bash-executable", 2, "cat"])));
  assert.ok(signatures.some((row) => row.signature === JSON.stringify(["bash-executable", 2, "git"])));
});

test("migration 14 preserves parent sessions and referencing conversation and scheduler data", (t) => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-openrouter-migration-"));
  const path = join(root, "glass.db");
  let db = openDatabase(path);
  t.after(() => {
    if (db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const parentId = createSession(db, root, true);
  const childId = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO sessions(
      id, workspace, title, model, reasoning_effort, verbosity, fast,
      prompt_cache_key, created_at, updated_at, persistent, agent_provider,
      agent_model, agent_reasoning_effort, session_kind, parent_session_id
    ) VALUES (?, ?, 'Child session', 'child-model', 'low', 'low', 0, ?, ?, ?, 1,
      'codex-lb', 'child-model', 'low', 'agent', ?)
  `).run(childId, root, randomUUID(), now, now, parentId);
  db.prepare(`
    INSERT INTO session_events(id, session_id, sequence, kind, payload_json, created_at)
    VALUES (1, ?, 1, 'note', '{"message":"preserve me"}', ?)
  `).run(childId, now);
  db.prepare(`
    INSERT INTO tool_calls(
      session_id, call_id, name, arguments_json, state, output_text, started_at
    ) VALUES (?, 'call-migration', 'lookup', '{}', 'completed', 'tool result', ?)
  `).run(childId, now);
  const jobId = randomUUID();
  db.prepare(`
    INSERT INTO scheduler_jobs(
      id, kind, schedule_kind, schedule, timezone, command_text, cwd, env_json,
      start_grace_ms, timeout_ms, output_bytes, enabled, next_due, session_id,
      prompt, created_at
    ) VALUES (?, 'command', 'once', ?, 'UTC', 'printf migration', ?, '{}',
      1000, 5000, 1024, 1, ?, ?, 'scheduled prompt', ?)
  `).run(jobId, new Date(now + 60_000).toISOString(), root, now + 60_000, childId, now);
  db.prepare(`
    INSERT INTO scheduler_occurrences(id, job_id, scheduled_at, state, created_at)
    VALUES (1, ?, ?, 'pending', ?)
  `).run(jobId, now + 60_000, now);
  db.prepare(`
    INSERT INTO scheduler_inbox(
      id, kind, job_id, occurrence_id, message, created_at
    ) VALUES (1, 'command_result', ?, 1, 'preserve scheduler record', ?)
  `).run(jobId, now);

  // Rebuild the sessions table into the v13 shape, retaining all records that
  // depend on it, then let openDatabase run migration 14 as a real upgrade.
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  db.exec(`
    DROP INDEX IF EXISTS sessions_workspace_updated;
    DROP INDEX IF EXISTS sessions_workspace_provider_updated;
    DROP INDEX IF EXISTS sessions_parent_kind;
    ALTER TABLE sessions RENAME TO sessions_before_openrouter_test;
    CREATE TABLE sessions (
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
      updated_at INTEGER NOT NULL,
      show_reasoning INTEGER NOT NULL DEFAULT 0 CHECK (show_reasoning IN (0, 1)),
      persistent INTEGER NOT NULL DEFAULT 0 CHECK (persistent IN (0, 1)),
      provider TEXT NOT NULL DEFAULT 'codex-lb'
        CHECK (provider IN ('codex-lb', 'lm-studio')),
      approval_mode TEXT NOT NULL DEFAULT 'review'
        CHECK (approval_mode IN ('review', 'code', 'unrestricted')),
      agent_provider TEXT
        CHECK (agent_provider IS NULL OR agent_provider IN ('codex-lb', 'lm-studio')),
      agent_model TEXT CHECK (agent_model IS NULL OR length(agent_model) > 0),
      agent_reasoning_effort TEXT,
      session_kind TEXT NOT NULL DEFAULT 'interactive'
        CHECK (session_kind IN ('interactive', 'agent')),
      parent_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      agents_enabled INTEGER NOT NULL DEFAULT 1 CHECK (agents_enabled IN (0, 1))
    ) STRICT;
    INSERT INTO sessions SELECT * FROM sessions_before_openrouter_test;
    DROP TABLE sessions_before_openrouter_test;
    CREATE INDEX sessions_workspace_updated ON sessions(workspace, updated_at DESC);
    CREATE INDEX sessions_workspace_provider_updated ON sessions(workspace, provider, updated_at DESC);
    CREATE INDEX sessions_parent_kind ON sessions(parent_session_id, session_kind, created_at);
    DELETE FROM schema_migrations WHERE version = 14;
  `);
  db.pragma("legacy_alter_table = OFF");
  db.pragma("foreign_keys = ON");
  db.close();

  db = openDatabase(path);
  const child = db.prepare("SELECT parent_session_id FROM sessions WHERE id = ?").get(childId) as { parent_session_id: string };
  assert.equal(child.parent_session_id, parentId);
  assert.deepEqual(db.prepare("SELECT message FROM scheduler_inbox WHERE id = 1").get(), {
    message: "preserve scheduler record",
  });
  assert.deepEqual(db.prepare("SELECT payload_json FROM session_events WHERE id = 1").get(), {
    payload_json: '{"message":"preserve me"}',
  });
  assert.deepEqual(db.prepare("SELECT output_text FROM tool_calls WHERE call_id = 'call-migration'").get(), {
    output_text: "tool result",
  });
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  const indexes = new Set((db.prepare("PRAGMA index_list('sessions')").all() as { name: string }[]).map((row) => row.name));
  assert.ok(indexes.has("sessions_workspace_updated"));
  assert.ok(indexes.has("sessions_workspace_provider_updated"));
  assert.ok(indexes.has("sessions_parent_kind"));
  assert.deepEqual(db.prepare("SELECT version FROM schema_migrations WHERE version = 14").get(), { version: 14 });
});

test("migration 10 upgrades an existing database with command approvals", (t) => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-approval-migration-"));
  const path = join(root, "glass.db");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let db = openDatabase(path);
  db.exec("DROP TABLE session_command_approvals");
  db.prepare("DELETE FROM schema_migrations WHERE version = 10").run();
  db.close();

  db = openDatabase(path);
  assert.deepEqual(
    db.prepare("SELECT version FROM schema_migrations WHERE version = 10").get(),
    { version: 10 },
  );
  const table = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_command_approvals'
  `).get();
  assert.deepEqual(table, { name: "session_command_approvals" });
  db.close();
});

test("scheduled turns inherit durable unrestricted mutation policy", () => {
  assert.equal(scheduledSessionReadOnly("review"), true);
  assert.equal(scheduledSessionReadOnly("code"), true);
  assert.equal(scheduledSessionReadOnly("unrestricted"), false);
});

test("migration 7 cancels unstarted prompts for nonpersistent sessions", (t) => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-migration-"));
  const path = join(root, "glass.db");
  let db = openDatabase(path);
  t.after(() => {
    if (db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const store = new SchedulerStore(db);
  const due = Date.parse("2026-01-01T00:00:00Z");
  const sessionId = createSession(db, root, true);
  const job = store.createSessionPrompt(sessionPromptInput(
    sessionId,
    "pending before upgrade",
    new Date(due).toISOString(),
  ), due - 1);
  const occurrence = store.materialize(due)[0];
  assert.equal(occurrence?.state, "pending");
  db.prepare("UPDATE sessions SET persistent = 0 WHERE id = ?").run(sessionId);
  db.prepare("UPDATE scheduler_jobs SET enabled = 1, suspended_by_session = 0 WHERE id = ?").run(job.id);
  db.prepare("DELETE FROM schema_migrations WHERE version = 7").run();
  db.close();

  db = openDatabase(path);
  const migratedStore = new SchedulerStore(db);
  assert.equal(migratedStore.listRuns(job.id)[0]?.state, "cancelled");
  assert.equal(migratedStore.getJob(job.id)?.enabled, false);
  assert.equal(migratedStore.getJob(job.id)?.suspendedBySession, true);
});

test("session prompts require persistent sessions and never enter command claims", (t) => {
  const { db, root, store } = fixture(t);
  const due = Date.parse("2026-01-02T00:00:00Z");
  const sessionId = createSession(db, root, false);
  const input = sessionPromptInput(sessionId, "Review the workspace", new Date(due).toISOString());

  assert.throws(() => store.createSessionPrompt(input, due - 1), /must be persistent/);
  db.prepare("UPDATE sessions SET persistent = 1 WHERE id = ?").run(sessionId);
  assert.throws(
    () => store.createSessionPrompt({ ...input, prompt: "bad\0prompt" }, due - 1),
    /NUL/,
  );
  assert.throws(
    () => store.createSessionPrompt({ ...input, outputBytes: -1 }, due - 1),
    /outputBytes/,
  );

  const job = store.createSessionPrompt(input, due - 1);
  assert.equal(job.kind, "session_prompt");
  assert.equal(job.sessionId, sessionId);
  assert.equal(job.prompt, input.prompt);
  assert.equal(job.cwd, root);
  assert.deepEqual(store.listJobsForSession(sessionId).map((item) => item.id), [job.id]);
  const stored = db.prepare(`
    SELECT kind, command_text, cwd, session_id, prompt FROM scheduler_jobs WHERE id = ?
  `).get(job.id) as {
    kind: string;
    command_text: string;
    cwd: string;
    session_id: string;
    prompt: string;
  };
  assert.equal(stored.kind, "command");
  assert.equal(stored.command_text, ":");
  assert.equal(stored.cwd, root);
  assert.equal(stored.session_id, sessionId);
  assert.equal(stored.prompt, input.prompt);

  assert.equal(store.materialize(due).length, 1);
  assert.equal(store.acquireLease("mapping-daemon", "mapping-boot", due, 60_000), true);
  db.prepare("UPDATE sessions SET persistent = 0 WHERE id = ?").run(sessionId);
  assert.equal(store.claimCommands("mapping-daemon", "mapping-boot", due, 60_000, 10).length, 0);
  assert.equal(store.claimSessionPrompts("mapping-daemon", "mapping-boot", due, 60_000, 10).length, 0);
  assert.equal(store.listRuns(job.id)[0]?.state, "pending");
  db.prepare("UPDATE sessions SET persistent = 1 WHERE id = ?").run(sessionId);
  assert.equal(store.claimSessionPrompts("mapping-daemon", "mapping-boot", due, 60_000, 10).length, 1);
  assert.equal(store.listRuns(job.id)[0]?.state, "claimed");
});

test("recurring session prompts skip missed turns and advance without catch-up", (t) => {
  const { db, root, store } = fixture(t);
  const createdAt = Date.parse("2026-01-01T00:00:30Z");
  const through = Date.parse("2026-01-01T00:03:30Z");
  const sessionId = createSession(db, root, true);
  const job = store.createSessionPrompt(sessionPromptInput(sessionId, "Check status", "* * * * *", {
    scheduleKind: "cron",
    startGraceMs: 1_000,
  }), createdAt);

  const occurrences = store.materialize(through, 10);
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0]?.scheduledAt, Date.parse("2026-01-01T00:01:00Z"));
  assert.equal(occurrences[0]?.state, "skipped");
  assert.match(occurrences[0]?.reason ?? "", /session prompt start grace/);
  assert.equal(store.getJob(job.id)?.nextDue, Date.parse("2026-01-01T00:04:00Z"));
  assert.equal(store.materialize(through, 10).length, 0);
  assert.match(store.listInbox()[0]?.message ?? "", /^Session turn skipped/);
});

test("session prompt pause and resume cancel work and fast-forward recurrence", (t) => {
  const { db, root, store } = fixture(t);
  const createdAt = Date.parse("2026-01-01T00:00:30Z");
  const due = Date.parse("2026-01-01T00:01:00Z");
  const resumeAt = Date.parse("2026-01-01T00:05:30Z");
  const sessionId = createSession(db, root, true);
  const recurring = store.createSessionPrompt(sessionPromptInput(sessionId, "Recurring turn", "* * * * *", {
    scheduleKind: "cron",
    startGraceMs: 10 * 60_000,
  }), createdAt);
  assert.equal(store.materialize(due).length, 1);
  assert.equal(store.acquireLease("pause-session", "pause-session-boot", due, 60 * 60_000), true);
  const claim = store.claimSessionPrompts("pause-session", "pause-session-boot", due, 60 * 60_000, 1)[0];
  assert.ok(claim);

  const disabled = store.setSessionJobsEnabled(sessionId, false, due + 1);
  assert.equal(disabled[0]?.enabled, false);
  assert.equal(store.listRuns(recurring.id)[0]?.state, "cancelled");
  const resumed = store.setSessionJobsEnabled(sessionId, true, resumeAt);
  assert.equal(resumed[0]?.enabled, true);
  assert.equal(resumed[0]?.nextDue, Date.parse("2026-01-01T00:06:00Z"));
  assert.equal(store.materialize(resumeAt).length, 0);

  const oneDue = resumeAt + 1_000;
  const oneShot = store.createSessionPrompt(sessionPromptInput(
    sessionId,
    "Only once",
    new Date(oneDue).toISOString(),
  ), resumeAt);
  assert.equal(store.materialize(oneDue).filter((run) => run.jobId === oneShot.id).length, 1);
  store.setSessionJobsEnabled(sessionId, false, oneDue + 1);
  const enabledAgain = store.setSessionJobsEnabled(sessionId, true, oneDue + 2);
  assert.equal(enabledAgain.find((job) => job.id === oneShot.id)?.nextDue, null);
  assert.equal(enabledAgain.find((job) => job.id === oneShot.id)?.enabled, false);

  store.pauseJob(recurring.id, oneDue + 3);
  store.setSessionJobsEnabled(sessionId, false, oneDue + 4);
  const afterGateResume = store.setSessionJobsEnabled(sessionId, true, oneDue + 5);
  assert.equal(afterGateResume.find((job) => job.id === recurring.id)?.enabled, false);
  assert.equal(afterGateResume.find((job) => job.id === recurring.id)?.suspendedBySession, false);
});

test("session prompt claims start and persist bounded success and failure results", (t) => {
  const { db, root, store } = fixture(t);
  const due = Date.parse("2026-01-01T00:00:00Z");
  const sessionId = createSession(db, root, true);
  const jobs = [
    store.createSessionPrompt(sessionPromptInput(
      sessionId,
      "success",
      new Date(due).toISOString(),
      { outputBytes: 5 },
    ), due - 2),
    store.createSessionPrompt(sessionPromptInput(
      sessionId,
      "failure",
      new Date(due).toISOString(),
      { outputBytes: 5 },
    ), due - 1),
  ];
  assert.equal(store.materialize(due, 10).length, 2);
  assert.equal(store.acquireLease("turn-daemon", "turn-boot", due, 1_000), true);
  const claims = store.claimSessionPrompts("turn-daemon", "turn-boot", due, 1_000, 10);
  assert.equal(claims.length, 1);
  assert.equal(store.claimCommands("turn-daemon", "turn-boot", due, 1_000, 10).length, 0);
  const successClaim = claims.find((claim) => claim.job.prompt === "success");
  assert.ok(successClaim);

  assert.equal(store.startClaimedSessionPrompt(
    successClaim.occurrence.id,
    successClaim.occurrence.claimToken,
    successClaim.occurrence.claimOwner,
    successClaim.occurrence.claimBootId,
    due + 1,
  )?.state, "running");
  assert.match((db.prepare("SELECT token FROM session_operation_leases WHERE session_id = ?").get(sessionId) as { token: string }).token, /^session-prompt:/);
  const success = store.finishSessionPrompt(
    successClaim.occurrence.id,
    successClaim.occurrence.claimToken,
    successClaim.occurrence.claimOwner,
    successClaim.occurrence.claimBootId,
    { state: "succeeded", output: "ééé", reason: null },
    due + 2,
  );
  assert.equal(success?.state, "succeeded");
  assert.equal(success?.stdout.toString("utf8"), "éé");
  assert.equal(success?.stdoutBytes, 6);
  assert.equal(success?.stdoutTruncated, true);
  assert.equal(db.prepare("SELECT 1 FROM session_operation_leases WHERE session_id = ?").get(sessionId), undefined);

  const failureClaim = store.claimSessionPrompts("turn-daemon", "turn-boot", due + 3, 1_000, 10)[0];
  assert.ok(failureClaim);
  assert.equal(failureClaim.job.prompt, "failure");

  assert.equal(store.startClaimedSessionPrompt(
    failureClaim.occurrence.id,
    failureClaim.occurrence.claimToken,
    failureClaim.occurrence.claimOwner,
    failureClaim.occurrence.claimBootId,
    due + 3,
  )?.state, "running");
  const failure = store.finishSessionPrompt(
    failureClaim.occurrence.id,
    failureClaim.occurrence.claimToken,
    failureClaim.occurrence.claimOwner,
    failureClaim.occurrence.claimBootId,
    { state: "failed", error: "problem detail", reason: "Model turn failed" },
    due + 4,
  );
  assert.equal(failure?.state, "failed");
  assert.equal(failure?.stderr.toString("utf8"), "probl");
  assert.equal(failure?.stderrTruncated, true);
  assert.equal(store.getJob(jobs[0]!.id)?.enabled, false);
  assert.deepEqual(
    store.listInbox().map((item) => item.message).sort(),
    ["Session turn failed: Model turn failed", "Session turn succeeded"],
  );
});

test("active interactive session leases defer scheduled prompt claims", (t) => {
  const { db, root, store } = fixture(t);
  const due = Date.parse("2026-01-01T00:00:00Z");
  const sessionId = createSession(db, root, true);
  store.createSessionPrompt(sessionPromptInput(
    sessionId,
    "deferred",
    new Date(due).toISOString(),
  ), due - 1);
  store.materialize(due);
  db.prepare(`
    INSERT INTO session_operation_leases(
      session_id, owner, token, kind, acquired_at, renewed_at, expires_at
    ) VALUES (?, 'interactive', 'interactive-token', 'turn', ?, ?, ?)
  `).run(sessionId, due, due, due + 100);
  assert.equal(store.acquireLease("session-daemon", "session-boot", due, 1_000), true);
  assert.equal(store.claimSessionPrompts("session-daemon", "session-boot", due, 1_000, 10).length, 0);
  assert.equal(store.claimSessionPrompts("session-daemon", "session-boot", due + 101, 1_000, 10).length, 1);
});

test("session prompt lease takeover fences results and blocks recurring jobs", (t) => {
  const { db, root, store } = fixture(t);
  const createdAt = Date.parse("2026-01-01T00:00:30Z");
  const due = Date.parse("2026-01-01T00:01:00Z");
  const sessionId = createSession(db, root, true);
  const job = store.createSessionPrompt(sessionPromptInput(sessionId, "Fenced turn", "* * * * *", {
    scheduleKind: "cron",
  }), createdAt);
  store.materialize(due);
  assert.equal(store.acquireLease("turn-a", "boot-a", due, 20), true);
  const claim = store.claimSessionPrompts("turn-a", "boot-a", due, 20, 1)[0];
  assert.ok(claim);
  assert.equal(store.startClaimedSessionPrompt(
    claim.occurrence.id,
    claim.occurrence.claimToken,
    claim.occurrence.claimOwner,
    claim.occurrence.claimBootId,
    due + 1,
  )?.state, "running");
  assert.equal(store.finishSessionPrompt(
    claim.occurrence.id,
    claim.occurrence.claimToken,
    claim.occurrence.claimOwner,
    claim.occurrence.claimBootId,
    { state: "succeeded", output: "too late" },
    due + 20,
  ), null);

  assert.equal(store.acquireLease("turn-b", "boot-b", due + 20, 100), true);
  assert.equal(store.listRuns(job.id)[0]?.state, "unknown");
  assert.equal(store.getJob(job.id)?.enabled, false);
  assert.match(store.getJob(job.id)?.blockedReason ?? "", /unknown outcome/);
  assert.match(store.listInbox()[0]?.message ?? "", /^Session turn unknown/);
  assert.equal(store.finishSessionPrompt(
    claim.occurrence.id,
    claim.occurrence.claimToken,
    claim.occurrence.claimOwner,
    claim.occurrence.claimBootId,
    { state: "succeeded", output: "stale owner" },
    due + 21,
  ), null);
});

test("session prompt runner records handler failures", async (t) => {
  const { db, root, store } = fixture(t);
  const due = Date.now();
  const sessionId = createSession(db, root, true);
  store.createSessionPrompt(sessionPromptInput(sessionId, "Fail this turn", new Date(due).toISOString()), due - 1);
  store.materialize(due);
  assert.equal(store.acquireLease("runner-turn", "runner-turn-boot", due, 60_000), true);
  const claim = store.claimSessionPrompts("runner-turn", "runner-turn-boot", due, 60_000, 1)[0];
  assert.ok(claim);
  const runner = new SessionPromptRunner(store, async () => {
    throw new Error("model unavailable");
  });

  const result = await runner.run(claim);
  assert.equal(result.state, "failed");
  assert.equal(result.stderr.toString("utf8"), "model unavailable");
  assert.match(result.reason ?? "", /model unavailable/);
  assert.match(store.listInbox()[0]?.message ?? "", /^Session turn failed/);
});

test("daemon invokes the session prompt handler and shares its worker budget", async (t) => {
  const { db, root, store } = fixture(t);
  const due = Date.now();
  const sessionId = createSession(db, root, true);
  const job = store.createSessionPrompt(sessionPromptInput(
    sessionId,
    "Run the scheduled turn",
    new Date(due).toISOString(),
  ), due - 1);
  const command = store.createCommand(commandInput(root, successCommand(), new Date(due).toISOString()), due - 1);
  assert.equal(store.acquireLease("session-daemon", "session-boot", due, 60_000), true);
  const handled: string[] = [];
  const daemon = new SchedulerDaemon(store, {
    pollIntervalMs: 10,
    leaseMs: 60_000,
    maxConcurrentCommands: 1,
    owner: "session-daemon",
    bootId: "session-boot",
    sessionPromptHandler: async (claimedJob, signal) => {
      assert.equal(signal.aborted, false);
      assert.equal(claimedJob.sessionId, sessionId);
      handled.push(claimedJob.prompt);
      return "turn complete";
    },
  });

  assert.deepEqual(await daemon.tick(due), { materialized: 2, claimed: 1 });
  await daemon.waitForIdle();
  assert.deepEqual(handled, []);
  assert.equal(store.listRuns(command.id)[0]?.state, "succeeded");
  assert.deepEqual(await daemon.tick(due), { materialized: 0, claimed: 1 });
  await daemon.waitForIdle();
  assert.deepEqual(handled, ["Run the scheduled turn"]);
  assert.equal(store.listRuns(job.id)[0]?.state, "succeeded");
  assert.equal(store.listRuns(job.id)[0]?.stdout.toString("utf8"), "turn complete");
});

test("daemon without a session prompt handler leaves turns pending", async (t) => {
  const { db, root, store } = fixture(t);
  const due = Date.now();
  const sessionId = createSession(db, root, true);
  const job = store.createSessionPrompt(sessionPromptInput(
    sessionId,
    "Wait for a configured handler",
    new Date(due).toISOString(),
  ), due - 1);
  assert.equal(store.acquireLease("no-handler", "no-handler-boot", due, 60_000), true);
  const daemon = new SchedulerDaemon(store, {
    pollIntervalMs: 10,
    leaseMs: 60_000,
    maxConcurrentCommands: 1,
    owner: "no-handler",
    bootId: "no-handler-boot",
  });

  assert.deepEqual(await daemon.tick(due), { materialized: 1, claimed: 0 });
  await daemon.waitForIdle();
  assert.equal(store.listRuns(job.id)[0]?.state, "pending");
  assert.equal(store.claimCommands("no-handler", "no-handler-boot", due, 60_000, 1).length, 0);
});

test("recurring reminders emit one catch-up and advance from scheduled cursors", (t) => {
  const { store } = fixture(t);
  const createdAt = Date.parse("2026-01-01T00:00:30Z");
  const through = Date.parse("2026-01-01T00:03:30Z");
  const job = store.createReminder({
    message: "check the build",
    scheduleKind: "cron",
    schedule: "* * * * *",
    timezone: "UTC",
  }, createdAt);

  const occurrences = store.materialize(through, 10);
  assert.deepEqual(occurrences.map((occurrence) => occurrence.scheduledAt), [
    Date.parse("2026-01-01T00:01:00Z"),
  ]);
  assert.ok(occurrences.every((occurrence) => occurrence.state === "succeeded"));
  assert.equal(store.getJob(job.id)?.nextDue, Date.parse("2026-01-01T00:04:00Z"));
  assert.deepEqual(store.listInbox().map((item) => item.message), ["check the build"]);
});

test("missed commands are skipped after their start grace", (t) => {
  const { root, store } = fixture(t);
  const scheduledAt = Date.parse("2026-01-01T00:00:00Z");
  const now = scheduledAt + 60_001;
  const job = store.createCommand(commandInput(root, successCommand(), new Date(scheduledAt).toISOString(), {
    startGraceMs: 60_000,
  }), scheduledAt - 1);

  const [occurrence] = store.materialize(now);
  assert.equal(occurrence?.state, "skipped");
  assert.match(occurrence?.reason ?? "", /start grace/);
  assert.equal(store.getJob(job.id)?.nextDue, null);
  assert.equal(store.listInbox()[0]?.occurrence.state, "skipped");
});

test("commands never overlap and scheduled occurrences remain unique", (t) => {
  const { root, store } = fixture(t);
  const createdAt = Date.parse("2026-01-01T00:00:30Z");
  const through = Date.parse("2026-01-01T00:02:00Z");
  const job = store.createCommand(commandInput(root, sleepCommand(1), "* * * * *", {
    scheduleKind: "cron",
    startGraceMs: 10 * 60_000,
  }), createdAt);

  const occurrences = store.materialize(through, 10);
  assert.deepEqual(occurrences.map((occurrence) => occurrence.state), ["pending"]);
  assert.deepEqual(occurrences.map((occurrence) => occurrence.scheduledAt), [
    Date.parse("2026-01-01T00:01:00Z"),
  ]);
  assert.equal(store.materialize(through, 10).length, 0);
  assert.equal(store.runNow(job.id, through).state, "skipped");
  assert.equal(store.listRuns(job.id).filter((run) => run.state === "pending").length, 1);
  assert.equal(new Set(store.listRuns(job.id).map((run) => run.scheduledAt)).size, 2);
});

test("claiming skips overdue pending commands and ignores disabled jobs", (t) => {
  const { db, root, store } = fixture(t);
  const due = Date.parse("2026-01-01T00:00:00Z");
  const overdue = store.createCommand(commandInput(root, successCommand(), new Date(due).toISOString(), {
    startGraceMs: 10,
  }), due - 1);
  const disabled = store.createCommand(commandInput(root, successCommand(), new Date(due).toISOString(), {
    startGraceMs: 1_000,
  }), due - 1);
  assert.equal(store.materialize(due).length, 2);
  db.prepare("UPDATE scheduler_jobs SET enabled = 0 WHERE id = ?").run(disabled.id);
  assert.equal(store.acquireLease("claim-daemon", "claim-boot", due, 10_000), true);

  assert.equal(store.claimCommands("claim-daemon", "claim-boot", due + 11, 10_000, 10).length, 0);
  assert.equal(store.listRuns(overdue.id)[0]?.state, "skipped");
  assert.match(store.listRuns(overdue.id)[0]?.reason ?? "", /start grace/);
  assert.equal(store.listRuns(disabled.id)[0]?.state, "pending");
  assert.equal(store.listInbox().filter((item) => item.jobId === overdue.id).length, 1);
});

test("daemon refreshes claim time after materialization", async (t) => {
  const { db, root } = fixture(t);
  let leaseExpiresAt = 0;
  class DelayedMaterializationStore extends SchedulerStore {
    override materialize(now = Date.now(), batchSize = 100) {
      const occurrences = super.materialize(now, batchSize);
      while (Date.now() <= leaseExpiresAt) {
        // Simulate a materialization pass that outlives the daemon lease.
      }
      return occurrences;
    }
  }
  const store = new DelayedMaterializationStore(db);
  const due = Date.now();
  store.createCommand(commandInput(root, successCommand(), new Date(due).toISOString(), {
    startGraceMs: 60_000,
  }), due - 1);
  const leaseAt = Date.now();
  const leaseMs = 5;
  leaseExpiresAt = leaseAt + leaseMs;
  assert.equal(store.acquireLease("slow-daemon", "slow-boot", leaseAt, leaseMs), true);
  const daemon = new SchedulerDaemon(store, {
    pollIntervalMs: 10,
    leaseMs,
    maxConcurrentCommands: 1,
    owner: "slow-daemon",
    bootId: "slow-boot",
  });

  const result = await daemon.tick();
  assert.deepEqual(result, { materialized: 1, claimed: 0 });
  assert.equal(store.listRuns()[0]?.state, "pending");
});

test("command start uses actual grace and returns the persisted skip", (t) => {
  const { root, store } = fixture(t);
  const due = Date.parse("2026-01-01T00:00:00Z");
  const job = store.createCommand(commandInput(root, successCommand(), new Date(due).toISOString(), {
    startGraceMs: 10,
  }), due - 1);
  assert.equal(store.materialize(due).length, 1);
  assert.equal(store.acquireLease("start-daemon", "start-boot", due, 1_000), true);
  const claim = store.claimCommands("start-daemon", "start-boot", due, 1_000, 1)[0];
  assert.ok(claim);

  assert.equal(
    store.startClaimedCommand(claim.occurrence.id, claim.occurrence.claimToken, "other-daemon", "other-boot", due + 1),
    null,
  );
  const skipped = store.startClaimedCommand(
    claim.occurrence.id,
    claim.occurrence.claimToken,
    claim.occurrence.claimOwner,
    claim.occurrence.claimBootId,
    due + 11,
  );
  assert.equal(skipped?.state, "skipped");
  assert.match(skipped?.reason ?? "", /start grace/);
  assert.equal(store.getJob(job.id)?.enabled, false);
  assert.equal(store.listInbox().filter((item) => item.jobId === job.id).length, 1);
});

test("pause after claim cancels without launching the command", async (t) => {
  const { root, store } = fixture(t);
  const due = Date.now();
  const marker = join(root, "launched");
  const job = store.createCommand(commandInput(root, writeMarkerCommand(marker), new Date(due).toISOString(), {
    startGraceMs: 60_000,
  }), due - 1);
  assert.equal(store.materialize(due).length, 1);
  const leaseAt = Date.now();
  assert.equal(store.acquireLease("pause-daemon", "pause-boot", leaseAt, 60_000), true);
  const claim = store.claimCommands("pause-daemon", "pause-boot", leaseAt, 60_000, 1)[0];
  assert.ok(claim);
  store.pauseJob(job.id, leaseAt + 1);

  const result = await new CommandRunner(store).run(claim);
  assert.equal(result.state, "cancelled");
  assert.equal(existsSync(marker), false);
  assert.equal(store.listInbox().filter((item) => item.jobId === job.id).length, 1);
});

test("command finish is fenced after lease expiry and takeover", (t) => {
  const { root, store } = fixture(t);
  const due = Date.parse("2026-01-01T00:00:00Z");
  store.createCommand(commandInput(root, successCommand(), new Date(due).toISOString()), due - 1);
  assert.equal(store.materialize(due).length, 1);
  assert.equal(store.acquireLease("finish-daemon", "finish-boot", due, 20), true);
  const claim = store.claimCommands("finish-daemon", "finish-boot", due, 20, 1)[0];
  assert.ok(claim);
  assert.equal(store.startClaimedCommand(
    claim.occurrence.id,
    claim.occurrence.claimToken,
    claim.occurrence.claimOwner,
    claim.occurrence.claimBootId,
    due + 1,
  )?.state, "running");

  assert.equal(store.finishCommand(
    claim.occurrence.id,
    claim.occurrence.claimToken,
    claim.occurrence.claimOwner,
    claim.occurrence.claimBootId,
    successfulCompletion(),
    due + 20,
  ), null);
  assert.equal(store.listRuns()[0]?.state, "running");
  assert.equal(store.acquireLease("takeover-daemon", "takeover-boot", due + 20, 100), true);
  assert.equal(store.listRuns()[0]?.state, "unknown");
  assert.equal(store.finishCommand(
    claim.occurrence.id,
    claim.occurrence.claimToken,
    claim.occurrence.claimOwner,
    claim.occurrence.claimBootId,
    successfulCompletion(),
    due + 21,
  ), null);
});

test("lease takeover marks claimed and running commands unknown and blocks recurring jobs", (t) => {
  const { root, store } = fixture(t);
  const createdAt = Date.parse("2026-01-01T00:00:30Z");
  const due = Date.parse("2026-01-01T00:01:00Z");
  const jobs = ["first", "second"].map((name) => store.createCommand(commandInput(root, outputCommand(name), "* * * * *", {
    scheduleKind: "cron",
  }), createdAt));
  assert.equal(store.materialize(due).length, 2);
  assert.equal(store.acquireLease("daemon-a", "boot-a", due, 100), true);
  const claims = store.claimCommands("daemon-a", "boot-a", due, 100, 2);
  assert.equal(claims.length, 2);
  assert.equal(store.startClaimedCommand(
    claims[0]!.occurrence.id,
    claims[0]!.occurrence.claimToken,
    claims[0]!.occurrence.claimOwner,
    claims[0]!.occurrence.claimBootId,
    due + 1,
  )?.state, "running");

  assert.equal(store.acquireLease("daemon-b", "boot-b", due + 100, 100), true);
  assert.deepEqual(store.listRuns().map((run) => run.state), ["unknown", "unknown"]);
  for (const job of jobs) {
    const recovered = store.getJob(job.id);
    assert.equal(recovered?.enabled, false);
    assert.match(recovered?.blockedReason ?? "", /unknown outcome/);
    assert.throws(() => store.resumeJob(job.id), /blocked/);
  }
  const resolved = store.acknowledgeUnknown(jobs[0]!.id, due + 10 * 60_000);
  assert.equal(resolved.blockedReason, null);
  assert.equal(resolved.enabled, true);
  assert.ok((resolved.nextDue ?? 0) > due + 10 * 60_000);
  assert.equal(store.materialize(due + 10 * 60_000).length, 0);
  assert.equal(store.listInbox().filter((item) => item.occurrence.state === "unknown").length, 2);
  assert.equal(store.claimCommands("daemon-a", "boot-a", due + 101, 100, 2).length, 0);
});

test("command runner records success, nonzero exit, timeout, and bounded output", async (t) => {
  const { root, store } = fixture(t);
  const owner = "runner-daemon";
  const bootId = "runner-boot";
  const leaseAt = Date.now();
  assert.equal(store.acquireLease(owner, bootId, leaseAt, 60_000), true);
  const previousSecret = process.env.TEST_SCHEDULER_API_KEY;
  process.env.TEST_SCHEDULER_API_KEY = "scheduler-secret-value-12345";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.TEST_SCHEDULER_API_KEY;
    else process.env.TEST_SCHEDULER_API_KEY = previousSecret;
  });
  const runner = new CommandRunner(store, ["TEST_SCHEDULER_API_KEY"]);

  async function execute(command: string, overrides: Partial<CreateCommandInput> = {}) {
    const now = Date.now();
    const job = store.createCommand(commandInput(root, command, new Date(now).toISOString(), overrides), now);
    assert.equal(store.materialize(now).length, 1);
    const claim = store.claimCommands(owner, bootId, now, 60_000, 1)[0];
    assert.ok(claim);
    const result = await runner.run(claim);
    assert.ok(result);
    return { job, result };
  }

  const success = await execute(`${outputEnvironmentCommand("SCHED_VALUE")}; ${outputCommand("warning", "stderr")}`, {
    env: { SCHED_VALUE: "from-env" },
  });
  assert.equal(success.result.state, "succeeded");
  assert.equal(success.result.stdout.toString(), "from-env");
  assert.equal(success.result.stderr.toString(), "warning");
  assert.equal(success.result.exitCode, 0);

  const strippedSecret = await execute(checkEnvironmentUnsetCommand("TEST_SCHEDULER_API_KEY", "stripped"), {
    env: { TEST_SCHEDULER_API_KEY: "job-override-secret" },
  });
  assert.equal(strippedSecret.result.stdout.toString(), "stripped");

  const nonzero = await execute(failureCommand(7, "bad"));
  assert.equal(nonzero.result.state, "failed");
  assert.equal(nonzero.result.exitCode, 7);
  assert.match(nonzero.result.reason ?? "", /code 7/);

  const timeout = await execute(sleepCommand(2), { timeoutMs: 50 });
  assert.equal(timeout.result.state, "timed_out");
  assert.match(timeout.result.reason ?? "", /50ms timeout/);

  const truncated = await execute(truncatedOutputCommand("abcdefgh", "123456"), { outputBytes: 4 });
  assert.equal(truncated.result.state, "succeeded");
  assert.equal(truncated.result.stdout.toString(), "abcd");
  assert.equal(truncated.result.stderr.toString(), "1234");
  assert.equal(truncated.result.stdoutBytes, 8);
  assert.equal(truncated.result.stderrBytes, 6);
  assert.equal(truncated.result.stdoutTruncated, true);
  assert.equal(truncated.result.stderrTruncated, true);

  const commandInbox = store.listInbox({ limit: 20 }).filter((item) => item.kind === "command_result");
  assert.equal(commandInbox.length, 5);
});

test("command runner revalidates cwd immediately before spawning", async (t) => {
  const { root, store } = fixture(t);
  const cwd = mkdtempSync(join(root, "scheduled-cwd-"));
  const due = Date.now();
  const job = store.createCommand(commandInput(cwd, successCommand(), new Date(due).toISOString()), due);
  assert.equal(store.materialize(due).length, 1);
  assert.equal(store.acquireLease("cwd-daemon", "cwd-boot", due, 60_000), true);
  const claim = store.claimCommands("cwd-daemon", "cwd-boot", due, 60_000, 1)[0];
  assert.ok(claim);

  // Creation validates the directory, but a scheduled run may happen much
  // later after the path has been removed or replaced.
  rmSync(cwd, { recursive: true, force: true });
  const result = await new CommandRunner(store).run(claim);
  assert.equal(result.state, "failed");
  assert.equal(result.exitCode, null);
  assert.match(result.reason ?? "", /workspace root.*cannot be verified/);
  assert.equal(store.getJob(job.id)?.blockedReason, null);
});

test("interrupted running commands become unknown and block recurrence", async (t) => {
  const { root, store } = fixture(t);
  const now = Date.now();
  const job = store.createCommand(commandInput(root, sleepCommand(5), "* * * * *", {
    scheduleKind: "cron",
  }), now);
  const due = job.nextDue!;
  assert.equal(store.materialize(due).length, 1);
  assert.equal(store.acquireLease("abort-daemon", "abort-boot", due, 60_000), true);
  const claim = store.claimCommands("abort-daemon", "abort-boot", due, 60_000, 1)[0];
  assert.ok(claim);
  const controller = new AbortController();
  const running = new CommandRunner(store).run(claim, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.abort();
  const result = await running;
  assert.equal(result.state, "unknown");
  assert.equal(store.getJob(job.id)?.enabled, false);
  assert.match(store.getJob(job.id)?.blockedReason ?? "", /unknown outcome/);
});

test("daemon rejects when a runner result cannot be persisted", async (t) => {
  const { root, store } = fixture(t);
  const due = Date.now();
  store.createCommand(commandInput(root, successCommand(), new Date(due).toISOString(), {
    startGraceMs: 60_000,
  }), due - 1);
  store.finishCommand = () => null;
  const daemon = new SchedulerDaemon(store, {
    pollIntervalMs: 5,
    leaseMs: 1_000,
    maxConcurrentCommands: 1,
    owner: "error-daemon",
    bootId: "error-boot",
  });

  await assert.rejects(
    daemon.run(new AbortController().signal),
    /could not be persisted/,
  );
  assert.ok((store.getLease()?.expiresAt ?? Number.POSITIVE_INFINITY) <= Date.now());
});

test("inbox remains durable until acknowledged", (t) => {
  const { store } = fixture(t);
  const due = Date.parse("2026-01-01T10:00:00Z");
  store.createReminder({
    message: "durable reminder",
    scheduleKind: "once",
    schedule: new Date(due).toISOString(),
    timezone: "UTC",
  }, due - 1);
  store.materialize(due);

  const item = store.listInbox()[0];
  assert.ok(item);
  assert.equal(item.message, "durable reminder");
  assert.equal(store.ackInbox(item.id, due + 1), true);
  assert.equal(store.ackInbox(item.id, due + 2), false);
  assert.equal(store.listInbox().length, 0);
  const archived = store.listInbox({ unackedOnly: false })[0];
  assert.equal(archived?.acknowledgedAt, due + 1);
});

test("deleted unknown jobs cannot be resolved and disabled jobs cannot run now", (t) => {
  const { root, store } = fixture(t);
  const due = Date.parse("2026-01-01T00:00:00Z");
  const job = store.createCommand(commandInput(
    root,
    "exit 0",
    new Date(due).toISOString(),
  ), due - 1);
  store.pauseJob(job.id, due - 1);
  assert.throws(() => store.runNow(job.id, due), /enabled/);
  const reminder = store.createReminder({
    message: "paused",
    scheduleKind: "once",
    schedule: new Date(due + 10_000).toISOString(),
    timezone: "UTC",
  }, due - 1);
  store.pauseJob(reminder.id, due - 1);
  assert.throws(() => store.runNow(reminder.id, due), /enabled/);

  const recurring = store.createCommand({
    ...commandInput(root, sleepCommand(1), "* * * * *"),
    scheduleKind: "cron",
  }, due - 60_000);
  store.materialize(due);
  assert.equal(store.acquireLease("old", "old-boot", due, 10), true);
  assert.equal(store.claimCommands("old", "old-boot", due, 10, 1).length, 1);
  assert.equal(store.acquireLease("new", "new-boot", due + 10, 1_000), true);
  assert.match(store.getJob(recurring.id)?.blockedReason ?? "", /unknown outcome/);
  assert.equal(store.deleteJob(recurring.id, due + 11).blockedReason, "deleted");
  assert.throws(() => store.acknowledgeUnknown(recurring.id, due + 12), /another reason/);
});

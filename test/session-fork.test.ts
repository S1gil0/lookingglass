import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/storage/database.js";
import { SessionStore } from "../src/storage/session-store.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-fork-"));
  const db = openDatabase(join(root, "state.db"));
  const sessions = new SessionStore(db);
  return { root, db, sessions };
}

test("session forks migrate and copy only independent conversation state", (t) => {
  const { root, db, sessions } = fixture();
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  assert.equal((db.prepare("SELECT 1 FROM schema_migrations WHERE version = 15").get() as object | undefined) !== undefined, true);
  const forkColumn = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string; type: string; notnull: number; dflt_value: string }[])
    .find((column) => column.name === "fork_count");
  assert.deepEqual(forkColumn && {
    name: forkColumn.name,
    type: forkColumn.type,
    notnull: forkColumn.notnull,
    dflt_value: forkColumn.dflt_value,
  }, { name: "fork_count", type: "INTEGER", notnull: 1, dflt_value: "0" });

  const source = sessions.create({
    workspace: root,
    provider: "openrouter",
    model: "source-model",
    reasoningEffort: "high",
    verbosity: "high",
    fast: true,
    approvalMode: "unrestricted",
    agentProvider: "lm-studio",
    agentModel: "agent-model",
    agentReasoningEffort: "low",
    agentsEnabled: false,
  });
  sessions.rename(source.id, "A useful conversation");
  sessions.updateSettings(source.id, { showReasoning: true, persistent: true });
  sessions.setLastResponseId(source.id, "response-source");
  sessions.appendEvent(source.id, "user", { text: "hello" });
  sessions.appendEvent(source.id, "response", { text: "world" });
  sessions.saveCheckpoint(source.id, 2, { summary: "compact" }, 42);
  db.prepare(`
    INSERT INTO tool_calls(
      session_id, call_id, name, arguments_json, state, output_text, error_text,
      started_at, finished_at, execution_token
    ) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)
  `).run(source.id, "call-1", "shell", '{"command":"true"}', "output", "error", 10, 20, "source-token");
  sessions.registerCommandApproval(source.id, "approval-signature", 10);
  db.prepare(`
    INSERT INTO scheduler_jobs(
      id, kind, schedule_kind, schedule, timezone, message, command_text, cwd, env_json,
      start_grace_ms, timeout_ms, output_bytes, enabled, blocked_reason, next_due,
      created_at, session_id, prompt
    ) VALUES (?, 'reminder', 'once', ?, 'UTC', ?, NULL, NULL, NULL, NULL, NULL, NULL, 1, NULL, NULL, ?, ?, NULL)
  `).run("job-source", "2020-01-01T00:00:00Z", "reminder", 10, source.id);

  const sourceEvents = sessions.events(source.id);
  const fork = sessions.fork(source.id);
  assert.equal(fork.title, "A useful conversation (fork 1)");
  assert.equal(fork.kind, "interactive");
  assert.equal(fork.parentSessionId, null);
  assert.equal(fork.lastResponseId, null);
  assert.notEqual(fork.id, source.id);
  assert.notEqual(fork.promptCacheKey, source.promptCacheKey);
  assert.equal(fork.provider, source.provider);
  assert.equal(fork.model, source.model);
  assert.equal(fork.approvalMode, source.approvalMode);
  assert.equal(fork.showReasoning, true);
  assert.equal(fork.persistent, true);
  assert.deepEqual(sessions.events(fork.id).map(({ id, sessionId, ...event }) => event),
    sourceEvents.map(({ id, sessionId, ...event }) => event));
  assert.deepEqual(sessions.latestCheckpoint(fork.id)?.compact, { summary: "compact" });
  assert.equal(sessions.latestCheckpoint(fork.id)?.inputTokens, 42);

  const copiedTool = sessions.getToolCall(fork.id, "call-1");
  assert.deepEqual(copiedTool && { ...copiedTool, sessionId: undefined, executionToken: undefined }, {
    sessionId: undefined,
    callId: "call-1",
    name: "shell",
    arguments: { command: "true" },
    state: "completed",
    output: "output",
    error: "error",
    startedAt: 10,
    finishedAt: 20,
    executionToken: undefined,
  });
  assert.equal(sessions.listCommandApprovals(fork.id).length, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM scheduler_jobs WHERE session_id = ?").get(fork.id) as { count: number }).count, 0);

  sessions.appendEvent(fork.id, "note", { forkOnly: true });
  sessions.rename(fork.id, "renamed fork");
  sessions.updateSettings(fork.id, { model: "fork-model", approvalMode: "review" });
  assert.equal(sessions.events(source.id).length, sourceEvents.length);
  assert.equal(sessions.get(source.id)?.title, "A useful conversation");
  assert.equal(sessions.get(source.id)?.model, "source-model");
  assert.equal(sessions.delete(fork.id).events, 3);
  assert.equal(sessions.fork(source.id).title, "A useful conversation (fork 2)");
});

test("session forks reject active leases and agent sessions", (t) => {
  const { root, db, sessions } = fixture();
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = sessions.create({ workspace: root, model: "model", reasoningEffort: "medium", verbosity: "low", fast: false });
  assert.equal(sessions.acquireOperationLease(source.id, "owner", "token", "turn", Date.now(), 30_000), true);
  assert.throws(() => sessions.fork(source.id), /active turn/);
  sessions.releaseOperationLease(source.id, "owner", "token");

  const agent = sessions.create({
    workspace: root,
    model: "model",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
    kind: "agent",
  });
  assert.throws(() => sessions.fork(agent.id), /Agent sessions cannot be forked/);
});
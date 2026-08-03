import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { openDatabase, type GlassDatabase } from "../src/storage/database.js";
import { SessionStore } from "../src/storage/session-store.js";

interface Fixture {
  root: string;
  db: GlassDatabase;
  sessions: SessionStore;
  artifacts: ArtifactStore;
}

function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-session-maintenance-"));
  const artifactDirectory = join(root, "artifacts");
  mkdirSync(artifactDirectory);
  const db = openDatabase(join(root, "state.db"));
  const sessions = new SessionStore(db);
  const artifacts = new ArtifactStore(db, artifactDirectory);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, db, sessions, artifacts };
}

function createSession(
  sessions: SessionStore,
  workspace: string,
  kind: "interactive" | "agent",
  persistent = false,
) {
  const session = sessions.create({
    workspace,
    model: "test-model",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
    kind,
  });
  if (persistent) sessions.updateSettings(session.id, { persistent: true });
  return session;
}

function setUpdatedAt(db: GlassDatabase, sessionId: string, updatedAt: number): void {
  db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(updatedAt, sessionId);
}

function createUncertainToolCall(
  db: GlassDatabase,
  sessions: SessionStore,
  sessionId: string,
  callId: string,
  state: "started" | "unknown",
  now: number,
): void {
  const owner = `${callId}-owner`;
  const token = `${callId}-token`;
  assert.equal(sessions.acquireOperationLease(sessionId, owner, token, "turn", now, 10_000), true);
  assert.equal(
    sessions.beginToolCall(sessionId, callId, "shell", { command: "uncertain" }, token).record.state,
    "started",
  );
  if (state === "unknown") {
    assert.equal(
      sessions.markToolCallUnknownWithEvent(sessionId, callId, token, { callId }).state,
      "unknown",
    );
  }
  assert.equal(sessions.releaseOperationLease(sessionId, owner, token), true);
  // Tool events update the session timestamp. Make each fixture session old
  // enough for the retention policy without changing the call state.
  setUpdatedAt(db, sessionId, now - 10_000);
}

function fenceNextImmediateTransaction(db: GlassDatabase, beforeImmediate: () => void): () => void {
  const originalTransaction = db.transaction.bind(db);
  let fired = false;
  db.transaction = ((callback: (...args: never[]) => unknown) => {
    const transaction = originalTransaction(callback);
    const wrapped = (...args: never[]): unknown => transaction(...args);
    Object.defineProperty(wrapped, "immediate", {
      value: (...args: never[]) => {
        if (!fired) {
          fired = true;
          beforeImmediate();
        }
        return transaction.immediate(...args);
      },
    });
    return wrapped as typeof transaction;
  }) as typeof db.transaction;
  return () => {
    db.transaction = originalTransaction;
  };
}

function appendSizedEvent(sessions: SessionStore, sessionId: string, text: string): number {
  const payload = { text };
  sessions.appendEvent(sessionId, "note", payload);
  return Buffer.byteLength(JSON.stringify(payload));
}

test("age pruning preserves interactive and persistent sessions and detaches artifacts", (t) => {
  const { root, db, sessions, artifacts } = fixture(t);
  const interactive = createSession(sessions, root, "interactive");
  const oldAgent = createSession(sessions, root, "agent");
  const persistentAgent = createSession(sessions, root, "agent", true);
  const recentAgent = createSession(sessions, root, "agent");
  const oldPayload = { text: "old agent result" };
  sessions.appendEvent(oldAgent.id, "note", oldPayload);
  const artifact = artifacts.save(oldAgent.id, "agent-result", "detached but retained");

  setUpdatedAt(db, interactive.id, 100);
  setUpdatedAt(db, oldAgent.id, 100);
  setUpdatedAt(db, persistentAgent.id, 100);
  setUpdatedAt(db, recentAgent.id, 900);

  const preview = sessions.previewAgentSessionRetention({ maxAgeMs: 500 }, 1_000);
  assert.equal(preview.mode, "dry-run");
  assert.equal(preview.dryRun, true);
  assert.equal(preview.total.sessions, 3);
  assert.equal(preview.candidate.sessions, 1);
  assert.equal(preview.selected.sessions, 1);
  assert.ok(sessions.get(oldAgent.id));

  const report = sessions.applyAgentSessionRetention({ maxAgeMs: 500 }, 1_000);
  assert.equal(report.mode, "apply");
  assert.equal(report.dryRun, false);
  assert.equal(report.total.sessions, 3);
  assert.equal(report.eligible.sessions, 2);
  assert.equal(report.protected.sessions, 1);
  assert.equal(report.candidate.sessions, 1);
  assert.equal(report.candidate.logicalBytes, Buffer.byteLength(JSON.stringify(oldPayload)));
  assert.equal(report.candidate.artifacts, 1);
  assert.equal(report.selected.sessions, 1);
  assert.equal(report.selected.artifacts, 1);
  assert.equal(report.remaining.sessions, 2);
  assert.equal(report.remaining.artifacts, report.total.artifacts);

  assert.equal(sessions.get(oldAgent.id), null);
  assert.ok(sessions.get(interactive.id));
  assert.ok(sessions.get(persistentAgent.id));
  assert.ok(sessions.get(recentAgent.id));
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?").get(oldAgent.id) as { count: number }).count, 0);

  const detached = db.prepare("SELECT session_id FROM artifacts WHERE id = ?").get(artifact.id) as { session_id: string | null } | undefined;
  assert.equal(detached?.session_id, null);
  assert.ok(artifacts.get(artifact.id));
  assert.equal(existsSync(artifact.path), true);
});

test("count quota removes oldest eligible agents while protecting sessions below min age", (t) => {
  const { root, db, sessions } = fixture(t);
  const oldest = createSession(sessions, root, "agent");
  const middle = createSession(sessions, root, "agent");
  const recent = createSession(sessions, root, "agent");
  setUpdatedAt(db, oldest.id, 100);
  setUpdatedAt(db, middle.id, 200);
  setUpdatedAt(db, recent.id, 950);

  const report = sessions.applyAgentSessionRetention({ maxSessions: 1, minAgeMs: 100 }, 1_000);
  assert.equal(report.total.sessions, 3);
  assert.equal(report.eligible.sessions, 3);
  assert.equal(report.candidate.sessions, 2);
  assert.equal(report.selected.sessions, 2);
  assert.equal(report.remaining.sessions, 1);
  assert.equal(sessions.get(oldest.id), null);
  assert.equal(sessions.get(middle.id), null);
  assert.ok(sessions.get(recent.id));
});

test("minimum age protects age-expired and future-dated agent sessions", (t) => {
  const { root, db, sessions } = fixture(t);
  const belowMinimum = createSession(sessions, root, "agent");
  const future = createSession(sessions, root, "agent");
  setUpdatedAt(db, belowMinimum.id, 950);
  setUpdatedAt(db, future.id, 1_100);

  const report = sessions.applyAgentSessionRetention({
    maxAgeMs: 0,
    minAgeMs: 100,
    maxSessions: 0,
  }, 1_000);

  assert.equal(report.candidate.sessions, 0);
  assert.ok(sessions.get(belowMinimum.id));
  assert.ok(sessions.get(future.id));
});

test("byte quota removes enough oldest data while honoring minimum age", (t) => {
  const { root, db, sessions } = fixture(t);
  const oldest = createSession(sessions, root, "agent");
  const middle = createSession(sessions, root, "agent");
  const recent = createSession(sessions, root, "agent");
  const oldestBytes = appendSizedEvent(sessions, oldest.id, "x".repeat(30));
  const middleBytes = appendSizedEvent(sessions, middle.id, "y".repeat(10));
  const recentBytes = appendSizedEvent(sessions, recent.id, "z".repeat(10));
  setUpdatedAt(db, oldest.id, 100);
  setUpdatedAt(db, middle.id, 200);
  setUpdatedAt(db, recent.id, 950);

  const report = sessions.applyAgentSessionRetention({
    maxLogicalBytes: middleBytes + recentBytes,
    minAgeMs: 100,
  }, 1_000);
  assert.equal(report.total.logicalBytes, oldestBytes + middleBytes + recentBytes);
  assert.equal(report.candidate.sessions, 1);
  assert.equal(report.candidate.logicalBytes, oldestBytes);
  assert.equal(report.selected.sessions, 1);
  assert.equal(report.remaining.logicalBytes, middleBytes + recentBytes);
  assert.equal(sessions.get(oldest.id), null);
  assert.ok(sessions.get(middle.id));
  assert.ok(sessions.get(recent.id));
});

test("retention honors maximum sessions and logical bytes per run", (t) => {
  const countFixture = fixture(t);
  const countOldest = createSession(countFixture.sessions, countFixture.root, "agent");
  const countMiddle = createSession(countFixture.sessions, countFixture.root, "agent");
  const countNewest = createSession(countFixture.sessions, countFixture.root, "agent");
  setUpdatedAt(countFixture.db, countOldest.id, 100);
  setUpdatedAt(countFixture.db, countMiddle.id, 200);
  setUpdatedAt(countFixture.db, countNewest.id, 300);
  const countReport = countFixture.sessions.applyAgentSessionRetention({
    maxAgeMs: 0,
    maxSessionsPerRun: 1,
  }, 1_000);
  assert.equal(countReport.candidate.sessions, 3);
  assert.equal(countReport.selected.sessions, 1);
  assert.equal(countReport.batchLimited, true);
  assert.equal(countFixture.sessions.get(countOldest.id), null);
  assert.ok(countFixture.sessions.get(countMiddle.id));
  assert.ok(countFixture.sessions.get(countNewest.id));

  const byteFixture = fixture(t);
  const byteSmall = createSession(byteFixture.sessions, byteFixture.root, "agent");
  const byteLarge = createSession(byteFixture.sessions, byteFixture.root, "agent");
  const byteNewest = createSession(byteFixture.sessions, byteFixture.root, "agent");
  const smallBytes = appendSizedEvent(byteFixture.sessions, byteSmall.id, "s".repeat(8));
  const largeBytes = appendSizedEvent(byteFixture.sessions, byteLarge.id, "l".repeat(40));
  const newestBytes = appendSizedEvent(byteFixture.sessions, byteNewest.id, "n".repeat(24));
  setUpdatedAt(byteFixture.db, byteSmall.id, 100);
  setUpdatedAt(byteFixture.db, byteLarge.id, 200);
  setUpdatedAt(byteFixture.db, byteNewest.id, 300);
  const byteReport = byteFixture.sessions.applyAgentSessionRetention({
    maxAgeMs: 0,
    maxLogicalBytesPerRun: smallBytes,
  }, 1_000);
  assert.equal(byteReport.candidate.sessions, 3);
  assert.equal(byteReport.candidate.logicalBytes, smallBytes + largeBytes + newestBytes);
  assert.equal(byteReport.selected.sessions, 1);
  assert.equal(byteReport.selected.logicalBytes, smallBytes);
  assert.equal(byteReport.batchLimited, true);
  assert.equal(byteFixture.sessions.get(byteSmall.id), null);
  assert.ok(byteFixture.sessions.get(byteLarge.id));
  assert.ok(byteFixture.sessions.get(byteNewest.id));
});

test("retention protects old agent sessions with started or unknown tool calls in preview and apply", (t) => {
  const { root, db, sessions } = fixture(t);
  const started = createSession(sessions, root, "agent");
  const unknown = createSession(sessions, root, "agent");
  const removable = createSession(sessions, root, "agent");
  const now = Date.now();

  createUncertainToolCall(db, sessions, started.id, "started-call", "started", now);
  createUncertainToolCall(db, sessions, unknown.id, "unknown-call", "unknown", now);
  setUpdatedAt(db, removable.id, now - 10_000);

  const policy = { maxAgeMs: 0 };
  const preview = sessions.previewAgentSessionRetention(policy, now);
  assert.equal(preview.total.sessions, 3);
  assert.equal(preview.eligible.sessions, 1);
  assert.equal(preview.protected.sessions, 2);
  assert.equal(preview.candidate.sessions, 1);
  assert.equal(preview.selected.sessions, 1);
  assert.ok(sessions.get(started.id));
  assert.ok(sessions.get(unknown.id));
  assert.equal(sessions.getToolCall(started.id, "started-call")?.state, "started");
  assert.equal(sessions.getToolCall(unknown.id, "unknown-call")?.state, "unknown");

  const report = sessions.applyAgentSessionRetention(policy, now);
  assert.equal(report.total.sessions, 3);
  assert.equal(report.eligible.sessions, 1);
  assert.equal(report.protected.sessions, 2);
  assert.equal(report.candidate.sessions, 1);
  assert.equal(report.selected.sessions, 1);
  assert.equal(sessions.get(removable.id), null);
  assert.ok(sessions.get(started.id));
  assert.ok(sessions.get(unknown.id));
  assert.equal(sessions.getToolCall(started.id, "started-call")?.state, "started");
  assert.equal(sessions.getToolCall(unknown.id, "unknown-call")?.state, "unknown");
});

test("retention rechecks uncertain tool calls before deleting a planned session", (t) => {
  const { root, db, sessions } = fixture(t);
  const session = createSession(sessions, root, "agent");
  const now = Date.now();
  setUpdatedAt(db, session.id, now - 10_000);

  const restoreTransaction = fenceNextImmediateTransaction(db, () => {
    createUncertainToolCall(db, sessions, session.id, "raced-call", "started", now);
  });
  let report;
  try {
    report = sessions.applyAgentSessionRetention({ maxAgeMs: 0 }, now);
  } finally {
    restoreTransaction();
  }

  assert.equal(report?.candidate.sessions, 1);
  assert.equal(report?.selected.sessions, 0);
  assert.equal(report?.batchLimited, true);
  assert.ok(sessions.get(session.id));
  assert.equal(sessions.getToolCall(session.id, "raced-call")?.state, "started");
});

test("retention does not remove an old agent session with an active lease", (t) => {
  const { root, db, sessions } = fixture(t);
  const leased = createSession(sessions, root, "agent");
  const idle = createSession(sessions, root, "agent");
  setUpdatedAt(db, leased.id, 100);
  setUpdatedAt(db, idle.id, 100);
  const now = Date.now();
  assert.equal(sessions.acquireOperationLease(leased.id, "maintenance-owner", "maintenance-token", "turn", now, 10_000), true);

  const report = sessions.applyAgentSessionRetention({ maxAgeMs: 0 }, now + 1);
  assert.equal(report.candidate.sessions, 1);
  assert.equal(report.selected.sessions, 1);
  assert.equal(report.protected.sessions, 1);
  assert.equal(sessions.get(idle.id), null);
  assert.ok(sessions.get(leased.id));
  assert.equal(sessions.assertOperationToken(leased.id, "maintenance-token", now + 1), true);
  assert.equal(sessions.releaseOperationLease(leased.id, "maintenance-owner", "maintenance-token"), true);
});

test("an active parent lease protects a newly created child agent", (t) => {
  const { root, db, sessions } = fixture(t);
  const parent = createSession(sessions, root, "interactive");
  const child = sessions.create({
    workspace: root,
    model: "test-model",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
    kind: "agent",
    parentSessionId: parent.id,
  });
  setUpdatedAt(db, child.id, 100);
  const now = Date.now();
  assert.equal(sessions.acquireOperationLease(parent.id, "parent-owner", "parent-token", "turn", now, 10_000), true);

  const report = sessions.applyAgentSessionRetention({ maxAgeMs: 0 }, now + 1);

  assert.equal(report.candidate.sessions, 0);
  assert.equal(report.protected.sessions, 1);
  assert.ok(sessions.get(child.id));
  assert.equal(sessions.releaseOperationLease(parent.id, "parent-owner", "parent-token"), true);
});

test("orphan reconciliation marks only calls without a live lease and removes expired leases", (t) => {
  const { root, sessions } = fixture(t);
  const orphan = createSession(sessions, root, "interactive");
  const active = createSession(sessions, root, "interactive");
  const expired = createSession(sessions, root, "interactive");
  const now = Date.now();

  assert.equal(sessions.acquireOperationLease(orphan.id, "orphan-owner", "orphan-token", "turn", now, 10_000), true);
  assert.equal(sessions.beginToolCall(orphan.id, "orphan-call", "shell", { command: "maybe" }, "orphan-token").record.state, "started");
  assert.equal(sessions.releaseOperationLease(orphan.id, "orphan-owner", "orphan-token"), true);

  assert.equal(sessions.acquireOperationLease(active.id, "active-owner", "active-token", "turn", now, 10_000), true);
  assert.equal(sessions.beginToolCall(active.id, "active-call", "shell", { command: "still running" }, "active-token").record.state, "started");

  assert.equal(sessions.acquireOperationLease(expired.id, "expired-owner", "expired-token", "compact", now, 0), true);

  const report = sessions.reconcileOrphanedToolCalls(now + 1);
  assert.deepEqual(report, { toolCallsMarkedUnknown: 1, expiredLeasesDeleted: 1 });
  assert.equal(sessions.getToolCall(orphan.id, "orphan-call")?.state, "unknown");
  assert.equal(sessions.getToolCall(orphan.id, "orphan-call")?.output, null);
  assert.equal(sessions.getToolCall(orphan.id, "orphan-call")?.error, "Tool execution was orphaned before a durable result was recorded.");
  assert.equal(sessions.getToolCall(active.id, "active-call")?.state, "started");
  assert.equal(sessions.assertOperationToken(active.id, "active-token", now + 1), true);
  assert.equal(sessions.inspectOperationLease(expired.id, "expired-owner", "expired-token", now + 1).kind, "missing");
});

test("a replacement lease does not mask a tool call owned by an obsolete token", (t) => {
  const { root, db, sessions } = fixture(t);
  const session = createSession(sessions, root, "interactive");
  const now = Date.now();
  assert.equal(sessions.acquireOperationLease(session.id, "old-owner", "old-token", "turn", now, 10_000), true);
  assert.equal(sessions.beginToolCall(session.id, "old-call", "shell", {}, "old-token").record.state, "started");
  db.prepare(`
    UPDATE session_operation_leases
    SET owner = 'new-owner', token = 'new-token', renewed_at = ?, expires_at = ?
    WHERE session_id = ?
  `).run(now + 1, now + 10_001, session.id);

  const report = sessions.reconcileOrphanedToolCalls(now + 2);

  assert.equal(report.toolCallsMarkedUnknown, 1);
  assert.equal(sessions.getToolCall(session.id, "old-call")?.state, "unknown");
  assert.equal(sessions.assertOperationToken(session.id, "new-token", now + 2), true);
});

test("tool-event reconciliation does not synthesize a result for an active started call", (t) => {
  const { root, sessions } = fixture(t);
  const session = createSession(sessions, root, "interactive");
  sessions.appendResponseAndSetContinuity(session.id, {
    response: {
      output: [{
        type: "function_call",
        call_id: "active-call",
        name: "shell",
        arguments: '{"command":"true"}',
      }],
    },
  }, "response-active-call");
  const now = Date.now();
  assert.equal(sessions.acquireOperationLease(session.id, "reconcile-owner", "reconcile-token", "turn", now, 10_000), true);
  assert.equal(sessions.beginToolCall(session.id, "active-call", "shell", { command: "true" }, "reconcile-token").record.state, "started");

  const before = sessions.events(session.id);
  assert.equal(sessions.reconcileToolCallEvents(session.id, "reconcile-token"), 0);
  const after = sessions.events(session.id);
  assert.equal(after.length, before.length);
  assert.deepEqual(after.map((event) => event.kind), ["response", "tool_started"]);
  assert.equal(sessions.getToolCall(session.id, "active-call")?.state, "started");
  assert.equal(after.some((event) => event.kind === "tool_result" || event.kind === "tool_denied"), false);
  assert.equal(sessions.releaseOperationLease(session.id, "reconcile-owner", "reconcile-token"), true);
});
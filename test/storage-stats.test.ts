import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { openDatabase } from "../src/storage/database.js";
import { SessionStore } from "../src/storage/session-store.js";

test("storage stats are aggregate-only and classify stale tool calls and leases", (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-storage-stats-"));
  const db = openDatabase(join(root, "state.db"));
  const sessions = new SessionStore(db);
  const artifactsDirectory = join(root, "artifacts");
  mkdirSync(artifactsDirectory);
  const artifacts = new ArtifactStore(db, artifactsDirectory);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const interactive = sessions.create({
    workspace: "workspace-secret",
    model: "test-model",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
  });
  const persistentAgent = sessions.create({
    workspace: "workspace-secret",
    model: "test-model",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
    kind: "agent",
  });
  sessions.updateSettings(persistentAgent.id, { persistent: true });
  const orphanedAgent = sessions.create({
    workspace: "workspace-secret",
    model: "test-model",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
    kind: "agent",
  });

  sessions.appendEvent(interactive.id, "user", { prompt: "prompt-secret" });
  sessions.appendEvent(interactive.id, "response", { output: "output-secret" });
  sessions.appendEvent(interactive.id, "error", { error: "error-secret" });
  sessions.appendEvent(persistentAgent.id, "note", { note: "note-secret" });
  sessions.saveCheckpoint(interactive.id, 2, { compact: "compact-secret" }, 7);

  const now = Date.now();
  assert.equal(sessions.acquireOperationLease(
    interactive.id,
    "owner-secret",
    "token-secret-active",
    "turn",
    now,
    60_000,
  ), true);
  assert.equal(sessions.beginToolCall(
    interactive.id,
    "call-secret-active",
    "shell",
    { command: "tool-args-secret" },
    "token-secret-active",
  ).record.state, "started");
  assert.equal(sessions.acquireOperationLease(
    orphanedAgent.id,
    "owner-secret-orphaned",
    "token-secret-orphaned",
    "turn",
    now,
    60_000,
  ), true);
  assert.equal(sessions.beginToolCall(
    orphanedAgent.id,
    "call-secret-orphaned",
    "shell",
    { command: "tool-args-secret" },
    "token-secret-orphaned",
  ).record.state, "started");
  assert.equal(sessions.releaseOperationLease(
    orphanedAgent.id,
    "owner-secret-orphaned",
    "token-secret-orphaned",
  ), true);
  db.prepare("UPDATE tool_calls SET started_at = ? WHERE call_id IN (?, ?)")
    .run(now - 20_000, "call-secret-active", "call-secret-orphaned");
  assert.equal(sessions.acquireOperationLease(
    persistentAgent.id,
    "owner-secret-stale",
    "token-secret-stale",
    "compact",
    now,
    0,
  ), true);

  const snapshot = sessions.getStats({ now, staleToolCallAgeMs: 10_000 });
  assert.deepEqual(snapshot.sessions, { total: 3, interactive: 1, agent: 2, persistent: 1 });
  assert.equal(snapshot.events.user, 1);
  assert.equal(snapshot.events.response, 1);
  assert.equal(snapshot.events.toolStarted, 2);
  assert.equal(snapshot.events.error, 1);
  assert.equal(snapshot.events.note, 1);
  assert.equal(snapshot.checkpoints.total, 1);
  assert.deepEqual(snapshot.toolCalls, {
    total: 2,
    started: 2,
    completed: 0,
    denied: 0,
    failed: 0,
    unknown: 0,
    staleStarted: 2,
    orphanedStarted: 1,
    oldestStaleStartedAgeMs: 20_000,
  });
  assert.equal(snapshot.leases.total, 2);
  assert.equal(snapshot.leases.active, 1);
  assert.equal(snapshot.leases.stale, 1);
  assert.equal(snapshot.leases.oldestStaleAgeMs, 0);

  const attached = artifacts.save(interactive.id, "output", "artifact-secret", { prompt: "metadata-secret" });
  artifacts.save(null, "output", Buffer.from("detached-secret"));
  assert.deepEqual(artifacts.getStats(), {
    total: 2,
    attached: 1,
    detached: 1,
    logicalBytes: attached.byteCount + Buffer.byteLength("detached-secret"),
  });

  const serialized = JSON.stringify({ snapshot, artifacts: artifacts.getStats() });
  assert.doesNotMatch(serialized, /workspace-secret|prompt-secret|output-secret|tool-args-secret/);
  assert.doesNotMatch(serialized, /owner-secret|token-secret|call-secret|metadata-secret|detached-secret/);
  assert.doesNotMatch(serialized, /state\.db|looking-glass-storage-stats/);

  assert.throws(() => sessions.getStats(-1), /now/);
  assert.throws(() => sessions.getStats(now, -1), /staleToolCallAgeMs/);
  assert.throws(() => sessions.getStats({ now, staleToolCallAgeMs: 1, staleStartedToolCallAgeMs: 2 }), /agree/);
});
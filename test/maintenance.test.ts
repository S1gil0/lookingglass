import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SchedulerStore } from "../src/scheduler/store.js";
import { runMaintenance } from "../src/maintenance.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { openDatabase, type GlassDatabase } from "../src/storage/database.js";
import { SessionStore } from "../src/storage/session-store.js";
import type { GlassConfig } from "../src/types.js";

interface Fixture {
  root: string;
  db: GlassDatabase;
  sessions: SessionStore;
  artifacts: ArtifactStore;
  scheduler: SchedulerStore;
}

function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-maintenance-"));
  const artifactsDirectory = join(root, "artifacts");
  mkdirSync(artifactsDirectory);
  const db = openDatabase(join(root, "state.db"));
  const sessions = new SessionStore(db);
  const artifacts = new ArtifactStore(db, artifactsDirectory);
  const scheduler = new SchedulerStore(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, db, sessions, artifacts, scheduler };
}

function maintenanceConfig(reconcileOrphanedTools = true): Pick<GlassConfig, "maintenance"> {
  const unlimited = Number.MAX_SAFE_INTEGER;
  return {
    maintenance: {
      runOnStartup: false,
      reconcileOrphanedTools,
      agentSessions: {
        maxAgeMs: 500,
        minAgeMs: 0,
        maxSessions: unlimited,
        maxLogicalBytes: unlimited,
        maxSessionsPerRun: unlimited,
        maxLogicalBytesPerRun: unlimited,
      },
      detachedArtifacts: {
        maxAgeMs: 500,
        minAgeMs: 0,
        maxArtifacts: unlimited,
        maxBytes: unlimited,
        maxArtifactsPerRun: unlimited,
        maxBytesPerRun: unlimited,
      },
      schedulerHistory: {
        outputRetentionMs: 0,
        occurrenceRetentionMs: 0,
        acknowledgedInboxRetentionMs: 0,
        deletedJobRetentionMs: 0,
        minOccurrencesPerJob: 0,
        batchSize: 100,
      },
    },
  };
}

function createAgent(fixtureValue: Fixture) {
  return fixtureValue.sessions.create({
    workspace: fixtureValue.root,
    model: "model-secret",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
    kind: "agent",
  });
}

test("dry-run estimates without mutating and apply runs in dependency order", (t) => {
  const fixtureValue = fixture(t);
  const now = Date.now();
  const oldAgent = createAgent(fixtureValue);
  const attached = fixtureValue.artifacts.save(oldAgent.id, "result-secret", "payload-secret", {
    metadata: "metadata-secret",
  });
  fixtureValue.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now - 1_000, oldAgent.id);
  fixtureValue.db.prepare("UPDATE artifacts SET created_at = ? WHERE id = ?").run(now - 1_000, attached.id);

  const orphan = fixtureValue.sessions.create({
    workspace: fixtureValue.root,
    model: "model-secret",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
  });
  assert.equal(fixtureValue.sessions.acquireOperationLease(
    orphan.id,
    "owner-secret",
    "token-secret",
    "turn",
    now,
    60_000,
  ), true);
  fixtureValue.sessions.beginToolCall(orphan.id, "call-secret", "shell", {
    command: "payload-secret",
  }, "token-secret");
  assert.equal(fixtureValue.sessions.releaseOperationLease(orphan.id, "owner-secret", "token-secret"), true);
  const expiredLeaseSession = fixtureValue.sessions.create({
    workspace: fixtureValue.root,
    model: "model-secret",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
  });
  fixtureValue.sessions.acquireOperationLease(expiredLeaseSession.id, "expired-owner", "expired-token", "turn", now, 0);
  fixtureValue.db.prepare("UPDATE tool_calls SET started_at = ? WHERE call_id = ?")
    .run(now - 1_000, "call-secret");

  const before = {
    sessions: (fixtureValue.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count,
    tools: (fixtureValue.db.prepare("SELECT state FROM tool_calls WHERE call_id = ?").get("call-secret") as { state: string }).state,
    leases: (fixtureValue.db.prepare("SELECT COUNT(*) AS count FROM session_operation_leases").get() as { count: number }).count,
    artifact: fixtureValue.artifacts.get(attached.id),
  };
  const preview = runMaintenance(
    fixtureValue.sessions,
    fixtureValue.artifacts,
    fixtureValue.scheduler,
    maintenanceConfig(),
    "dry-run",
    now,
  );

  assert.equal(preview.schemaVersion, 1);
  assert.equal(preview.mode, "dry-run");
  assert.equal(preview.dryRun, true);
  assert.equal(preview.orphanedTools.pending, 1);
  assert.equal(preview.orphanedTools.reconciled, 0);
  assert.equal(preview.expiredLeasesDeleted, 0);
  assert.equal(preview.agentSessions.selected.sessions, 1);
  assert.equal(preview.detachedArtifacts.selected.artifacts, 0);
  assert.equal((fixtureValue.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count, before.sessions);
  assert.equal((fixtureValue.db.prepare("SELECT state FROM tool_calls WHERE call_id = ?").get("call-secret") as { state: string }).state, before.tools);
  assert.equal((fixtureValue.db.prepare("SELECT COUNT(*) AS count FROM session_operation_leases").get() as { count: number }).count, before.leases);
  assert.deepEqual(fixtureValue.artifacts.get(attached.id), before.artifact);
  assert.equal(existsSync(attached.path), true);

  const applied = runMaintenance(
    fixtureValue.sessions,
    fixtureValue.artifacts,
    fixtureValue.scheduler,
    maintenanceConfig(),
    "apply",
    now,
  );
  assert.equal(applied.mode, "apply");
  assert.equal(applied.dryRun, false);
  assert.equal(applied.orphanedTools.pending, 1);
  assert.equal(applied.orphanedTools.reconciled, 1);
  assert.equal(applied.expiredLeasesDeleted, 1);
  assert.equal(applied.agentSessions.selected.sessions, 1);
  assert.equal(applied.detachedArtifacts.selected.artifacts, 1);
  assert.equal(fixtureValue.sessions.get(oldAgent.id), null);
  assert.equal(fixtureValue.sessions.getToolCall(orphan.id, "call-secret")?.state, "unknown");
  assert.equal(fixtureValue.artifacts.get(attached.id), null);
  assert.equal(existsSync(attached.path), false);

  const second = runMaintenance(
    fixtureValue.sessions,
    fixtureValue.artifacts,
    fixtureValue.scheduler,
    maintenanceConfig(),
    "apply",
    now,
  );
  assert.equal(second.orphanedTools.pending, 0);
  assert.equal(second.orphanedTools.reconciled, 0);
  assert.equal(second.expiredLeasesDeleted, 0);
  assert.equal(second.agentSessions.selected.sessions, 0);
  assert.equal(second.detachedArtifacts.selected.artifacts, 0);
});

test("disabled reconciliation reports zeros and reports never expose durable data", (t) => {
  const fixtureValue = fixture(t);
  const now = Date.now();
  const session = fixtureValue.sessions.create({
    workspace: "workspace-secret",
    model: "model-secret",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
  });
  fixtureValue.sessions.acquireOperationLease(session.id, "owner-secret", "token-secret", "turn", now, 0);
  const artifact = fixtureValue.artifacts.save(null, "kind-secret", "payload-secret", {
    metadata: "metadata-secret",
  });
  const report = runMaintenance(
    fixtureValue.sessions,
    fixtureValue.artifacts,
    fixtureValue.scheduler,
    maintenanceConfig(false),
    "dry-run",
    now,
  );
  assert.deepEqual(report.orphanedTools, { pending: 0, reconciled: 0 });
  assert.equal(report.expiredLeasesDeleted, 0);
  const serialized = JSON.stringify(report);
  for (const secret of [session.id, artifact.id, artifact.path, "workspace-secret", "model-secret", "payload-secret", "metadata-secret"]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal((fixtureValue.db.prepare("SELECT COUNT(*) AS count FROM session_operation_leases").get() as { count: number }).count, 1);
});

test("mode and time are validated before any stage runs", (t) => {
  const fixtureValue = fixture(t);
  const config = maintenanceConfig();
  assert.throws(
    () => runMaintenance(fixtureValue.sessions, fixtureValue.artifacts, fixtureValue.scheduler, config, "invalid" as never, 0),
    /mode/,
  );
  assert.throws(
    () => runMaintenance(fixtureValue.sessions, fixtureValue.artifacts, fixtureValue.scheduler, config, "dry-run", -1),
    /now/,
  );
});
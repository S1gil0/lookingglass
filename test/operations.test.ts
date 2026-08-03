import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { collectOperationalSnapshot, TELEMETRY_SCHEMA_VERSION } from "../src/operations.js";
import { SchedulerStore } from "../src/scheduler/store.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { openDatabase } from "../src/storage/database.js";
import { SessionStore } from "../src/storage/session-store.js";

test("operational snapshots have stable aggregate shape and SQLite storage math", (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-operations-"));
  const db = openDatabase(join(root, "state.db"));
  const sessions = new SessionStore(db);
  const artifactsDirectory = join(root, "artifacts");
  mkdirSync(artifactsDirectory);
  const artifacts = new ArtifactStore(db, artifactsDirectory);
  const scheduler = new SchedulerStore(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const session = sessions.create({
    workspace: "workspace-secret",
    model: "model-secret",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
  });
  sessions.appendEvent(session.id, "user", { prompt: "prompt-secret" });
  const artifact = artifacts.save(session.id, "output", "output-secret", { metadata: "metadata-secret" });
  const job = scheduler.createReminder({
    message: "job-message-secret",
    scheduleKind: "once",
    schedule: new Date(2_000_000).toISOString(),
    timezone: "UTC",
  }, 2_000_000);
  scheduler.materialize(2_000_000);

  const now = 2_000_000;
  const snapshot = collectOperationalSnapshot(db, sessions, artifacts, scheduler, "9.8.7", now);
  assert.deepEqual(Object.keys(snapshot), [
    "telemetrySchemaVersion",
    "appVersion",
    "generatedAt",
    "runtime",
    "sqlite",
    "sessions",
    "artifacts",
    "scheduler",
  ]);
  assert.equal(snapshot.telemetrySchemaVersion, TELEMETRY_SCHEMA_VERSION);
  assert.equal(snapshot.appVersion, "9.8.7");
  assert.equal(snapshot.generatedAt, now);
  assert.deepEqual(snapshot.runtime, {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  });

  const pageCount = (db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
  const pageSize = (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
  const freelistCount = (db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
  const migrationVersion = (db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version;
  const sqliteVersion = (db.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version;
  assert.equal(snapshot.sqlite.libraryVersion, sqliteVersion);
  assert.equal(snapshot.sqlite.schemaMigrationVersion, migrationVersion);
  assert.equal(snapshot.sqlite.pageCount, pageCount);
  assert.equal(snapshot.sqlite.pageSize, pageSize);
  assert.equal(snapshot.sqlite.freelistCount, Math.min(freelistCount, pageCount));
  assert.equal(snapshot.sqlite.logicalAllocatedBytes, pageCount * pageSize);
  assert.equal(snapshot.sqlite.logicalFreeBytes, Math.min(pageCount * pageSize, freelistCount * pageSize));
  assert.equal(
    snapshot.sqlite.logicalUsedBytes + snapshot.sqlite.logicalFreeBytes,
    snapshot.sqlite.logicalAllocatedBytes,
  );

  assert.equal(snapshot.sessions.sessions.total, 1);
  assert.equal(snapshot.sessions.events.user, 1);
  assert.equal(snapshot.artifacts.total, 1);
  assert.equal(snapshot.artifacts.attached, 1);
  assert.equal(snapshot.artifacts.logicalBytes, Buffer.byteLength("output-secret"));
  assert.equal(snapshot.scheduler.jobs.total, 1);
  assert.equal(snapshot.scheduler.occurrences.total, 1);

  const serialized = JSON.stringify(snapshot);
  for (const secret of [
    "workspace-secret",
    "model-secret",
    "prompt-secret",
    "output-secret",
    "metadata-secret",
    "job-message-secret",
    session.id,
    artifact.id,
    job.id,
    root,
  ]) {
    assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("operational snapshot validates its bounded inputs", () => {
  assert.throws(
    () => collectOperationalSnapshot(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      "1.0.0",
      -1,
    ),
    /now/,
  );
});
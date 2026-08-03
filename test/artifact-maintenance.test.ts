import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { openDatabase, type GlassDatabase } from "../src/storage/database.js";
import { SessionStore } from "../src/storage/session-store.js";

interface Fixture {
  root: string;
  artifactsDirectory: string;
  db: GlassDatabase;
  store: ArtifactStore;
  sessions: SessionStore;
}

function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-artifact-maintenance-"));
  const artifactsDirectory = join(root, "artifacts");
  mkdirSync(artifactsDirectory);
  const db = openDatabase(join(root, "state.db"));
  const sessions = new SessionStore(db);
  const store = new ArtifactStore(db, artifactsDirectory);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, artifactsDirectory, db, store, sessions };
}

function detached(fixtureValue: Fixture, text: string, createdAt: number) {
  const artifact = fixtureValue.store.save(null, "test", text);
  fixtureValue.db.prepare("UPDATE artifacts SET created_at = ? WHERE id = ?").run(createdAt, artifact.id);
  return artifact;
}

test("preview is dry-run and apply removes detached artifacts oldest-first", (t) => {
  const fixtureValue = fixture(t);
  const oldest = detached(fixtureValue, "old", 100);
  const newest = detached(fixtureValue, "new", 200);
  const preview = fixtureValue.store.previewDetachedArtifactMaintenance({ maxAgeMs: 500 }, 1_000);

  assert.equal(preview.mode, "dry-run");
  assert.equal(preview.dryRun, true);
  assert.equal(preview.candidate.artifacts, 2);
  assert.equal(preview.selected.artifacts, 2);
  assert.equal(existsSync(oldest.path), true);
  assert.equal(fixtureValue.store.get(oldest.id)?.id, oldest.id);

  const report = fixtureValue.store.applyDetachedArtifactMaintenance({ maxAgeMs: 500 }, 1_000);
  assert.equal(report.mode, "apply");
  assert.equal(report.deletedMetadata, 2);
  assert.equal(report.deletedFiles, 2);
  assert.equal(report.errors, 0);
  assert.equal(existsSync(oldest.path), false);
  assert.equal(existsSync(newest.path), false);
});

test("quotas and batch limits select the deterministic oldest rows", (t) => {
  const fixtureValue = fixture(t);
  const oldest = detached(fixtureValue, "a", 100);
  const middle = detached(fixtureValue, "bb", 200);
  const newest = detached(fixtureValue, "ccc", 300);
  const policy = { maxArtifacts: 1, maxArtifactsPerRun: 1, maxAgeMs: 0 };
  const preview = fixtureValue.store.previewDetachedArtifactMaintenance(policy, 1_000);
  assert.equal(preview.candidate.artifacts, 3);
  assert.equal(preview.selected.artifacts, 1);
  assert.equal(preview.batchLimited, true);

  const report = fixtureValue.store.applyDetachedArtifactMaintenance(policy, 1_000);
  assert.equal(report.selected.artifacts, 1);
  assert.equal(report.selected.bytes, 1);
  assert.equal(fixtureValue.store.get(oldest.id), null);
  assert.ok(fixtureValue.store.get(middle.id));
  assert.ok(fixtureValue.store.get(newest.id));
});

test("attached, future, and minimum-age artifacts are protected", (t) => {
  const fixtureValue = fixture(t);
  const session = fixtureValue.sessions.create({
    workspace: fixtureValue.root,
    model: "test-model",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
  });
  const attached = fixtureValue.store.save(session.id, "attached", "attached");
  const future = detached(fixtureValue, "future", 2_000);
  const young = detached(fixtureValue, "young", 950);
  const report = fixtureValue.store.applyDetachedArtifactMaintenance({
    maxAgeMs: 0,
    minAgeMs: 100,
    maxArtifacts: 0,
  }, 1_000);

  assert.equal(report.selected.artifacts, 0);
  assert.ok(fixtureValue.store.get(attached.id));
  assert.ok(fixtureValue.store.get(future.id));
  assert.ok(fixtureValue.store.get(young.id));
  assert.equal(existsSync(attached.path), true);
});

test("path escapes and symlinks are refused without exposing paths", (t) => {
  const fixtureValue = fixture(t);
  const outside = join(fixtureValue.root, "outside");
  writeFileSync(outside, "do not remove");
  const escapedId = "escaped";
  const symlinkId = "symlink";
  const symlinkPath = join(fixtureValue.artifactsDirectory, symlinkId);
  symlinkSync(outside, symlinkPath);
  fixtureValue.db.prepare(`
    INSERT INTO artifacts(id, session_id, kind, file_path, byte_count, metadata_json, created_at)
    VALUES (?, NULL, 'test', ?, 13, '{}', 100)
  `).run(escapedId, outside);
  fixtureValue.db.prepare(`
    INSERT INTO artifacts(id, session_id, kind, file_path, byte_count, metadata_json, created_at)
    VALUES (?, NULL, 'test', ?, 13, '{}', 100)
  `).run(symlinkId, symlinkPath);

  const report = fixtureValue.store.applyDetachedArtifactMaintenance({ maxAgeMs: 0 }, 1_000);
  assert.equal(report.deletedMetadata, 0);
  assert.equal(report.deletedFiles, 0);
  assert.equal(report.errors, 2);
  assert.equal(JSON.stringify(report).includes(outside), false);
  assert.equal(readFileText(outside), "do not remove");
  assert.equal(lstatSync(symlinkPath).isSymbolicLink(), true);
  assert.ok(fixtureValue.store.get(escapedId));
  assert.ok(fixtureValue.store.get(symlinkId));
});

test("missing files lose stale metadata but are not counted as file deletions", (t) => {
  const fixtureValue = fixture(t);
  const artifact = detached(fixtureValue, "gone", 100);
  unlinkSync(artifact.path);
  const report = fixtureValue.store.applyDetachedArtifactMaintenance({ maxAgeMs: 0 }, 1_000);
  assert.equal(report.deletedMetadata, 1);
  assert.equal(report.deletedFiles, 0);
  assert.equal(report.errors, 0);
  assert.equal(fixtureValue.store.get(artifact.id), null);
});

test("database deletion failures keep metadata and files", (t) => {
  const fixtureValue = fixture(t);
  const artifact = detached(fixtureValue, "blocked", 100);
  fixtureValue.db.exec(`
    CREATE TRIGGER block_artifact_delete
    BEFORE DELETE ON artifacts
    BEGIN
      SELECT RAISE(ABORT, 'maintenance blocked');
    END;
  `);

  const report = fixtureValue.store.applyDetachedArtifactMaintenance({ maxAgeMs: 0 }, 1_000);
  assert.equal(report.deletedMetadata, 0);
  assert.equal(report.deletedFiles, 0);
  assert.equal(report.errors, 1);
  assert.ok(fixtureValue.store.get(artifact.id));
  assert.equal(existsSync(artifact.path), true);
});

test("save removes the file when the database insert fails", (t) => {
  const fixtureValue = fixture(t);
  assert.throws(() => fixtureValue.store.save("missing-session", "test", "rollback"));
  assert.deepEqual(readdirSync(fixtureValue.artifactsDirectory), []);
});

function readFileText(path: string): string {
  return readFileSync(path, "utf8");
}
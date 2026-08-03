import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SchedulerStore } from "../src/scheduler/store.js";
import { openDatabase } from "../src/storage/database.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-scheduler-maintenance-"));
  const db = openDatabase(join(root, "glass.db"));
  const store = new SchedulerStore(db);
  return { root, db, store };
}

test("terminal transitions fence and clear occurrence claims", (t) => {
  const { root, db, store } = fixture();
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const now = 1_000_000;
  store.createCommand({
    command: ":",
    cwd: root,
    scheduleKind: "once",
    schedule: new Date(now).toISOString(),
    timezone: "UTC",
    startGraceMs: 60_000,
    timeoutMs: 5_000,
    outputBytes: 100,
  }, now - 1);
  const occurrence = store.materialize(now)[0]!;
  assert.equal(store.acquireLease("maintenance", "boot", now, 10_000), true);
  const claim = store.claimCommands("maintenance", "boot", now, 10_000, 1)[0]!;
  assert.equal(store.startClaimedCommand(
    occurrence.id,
    claim.occurrence.claimToken,
    claim.occurrence.claimOwner,
    claim.occurrence.claimBootId,
    now + 1,
  )?.state, "running");
  assert.equal(store.finishCommand(
    occurrence.id,
    claim.occurrence.claimToken,
    claim.occurrence.claimOwner,
    claim.occurrence.claimBootId,
    {
      state: "succeeded",
      exitCode: 0,
      signal: null,
      reason: null,
      stdout: Buffer.from("done"),
      stderr: Buffer.alloc(0),
      stdoutBytes: 4,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
    },
    now + 2,
  )?.state, "succeeded");
  assert.deepEqual(db.prepare(`
    SELECT claim_token, claim_owner, claim_boot_id, claim_lease_expires_at
    FROM scheduler_occurrences WHERE id = ?
  `).get(occurrence.id), {
    claim_token: null,
    claim_owner: null,
    claim_boot_id: null,
    claim_lease_expires_at: null,
  });

  db.prepare(`
    UPDATE scheduler_occurrences
    SET claim_token = 'old-token', claim_owner = 'old-owner', claim_boot_id = 'old-boot',
        claim_lease_expires_at = ?
    WHERE id = ?
  `).run(now, occurrence.id);
  assert.equal(store.scrubTerminalClaims(), 1);
  assert.equal(store.getStats(now).terminalClaims, 0);
});

test("reason, error, and inbox diagnostics are bounded at the store boundary", (t) => {
  const { root, db, store } = fixture();
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const now = 2_000_000;
  const message = "é".repeat(2_000);
  const job = store.createReminder({
    message,
    scheduleKind: "once",
    schedule: new Date(now).toISOString(),
    timezone: "UTC",
  }, now - 1);
  store.materialize(now);
  const inbox = db.prepare(`
    SELECT message, length(CAST(message AS BLOB)) AS bytes
    FROM scheduler_inbox WHERE job_id = ?
  `).get(job.id) as { message: string; bytes: number };
  assert.ok(inbox.bytes <= 2 * 1024);
  assert.equal(Buffer.byteLength(inbox.message, "utf8"), inbox.bytes);
  assert.equal(inbox.message.endsWith("�"), false);

  store.createCommand({
    command: ":",
    cwd: root,
    scheduleKind: "once",
    schedule: new Date(now).toISOString(),
    timezone: "UTC",
    startGraceMs: 60_000,
    timeoutMs: 5_000,
    outputBytes: 100,
  }, now - 1);
  const commandOccurrence = store.materialize(now)[0]!;
  assert.equal(store.acquireLease("maintenance", "boot", now, 10_000), true);
  const claim = store.claimCommands("maintenance", "boot", now, 10_000, 1)[0]!;
  store.startClaimedCommand(
    commandOccurrence.id,
    claim.occurrence.claimToken,
    claim.occurrence.claimOwner,
    claim.occurrence.claimBootId,
    now + 1,
  );
  const reason = "\u0001é".repeat(400);
  store.finishCommand(
    commandOccurrence.id,
    claim.occurrence.claimToken,
    claim.occurrence.claimOwner,
    claim.occurrence.claimBootId,
    {
      state: "failed",
      exitCode: 1,
      signal: null,
      reason,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
    },
    now + 2,
  );
  const storedReason = db.prepare(`
    SELECT reason FROM scheduler_occurrences WHERE id = ?
  `).get(commandOccurrence.id) as { reason: string };
  assert.ok(Buffer.byteLength(storedReason.reason, "utf8") <= 512);
  assert.equal(storedReason.reason.includes("\u0001"), false);
  assert.equal(storedReason.reason.includes("�"), true);
});

test("retention is dry-run safe, protects unread/unknown rows, and orders deletes", (t) => {
  const { root, db, store } = fixture();
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const now = 3_000_000;
  const job = store.createReminder({
    message: "retained",
    scheduleKind: "once",
    schedule: new Date(now - 10_000).toISOString(),
    timezone: "UTC",
  }, now - 20_000);
  const occurrence = store.materialize(now)[0]!;
  db.prepare("UPDATE scheduler_inbox SET acknowledged_at = ? WHERE occurrence_id = ?").run(now - 10_000, occurrence.id);
  db.prepare(`
    UPDATE scheduler_occurrences
    SET stdout = ?, stderr = ?, stdout_bytes = 3, stderr_bytes = 2,
        stdout_truncated = 1, stderr_truncated = 1
    WHERE id = ?
  `).run(Buffer.from("abc"), Buffer.from("xy"), occurrence.id);

  const policy = {
    outputRetentionMs: 0,
    occurrenceRetentionMs: 0,
    acknowledgedInboxRetentionMs: 0,
    deletedJobRetentionMs: 0,
    batchSize: 10,
  } as const;
  const preview = store.planSchedulerRetention(policy, now);
  assert.equal(preview.dryRun, true);
  assert.equal(store.getStats(now).occurrences.total, 1);
  const scrubbed = store.applySchedulerRetention({ outputRetentionMs: 0 }, now);
  assert.equal(scrubbed.outputBytes, 5);
  assert.deepEqual(db.prepare(`
    SELECT stdout, stderr, stdout_bytes, stderr_bytes, stdout_truncated, stderr_truncated
    FROM scheduler_occurrences WHERE id = ?
  `).get(occurrence.id), {
    stdout: null,
    stderr: null,
    stdout_bytes: 3,
    stderr_bytes: 2,
    stdout_truncated: 1,
    stderr_truncated: 1,
  });
  const applied = store.applySchedulerRetention({
    occurrenceRetentionMs: 0,
    acknowledgedInboxRetentionMs: 0,
    deletedJobRetentionMs: 0,
  }, now);
  assert.equal(applied.inboxDeleted, 1);
  assert.equal(applied.occurrencesDeleted, 1);
  assert.equal(store.getStats(now).occurrences.total, 0);
  assert.equal(store.getStats(now).inbox.total, 0);
  assert.equal(store.getJob(job.id) !== null, true);

  const unknownJob = store.createReminder({
    message: "unknown",
    scheduleKind: "once",
    schedule: new Date(now - 10_000).toISOString(),
    timezone: "UTC",
  }, now - 20_000);
  const unknown = store.materialize(now)[0]!;
  db.prepare("UPDATE scheduler_occurrences SET state = 'unknown', finished_at = ? WHERE id = ?").run(now - 10_000, unknown.id);
  db.prepare("UPDATE scheduler_inbox SET acknowledged_at = ? WHERE occurrence_id = ?").run(now - 10_000, unknown.id);
  const protectedReport = store.applySchedulerRetention({
    occurrenceRetentionMs: 0,
    acknowledgedInboxRetentionMs: 0,
    deletedJobRetentionMs: 0,
  }, now);
  assert.equal(protectedReport.occurrencesDeleted, 0);
  assert.equal(store.getJob(unknownJob.id) !== null, true);
  assert.equal(store.getStats(now).inbox.total, 1);
});

test("deleted job retention starts when the job is deleted", (t) => {
  const { root, db, store } = fixture();
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const createdAt = 1_000;
  const deletedAt = 10_000;
  const job = store.createReminder({
    message: "delete later",
    scheduleKind: "once",
    schedule: new Date(100_000).toISOString(),
    timezone: "UTC",
  }, createdAt);

  const deleted = store.deleteJob(job.id, deletedAt);
  assert.equal(deleted.deletedAt, deletedAt);
  assert.equal(store.applySchedulerRetention({ deletedJobRetentionMs: 100 }, deletedAt + 99).jobsDeleted, 0);
  assert.ok(store.getJob(job.id));
  assert.equal(store.applySchedulerRetention({ deletedJobRetentionMs: 100 }, deletedAt + 101).jobsDeleted, 1);
  assert.equal(store.getJob(job.id), null);
});

test("scheduler stats expose aggregates without scheduler payloads", (t) => {
  const { root, db, store } = fixture();
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const now = 4_000_000;
  store.createReminder({
    message: "queue",
    scheduleKind: "once",
    schedule: new Date(now).toISOString(),
    timezone: "UTC",
  }, now - 10);
  store.materialize(now);
  const stats = store.getStats(now);
  assert.equal(stats.jobs.total, 1);
  assert.equal(stats.occurrences.terminal, 1);
  assert.equal(stats.inbox.unread, 1);
  assert.equal(stats.queueAges.pendingMs, null);
  assert.equal("message" in stats, false);
  assert.equal("claimToken" in stats, false);
});
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  formatOperationLeaseLoss,
  type SessionOperationLeaseLossDiagnostic,
} from "../src/engine/engine.js";
import { openDatabase } from "../src/storage/database.js";
import { SessionStore } from "../src/storage/session-store.js";

function fixture(t: TestContext): { sessions: SessionStore; sessionId: string } {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-lease-diagnostics-"));
  const db = openDatabase(join(root, "state.db"));
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const sessions = new SessionStore(db);
  const session = sessions.create({
    workspace: root,
    model: "test-model",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
  });
  return { sessions, sessionId: session.id };
}

test("operation lease checks classify missing, expired, and replaced rows", (t) => {
  const { sessions, sessionId } = fixture(t);
  const now = 10_000;

  assert.equal(sessions.inspectOperationLease(sessionId, "owner-a", "token-a", now).kind, "missing");
  assert.equal(sessions.acquireOperationLease(sessionId, "owner-a", "token-a", "turn", now, 100), true);

  const active = sessions.assertOperationLeaseChecked(sessionId, "owner-a", "token-a", now + 50);
  assert.equal(active.ok, true);
  assert.deepEqual(active.state, {
    kind: "active",
    leaseDurationMs: 100,
    renewalAgeMs: 50,
    expiryOffsetMs: 50,
  });

  const expired = sessions.renewOperationLeaseChecked(sessionId, "owner-a", "token-a", now + 100, 100);
  assert.equal(expired.ok, false);
  assert.deepEqual(expired.state, {
    kind: "expired",
    leaseDurationMs: 100,
    renewalAgeMs: 100,
    expiryOffsetMs: 0,
  });

  assert.equal(sessions.acquireOperationLease(sessionId, "owner-b", "token-b", "turn", now + 101, 100), true);
  const replaced = sessions.assertOperationLeaseChecked(sessionId, "owner-a", "token-a", now + 102);
  assert.equal(replaced.ok, false);
  assert.deepEqual(replaced.state, {
    kind: "replaced",
    leaseDurationMs: null,
    renewalAgeMs: null,
    expiryOffsetMs: null,
  });
});

test("lease-loss formatting is actionable without ownership or session identifiers", () => {
  const diagnostic: SessionOperationLeaseLossDiagnostic = {
    phase: "final assertion",
    kind: "expired",
    leaseMs: 30_000,
    heartbeatMs: 10_000,
    leaseDurationMs: 30_000,
    renewalAgeMs: 30_005,
    expiryOffsetMs: -5,
  };
  const message = formatOperationLeaseLoss(diagnostic);

  assert.equal(
    message,
    "Session operation lease lost during final assertion: the same lease expired 5ms ago "
      + "(lease duration 30000ms; heartbeat every 10000ms; last renewal 30005ms ago). Retry the operation.",
  );
  assert.doesNotMatch(message, /owner-a|token-a|session-secret|session[- ]id/i);

  const replaced = formatOperationLeaseLoss({
    ...diagnostic,
    phase: "heartbeat renewal",
    kind: "replaced",
    leaseDurationMs: null,
    renewalAgeMs: null,
    expiryOffsetMs: null,
  });
  assert.match(replaced, /ownership changed/);
  assert.doesNotMatch(replaced, /observed duration/);
  assert.match(replaced, /heartbeat every 10000ms/);
});
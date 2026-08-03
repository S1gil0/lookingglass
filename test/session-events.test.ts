import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/storage/database.js";
import { SessionStore } from "../src/storage/session-store.js";

test("reads a bounded recent event window without removing durable history", (t) => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-events-"));
  const db = openDatabase(join(root, "state.db"));
  const sessions = new SessionStore(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const session = sessions.create({
    workspace: root,
    model: "test-model",
    reasoningEffort: "medium",
    verbosity: "medium",
    fast: false,
  });
  for (let index = 1; index <= 12; index += 1) {
    sessions.appendEvent(session.id, "note", { index });
  }

  const recent = sessions.recentEvents(session.id, 5);
  assert.deepEqual(recent.map((event) => event.sequence), [8, 9, 10, 11, 12]);
  assert.equal(sessions.eventCount(session.id), 12);
  assert.equal(sessions.events(session.id).length, 12);
  assert.deepEqual(sessions.recentEvents(session.id, 0), []);
});
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Response, ResponseInputItem } from "openai/resources/responses/responses";
import { DEFAULT_CONFIG } from "../src/config.js";
import { compactionQuality } from "../src/engine/compaction.js";
import { projectContext } from "../src/engine/context.js";
import { ConversationEngine } from "../src/engine/engine.js";
import type { CodexLbClient } from "../src/model/codex-lb.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { openDatabase } from "../src/storage/database.js";
import { SessionStore } from "../src/storage/session-store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const user = (text: string): ResponseInputItem => ({ role: "user", content: [{ type: "input_text", text }] });
const checkpoint = (text: string, details: Record<string, unknown> = {}) => ({
  output: [{ type: "message", ...user(text) }], compaction_details: details,
});
const answer = (id: string, text: string): Response => ({
  id, status: "completed", output_text: text,
  output: [{ id: `msg_${id}`, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }] }],
} as unknown as Response);

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "glass-compaction-storage-"));
  const path = join(root, "state.db");
  let db = openDatabase(path);
  let sessions = new SessionStore(db);
  const session = sessions.create({ workspace: root, model: "test", reasoningEffort: "none", verbosity: "low", fast: false });
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return {
    get db() { return db; },
    get sessions() { return sessions; },
    session,
    reload() {
      db.close();
      db = openDatabase(path);
      sessions = new SessionStore(db);
      return sessions;
    },
    checkpointIds: () => (db.prepare("SELECT id FROM context_checkpoints WHERE session_id = ? ORDER BY through_sequence")
      .all(session.id) as { id: number }[]).map((row) => row.id),
    engine: (client: Partial<CodexLbClient>) => new ConversationEngine(
      structuredClone(DEFAULT_CONFIG), root, sessions, new ArtifactStore(db, join(root, "artifacts")),
      client as CodexLbClient, new ToolRegistry(), "test instructions", async () => {},
    ),
  };
}

function storedResult(
  sessions: SessionStore, sessionId: string, callId: string, output: string | null, error: string | null,
  kind: "tool_result" | "tool_denied" = "tool_result",
) {
  assert.ok(sessions.acquireOperationLease(sessionId, "test-owner", "test-token", "turn"));
  sessions.beginToolCall(sessionId, callId, "inspect", {}, "test-token");
  sessions.finishToolCall(sessionId, callId, kind === "tool_denied" ? "denied" : "failed", output, error);
  assert.ok(sessions.releaseOperationLease(sessionId, "test-owner", "test-token"));
  return sessions.appendEvent(sessionId, kind, { callId, name: "inspect" });
}

for (const kind of ["tool_result", "tool_denied"] as const) {
  test(`repair preflight and replay accept error-only ${kind} results`, async (t) => {
    const f = fixture(t);
    const { sessions, session } = f;
    sessions.appendEvent(session.id, "user", { item: user("Inspect the source") });
    sessions.appendEvent(session.id, "response", { response: { ...answer("call", ""), output: [{
      type: "function_call", id: "fc_error", call_id: "error-only", name: "inspect", arguments: "{}",
    }] } });
    const error = "ERROR_ONLY_RESULT: source inspection failed without any output";
    const result = storedResult(sessions, session.id, "error-only", null, error, kind);
    const end = sessions.appendEvent(session.id, "response", { response: answer("done", "The inspection did not succeed") });
    assert.deepEqual(sessions.sourceHistoryStats(session.id, result.sequence - 1, result.sequence), {
      events: 1, characters: JSON.stringify(result.payload).length + error.length, missingToolOutputs: 0,
    });
    const expected = { type: "function_call_output", call_id: "error-only", output: error };
    assert.deepEqual(projectContext(sessions, session.id).input.find((item) => item.type === "function_call_output"), expected);
    sessions.saveCheckpoint(session.id, end.sequence, checkpoint("LOSSY", { degraded: true }), null);
    const events = sessions.events(session.id);
    const toolCall = sessions.getToolCall(session.id, "error-only");
    let requests = 0;
    await f.engine({ async compact(request) {
      requests += 1;
      assert.equal(request.semanticOnly, true);
      assert.deepEqual(request.input.find((item) => item.type === "function_call_output"), expected);
      assert.doesNotMatch(JSON.stringify(request.input), /LOSSY/);
      return checkpoint("Repaired failure history");
    } }).compactNow(session.id, { signal: new AbortController().signal, repair: true });
    assert.equal(requests, 1);
    assert.equal(compactionQuality(sessions.latestCheckpoint(session.id)!.compact).degraded, false);
    assert.deepEqual(sessions.events(session.id), events);
    assert.deepEqual(sessions.getToolCall(session.id, "error-only"), toolCall);
  });
}

for (const [name, output, error, resolved] of [
  ["output takes precedence", "OUTPUT", "ignored error", "OUTPUT"],
  ["empty output takes precedence", "", "ignored error", ""],
  ["empty error remains available", null, "", ""],
  ["both columns missing", null, null, null],
] as const) {
  test(`repair source accounting matches replay resolution: ${name}`, (t) => {
    const { sessions, session } = fixture(t);
    const event = storedResult(sessions, session.id, "stored", output, error);
    assert.deepEqual(sessions.sourceHistoryStats(session.id, event.sequence - 1, event.sequence), {
      events: 1, characters: JSON.stringify(event.payload).length + (resolved?.length ?? 0),
      missingToolOutputs: resolved === null ? 1 : 0,
    });
    assert.equal(sessions.toolCallOutputs(session.id, ["stored"]).get("stored"), resolved ?? "Tool result is unavailable.");
  });
}

test("repair source accounting does not double-count stored errors for inline outputs or items", (t) => {
  const { sessions, session } = fixture(t);
  const reference = storedResult(sessions, session.id, "stored", null, "not the inline result");
  const output = sessions.appendEvent(session.id, "tool_result", { ...reference.payload, output: "inline output" });
  const item = sessions.appendEvent(session.id, "tool_denied", { ...reference.payload,
    item: { type: "function_call_output", call_id: "stored", output: "inline item" } });
  assert.deepEqual(sessions.sourceHistoryStats(session.id, reference.sequence, item.sequence), {
    events: 2, characters: JSON.stringify(output.payload).length + JSON.stringify(item.payload).length, missingToolOutputs: 0,
  });
});

for (const [name, details] of [
  ["explicit degradation", { degraded: true }],
  ["local recovery", { strategy: "local-recovery" }],
  ["local parts", { total_parts: 2, local_parts: 1 }],
  ["truncated parts", { quality: { truncated_parts: 1 } }],
  ["incomplete parts", { quality: { incomplete_parts: 1 } }],
  ["inherited degradation", { degraded: false, quality: { inherited_degradation: true } }],
] as const) {
  test(`provider migration retains the newest usable healthy anchor for ${name}`, (t) => {
    const f = fixture(t);
    const { sessions, session } = f;
    sessions.saveCheckpoint(session.id, 1, checkpoint("OBSOLETE_HEALTHY"), null);
    const anchor = sessions.saveCheckpoint(session.id, 2, checkpoint("HEALTHY_ANCHOR"), null);
    sessions.saveCheckpoint(session.id, 3, checkpoint(" "), null);
    sessions.saveCheckpoint(session.id, 4, { output: [{ type: "compaction", encrypted_content: "OLD_NATIVE" }] }, null);
    sessions.saveCheckpoint(session.id, 5, checkpoint("OLDER_DEGRADED", { quality: { inherited_degradation: true } }), null);
    const latest = sessions.saveCheckpoint(session.id, 6, checkpoint("LATEST_PORTABLE", details), null);
    sessions.saveCheckpoint(session.id, 7, { output: [{ type: "compaction", encrypted_content: "NEW_NATIVE" }] }, null);

    sessions.updateSettings(session.id, { provider: "openrouter" });

    assert.deepEqual(f.checkpointIds(), [anchor.id, latest.id]);
    assert.deepEqual(sessions.latestCheckpoint(session.id), latest);
  });
}

test("healthy provider migration still prunes obsolete healthy and degraded checkpoints", (t) => {
  const f = fixture(t);
  const { sessions, session } = f;
  sessions.saveCheckpoint(session.id, 1, checkpoint("OBSOLETE_HEALTHY"), null);
  sessions.saveCheckpoint(session.id, 2, checkpoint("OBSOLETE_DEGRADED", { degraded: true }), null);
  const latest = sessions.saveCheckpoint(session.id, 3, checkpoint("LATEST_HEALTHY"), null);
  sessions.updateSettings(session.id, { provider: "lm-studio" });
  assert.deepEqual(f.checkpointIds(), [latest.id]);
});

test("degraded provider migration without a healthy anchor retains only the newest portable checkpoint", (t) => {
  const f = fixture(t);
  const { sessions, session } = f;
  sessions.saveCheckpoint(session.id, 1, checkpoint("OLD_DEGRADED", { degraded: true }), null);
  const latest = sessions.saveCheckpoint(session.id, 2, checkpoint("LATEST_DEGRADED", { strategy: "local-recovery" }), null);
  sessions.updateSettings(session.id, { provider: "lm-studio" });
  assert.deepEqual(f.checkpointIds(), [latest.id]);
});

test("provider migration and database reload preserve bounded repair from the healthy anchor", async (t) => {
  const f = fixture(t);
  const { sessions, session } = f;
  sessions.appendEvent(session.id, "user", { item: user("OLD_HISTORY_COVERED_BY_ANCHOR") });
  sessions.appendEvent(session.id, "response", { response: answer("old", "OLD_ANSWER") });
  const anchor = sessions.saveCheckpoint(session.id, 2, checkpoint("HEALTHY_BASELINE"), null);
  sessions.appendEvent(session.id, "user", { item: user("OMITTED_FACT " + "x".repeat(90_000)) });
  const sourceEnd = sessions.appendEvent(session.id, "response", { response: answer("source", "SOURCE_ANSWER") }).sequence;
  const descendant = sessions.saveCheckpoint(session.id, sourceEnd, checkpoint("LOSSY_DESCENDANT", {
    quality: { inherited_degradation: true },
  }), null);
  sessions.appendEvent(session.id, "user", { item: user("RECENT_REQUEST") });
  sessions.appendEvent(session.id, "response", { response: answer("recent", "RECENT_ANSWER") });
  // Repair must use the healthy anchor, rather than require the already-covered prefix.
  f.db.prepare("DELETE FROM session_events WHERE session_id = ? AND sequence <= ?").run(session.id, anchor.throughSequence);
  sessions.setLastResponseId(session.id, "OLD_CONTINUITY");
  const migrated = sessions.updateSettings(session.id, { provider: "openrouter" });
  assert.equal(migrated.lastResponseId, null);
  assert.notEqual(migrated.promptCacheKey, session.promptCacheKey);
  const reloaded = f.reload();
  assert.equal(reloaded.get(session.id)?.provider, "openrouter");
  assert.deepEqual(f.checkpointIds(), [anchor.id, descendant.id]);
  const events = reloaded.events(session.id);
  let requests = 0;
  await f.engine({ async compact(request) {
    requests += 1;
    assert.equal(request.semanticOnly, true);
    assert.match(JSON.stringify(request.input), /HEALTHY_BASELINE.*OMITTED_FACT/);
    assert.doesNotMatch(JSON.stringify(request.input), /OLD_HISTORY_COVERED_BY_ANCHOR|LOSSY_DESCENDANT|RECENT_REQUEST/);
    return checkpoint("REPAIRED_SOURCE");
  } }).compactNow(session.id, { signal: new AbortController().signal, repair: true });
  assert.equal(requests, 1);
  const saved = reloaded.latestCheckpoint(session.id)!;
  assert.equal(saved.throughSequence, sourceEnd);
  assert.equal(compactionQuality(saved.compact).degraded, false);
  assert.equal((saved.compact.compaction_details as { source_checkpoint_sequence: number }).source_checkpoint_sequence, anchor.throughSequence);
  assert.deepEqual(f.checkpointIds(), [saved.id]);
  assert.deepEqual(reloaded.events(session.id), events);
  assert.match(JSON.stringify(projectContext(reloaded, session.id).input), /REPAIRED_SOURCE.*RECENT_REQUEST.*RECENT_ANSWER/);
});
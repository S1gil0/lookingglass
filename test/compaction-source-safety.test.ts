import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Response, ResponseInputItem } from "openai/resources/responses/responses";
import { DEFAULT_CONFIG } from "../src/config.js";
import { compactionQuality } from "../src/engine/compaction.js";
import { ConversationEngine, type TurnMetrics } from "../src/engine/engine.js";
import type { CodexLbClient, CompactRequest } from "../src/model/codex-lb.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { openDatabase } from "../src/storage/database.js";
import { SessionStore } from "../src/storage/session-store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { GatewayProvider, ModelInfo } from "../src/types.js";

const user = (text: string): ResponseInputItem => ({ role: "user", content: [{ type: "input_text", text }] });
const checkpoint = (text: string, details: Record<string, unknown> = {}) => ({
  output: [{ type: "message", ...user(text) }], compaction_details: details,
});
const native = () => ({ output: [{ type: "compaction", encrypted_content: "OPAQUE_NATIVE" }] });
const answer = (text: string): Response => ({
  id: "answer", status: "completed", output_text: text,
  output: [{ id: "message", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }] }],
} as unknown as Response);
const outage = () => Object.assign(new Error("private provider failure"), {
  code: "compaction_part_retry_exhausted", retryable: false,
});
const partial = () => checkpoint("PARTIAL_SUMMARY", { total_parts: 2, semantic_parts: 1, local_parts: 1 });

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "glass-compaction-source-safety-"));
  const db = openDatabase(join(root, "state.db"));
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const sessions = new SessionStore(db);
  const session = sessions.create({ workspace: root, model: "test", reasoningEffort: "none", verbosity: "low", fast: false });
  const exchange = (text: string) => {
    sessions.appendEvent(session.id, "user", { item: user(text) });
    return sessions.appendEvent(session.id, "response", { response: answer(`${text}_ANSWER`) }).sequence;
  };
  return { db, sessions, session, exchange,
    engine: (client: Partial<CodexLbClient>,
      modelFor?: (id: string, provider: GatewayProvider, signal: AbortSignal) => Promise<ModelInfo>) => new ConversationEngine(
      structuredClone(DEFAULT_CONFIG), root, sessions, new ArtifactStore(db, join(root, "artifacts")),
      client as CodexLbClient, new ToolRegistry(), "test instructions", async () => {},
      undefined, undefined, undefined, modelFor,
    ),
    checkpointIds: () => (db.prepare("SELECT id FROM context_checkpoints WHERE session_id = ? ORDER BY through_sequence")
      .all(session.id) as { id: number }[]).map((row) => row.id),
  };
}

async function assertSourceUnavailable(t: TestContext, f: ReturnType<typeof fixture>) {
  const { sessions, session } = f;
  sessions.setLastResponseId(session.id, "HEALTHY_CONTINUITY");
  const saved = sessions.latestCheckpoint(session.id);
  const before = sessions.events(session.id);
  const continuity = sessions.get(session.id)!;
  const events = t.mock.method(sessions, "events", () => assert.fail("preflight must not materialize source replay"));
  const stats = t.mock.method(sessions, "sourceHistoryStats");
  let remoteAttempts = 0;
  const unexpected = async (): Promise<never> => { remoteAttempts += 1; assert.fail("source preflight must run before remote work"); };
  await assert.rejects(f.engine({ compact: unexpected, stream: unexpected }, unexpected).compactNow(session.id, {
    signal: new AbortController().signal,
  }), { code: "checkpoint_conversion_unavailable" });
  assert.equal(remoteAttempts, 0);
  assert.equal(events.mock.callCount(), 0);
  assert.equal(stats.mock.callCount(), 1);
  assert.deepEqual(sessions.latestCheckpoint(session.id), saved);
  assert.equal(sessions.get(session.id)?.lastResponseId, continuity.lastResponseId);
  assert.equal(sessions.get(session.id)?.promptCacheKey, continuity.promptCacheKey);
  events.mock.restore();
  assert.deepEqual(sessions.events(session.id).slice(0, before.length), before);
  assert.equal(sessions.events(session.id).length, before.length + 1);
  assert.equal((sessions.events(session.id).at(-1)?.payload as { code?: string }).code, "compaction_failed");
}

for (const gap of ["prefix", "middle", "after portable anchor"] as const) {
  test(`native conversion rejects a missing ${gap} event despite nonempty replay`, async (t) => {
    const f = fixture(t);
    const { db, sessions, session, exchange } = f;
    exchange("ORIGINAL");
    if (gap === "after portable anchor") sessions.saveCheckpoint(session.id, 2, checkpoint("PORTABLE_BASELINE"), 10);
    exchange("NEWER");
    sessions.saveCheckpoint(session.id, 4, native(), 10);
    const missingSequence = gap === "prefix" ? 1 : gap === "middle" ? 2 : 3;
    db.prepare("DELETE FROM session_events WHERE session_id = ? AND sequence = ?").run(session.id, missingSequence);
    await assertSourceUnavailable(t, f);
  });
}

test("native conversion rejects an imported zero-watermark checkpoint even with newer input", async (t) => {
  const f = fixture(t);
  f.sessions.saveCheckpoint(f.session.id, 0, native(), 10);
  f.exchange("NEW_INPUT_CANNOT_REPLACE_IMPORTED_STATE");
  await assertSourceUnavailable(t, f);
});

test("native conversion rejects a watermark ahead of retained events", async (t) => {
  const f = fixture(t);
  f.exchange("RETAINED_SOURCE");
  f.sessions.saveCheckpoint(f.session.id, 4, native(), 10);
  await assertSourceUnavailable(t, f);
});

test("native conversion cannot use newer semantic events as its old source", async (t) => {
  const f = fixture(t);
  f.sessions.appendEvent(f.session.id, "note", { message: "not semantic source" });
  f.sessions.saveCheckpoint(f.session.id, 1, native(), 10);
  f.exchange("NEWER_INPUT");
  await assertSourceUnavailable(t, f);
});

for (const kind of ["tool_result", "tool_denied"] as const) {
  test(`native conversion rejects a ${kind} whose durable output and error are missing`, async (t) => {
    const f = fixture(t);
    const { sessions, session } = f;
    sessions.appendEvent(session.id, "user", { item: user("INSPECT_SOURCE") });
    sessions.appendEvent(session.id, "response", { response: { ...answer(""), output: [{
      type: "function_call", id: "function", call_id: "inspect", name: "inspect", arguments: "{}",
    }] } });
    assert.ok(sessions.acquireOperationLease(session.id, "test-owner", "test-token", "turn"));
    sessions.beginToolCall(session.id, "inspect", "inspect", {}, "test-token");
    sessions.finishToolCall(session.id, "inspect", kind === "tool_denied" ? "denied" : "completed", null, null);
    assert.ok(sessions.releaseOperationLease(session.id, "test-owner", "test-token"));
    sessions.appendEvent(session.id, kind, { callId: "inspect", name: "inspect" });
    const end = sessions.appendEvent(session.id, "response", { response: answer("FINISHED") });
    sessions.saveCheckpoint(session.id, end.sequence, native(), 10);
    await assertSourceUnavailable(t, f);
    assert.equal(sessions.getToolCall(session.id, "inspect")?.output, null);
  });
}

test("native conversion rejects a result reference with no durable tool row", async (t) => {
  const f = fixture(t);
  f.exchange("RETAINED_SOURCE");
  const result = f.sessions.appendEvent(f.session.id, "tool_result", { callId: "missing", name: "inspect" });
  f.sessions.saveCheckpoint(f.session.id, result.sequence, native(), 10);
  await assertSourceUnavailable(t, f);
});

test("native conversion reuses its portable anchor when original prefix events were pruned", async (t) => {
  const f = fixture(t);
  const { sessions, session, exchange, db } = f;
  exchange("PRUNED_ORIGINAL");
  const anchor = sessions.saveCheckpoint(session.id, 2, checkpoint("PORTABLE_BASELINE"), 10);
  exchange("SOURCE_AFTER_ANCHOR");
  sessions.saveCheckpoint(session.id, 4, native(), 10);
  exchange("LATEST_EXCHANGE");
  db.prepare("DELETE FROM session_events WHERE session_id = ? AND sequence <= ?").run(session.id, anchor.throughSequence);
  const before = sessions.events(session.id);
  const stats = t.mock.method(sessions, "sourceHistoryStats");
  const events = t.mock.method(sessions, "events");
  let requests = 0;
  const result = await f.engine({ async compact(request) {
    requests += 1;
    assert.equal(request.semanticOnly, true);
    assert.match(JSON.stringify(request.input), /PORTABLE_BASELINE.*SOURCE_AFTER_ANCHOR.*LATEST_EXCHANGE/);
    assert.doesNotMatch(JSON.stringify(request.input), /PRUNED_ORIGINAL|OPAQUE_NATIVE/);
    return checkpoint("CONVERTED_SUMMARY");
  } }).compactNow(session.id, { signal: new AbortController().signal });
  assert.deepEqual(result, { degraded: false, inheritedDegradation: false });
  assert.equal(requests, 1);
  assert.deepEqual(stats.mock.calls.map((call) => call.arguments), [[session.id, 2, 4]]);
  assert.ok(events.mock.calls.every((call) => call.arguments[1]! >= anchor.throughSequence));
  assert.equal(sessions.latestCheckpoint(session.id)?.throughSequence, 6);
  assert.deepEqual(sessions.events(session.id), before);
});

test("empty history keeps the no-checkpoint sentinel and never contacts a provider", async (t) => {
  const f = fixture(t);
  const result = await f.engine({ async compact() { assert.fail("empty history must not compact"); } }).compactNow(f.session.id, {
    signal: new AbortController().signal,
  });
  assert.equal(result, undefined);
  assert.equal(f.sessions.latestCheckpoint(f.session.id), null);
  assert.deepEqual(f.sessions.events(f.session.id), []);
});

for (const failure of ["local fallback", "partial fallback", "degraded response"] as const) {
    test(`same-watermark ${failure} preserves a healthy portable checkpoint and continuity`, async (t) => {
      const f = fixture(t);
      const { sessions, session } = f;
      const sequence = f.exchange("PRESERVE_SOURCE");
      const saved = sessions.saveCheckpoint(session.id, sequence, checkpoint("HEALTHY_ANCHOR"), 10);
      // Nonsemantic notes must not make an unchanged semantic watermark look new.
      sessions.appendEvent(session.id, "note", { message: "audit only" });
      sessions.setLastResponseId(session.id, "HEALTHY_CONTINUITY");
      const continuity = sessions.get(session.id)!;
      const before = sessions.events(session.id);
      const save = t.mock.method(sessions, "saveCheckpointAndResetContinuityFenced");
      let requests = 0;
      let updates = 0;
      const statuses: string[] = [];
      const warnings: string[] = [];
      let failureCode: string | undefined;
      await assert.rejects(f.engine({ async compact(request) {
        requests += 1;
        if (failure === "degraded response") return partial();
        if (failure === "partial fallback") request.onPartialCheckpoint?.(partial());
        throw outage();
      } }).compactNow(session.id, { signal: new AbortController().signal, callbacks: {
        onContextCompacted: () => { updates += 1; },
        onStatus: (status) => { statuses.push(status); },
        onWarning: (warning) => { warnings.push(warning); },
      } }), (error: unknown) => {
        failureCode = (error as { code?: string }).code;
        return true;
      });
      assert.equal(requests, 1);
      assert.equal(save.mock.callCount(), 0);
      assert.equal(updates, 0);
      assert.deepEqual(warnings, []);
      assert.ok(!statuses.some((status) => status.startsWith("Context compacted")));
      assert.deepEqual(sessions.latestCheckpoint(session.id), saved);
      assert.deepEqual(f.checkpointIds(), [saved.id]);
      assert.equal(sessions.get(session.id)?.lastResponseId, continuity.lastResponseId);
      assert.equal(sessions.get(session.id)?.promptCacheKey, continuity.promptCacheKey);
      assert.deepEqual(sessions.events(session.id).slice(0, before.length), before);
      assert.equal(sessions.events(session.id).length, before.length + 1);
      assert.doesNotMatch(JSON.stringify(sessions.events(session.id)), /private provider failure/);
      assert.equal(failureCode, "compaction_checkpoint_preserved");
    });
}

test("complete native source permits degraded conversion for a migrated stateless turn", async (t) => {
  const f = fixture(t);
  const { sessions, session } = f;
  const sequence = f.exchange("RETAINED_SOURCE");
  sessions.saveCheckpoint(session.id, sequence, native(), 10);
  sessions.setLastResponseId(session.id, "HEALTHY_CONTINUITY");
  const metrics: TurnMetrics[] = [];
  let streams = 0;
  const result = await f.engine({
    supportsResponseContinuity: () => false,
    async compact() { throw outage(); },
    async stream() { streams += 1; return answer("CONTINUED"); },
  }).turn(session.id, "NEW_REQUEST", {
    signal: new AbortController().signal,
    modelInfo: { id: "test", contextWindow: 272_000, maxOutputTokens: null } as ModelInfo,
    interaction: { approve: async () => "once", ask: async () => "" },
    callbacks: { onTurnComplete: (value) => { metrics.push(value); } },
  });
  assert.equal(result.text, "CONTINUED");
  assert.equal(streams, 1);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]?.compactions, 1);
  assert.equal(metrics[0]?.termination, "completed");
  assert.equal(sessions.latestCheckpoint(session.id)?.throughSequence, sequence);
  assert.equal(sessions.latestCheckpoint(session.id)?.compact.id, "compact_local_recovery");
  assert.match(JSON.stringify(sessions.latestCheckpoint(session.id)?.compact.output), /RETAINED_SOURCE/);
  assert.match(JSON.stringify(sessions.events(session.id)), /NEW_REQUEST/);
});

test("healthy same-watermark manual recompaction still saves a new semantic summary", async (t) => {
  const f = fixture(t);
  const { sessions, session } = f;
  const sequence = f.exchange("ORIGINAL_SOURCE");
  const original = sessions.saveCheckpoint(session.id, sequence, checkpoint("OLD_SUMMARY"), 10);
  sessions.setLastResponseId(session.id, "OLD_CONTINUITY");
  let requests = 0;
  let updates = 0;
  const result = await f.engine({ async compact(request) {
    requests += 1;
    assert.match(JSON.stringify(request.input), /OLD_SUMMARY/);
    return checkpoint("NEW_HEALTHY_SUMMARY");
  } }).compactNow(session.id, { signal: new AbortController().signal,
    callbacks: { onContextCompacted: () => { updates += 1; } } });
  assert.deepEqual(result, { degraded: false, inheritedDegradation: false });
  assert.equal(requests, 1);
  assert.equal(updates, 1);
  assert.equal(sessions.latestCheckpoint(session.id)?.id, original.id);
  assert.equal(sessions.latestCheckpoint(session.id)?.throughSequence, sequence);
  assert.match(JSON.stringify(sessions.latestCheckpoint(session.id)?.compact), /NEW_HEALTHY_SUMMARY/);
  assert.equal(sessions.get(session.id)?.lastResponseId, null);
});

for (const mode of ["local", "partial"] as const) {
  test(`new semantic events allow a degraded ${mode} descendant while preserving the healthy repair anchor`, async (t) => {
    const f = fixture(t);
    const { sessions, session } = f;
    const anchorSequence = f.exchange("ORIGINAL_SOURCE");
    const anchor = sessions.saveCheckpoint(session.id, anchorSequence, checkpoint("HEALTHY_ANCHOR"), 10);
    const newSequence = f.exchange("NEW_SEMANTIC_EVENTS");
    const before = sessions.events(session.id);
    let requests = 0;
    let updates = 0;
    const result = await f.engine({ async compact(request: CompactRequest) {
      requests += 1;
      assert.match(JSON.stringify(request.input), /HEALTHY_ANCHOR.*NEW_SEMANTIC_EVENTS/);
      if (mode === "partial") request.onPartialCheckpoint?.(partial());
      throw outage();
    } }).compactNow(session.id, { signal: new AbortController().signal,
      callbacks: { onContextCompacted: () => { updates += 1; } } });
    assert.deepEqual(result, { degraded: true, inheritedDegradation: false });
    assert.equal(requests, 1);
    assert.equal(updates, 1);
    const descendant = sessions.latestCheckpoint(session.id)!;
    assert.equal(descendant.throughSequence, newSequence);
    assert.equal(compactionQuality(descendant.compact).degraded, true);
    assert.deepEqual(f.checkpointIds(), [anchor.id, descendant.id]);
    assert.deepEqual(sessions.latestCheckpoint(session.id, { throughSequence: anchorSequence }), anchor);
    assert.deepEqual(sessions.events(session.id).slice(0, before.length), before);
    assert.equal(sessions.events(session.id).length, before.length + 1);
  });
}
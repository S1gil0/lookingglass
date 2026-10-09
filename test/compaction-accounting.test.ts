import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { DEFAULT_CONFIG } from "../src/config.js";
import { COMPACTION_REPAIR_MAX_SOURCE_CHARACTERS, compactionQuality } from "../src/engine/compaction.js";
import { contextUsage, type ContextUsage } from "../src/engine/context.js";
import { ConversationEngine } from "../src/engine/engine.js";
import type { CodexLbClient, CompactRequest } from "../src/model/codex-lb.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { openDatabase } from "../src/storage/database.js";
import { SessionStore } from "../src/storage/session-store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { VisualizerEventBus, type VisualizerEvent } from "../src/visualizer/events.js";

const user = (text: string): ResponseInputItem => ({ role: "user", content: [{ type: "input_text", text }] });
const answer = (text: string) => ({ id: "answer", status: "completed",
  output: [{ id: "message", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }] }] });
const checkpoint = (text: string, degraded = false) => ({
  output: [{ type: "message", ...user(text) }], compaction_details: { degraded },
});

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "glass-compaction-accounting-"));
  const db = openDatabase(join(root, "state.db"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.apiKeyEnv = "";
  const sessions = new SessionStore(db);
  const session = sessions.create({ workspace: root, model: "main", agentModel: "leaf",
    reasoningEffort: "none", verbosity: "low", fast: false });
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const exchange = (text: string) => {
    sessions.appendEvent(session.id, "user", { item: user(text) });
    return sessions.appendEvent(session.id, "response", { response: answer("DONE") }).sequence;
  };
  // Hash raw durable rows instead of decoding the entire backlog for assertions.
  const sourceDigest = () => {
    const hash = createHash("sha256");
    for (const table of ["session_events", "tool_calls"] as const) {
      const order = table === "session_events" ? "sequence" : "call_id";
      for (const row of db.prepare(`SELECT * FROM ${table} WHERE session_id = ? ORDER BY ${order}`).iterate(session.id)) {
        hash.update(JSON.stringify(row));
      }
    }
    return hash.digest("hex");
  };
  return { db, sessions, session, exchange, sourceDigest,
    engine: (client: Partial<CodexLbClient>, visualizer?: VisualizerEventBus) => new ConversationEngine(
      config, root, new SessionStore(db), new ArtifactStore(db, join(root, "artifacts")),
      client as CodexLbClient, new ToolRegistry(), "Preserve facts", async () => {}, visualizer,
    ),
  };
}

for (const activeCheckpoint of ["absent", "early"] as const) {
  test(`partial repair with an ${activeCheckpoint} active checkpoint does not decode the oversized tail for accounting`, async (t) => {
    const f = fixture(t);
    const { db, sessions, session } = f;
    f.exchange("ORIGINAL_REQUEST");
    const active = activeCheckpoint === "early"
      ? sessions.saveCheckpoint(session.id, 2, checkpoint("LOSSY_EARLY_CHECKPOINT", true), null) : null;
    const toolIds: string[] = [];
    let storedOutputCharacters = 0;
    let storedErrorCharacters = 0;
    if (activeCheckpoint === "absent") {
      // 12 MB of inline source: the semantic part limit leaves most of it pending.
      for (let index = 0; index < 20; index += 1) f.exchange(`SOURCE_${index} ${"x".repeat(600_000)}`);
    } else {
      // 18 MB out of line: a storage-bounded batch still leaves >8 MiB after it.
      assert.ok(sessions.acquireOperationLease(session.id, "seed", "seed-token", "turn"));
      for (let index = 0; index < 9; index += 1) {
        const callId = `stored_${index}`;
        const failed = index % 2 === 1;
        const text = `${failed ? "ERROR" : "OUTPUT"}_${index} ${"x".repeat(2_000_000)}`;
        toolIds.push(callId);
        if (failed) storedErrorCharacters += text.length;
        else storedOutputCharacters += text.length;
        sessions.appendEvent(session.id, "user", { item: user(`SOURCE_${index}`) });
        sessions.appendEvent(session.id, "response", { response: { ...answer(""), output: [{
          id: callId, type: "function_call", call_id: callId, name: "inspect", arguments: "{}",
        }] } });
        sessions.beginToolCall(session.id, callId, "inspect", {}, "seed-token");
        sessions.finishToolCall(session.id, callId, failed ? "failed" : "completed",
          failed ? null : text, failed ? text : null);
        sessions.appendEvent(session.id, "tool_result", { name: "inspect", callId });
        sessions.appendEvent(session.id, "response", { response: answer("DONE") });
      }
      sessions.releaseOperationLease(session.id, "seed", "seed-token");
    }
    f.exchange("RECENT_REQUEST_MUST_REMAIN");
    sessions.setLastResponseId(session.id, "BEFORE_REPAIR_CONTINUITY");
    const before = sessions.get(session.id)!;
    const sourceBefore = f.sourceDigest();
    const end = sessions.latestSequence(session.id);
    const originalStats = sessions.sourceHistoryStats(session.id, 0, end);
    assert.equal(originalStats.events, end);
    assert.equal(originalStats.missingToolOutputs, 0);
    assert.ok(originalStats.characters > COMPACTION_REPAIR_MAX_SOURCE_CHARACTERS);
    if (toolIds.length > 0) {
      const { characters } = db.prepare(`
        SELECT SUM(length(payload_json)) AS characters FROM session_events WHERE session_id = ?
      `).get(session.id) as { characters: number };
      assert.ok(characters < 20_000, "event JSON alone must not trigger the large-context fast path");
      assert.ok(storedErrorCharacters > 0 && storedOutputCharacters > 0);
      assert.equal(originalStats.characters, characters + storedErrorCharacters + storedOutputCharacters,
        "aggregate sizing includes both output_text and fallback error_text");
    }

    const events = t.mock.method(SessionStore.prototype, "events");
    const outputs = t.mock.method(SessionStore.prototype, "toolCallOutputs");
    const readCounts = () => [events.mock.callCount(), outputs.mock.callCount()];
    const visualizer = activeCheckpoint === "early" ? new VisualizerEventBus() : undefined;
    const visualizerEvents: VisualizerEvent[] = [];
    visualizer?.subscribe(event => visualizerEvents.push(event));
    let requests = 0;
    let batchCharacters = 0;
    let readsAtProvider: number[] = [];
    let readsBeforeRefresh: number[] = [];
    let readsAfterRefresh: number[] = [];
    const refreshes: ContextUsage[] = [];
    const statuses: string[] = [];
    const result = await f.engine({ async compact(request: CompactRequest) {
      requests += 1;
      readsAtProvider = readCounts();
      assert.equal(request.model, "leaf");
      assert.equal(request.semanticOnly, true);
      const batch = JSON.stringify(request.input);
      batchCharacters = batch.length;
      assert.match(batch, /ORIGINAL_REQUEST/);
      assert.doesNotMatch(batch, /LOSSY_EARLY_CHECKPOINT|RECENT_REQUEST_MUST_REMAIN/);
      const calls = request.input.filter(item => item.type === "function_call").map(item => item.call_id);
      const results = request.input.filter(item => item.type === "function_call_output").map(item => item.call_id);
      assert.deepEqual(results, calls, "the repair batch preserves complete tool exchanges");
      if (toolIds.length > 0) assert.deepEqual(results, toolIds.slice(0, 4));
      return checkpoint("REPAIRED_PREFIX");
    } }, visualizer).compactNow(session.id, { repair: true, signal: new AbortController().signal, callbacks: {
      onStatus: status => statuses.push(status),
      onContextCompacted() {
        readsBeforeRefresh = readCounts();
        refreshes.push(contextUsage(sessions, session.id));
        readsAfterRefresh = readCounts();
      },
    } });

    assert.equal(requests, 1);
    assert.equal(result?.repairPending, true);
    assert.equal(result.degraded, false);
    const reloaded = new SessionStore(db);
    const saved = reloaded.latestCheckpoint(session.id)!;
    assert.ok(saved.throughSequence > (active?.throughSequence ?? 0) && saved.throughSequence < end,
      "successful partial repair durably advances the active checkpoint");
    assert.equal(compactionQuality(saved.compact).degraded, false);
    assert.deepEqual(saved.compact.output, checkpoint("REPAIRED_PREFIX").output);
    const details = saved.compact.compaction_details as Record<string, unknown>;
    assert.equal(details.source_repair, true);
    assert.equal(details.source_repair_pending, true);
    assert.equal(details.source_checkpoint_sequence, 0);
    assert.equal(details.source_sequence, saved.throughSequence);
    assert.equal(details.source_repair_target_sequence, end);
    assert.equal(reloaded.get(session.id)?.lastResponseId, null, "advancing the active checkpoint resets continuity");
    assert.equal(reloaded.get(session.id)?.promptCacheKey, before.promptCacheKey);
    assert.equal(reloaded.latestSequence(session.id), end);
    assert.equal(f.sourceDigest(), sourceBefore, "repair and usage accounting preserve every source event and tool row");
    assert.deepEqual(reloaded.sourceHistoryStats(session.id, 0, end), originalStats);
    assert.match(statuses.at(-1)!, /Repair progress saved.*\/compact repair/);

    const remaining = reloaded.sourceHistoryStats(session.id, saved.throughSequence, end);
    assert.ok(remaining.characters > COMPACTION_REPAIR_MAX_SOURCE_CHARACTERS,
      "fixture must leave an oversized backlog after the saved prefix");
    const expectedTokens = Math.ceil((JSON.stringify(saved.compact.output).length + remaining.characters) / 4);
    const afterReturn = contextUsage(reloaded, session.id);

    assert.deepEqual(readsAtProvider, [1, 1]);
    const sourceRead = events.mock.calls[0]!;
    assert.equal(sourceRead.arguments[1], 0);
    const through = sourceRead.arguments[2];
    assert.ok(through !== undefined && through < end);
    assert.ok(sessions.sourceHistoryStats(session.id, 0, through).characters + JSON.stringify([]).length
      <= COMPACTION_REPAIR_MAX_SOURCE_CHARACTERS, "preflight bounds source materialization before decode");
    assert.ok(batchCharacters <= COMPACTION_REPAIR_MAX_SOURCE_CHARACTERS);
    assert.deepEqual(readsBeforeRefresh, readsAtProvider,
      "saving a repair batch must not trigger a full-tail replay, even with the visualizer enabled");
    assert.deepEqual(readsAfterRefresh, readsAtProvider, "the TUI refresh must use aggregate accounting, not replay");
    assert.deepEqual(readCounts(), readsAtProvider, "usage after reload must not decode the oversized tail either");
    assert.deepEqual(refreshes, [{ inputTokens: expectedTokens, estimated: true }]);
    assert.deepEqual(afterReturn, refreshes[0]);
    assert.ok(expectedTokens > Math.ceil(batchCharacters / 4), "usage describes the backlog, not just the summarized batch");
    if (visualizer) {
      const completed = visualizerEvents.filter(event => event.type === "context.compact" && event.status === "complete");
      assert.equal(completed.length, 1);
      assert.equal(completed[0]!.contextTokens, expectedTokens);
      assert.equal(completed[0]!.summary, "repair progress saved");
    }
  });
}
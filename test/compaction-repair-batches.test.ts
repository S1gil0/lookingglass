import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { DEFAULT_CONFIG } from "../src/config.js";
import { COMPACTION_REPAIR_MAX_SOURCE_CHARACTERS, compactionQuality } from "../src/engine/compaction.js";
import { projectContext } from "../src/engine/context.js";
import { ConversationEngine } from "../src/engine/engine.js";
import { CodexLbClient, type CompactRequest } from "../src/model/codex-lb.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { openDatabase } from "../src/storage/database.js";
import { SessionStore } from "../src/storage/session-store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ModelInfo } from "../src/types.js";

const user = (text: string): ResponseInputItem => ({ role: "user", content: [{ type: "input_text", text }] });
const answer = (text: string) => ({ id: "answer", status: "completed",
  output: [{ id: "message", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }] }] });
const checkpoint = (text: string, degraded = false) => ({
  output: [{ type: "message", ...user(text) }], compaction_details: { degraded },
});
const repairOptions = () => ({ repair: true, signal: new AbortController().signal });

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "glass-repair-batches-"));
  const db = openDatabase(join(root, "state.db"));
  const config = structuredClone(DEFAULT_CONFIG);
  const sessions = new SessionStore(db);
  const session = sessions.create({ workspace: root, model: "main", agentModel: "leaf",
    reasoningEffort: "none", verbosity: "low", fast: false });
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const exchange = (text: string) => {
    sessions.appendEvent(session.id, "user", { item: user(text) });
    return sessions.appendEvent(session.id, "response", { response: answer("DONE") }).sequence;
  };
  const seed = (exchanges = 36, characters = 80_000) => {
    const base = exchange("COVERED_ORIGINAL");
    sessions.saveCheckpoint(session.id, base, checkpoint("HEALTHY_BASELINE"), null);
    for (let index = 0; index < exchanges; index += 1) exchange(`SOURCE_${index}_END ${"x".repeat(characters)}`);
    const active = sessions.saveCheckpoint(session.id, sessions.latestSequence(session.id), checkpoint("LOSSY_ACTIVE", true), null);
    exchange("RECENT_REQUEST");
    sessions.setLastResponseId(session.id, "ACTIVE_CONTINUITY");
    return active;
  };
  return { db, config, sessions, session, exchange, seed,
    engine: (client: Partial<CodexLbClient>, model?: ModelInfo) => new ConversationEngine(
      config, root, new SessionStore(db), new ArtifactStore(db, join(root, "artifacts")),
      client as CodexLbClient, new ToolRegistry(), "Preserve facts", async () => {},
      undefined, undefined, undefined, model ? async () => model : undefined,
    ),
    healthy: () => sessions.latestCheckpoint(session.id, { portableOnly: true,
      accept: compact => !compactionQuality(compact).degraded }),
    checkpointCount: () => (db.prepare("SELECT COUNT(*) AS n FROM context_checkpoints WHERE session_id = ?")
      .get(session.id) as { n: number }).n,
  };
}

test("oversized repair resumes bounded source batches across reloads without replacing the active checkpoint early", async (t) => {
  const f = fixture(t);
  const { sessions, session } = f;
  const active = f.seed();
  const events = sessions.events(session.id);
  const continuity = sessions.get(session.id)!;
  const client = new CodexLbClient(f.config);
  t.after(() => client.close());
  let requests = 0;
  let batches = 0;
  const sources: string[] = [];
  const statuses: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    requests += 1;
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "leaf");
    return Response.json(answer("REPAIRED_PREFIX"));
  });
  const compact = { async compact(request: CompactRequest) {
    batches += 1;
    sources.push(JSON.stringify(request.input));
    assert.equal(request.semanticOnly, true);
    return client.compact(request);
  } };
  let previousSequence = f.healthy()!.throughSequence;
  let completed = false;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    requests = 0;
    let activeUpdates = 0;
    const result = await f.engine(compact).compactNow(session.id, { ...repairOptions(), callbacks: {
      onStatus: status => statuses.push(status), onContextCompacted: () => { activeUpdates += 1; },
    } });
    assert.ok(requests > 0 && requests <= 32);
    assert.equal(result?.degraded, false);
    const anchor = f.healthy()!;
    assert.ok(anchor.throughSequence > previousSequence, "every successful batch must durably advance the anchor");
    previousSequence = anchor.throughSequence;
    if (result?.repairPending) {
      assert.deepEqual(sessions.latestCheckpoint(session.id), active);
      assert.equal(sessions.get(session.id)?.lastResponseId, continuity.lastResponseId);
      assert.equal(sessions.get(session.id)?.promptCacheKey, continuity.promptCacheKey);
      assert.equal(activeUpdates, 0);
      assert.equal(f.checkpointCount(), 2);
      assert.match(statuses.at(-1)!, /Repair progress saved.*\/compact repair/);
    } else {
      assert.equal(activeUpdates, 1);
      assert.equal(f.checkpointCount(), 1);
      assert.equal(sessions.get(session.id)?.lastResponseId, null);
      completed = true;
      break;
    }
  }
  assert.ok(completed && batches > 1);
  assert.doesNotMatch(sources.join("\n"), /LOSSY_ACTIVE|COVERED_ORIGINAL/);
  for (let index = 0; index < 36; index += 1) {
    assert.equal(sources.join("\n").split(`SOURCE_${index}_END`).length - 1, 1, "covered source is not replayed again");
  }
  assert.match(JSON.stringify(projectContext(sessions, session.id).input), /REPAIRED_PREFIX.*RECENT_REQUEST/);
  assert.deepEqual(sessions.events(session.id), events);
});

test("repair adapts the source batch to a smaller leaf context before sending any parts", async (t) => {
  const f = fixture(t);
  const active = f.seed(14, 20_000);
  const client = new CodexLbClient(f.config);
  t.after(() => client.close());
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "leaf");
    assert.equal(body.max_output_tokens, 256);
    assert.ok(JSON.stringify(body).length < 8_192);
    calls += 1;
    return Response.json(answer("SMALL_LEAF_PREFIX"));
  });
  const result = await f.engine(client, { id: "leaf", contextWindow: 4_096, maxOutputTokens: 256 } as ModelInfo)
    .compactNow(f.session.id, repairOptions());
  assert.equal(result?.repairPending, true);
  assert.ok(calls > 0 && calls <= 32);
  assert.ok(f.healthy()!.throughSequence > 2);
  assert.deepEqual(f.sessions.latestCheckpoint(f.session.id), active);
});

test("repair bounds stored replay before decoding a backlog larger than the storage preflight limit", async (t) => {
  const f = fixture(t);
  const { sessions, session } = f;
  f.exchange("COVERED_ORIGINAL");
  sessions.saveCheckpoint(session.id, 2, checkpoint("HEALTHY_BASELINE"), null);
  assert.ok(sessions.acquireOperationLease(session.id, "owner", "token", "turn"));
  for (let index = 0; index < 5; index += 1) {
    const callId = `stored_${index}`;
    sessions.appendEvent(session.id, "response", { response: { ...answer(""), output: [{
      id: callId, type: "function_call", call_id: callId, name: "inspect", arguments: "{}",
    }] } });
    sessions.beginToolCall(session.id, callId, "inspect", {}, "token");
    sessions.finishToolCall(session.id, callId, "completed", `RESULT_${index} ${"x".repeat(2_000_000)}`, null);
    sessions.appendEvent(session.id, "tool_result", { name: "inspect", callId });
    sessions.appendEvent(session.id, "response", { response: answer("DONE") });
  }
  sessions.releaseOperationLease(session.id, "owner", "token");
  const active = sessions.saveCheckpoint(session.id, sessions.latestSequence(session.id), checkpoint("LOSSY", true), null);
  f.exchange("RECENT_REQUEST");
  sessions.setLastResponseId(session.id, "ACTIVE_CONTINUITY");
  const end = sessions.latestSequence(session.id);
  assert.ok(sessions.sourceHistoryStats(session.id, 2, end).characters > COMPACTION_REPAIR_MAX_SOURCE_CHARACTERS);
  const events = t.mock.method(SessionStore.prototype, "events");
  const seen: string[] = [];
  let calls = 0;
  const compact = { async compact(request: CompactRequest) {
    calls += 1;
    const outputs = request.input.filter(item => item.type === "function_call_output");
    const toolCalls = request.input.filter(item => item.type === "function_call");
    assert.equal(toolCalls.length, outputs.length);
    seen.push(...outputs.map(item => item.call_id));
    return checkpoint("REPAIRED_RESULTS");
  } };
  const result = await f.engine(compact).compactNow(session.id, repairOptions());
  assert.equal(result?.repairPending, true);
  assert.deepEqual(sessions.latestCheckpoint(session.id), active);
  assert.equal(sessions.get(session.id)?.lastResponseId, "ACTIVE_CONTINUITY");
  const sourceReads = events.mock.calls.filter(call => call.arguments[1] === 2);
  assert.equal(sourceReads.length, 1);
  assert.ok(sourceReads[0]!.arguments[2]! < end);
  assert.ok(sessions.sourceHistoryStats(session.id, 2, sourceReads[0]!.arguments[2]!).characters
    <= COMPACTION_REPAIR_MAX_SOURCE_CHARACTERS);
  assert.deepEqual(seen, ["stored_0", "stored_1", "stored_2", "stored_3"]);
  const final = await f.engine(compact).compactNow(session.id, repairOptions());
  assert.equal(final?.repairPending, undefined);
  assert.equal(calls, 2);
  assert.deepEqual(seen, ["stored_0", "stored_1", "stored_2", "stored_3", "stored_4"]);
  assert.equal(f.checkpointCount(), 1);
  assert.equal(sessions.latestSequence(session.id), end);
});

test("bounded repair never splits parallel tool calls from their results", (t) => {
  const f = fixture(t);
  const { sessions, session } = f;
  f.exchange("COMPLETE_EXCHANGE");
  sessions.appendEvent(session.id, "user", { item: user("TOOL_REQUEST") });
  sessions.appendEvent(session.id, "response", { response: { ...answer(""), output: ["a", "b"].map(callId => ({
    id: callId, type: "function_call", call_id: callId, name: "inspect", arguments: "{}",
  })) } });
  for (const callId of ["a", "b"]) sessions.appendEvent(session.id, "tool_result", {
    callId, name: "inspect", output: `RESULT_${callId}`,
  });
  const context = projectContext(sessions, session.id, { checkpoint: null, retainRecentCharacters: 1,
    repairBatch: { hasMoreSource: false, fits: input => !JSON.stringify(input).includes("RESULT_b") } });
  assert.equal(context.repairPending, true);
  assert.equal(context.latestSequence, 2);
  assert.match(JSON.stringify(context.input), /COMPLETE_EXCHANGE/);
  assert.doesNotMatch(JSON.stringify(context.input), /TOOL_REQUEST|function_call|RESULT_/);
});

test("repair anchor persistence is fenced, monotonic and leaves active continuity untouched", (t) => {
  const f = fixture(t);
  const { sessions, session } = f;
  f.exchange("OLD");
  sessions.saveCheckpoint(session.id, 2, checkpoint("BASELINE"), null);
  f.exchange("PREFIX");
  f.exchange("LATER");
  const active = sessions.saveCheckpoint(session.id, 6, checkpoint("ACTIVE", true), null);
  sessions.setLastResponseId(session.id, "CONTINUITY");
  const before = sessions.get(session.id);
  assert.equal(sessions.saveRepairAnchorFenced(session.id, "missing", 4, checkpoint("REPAIRED"), null), null);
  assert.equal(f.checkpointCount(), 2);
  assert.ok(sessions.acquireOperationLease(session.id, "owner", "token", "compact"));
  assert.equal(sessions.saveRepairAnchorFenced(session.id, "stale", 4, checkpoint("REPAIRED"), null), null);
  assert.throws(() => sessions.saveRepairAnchorFenced(session.id, "token", 4, checkpoint("LOSSY", true), null));
  const saved = sessions.saveRepairAnchorFenced(session.id, "token", 4, checkpoint("REPAIRED"), null);
  assert.ok(saved);
  assert.equal(f.healthy()?.id, saved.id);
  assert.deepEqual(sessions.latestCheckpoint(session.id), active);
  assert.deepEqual(sessions.get(session.id), before);
  assert.equal(f.checkpointCount(), 2);
  assert.throws(() => sessions.saveRepairAnchorFenced(session.id, "token", 2, checkpoint("STALE"), null));
  assert.throws(() => sessions.saveRepairAnchorFenced(session.id, "token", 6, checkpoint("REPLACE_ACTIVE"), null));
  assert.deepEqual(f.healthy(), saved);
  sessions.releaseOperationLease(session.id, "owner", "token");
});

for (const failure of ["degraded", "cancelled", "deadline", "lease", "auth"] as const) {
  test(`a ${failure} repair batch cannot advance or erase previous progress`, async (t) => {
    const f = fixture(t);
    const active = f.seed(28);
    const progress = await f.engine({ async compact() { return checkpoint("PREVIOUS_REPAIR_PROGRESS"); } })
      .compactNow(f.session.id, repairOptions());
    assert.equal(progress?.repairPending, true);
    const anchor = f.healthy();
    assert.ok(anchor!.throughSequence > 2);
    const before = f.sessions.get(f.session.id)!;
    const controller = new AbortController();
    if (failure === "deadline") {
      f.config.automation.providerRetryMaxElapsedMs = 100;
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    }
    let requests = 0;
    await assert.rejects(f.engine({ async compact(request) {
      requests += 1;
      request.onPartialCheckpoint?.(checkpoint("PARTIAL"));
      if (failure === "cancelled") controller.abort(new Error("cancelled"));
      if (failure === "deadline") t.mock.timers.tick(100);
      if (failure === "lease") f.db.prepare("DELETE FROM session_operation_leases WHERE session_id = ?").run(f.session.id);
      if (failure === "auth") throw Object.assign(new Error("private authorization error"), { status: 401 });
      return checkpoint("MUST_NOT_SAVE", failure === "degraded");
    } }).compactNow(f.session.id, { repair: true, signal: controller.signal, automated: failure === "deadline" }));
    assert.equal(requests, 1);
    assert.deepEqual(f.healthy(), anchor);
    assert.deepEqual(f.sessions.latestCheckpoint(f.session.id), active);
    assert.equal(f.sessions.get(f.session.id)?.lastResponseId, before.lastResponseId);
    assert.equal(f.sessions.get(f.session.id)?.promptCacheKey, before.promptCacheKey);
    assert.equal(f.checkpointCount(), 2);
  });
}

test("ordinary compaction and provider migration retain the advanced repair anchor", async (t) => {
  const f = fixture(t);
  f.seed(16);
  const result = await f.engine({ async compact() { return checkpoint("REPAIRED_PREFIX"); } })
    .compactNow(f.session.id, repairOptions());
  assert.equal(result?.repairPending, true);
  const anchor = f.healthy();
  assert.ok(anchor!.throughSequence > 2);
  await f.engine({ async compact(request) {
    assert.match(JSON.stringify(request.input), /LOSSY_ACTIVE/);
    return checkpoint("ORDINARY_SUMMARY");
  } }).compactNow(f.session.id, { signal: new AbortController().signal });
  assert.deepEqual(f.healthy(), anchor);
  assert.equal(compactionQuality(f.sessions.latestCheckpoint(f.session.id)!.compact).inheritedDegradation, true);
  f.sessions.updateSettings(f.session.id, { provider: "openrouter" });
  assert.deepEqual(f.healthy(), anchor);
  assert.equal(f.checkpointCount(), 2);
});
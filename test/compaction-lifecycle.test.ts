import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Response, ResponseInputItem } from "openai/resources/responses/responses";
import { DEFAULT_CONFIG } from "../src/config.js";
import { COMPACTION_MAX_ELAPSED_MS } from "../src/engine/compaction.js";
import { ConversationEngine } from "../src/engine/engine.js";
import type { CodexLbClient, CompactRequest } from "../src/model/codex-lb.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { openDatabase } from "../src/storage/database.js";
import { SessionStore } from "../src/storage/session-store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { GatewayProvider, ModelInfo } from "../src/types.js";

const user = (text: string): ResponseInputItem => ({ role: "user", content: [{ type: "input_text", text }] });
const checkpoint = (text: string) => ({ output: [{ type: "message", ...user(text) }] });
const partial = () => ({ ...checkpoint("PARTIAL_SUMMARY"), compaction_details: { total_parts: 2, local_parts: 1 } });
const answer = (inputTokens = 10): Response => ({
  id: "answer", status: "completed", output_text: "DONE",
  output: [{ id: "message", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "DONE", annotations: [] }] }],
  usage: { input_tokens: inputTokens, output_tokens: 2, total_tokens: inputTokens + 2 },
} as unknown as Response);
const modelInfo = { id: "test", contextWindow: 272_000, maxOutputTokens: null } as ModelInfo;
const turnOptions = () => ({ signal: new AbortController().signal, modelInfo,
  interaction: { approve: async () => "once" as const, ask: async () => "" } });
const overflow = () => Object.assign(new Error("context overflow"), { code: "context_length_exceeded" });

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "glass-compaction-lifecycle-"));
  const db = openDatabase(join(root, "state.db"));
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const sessions = new SessionStore(db);
  const session = sessions.create({ workspace: root, model: "test", reasoningEffort: "none", verbosity: "low", fast: false });
  const config = structuredClone(DEFAULT_CONFIG);
  const artifacts = new ArtifactStore(db, join(root, "artifacts"));
  const engine = (client: Partial<CodexLbClient>,
    modelFor?: (id: string, provider: GatewayProvider, signal: AbortSignal) => Promise<ModelInfo>) => new ConversationEngine(
    config, root, sessions, artifacts, client as CodexLbClient, new ToolRegistry(), "safety instructions",
    async () => undefined, undefined, undefined, undefined, modelFor,
  );
  const seed = () => {
    sessions.appendEvent(session.id, "user", { item: user("PRESERVE_SOURCE") });
    sessions.appendEvent(session.id, "response", { response: answer() });
    sessions.saveCheckpoint(session.id, 2, checkpoint("PREVIOUS_CHECKPOINT"), 10);
    sessions.setLastResponseId(session.id, "PREVIOUS_ANCHOR");
    return sessions.latestCheckpoint(session.id);
  };
  return { sessions, session, config, engine, seed };
}

test("metadata resolution that cancels the caller never dispatches compaction", async (t) => {
  const { sessions, session, engine, seed } = fixture(t);
  const saved = seed();
  const controller = new AbortController();
  const reason = new Error("cancelled during metadata resolution");
  let calls = 0;
  await assert.rejects(engine({ async compact() { calls += 1; return checkpoint("UNEXPECTED"); } }, async () => {
    controller.abort(reason);
    return modelInfo;
  }).compactNow(session.id, { signal: controller.signal }), (error) => error === reason);
  assert.equal(calls, 0);
  assert.deepEqual(sessions.latestCheckpoint(session.id), saved);
  assert.equal(sessions.get(session.id)?.lastResponseId, "PREVIOUS_ANCHOR");
});

for (const expiry of ["signal", "clock"] as const) {
  test(`metadata resolution past its own ${expiry} deadline skips dispatch but permits local recovery`, async (t) => {
    const { sessions, session, config, engine, seed } = fixture(t);
    seed();
    sessions.appendEvent(session.id, "user", { item: user("NEW_SOURCE") });
    config.automation.providerRetryMaxElapsedMs = 100;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    let calls = 0;
    const result = await engine({ async compact() { calls += 1; return checkpoint("UNEXPECTED"); } }, async () => {
      if (expiry === "signal") t.mock.timers.tick(100);
      else now += 100;
      return modelInfo;
    }).compactNow(session.id, { signal: new AbortController().signal, automated: true });
    assert.equal(calls, 0);
    assert.equal(result?.degraded, true);
    assert.equal(sessions.latestCheckpoint(session.id)?.compact.id, "compact_local_recovery");
  });
}

test("overflow recovery inherits the enclosing deadline and ignores late adapter output", async (t) => {
  const { sessions, session, config, engine, seed } = fixture(t);
  const saved = seed();
  const continuity = sessions.get(session.id)!;
  config.automation.providerRetryMaxAttempts = 2;
  config.automation.providerRetryMaxElapsedMs = 100;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let resolveLate!: (value: Record<string, unknown>) => void;
  let request!: CompactRequest;
  let streams = 0;
  const pending = engine({
    async stream() { streams += 1; t.mock.timers.tick(60); throw overflow(); },
    compact(input) {
      request = input;
      request.onPartialCheckpoint?.(partial());
      started();
      return new Promise((resolve) => { resolveLate = resolve; });
    },
  }).turn(session.id, "continue", { ...turnOptions(), automated: true });
  const rejected = assert.rejects(pending, { code: "automated_provider_retry_exhausted" });
  await ready;
  t.mock.timers.tick(39);
  assert.equal(request.signal?.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(request.signal?.aborted, true);
  assert.equal(streams, 1);
  assert.deepEqual(sessions.latestCheckpoint(session.id), saved);
  assert.equal(sessions.get(session.id)?.lastResponseId, continuity.lastResponseId);
  assert.equal(sessions.get(session.id)?.promptCacheKey, continuity.promptCacheKey);
  request.onPartialCheckpoint?.(partial());
  resolveLate(checkpoint("LATE_SUMMARY"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(sessions.latestCheckpoint(session.id), saved);
});

test("overflow recovery checks the enclosing absolute deadline before checkpoint commit", async (t) => {
  const { sessions, session, config, engine, seed } = fixture(t);
  const saved = seed();
  config.automation.providerRetryMaxAttempts = 2;
  config.automation.providerRetryMaxElapsedMs = 100;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let compactions = 0;
  await assert.rejects(engine({
    async stream() { now += 60; throw overflow(); },
    async compact(request) {
      compactions += 1;
      now += 40;
      assert.equal(request.signal?.aborted, false);
      return checkpoint("EXPIRED_SUMMARY");
    },
  }).turn(session.id, "continue", { ...turnOptions(), automated: true }), { code: "automated_provider_retry_exhausted" });
  assert.equal(compactions, 1);
  assert.deepEqual(sessions.latestCheckpoint(session.id), saved);
  assert.equal(sessions.get(session.id)?.lastResponseId, "PREVIOUS_ANCHOR");
});

for (const code of ["context_length_exceeded", "bridge_previous_response_not_found"]) {
  test(`exhausted attempt count forbids ${code} recovery side effects`, async (t) => {
    const { sessions, session, config, engine, seed } = fixture(t);
    const saved = seed();
    const continuity = sessions.get(session.id)!;
    config.automation.providerRetryMaxAttempts = 1;
    let compactions = 0;
    const statuses: string[] = [];
    await assert.rejects(engine({
      async stream() { throw Object.assign(new Error(code), { code }); },
      async compact() { compactions += 1; return checkpoint("UNEXPECTED"); },
    }).turn(session.id, "continue", { ...turnOptions(), automated: true,
      callbacks: { onStatus: (status) => { statuses.push(status); } },
    }), { code: "automated_provider_retry_exhausted" });
    assert.equal(compactions, 0);
    assert.ok(!statuses.some((status) => status.startsWith("Recovering")));
    assert.deepEqual(sessions.latestCheckpoint(session.id), saved);
    assert.equal(sessions.get(session.id)?.lastResponseId, continuity.lastResponseId);
    assert.equal(sessions.get(session.id)?.promptCacheKey, continuity.promptCacheKey);
  });
}

for (const contextWindow of [4_096, 8_192, 16_384]) {
  for (const maxOutputTokens of [null, 256, contextWindow]) {
    test(`a tiny stateless turn in a ${contextWindow} window with output limit ${maxOutputTokens} does not compact`, async (t) => {
      const { sessions, session, engine } = fixture(t);
      let compactions = 0;
      let streams = 0;
      const result = await engine({
        supportsResponseContinuity: () => false,
        async stream() { streams += 1; return answer(); },
        async compact() { compactions += 1; return checkpoint("UNEXPECTED"); },
      }).turn(session.id, "hello", { ...turnOptions(), modelInfo: { ...modelInfo, contextWindow, maxOutputTokens } });
      assert.equal(result.text, "DONE");
      assert.equal(result.compacted, false);
      assert.equal(streams, 1);
      assert.equal(compactions, 0);
      assert.equal(sessions.latestCheckpoint(session.id), null);
    });
  }
}

test("a throwing deferred-compaction warning observer cannot reject the answer or suppress its event", async (t) => {
  const { sessions, session, engine } = fixture(t);
  let warnings = 0;
  const result = await engine({
    async stream() { return answer(250_000); },
    async compact() { throw Object.assign(new Error("bad request"), { code: "invalid_request_error", status: 400 }); },
  }).turn(session.id, "finish", { ...turnOptions(), callbacks: { onWarning(message) {
    warnings += 1;
    assert.match(message, /Context compaction deferred/);
    throw new Error("observer failed");
  } } });
  assert.equal(result.text, "DONE");
  assert.equal(result.compacted, false);
  assert.equal(warnings, 1);
  assert.equal(sessions.events(session.id).filter((event) => event.kind === "error"
    && (event.payload as { code?: string }).code === "compaction_deferred").length, 1);
  assert.equal(sessions.latestCheckpoint(session.id), null);
});

for (const failure of [
  { code: "invalid_request_error", kind: "invalid_request", status: 400 },
  { code: "invalid_api_key", kind: "auth", status: 401 },
]) {
  test(`a latched ${failure.status} part failure vetoes partial fallback when another adapter hangs`, async (t) => {
    const { sessions, session, engine, seed } = fixture(t);
    const saved = seed();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let request!: CompactRequest;
    let resolveLate!: (value: Record<string, unknown>) => void;
    let updates = 0;
    const pending = engine({ compact(input) {
      request = input;
      request.onPartialCheckpoint?.(partial());
      request.onFailure?.({ ...failure, stage: "semantic", part: 2, attempt: 1 });
      return new Promise((resolve) => { resolveLate = resolve; });
    } }).compactNow(session.id, { signal: new AbortController().signal,
      callbacks: { onContextCompacted: () => { updates += 1; } } });
    const rejected = assert.rejects(pending, failure);
    t.mock.timers.tick(COMPACTION_MAX_ELAPSED_MS);
    await rejected;
    assert.equal(request.signal?.aborted, true);
    assert.equal(updates, 0);
    assert.deepEqual(sessions.latestCheckpoint(session.id), saved);
    assert.equal(sessions.get(session.id)?.lastResponseId, "PREVIOUS_ANCHOR");
    assert.ok(!sessions.events(session.id).some((event) => (event.payload as { code?: string }).code === "compaction_degraded"));
    resolveLate(checkpoint("LATE_SUMMARY"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sessions.latestCheckpoint(session.id), saved);
  });
}

test("a recoverable part failure still permits partial recovery at compaction's own deadline", async (t) => {
  const { sessions, session, engine, seed } = fixture(t);
  seed();
  sessions.appendEvent(session.id, "user", { item: user("NEW_SOURCE") });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = engine({ compact(request) {
    request.onPartialCheckpoint?.(partial());
    request.onFailure?.({ stage: "semantic", code: "empty_response", kind: "protocol", part: 2, attempt: 1 });
    return new Promise(() => undefined);
  } }).compactNow(session.id, { signal: new AbortController().signal });
  t.mock.timers.tick(COMPACTION_MAX_ELAPSED_MS);
  assert.equal((await pending)?.degraded, true);
  assert.deepEqual(sessions.latestCheckpoint(session.id)?.compact.output, partial().output);
});
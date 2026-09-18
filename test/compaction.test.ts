import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Response, ResponseInputItem } from "openai/resources/responses/responses";
import { DEFAULT_CONFIG } from "../src/config.js";
import { COMPACTION_MAX_ELAPSED_MS, COMPACTION_REPAIR_MAX_SOURCE_CHARACTERS, compactionQuality, localRecoveryCheckpoint } from "../src/engine/compaction.js";
import { contextUsage, projectContext, type ContextUsage } from "../src/engine/context.js";
import { ConversationEngine } from "../src/engine/engine.js";
import { providerError } from "../src/errors.js";
import { compactionFailure, CompactionDiagnostics } from "../src/model/compaction-diagnostics.js";
import { CodexLbClient, isRecoverableCompactionError, type CompactRequest, type ResponseRequest } from "../src/model/codex-lb.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { openDatabase } from "../src/storage/database.js";
import { isPortableCheckpoint, SessionStore } from "../src/storage/session-store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { GatewayProvider, ModelInfo } from "../src/types.js";

const user = (text: string): ResponseInputItem => ({ role: "user", content: [{ type: "input_text", text }] });
const checkpoint = (text: string) => ({ output: [{ type: "message", ...user(text) }] });
const answer = (id: string, text: string): Response => ({
  id, status: "completed", output_text: text,
  output: [{ id: `msg_${id}`, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }] }],
  usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
} as unknown as Response);
const call = (id: string): ResponseInputItem => ({
  type: "function_call", id: `fc_${id}`, call_id: id, name: "inspect", arguments: "{}",
});
const result = (id: string, text: string): ResponseInputItem => ({ type: "function_call_output", call_id: id, output: text });
const modelInfo = { contextWindow: 272_000, maxOutputTokens: null } as ModelInfo;

function diagnosticsOf(compact: Record<string, unknown> | undefined) {
  return (compact?.compaction_details as { diagnostics: {
    attempts: number; failure_count: number; failures: Array<{ stage: string; code?: string; status?: number; part?: number; attempt?: number }>;
  } }).diagnostics;
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "glass-compaction-"));
  const db = openDatabase(join(root, "state.db"));
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const sessions = new SessionStore(db);
  const session = sessions.create({ workspace: root, model: "test", reasoningEffort: "none", verbosity: "low", fast: false });
  const config = structuredClone(DEFAULT_CONFIG);
  const artifacts = new ArtifactStore(db, join(root, "artifacts"));
  const delays: number[] = [];
  const engine = (client: Partial<CodexLbClient> | ((provider: GatewayProvider) => CodexLbClient), registry = new ToolRegistry(),
    modelFor?: (id: string, provider: GatewayProvider, signal: AbortSignal) => Promise<ModelInfo>) => new ConversationEngine(
    config, root, sessions, artifacts, client as CodexLbClient, registry, "safety instructions",
    async (milliseconds) => { delays.push(milliseconds); },
    undefined, undefined, undefined, modelFor,
  );
  const seed = () => {
    sessions.appendEvent(session.id, "user", { item: user("ORIGINAL_REQUIREMENT " + "x".repeat(90_000)) });
    sessions.appendEvent(session.id, "response", { response: answer("old", "OLD_COMPLETE_ANSWER") });
  };
  return { root, db, sessions, session, config, engine, delays, seed };
}

test("specific compaction size codes override generic invalid-request classification only", () => {
  for (const code of ["responses_compact_input_too_large", "compaction_input_too_large"]) {
    const error = providerError({ code, type: "invalid_request_error", param: "input",
      message: "Compact input exceeds the upstream size limit" },
    { provider: "codex-lb", operation: "compact", status: 400 });
    assert.equal(error.kind, "invalid_request");
    assert.equal(isRecoverableCompactionError(error), true);
    for (const kind of ["auth", "cancelled", "unsupported"]) {
      assert.equal(isRecoverableCompactionError({ ...error, kind }), false);
    }
  }
  assert.equal(isRecoverableCompactionError(providerError({ code: "invalid_request_error" },
    { provider: "codex-lb", operation: "compact", status: 400 })), false);
});

test("legacy native state is reconstructed before leaf compaction and releases the lease", async (t) => {
  const { sessions, session, engine, seed, db } = fixture(t);
  seed();
  sessions.saveCheckpoint(session.id, 2, {
    output: [{ type: "compaction", encrypted_content: "OPAQUE_STATE" }],
  }, 10);
  const events = sessions.events(session.id);
  const inputs: ResponseInputItem[][] = [];
  await engine({ async compact(request) {
    inputs.push(request.input);
    assert.equal(request.semanticOnly, true);
    return checkpoint("RECOVERED_HISTORY");
  } }).compactNow(session.id, { signal: new AbortController().signal });
  assert.equal(inputs.length, 1);
  assert.match(JSON.stringify(inputs[0]), /ORIGINAL_REQUIREMENT/);
  assert.doesNotMatch(JSON.stringify(inputs[0]), /OPAQUE_STATE/);
  assert.match(JSON.stringify(projectContext(sessions, session.id).input), /RECOVERED_HISTORY/);
  assert.deepEqual(sessions.events(session.id), events);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM session_operation_leases WHERE session_id = ?")
    .get(session.id) as { n: number }).n, 0);
});

for (const provider of ["codex-lb", "openrouter"] as const) {
  test(`manual compaction uses the configured ${provider} leaf with agents disabled`, async (t) => {
    const { sessions, session, engine, seed } = fixture(t);
    seed();
    sessions.updateSettings(session.id, { model: "expensive-main", agentModel: "cheap-leaf", agentProvider: provider,
      agentsEnabled: false, fast: true });
    const requests: CompactRequest[] = [];
    const statuses: string[] = [];
    const leaf = { ...modelInfo, id: "cheap-leaf", contextWindow: 16_384, maxOutputTokens: 1_024 };
    await engine((selected) => {
      assert.equal(selected, provider);
      return { async compact(request: CompactRequest) { requests.push(request); return checkpoint("LEAF_SUMMARY"); } } as unknown as CodexLbClient;
    }, undefined, async (id, selected) => {
      assert.equal(id, "cheap-leaf");
      assert.equal(selected, provider);
      return leaf;
    }).compactNow(session.id, { signal: new AbortController().signal, callbacks: { onStatus: (s) => statuses.push(s) } });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.model, "cheap-leaf");
    assert.equal(requests[0]?.fast, false);
    assert.equal(requests[0]?.semanticOnly, true);
    assert.equal(requests[0]?.modelInfo, leaf);
    assert.ok(statuses.some((s) => s.includes(`${provider}:cheap-leaf`)));
    assert.equal(sessions.get(session.id)?.model, "expensive-main");
  });
}

test("automatic end-of-turn compaction uses the leaf, not the main model", async (t) => {
  const { sessions, session, engine, seed } = fixture(t);
  seed();
  sessions.updateSettings(session.id, { agentModel: "leaf", agentProvider: "openrouter", agentsEnabled: false });
  const providers: GatewayProvider[] = [];
  const result = await engine((provider) => {
    providers.push(provider);
    return provider === "openrouter" ? { async compact(request: CompactRequest) {
      assert.equal(request.model, "leaf");
      return checkpoint("LEAF_SUMMARY");
    } } as unknown as CodexLbClient : { async stream(request: ResponseRequest) {
      assert.equal(request.model, "test");
      return { ...answer("done", "DONE"), usage: { input_tokens: 250_000, output_tokens: 2, total_tokens: 250_002 } };
    } } as unknown as CodexLbClient;
  }).turn(session.id, "continue", { signal: new AbortController().signal, modelInfo,
    interaction: { approve: async () => "once", ask: async () => "" } });
  assert.equal(result.compacted, true);
  assert.ok(providers.includes("openrouter"));
});

test("an unavailable leaf never falls back to the main provider", async (t) => {
  const { sessions, session, engine, seed } = fixture(t);
  seed();
  sessions.updateSettings(session.id, { agentModel: "leaf", agentProvider: "openrouter" });
  let calls = 0;
  await engine((provider) => {
    assert.equal(provider, "openrouter");
    return { async compact(request: CompactRequest) {
      calls += 1;
      assert.equal(request.model, "leaf");
      throw Object.assign(new Error("unavailable"), { status: 503 });
    } } as unknown as CodexLbClient;
  }).compactNow(session.id, { signal: new AbortController().signal });
  assert.equal(calls, 2);
  assert.equal(sessions.latestCheckpoint(session.id)?.compact.id, "compact_local_recovery");
});

for (const provider of ["codex-lb", "openrouter", "custom", "opencode-go"] as const) {
  test(`portable ${provider} compaction parts honor the leaf context/output limits`, async (t) => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.gateway.provider = provider;
    config.gateway.apiKeyEnv = "GLASS_LEAF_COMPACTION_TEST_KEY";
    const previous = process.env[config.gateway.apiKeyEnv];
    process.env[config.gateway.apiKeyEnv] = "synthetic-test-key";
    t.after(() => {
      if (previous === undefined) delete process.env[config.gateway.apiKeyEnv];
      else process.env[config.gateway.apiKeyEnv] = previous;
    });
    const requests: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      assert.ok(!url.endsWith("/responses/compact"));
      const body = JSON.parse(String(init.body));
      requests.push(body);
      assert.equal(body.model, provider === "opencode-go" ? "glm-5" : "leaf");
      assert.ok(JSON.stringify(body).length < 8_192);
      assert.equal(body.max_tokens ?? body.max_output_tokens, 256);
      return globalThis.Response.json(url.endsWith("/chat/completions")
        ? { choices: [{ message: { content: "LEAF_SUMMARY" } }] }
        : answer("leaf", "LEAF_SUMMARY"));
    });
    const compact = await new CodexLbClient(config).compact({ model: provider === "opencode-go" ? "glm-5" : "leaf",
      instructions: "Summarize safely", input: [user("x".repeat(20_000))], promptCacheKey: "test", fast: false,
      semanticOnly: true, modelInfo: { contextWindow: 4_096, maxOutputTokens: 256 } });
    assert.ok(requests.length > 1);
    assert.ok(isPortableCheckpoint(compact));
  });
}

for (const provider of ["codex-lb", "custom"] as const) {
  for (const overflow of [false, true]) {
    test(`${provider} shares unused summary space deterministically${overflow ? " with global overflow" : " without needless trims"}`, async (t) => {
      const config = structuredClone(DEFAULT_CONFIG);
      config.gateway.provider = provider;
      const summaries = [
        `HEAD_1 ${"😀".repeat(overflow ? 12_000 : 8_000)} TAIL_1`,
        `HEAD_2 ${"y".repeat(overflow ? 22_000 : 1_000)} TAIL_2`,
        "SHORT_3", "SHORT_4",
      ];
      const textOf = (compact: Record<string, unknown>) => (compact.output as { content: { text: string }[] }[])[0]!.content[0]!.text;
      const qualityOf = (compact: Record<string, unknown>) => (compact.compaction_details as { quality: {
        truncated_parts: number; checkpoint_characters: number; checkpoint_character_budget: number;
      } }).quality;
      const run = async (order: number[]) => {
        const pending = new Map<number, (response: globalThis.Response) => void>();
        const snapshots: Record<string, unknown>[] = [];
        let progressed = () => {};
        t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body));
          const part = Number(/transcript part (\d+) of 4/u.exec(body.instructions)?.[1]);
          assert.ok(part >= 1 && part <= 4);
          assert.equal(body.max_output_tokens, 2_048);
          return new Promise<globalThis.Response>((resolve) => { pending.set(part, resolve); });
        });
        const work = new CodexLbClient(config).compact({ model: "leaf", instructions: "Keep context",
          input: [user("x".repeat(32_768 * 4 - "USER: ".length))], promptCacheKey: "test", fast: false,
          semanticOnly: true, onPartialCheckpoint: (snapshot) => { snapshots.push(snapshot); progressed(); } });
        assert.equal(pending.size, 4);
        for (const part of order) {
          const progress = new Promise<void>((resolve) => { progressed = resolve; });
          pending.get(part)!(globalThis.Response.json(answer(`part_${part}`, summaries[part - 1]!)));
          await progress;
        }
        const compact = await work;
        for (const snapshot of snapshots) {
          assert.ok(textOf(snapshot).length <= 32_768);
          assert.equal(qualityOf(snapshot).checkpoint_characters, textOf(snapshot).length);
          assert.equal(qualityOf(snapshot).checkpoint_character_budget, 32_768);
          assert.doesNotMatch(textOf(snapshot), /[\uD800-\uDFFF]/u);
        }
        if (order[0] === 1) assert.equal(qualityOf(snapshots[0]!).truncated_parts, 1);
        return compact;
      };
      const forward = await run([1, 2, 3, 4]);
      const reverse = await run([4, 3, 2, 1]);
      assert.deepEqual(forward, reverse);
      assert.equal(qualityOf(forward).truncated_parts, overflow ? 2 : 0);
      if (!overflow) for (const summary of summaries) assert.ok(textOf(forward).includes(summary));
      for (const marker of ["HEAD_1", "TAIL_1", "HEAD_2", "TAIL_2", "SHORT_3", "SHORT_4"]) {
        assert.ok(textOf(forward).includes(marker));
      }
    });
  }
}

test("local recovery is bounded Unicode-safe text with original and latest user requirements", () => {
  const input = [user("ORIGINAL_REQUIREMENT " + "😀".repeat(30_000)), user("LATEST_REQUIREMENT"),
    call("recent"), result("recent", "UNKNOWN_OUTCOME " + "😀".repeat(20_000) + " RECENT_TAIL")];
  const compact = localRecoveryCheckpoint(input);
  assert.ok(isPortableCheckpoint(compact));
  const text = (compact.output as { content: { text: string }[] }[])[0]!.content[0]!.text;
  assert.ok(text.length <= 32_768);
  assert.doesNotMatch(text, /[\uD800-\uDFFF]/u);
  assert.match(text, /Degraded local recovery/);
  assert.match(text, /not a semantic summary/);
  assert.match(text, /ORIGINAL_REQUIREMENT/);
  assert.match(text, /LATEST_REQUIREMENT/);
  assert.match(text, /UNKNOWN_OUTCOME/);
  assert.match(text, /RECENT_TAIL/);
  assert.equal((compact.compaction_details as { degraded: boolean }).degraded, true);
  assert.throws(() => localRecoveryCheckpoint([{ type: "compaction", encrypted_content: "opaque" }]),
    { code: "checkpoint_conversion_unavailable" });
});

test("compaction retains a recent user request and parallel tool batch verbatim", async (t) => {
  const { sessions, session, engine, seed } = fixture(t);
  seed();
  sessions.appendEvent(session.id, "user", { item: user("CURRENT_TASK") });
  sessions.appendEvent(session.id, "response", { response: { ...answer("batch", ""), output: [call("a"), call("b")] } });
  sessions.appendEvent(session.id, "tool_started", { callId: "a", name: "inspect" });
  sessions.appendEvent(session.id, "tool_result", { callId: "b", name: "inspect", item: result("b", "EXACT_B") });
  sessions.appendEvent(session.id, "tool_result", { callId: "a", name: "inspect", item: result("a", "EXACT_A") });
  const before = projectContext(sessions, session.id);
  const events = sessions.events(session.id);
  let remoteInput: ResponseInputItem[] = [];
  await engine({ async compact(request) { remoteInput = request.input; return checkpoint("OLDER_SUMMARY"); } })
    .compactNow(session.id, { signal: new AbortController().signal });
  assert.equal(sessions.latestCheckpoint(session.id)?.throughSequence, 2);
  assert.equal(remoteInput.length, 2);
  assert.doesNotMatch(JSON.stringify(remoteInput), /CURRENT_TASK|EXACT_A|EXACT_B/);
  const replay = projectContext(sessions, session.id).input;
  assert.deepEqual(replay.slice(1), before.input.slice(2));
  assert.deepEqual(sessions.events(session.id), events);
});

for (const recovery of ["semantic", "local"] as const) {
  test(`${recovery} compaction immediately refreshes retained-response usage and survives reload`, async (t) => {
    const { sessions, session, db, engine, seed } = fixture(t);
    seed();
    sessions.appendEvent(session.id, "user", { item: user("RECENT_REQUEST") });
    sessions.appendEvent(session.id, "response", { response: { ...answer("recent", "RECENT_ANSWER"),
      usage: { input_tokens: 150_000, output_tokens: 2, total_tokens: 150_002 } } });
    assert.deepEqual(contextUsage(sessions, session.id), { inputTokens: 150_000, estimated: false });
    const updates: ContextUsage[] = [];
    await engine({ async compact() {
      if (recovery === "local") throw Object.assign(new Error("no progress"), { code: "compaction_part_retry_exhausted" });
      return { ...checkpoint("COMPACT_SUMMARY"), usage: { input_tokens: 90_000 } };
    } }).compactNow(session.id, { signal: new AbortController().signal, callbacks: { onContextCompacted() {
      assert.ok(sessions.latestCheckpoint(session.id));
      updates.push(contextUsage(sessions, session.id));
    } } });
    const saved = sessions.latestCheckpoint(session.id)!;
    assert.equal(saved.throughSequence, 2);
    assert.equal((saved.compact.compaction_details as { source_sequence: number }).source_sequence, 4);
    assert.equal(sessions.latestResponseUsage(session.id)?.sequence, 4);
    assert.equal(updates.length, 1);
    const expected = Math.ceil(JSON.stringify(projectContext(sessions, session.id).input).length / 4);
    assert.deepEqual(updates[0], { inputTokens: expected, estimated: true });
    assert.ok(expected < 20_000);
    assert.deepEqual(contextUsage(new SessionStore(db), session.id), updates[0]);
    // Sequence ordering must work even when the fresh response and compaction
    // were recorded in the same millisecond (or the clock moved backwards).
    t.mock.method(Date, "now", () => saved.createdAt);
    sessions.appendEvent(session.id, "response", { response: { ...answer("fresh", "FRESH"),
      usage: { input_tokens: 12_345, output_tokens: 2, total_tokens: 12_347 } } });
    assert.deepEqual(contextUsage(sessions, session.id), { inputTokens: 12_345, estimated: false });
  });
}

test("legacy checkpoints and stateless replay use a current estimate when provider usage is stale or too small", (t) => {
  const { sessions, session, seed } = fixture(t);
  seed();
  sessions.appendEvent(session.id, "user", { item: user("RECENT " + "x".repeat(8_000)) });
  sessions.appendEvent(session.id, "response", { response: { ...answer("retained", "ANSWER"),
    usage: { input_tokens: 150_000, output_tokens: 2, total_tokens: 150_002 } } });
  const saved = sessions.saveCheckpoint(session.id, 2, checkpoint("LEGACY_CHECKPOINT"), 100_000);
  const estimated = contextUsage(sessions, session.id);
  assert.equal(estimated.estimated, true);
  assert.ok(estimated.inputTokens < 10_000);
  t.mock.method(Date, "now", () => saved.createdAt + 1);
  sessions.appendEvent(session.id, "response", { response: answer("fresh", "small usage") });
  assert.equal(contextUsage(sessions, session.id).inputTokens, 10);
  assert.equal(contextUsage(sessions, session.id, true).estimated, true);
  assert.ok(contextUsage(sessions, session.id, true).inputTokens > 2_000);
});

test("context refresh observers cannot turn a committed checkpoint into a failed operation", async (t) => {
  const { sessions, session, engine, seed } = fixture(t);
  seed();
  const result = await engine({ async compact() { return checkpoint("SAVED"); } }).compactNow(session.id, {
    signal: new AbortController().signal, callbacks: { onContextCompacted() { throw new Error("broken observer"); } },
  });
  assert.equal(result?.degraded, false);
  assert.match(JSON.stringify(sessions.latestCheckpoint(session.id)?.compact.output), /SAVED/);
  assert.equal(sessions.events(session.id).filter((event) => (event.payload as { code?: string }).code === "compaction_failed").length, 0);
});

test("a mid-tool turn continues after bounded compaction outage without executing a tool twice", async (t) => {
  const { sessions, session, engine, seed, delays } = fixture(t);
  seed();
  const requests: ResponseRequest[] = [];
  let compactions = 0;
  let executions = 0;
  const warnings: string[] = [];
  const contextUpdates: ContextUsage[] = [];
  const registry = new ToolRegistry().register({
    name: "inspect", risk: "read", description: "test", parameters: { type: "object", properties: {} },
    summarize: () => "inspect",
    async execute() { executions += 1; return { output: "EXACT_RESULT" }; },
  });
  const result = await engine({
    async stream(request) {
      requests.push(request);
      if (requests.length === 2) {
        assert.equal(contextUpdates.length, 1, "refresh before the next model request, not just at turn completion");
        assert.equal(contextUpdates[0]?.estimated, true);
        assert.ok(contextUpdates[0]!.inputTokens < 250_000);
      }
      return requests.length === 1 ? {
        ...answer("tool", ""), output: [call("once")],
        usage: { input_tokens: 250_000, output_tokens: 2, total_tokens: 250_002 },
      } as Response : answer("done", "FINISHED");
    },
    async compact() { compactions += 1; throw Object.assign(new Error("provider-private-detail"), { status: 503 }); },
  }, registry).turn(session.id, "CURRENT_TASK", {
    signal: new AbortController().signal, modelInfo,
    interaction: { approve: async () => "once", ask: async () => "" },
    callbacks: { onWarning: (message) => warnings.push(message),
      onContextCompacted: () => contextUpdates.push(contextUsage(sessions, session.id)) },
  });
  assert.equal(result.text, "FINISHED");
  assert.equal(result.metrics?.compactions, 1);
  assert.equal(compactions, 2);
  assert.deepEqual(delays, [1_000]);
  assert.equal(executions, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.previousResponseId, undefined);
  assert.match(JSON.stringify(requests[1]?.input), /CURRENT_TASK/);
  assert.match(JSON.stringify(requests[1]?.input), /EXACT_RESULT/);
  assert.equal(requests[1]?.input.filter((item) => item.type === "function_call").length, 1);
  assert.equal(requests[1]?.input.filter((item) => item.type === "function_call_output").length, 1);
  assert.match(warnings.join(" "), /degraded local recovery/);
  assert.doesNotMatch(JSON.stringify(sessions.latestCheckpoint(session.id)), /provider-private-detail/);
  assert.equal(sessions.events(session.id).filter((event) => event.kind === "user").length, 2);
});

for (const code of ["compaction_part_retry_exhausted", "compaction_input_too_large"]) {
  test(`${code} uses explicit local recovery rather than failing the turn`, async (t) => {
    const { sessions, session, engine, seed } = fixture(t);
    seed();
    let attempts = 0;
    await engine({ async compact() { attempts += 1; throw Object.assign(new Error(code), { code, retryable: false }); } })
      .compactNow(session.id, { signal: new AbortController().signal });
    assert.equal(attempts, 1);
    assert.equal(sessions.latestCheckpoint(session.id)?.compact.id, "compact_local_recovery");
    assert.equal(sessions.events(session.id).filter((event) => event.kind === "note").length, 1);
  });
}

test("interactive compaction has a hard deadline even if a provider ignores abort", async (t) => {
  const { sessions, session, engine, seed } = fixture(t);
  seed();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolveLate: (value: Record<string, unknown>) => void = () => undefined;
  let request: CompactRequest | undefined;
  const statuses: string[] = [];
  const pending = engine({ compact(input) {
    request = input;
    return new Promise((resolve) => { resolveLate = resolve; });
  } }).compactNow(session.id, { signal: new AbortController().signal, callbacks: { onStatus: (status) => statuses.push(status) } });
  assert.ok(request);
  assert.equal(request.signal?.aborted, false);
  t.mock.timers.tick(COMPACTION_MAX_ELAPSED_MS);
  await pending;
  assert.equal(request.signal?.aborted, true);
  const saved = sessions.latestCheckpoint(session.id);
  assert.equal(saved?.compact.id, "compact_local_recovery");
  request.onStatus?.("LATE_REMOTE_STATUS");
  resolveLate(checkpoint("LATE_REMOTE_SUMMARY"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(sessions.latestCheckpoint(session.id), saved);
  assert.ok(!statuses.includes("LATE_REMOTE_STATUS"));
});

test("automated compaction honors a tighter elapsed budget", async (t) => {
  const { sessions, session, config, engine, seed } = fixture(t);
  seed();
  config.automation.providerRetryMaxElapsedMs = 100;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = engine({ compact: () => new Promise(() => undefined) })
    .compactNow(session.id, { signal: new AbortController().signal, automated: true });
  t.mock.timers.tick(100);
  await pending;
  assert.equal(sessions.latestCheckpoint(session.id)?.compact.id, "compact_local_recovery");
});

for (const failure of [
  { code: "invalid_api_key", status: 503 },
  { code: "invalid_request_error", status: 400 },
  { code: "session_operation_lease_lost" },
  { code: "session_operation_lease_unavailable" },
]) {
  test(`compaction never recovers over ${failure.code}`, async (t) => {
    const { sessions, session, engine } = fixture(t);
    sessions.appendEvent(session.id, "user", { item: user("preserve") });
    sessions.saveCheckpoint(session.id, 1, checkpoint("LAST_GOOD_CHECKPOINT"), 1);
    sessions.setLastResponseId(session.id, "LAST_GOOD_ANCHOR");
    const saved = sessions.latestCheckpoint(session.id);
    let attempts = 0;
    let refreshes = 0;
    const error = Object.assign(new Error(failure.code), failure);
    await assert.rejects(engine({ async compact(request) {
      attempts += 1;
      request.onPartialCheckpoint?.({ ...checkpoint("PARTIAL_MUST_NOT_COMMIT"),
        compaction_details: { total_parts: 2, semantic_parts: 1, local_parts: 1 } });
      throw error;
    } })
      .compactNow(session.id, { signal: new AbortController().signal,
        callbacks: { onContextCompacted: () => { refreshes += 1; } } }), { code: failure.code });
    assert.equal(attempts, 1);
    assert.equal(refreshes, 0);
    assert.deepEqual(sessions.latestCheckpoint(session.id), saved);
    assert.equal(sessions.get(session.id)?.lastResponseId, "LAST_GOOD_ANCHOR");
  });
}

test("caller cancellation leaves the last checkpoint and continuity unchanged", async (t) => {
  const { sessions, session, engine } = fixture(t);
  sessions.appendEvent(session.id, "user", { item: user("preserve") });
  sessions.saveCheckpoint(session.id, 1, checkpoint("LAST_GOOD_CHECKPOINT"), 1);
  sessions.setLastResponseId(session.id, "LAST_GOOD_ANCHOR");
  const saved = sessions.latestCheckpoint(session.id);
  const controller = new AbortController();
  const reason = new Error("caller cancellation");
  const pending = engine({ compact(request) {
    request.onPartialCheckpoint?.({ ...checkpoint("PARTIAL_MUST_NOT_COMMIT"),
      compaction_details: { total_parts: 2, semantic_parts: 1, local_parts: 1 } });
    return new Promise(() => undefined);
  } }).compactNow(session.id, { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.deepEqual(sessions.latestCheckpoint(session.id), saved);
  assert.equal(sessions.get(session.id)?.lastResponseId, "LAST_GOOD_ANCHOR");
});

test("native checkpoint timeout reconstructs durable source before local recovery", async (t) => {
  const { sessions, session, engine, seed } = fixture(t);
  seed();
  sessions.saveCheckpoint(session.id, 2, { output: [{ type: "compaction", encrypted_content: "OPAQUE_NATIVE" }] }, 1);
  const inputs: ResponseInputItem[][] = [];
  await engine({ async compact(request) {
    inputs.push(request.input);
    throw Object.assign(new Error("timeout"), { kind: "timeout", retryable: true });
  } }).compactNow(session.id, { signal: new AbortController().signal });
  assert.equal(inputs.length, 2);
  assert.doesNotMatch(JSON.stringify(inputs[0]), /OPAQUE_NATIVE/);
  assert.doesNotMatch(JSON.stringify(inputs[1]), /OPAQUE_NATIVE/);
  assert.match(JSON.stringify(sessions.latestCheckpoint(session.id)), /ORIGINAL_REQUIREMENT/);
  assert.equal(sessions.latestCheckpoint(session.id)?.throughSequence, 2);
});

test("native-only checkpoints without source history are never silently discarded", async (t) => {
  const { sessions, session, engine } = fixture(t);
  sessions.saveCheckpoint(session.id, 0, { output: [{ type: "compaction", encrypted_content: "IRREPLACEABLE" }] }, 1);
  sessions.appendEvent(session.id, "user", { item: user("new request is not the missing old history") });
  const saved = sessions.latestCheckpoint(session.id);
  await assert.rejects(engine({ async compact() { throw Object.assign(new Error("not found"), { status: 404 }); } })
    .compactNow(session.id, { signal: new AbortController().signal }), { code: "checkpoint_conversion_unavailable" });
  assert.deepEqual(sessions.latestCheckpoint(session.id), saved);
});

test("lease fencing rejects a local checkpoint when ownership changes during remote work", async (t) => {
  const { db, sessions, session, engine, seed } = fixture(t);
  seed();
  await assert.rejects(engine({ async compact() {
    db.prepare("DELETE FROM session_operation_leases WHERE session_id = ?").run(session.id);
    throw Object.assign(new Error("parts exhausted"), { code: "compaction_part_retry_exhausted" });
  } }).compactNow(session.id, { signal: new AbortController().signal }), { code: "session_operation_lease_lost" });
  assert.equal(sessions.latestCheckpoint(session.id), null);
});

test("empty checkpoint output cannot advance durable context as a successful summary", async (t) => {
  const { sessions, session, engine, seed } = fixture(t);
  seed();
  await engine({ async compact() { return checkpoint("  "); } })
    .compactNow(session.id, { signal: new AbortController().signal });
  assert.equal(sessions.latestCheckpoint(session.id)?.compact.id, "compact_local_recovery");
});

test("manual compaction reconciles interrupted calls as unknown without executing them", async (t) => {
  const { sessions, session, engine, seed } = fixture(t);
  seed();
  sessions.appendEvent(session.id, "response", { response: { ...answer("pending", ""), output: [call("pending")] } });
  assert.throws(() => projectContext(sessions, session.id, { retainRecentCharacters: 32_768 }),
    { code: "compaction_pending_tools" });
  const registry = new ToolRegistry().register({
    name: "inspect", risk: "read", description: "test", parameters: { type: "object", properties: {} },
    summarize: () => "inspect", async execute() { assert.fail("must never rerun an interrupted tool"); },
  });
  await engine({ async compact() { return checkpoint("OLDER_SUMMARY"); } }, registry)
    .compactNow(session.id, { signal: new AbortController().signal });
  const replay = projectContext(sessions, session.id).input;
  assert.equal(replay.filter((item) => item.type === "function_call_output").length, 1);
  assert.match(JSON.stringify(replay), /No durable tool result was recorded/);
  const reconciled = sessions.events(session.id).filter((event) => event.kind === "tool_denied");
  assert.equal(reconciled.length, 1);
  await engine({ async compact() { return checkpoint("SUMMARY"); } }, registry)
    .compactNow(session.id, { signal: new AbortController().signal });
  assert.deepEqual(sessions.events(session.id).filter((event) => event.kind === "tool_denied"), reconciled);
});

test("manual compaction cannot reconcile tools owned by an active turn", async (t) => {
  const { sessions, session, engine, seed } = fixture(t);
  seed();
  assert.ok(sessions.acquireOperationLease(session.id, "other-owner", "live-token", "turn"));
  sessions.beginToolCall(session.id, "live", "inspect", {}, "live-token");
  await assert.rejects(engine({ async compact() { assert.fail("must not compact an active turn"); } })
    .compactNow(session.id, { signal: new AbortController().signal }), /busy with another turn/);
  assert.equal(sessions.getToolCall(session.id, "live")?.state, "started");
});

test("leaf recovery reuses a portable checkpoint without any native request", async (t) => {
  const { sessions, session, config, engine, seed } = fixture(t);
  seed();
  sessions.saveCheckpoint(session.id, 2, checkpoint("PORTABLE_BASELINE"), 10);
  sessions.appendEvent(session.id, "user", { item: user("UNCHECKPOINTED_REQUIREMENT") });
  sessions.appendEvent(session.id, "response", { response: answer("recent", "RECENT_ANSWER") });
  sessions.saveCheckpoint(session.id, 4, { output: [{ type: "compaction", encrypted_content: "OPAQUE" }] }, 10);
  let nativeCalls = 0;
  const semanticInputs: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/responses/compact")) {
      nativeCalls += 1;
      return globalThis.Response.json({}, { status: 404 });
    }
    semanticInputs.push(JSON.stringify(JSON.parse(String(init.body)).input));
    return globalThis.Response.json(answer("recovered", "RECOVERED"));
  });
  assert.match(JSON.stringify(projectContext(sessions, session.id, { throughSequence: 2 }).input), /PORTABLE_BASELINE/);
  assert.doesNotMatch(JSON.stringify(projectContext(sessions, session.id, { throughSequence: 2 }).input), /OPAQUE/);
  await engine(new CodexLbClient(config)).compactNow(session.id, { signal: new AbortController().signal });
  assert.equal(nativeCalls, 0);
  assert.equal(semanticInputs.length, 1);
  assert.match(semanticInputs[0]!, /PORTABLE_BASELINE/);
  assert.match(semanticInputs[0]!, /UNCHECKPOINTED_REQUIREMENT/);
  assert.doesNotMatch(semanticInputs[0]!, /ORIGINAL_REQUIREMENT|OPAQUE/);
  assert.equal(sessions.latestCheckpoint(session.id)?.throughSequence, 4);
});

test("the engine retains completed semantic parts at its deadline and ignores late work", async (t) => {
  const { sessions, session, config, engine } = fixture(t);
  sessions.appendEvent(session.id, "user", { item: user("SOURCE " + "x".repeat(60_000) + " SOURCE_TAIL") });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | null | undefined;
  let resolveLate!: (value: globalThis.Response) => void;
  let ready!: () => void;
  const progress = new Promise<void>((resolve) => { ready = resolve; });
  let semanticCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/responses/compact")) return globalThis.Response.json({}, { status: 404 });
    semanticCalls += 1;
    const body = JSON.parse(String(init.body));
    if (/transcript part 1 of/.test(body.instructions)) return globalThis.Response.json(answer("first", "KEEP_COMPLETED_SEMANTIC_PART"));
    signal = init.signal;
    return new Promise((resolve) => { resolveLate = resolve; });
  });
  const warnings: string[] = [];
  const pending = engine(new CodexLbClient(config)).compactNow(session.id, { signal: new AbortController().signal,
    callbacks: { onStatus: (status) => { if (status.includes("1/2 parts")) ready(); }, onWarning: (warning) => warnings.push(warning) } });
  await progress;
  t.mock.timers.tick(COMPACTION_MAX_ELAPSED_MS);
  await pending;
  assert.equal(semanticCalls, 2);
  assert.equal(signal?.aborted, true);
  const saved = sessions.latestCheckpoint(session.id);
  assert.equal(saved?.compact.id, "compact_semantic_fallback");
  assert.match(JSON.stringify(saved?.compact.output), /KEEP_COMPLETED_SEMANTIC_PART/);
  assert.match(JSON.stringify(saved?.compact.output), /SOURCE_TAIL/);
  assert.deepEqual(saved?.compact.usage, { input_tokens: 10, output_tokens: 2, total_tokens: 12 });
  assert.match(warnings.join(" "), /local excerpts \(1\/2 parts\)/);
  resolveLate(globalThis.Response.json(answer("late", "LATE_SUMMARY")));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(sessions.latestCheckpoint(session.id), saved);
});

test("a complete semantic outage stops after twelve requests, not three for every part", async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => { attempts += 1; return globalThis.Response.json({ output: [] }); });
  await assert.rejects(new CodexLbClient(structuredClone(DEFAULT_CONFIG)).compact({
    model: "test", instructions: "summarize", input: [user("x".repeat(900_000))],
    promptCacheKey: "test", fast: false, semanticOnly: true,
  }), { code: "compaction_part_retry_exhausted", retryable: false });
  assert.equal(attempts, 12);
});

test("partial semantic recovery is retained and its degradation is surfaced", async (t) => {
  const { sessions, session, engine, seed } = fixture(t);
  seed();
  const warnings: string[] = [];
  const compact = { ...checkpoint("SEMANTIC_AND_LOCAL"), compaction_details: { total_parts: 2, local_parts: 1 } };
  await engine({ async compact() { return compact; } }).compactNow(session.id, {
    signal: new AbortController().signal, callbacks: { onWarning: (warning) => warnings.push(warning) },
  });
  assert.deepEqual(sessions.latestCheckpoint(session.id)?.compact.output, compact.output);
  assert.equal((sessions.latestCheckpoint(session.id)?.compact.compaction_details as { local_parts: number }).local_parts, 1);
  assert.match(warnings.join(" "), /local excerpts \(1\/2 parts\)/);
  assert.doesNotMatch(JSON.stringify(projectContext(sessions, session.id).input), /compaction_details/);
});

test("successful compactions preserve inherited degradation without repeating historical warnings", async (t) => {
  const { sessions, session, engine, seed, db } = fixture(t);
  seed();
  sessions.saveCheckpoint(session.id, 2, { ...checkpoint("LOSSY_CHECKPOINT"),
    compaction_details: { strategy: "local-recovery", degraded: true } }, null);
  sessions.appendEvent(session.id, "note", { code: "compaction_degraded", message: "Historical local recovery" });
  sessions.appendEvent(session.id, "note", { code: "compaction_failed", message: "Historical repair exceeded its limit" });
  const events = sessions.events(session.id);
  const warnings: string[] = [];
  const statuses: string[] = [];
  let updates = 0;
  for (let round = 0; round < 2; round += 1) {
    const result = await engine({ async compact(request) {
      assert.doesNotMatch(JSON.stringify(request.input), /ORIGINAL_REQUIREMENT/);
      return checkpoint("SUMMARY_OF_LOSSY_CHECKPOINT");
    } }).compactNow(session.id, { signal: new AbortController().signal, callbacks: {
      onWarning: (s) => warnings.push(s), onStatus: (s) => statuses.push(s), onContextCompacted: () => { updates += 1; },
    } });
    assert.deepEqual(result, { degraded: false, inheritedDegradation: true });
    assert.equal(statuses.at(-1), "Context compacted");
    const saved = new SessionStore(db).latestCheckpoint(session.id)!;
    assert.equal(compactionQuality(saved.compact).inheritedDegradation, true);
    assert.equal(compactionQuality(saved.compact).currentDegradation, false);
    assert.equal(compactionQuality(saved.compact).degraded, true);
    assert.equal((saved.compact.compaction_details as { source_repair?: boolean }).source_repair, undefined);
  }
  assert.deepEqual(warnings, []);
  assert.equal(updates, 2);
  assert.deepEqual(sessions.events(session.id), events);
});

for (const [name, details, warning] of [
  ["local recovery", { strategy: "local-recovery", degraded: true }, /degraded local recovery/],
  ["local parts", { total_parts: 2, local_parts: 1 }, /local excerpts \(1\/2 parts\)/],
  ["trimming", { quality: { truncated_parts: 1 } }, /1 trimmed, 0 incomplete/],
  ["incomplete parts", { quality: { incomplete_parts: 1 } }, /0 trimmed, 1 incomplete/],
  ["explicit degradation", { degraded: true }, /degraded checkpoint/],
] as const) {
  test(`new ${name} still warns when degradation is inherited`, async (t) => {
    const { sessions, session, engine, seed } = fixture(t);
    seed();
    sessions.saveCheckpoint(session.id, 2, { ...checkpoint("LOSSY_ANCESTOR"),
      compaction_details: { quality: { inherited_degradation: true } } }, null);
    const warnings: string[] = [];
    const statuses: string[] = [];
    let expectedWarnings = 0;
    for (const degraded of [true, false, true]) {
      const result = await engine({ async compact() {
        return { ...checkpoint("NEW_SUMMARY"), compaction_details: degraded ? details : {} };
      } }).compactNow(session.id, { signal: new AbortController().signal, callbacks: {
        onWarning: (s) => warnings.push(s), onStatus: (s) => statuses.push(s),
      } });
      assert.deepEqual(result, { degraded, inheritedDegradation: true });
      const quality = compactionQuality(sessions.latestCheckpoint(session.id)!.compact);
      assert.equal(quality.currentDegradation, degraded);
      assert.equal(quality.degraded, true);
      assert.equal(statuses.at(-1), degraded ? "Context compacted (degraded checkpoint)" : "Context compacted");
      if (degraded) expectedWarnings += 1;
      assert.equal(warnings.length, expectedWarnings);
      assert.match(warnings.at(-1)!, warning);
      assert.match(warnings.at(-1)!, /Earlier checkpoint omissions have not been repaired/);
      assert.equal(sessions.events(session.id).filter((event) =>
        (event.payload as { code?: string }).code === "compaction_degraded").length, expectedWarnings);
    }
  });
}

test("explicit repair recovers original events, retains recent exchanges, and refreshes context", async (t) => {
  const { sessions, session, engine, seed } = fixture(t);
  seed();
  sessions.saveCheckpoint(session.id, 2, { ...checkpoint("LOSSY_CHECKPOINT"), compaction_details: { degraded: true } }, null);
  sessions.appendEvent(session.id, "user", { item: user("RECENT_REQUEST") });
  sessions.appendEvent(session.id, "response", { response: answer("recent", "RECENT_ANSWER") });
  sessions.setLastResponseId(session.id, "OLD_ANCHOR");
  const events = sessions.events(session.id);
  const updates: ContextUsage[] = [];
  const result = await engine({ async compact(request) {
    assert.equal(request.semanticOnly, true);
    assert.equal(request.model, session.agentModel);
    assert.match(JSON.stringify(request.input), /ORIGINAL_REQUIREMENT/);
    assert.doesNotMatch(JSON.stringify(request.input), /LOSSY_CHECKPOINT|RECENT_REQUEST/);
    return checkpoint("RECOVERED_ORIGINAL_FACTS");
  } }).compactNow(session.id, { signal: new AbortController().signal, repair: true,
    callbacks: { onContextCompacted: () => updates.push(contextUsage(sessions, session.id)) } });
  assert.deepEqual(result, { degraded: false, inheritedDegradation: false });
  const saved = sessions.latestCheckpoint(session.id)!;
  assert.equal(saved.throughSequence, 2);
  assert.equal((saved.compact.compaction_details as { source_repair: boolean }).source_repair, true);
  assert.equal((saved.compact.compaction_details as { source_checkpoint_sequence: number }).source_checkpoint_sequence, 0);
  assert.equal(compactionQuality(saved.compact).inheritedDegradation, false);
  assert.match(JSON.stringify(projectContext(sessions, session.id).input), /RECOVERED_ORIGINAL_FACTS.*RECENT_REQUEST.*RECENT_ANSWER/);
  assert.deepEqual(sessions.events(session.id), events);
  assert.equal(sessions.get(session.id)?.lastResponseId, null);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.estimated, true);
});

test("degraded descendants retain one healthy anchor for bounded source repair after reload", async (t) => {
  const { sessions, session, engine, seed, db } = fixture(t);
  seed();
  sessions.saveCheckpoint(session.id, 2, checkpoint("HEALTHY_BASELINE"), 10);
  sessions.appendEvent(session.id, "user", { item: user("OMITTED_FACT " + "y".repeat(90_000)) });
  const sourceEnd = sessions.appendEvent(session.id, "response", { response: answer("source", "SOURCE_ANSWER") }).sequence;
  await engine({ async compact() { return { ...checkpoint("LOSSY_DESCENDANT"),
    compaction_details: { total_parts: 2, semantic_parts: 1, local_parts: 1 } }; } })
    .compactNow(session.id, { signal: new AbortController().signal });
  sessions.appendEvent(session.id, "user", { item: user("RECENT_REQUEST") });
  sessions.appendEvent(session.id, "response", { response: answer("recent", "RECENT_ANSWER") });
  await engine({ async compact() { return checkpoint("SUMMARY_OF_LOSSY_DESCENDANT"); } })
    .compactNow(session.id, { signal: new AbortController().signal });
  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM context_checkpoints WHERE session_id = ?").get(session.id) as { n: number }).n;
  assert.equal(count(), 2);
  const reloaded = new SessionStore(db);
  const base = reloaded.latestCheckpoint(session.id, { portableOnly: true, accept: (compact) => !compactionQuality(compact).degraded });
  assert.equal(base?.throughSequence, 2);
  assert.match(JSON.stringify(base?.compact.output), /HEALTHY_BASELINE/);
  // A clean anchor can cover old events that are no longer retained.
  db.prepare("DELETE FROM session_events WHERE session_id = ? AND sequence <= 2").run(session.id);
  await engine({ async compact(request) {
    const text = JSON.stringify(request.input);
    assert.match(text, /HEALTHY_BASELINE.*OMITTED_FACT/);
    assert.doesNotMatch(text, /ORIGINAL_REQUIREMENT|LOSSY_DESCENDANT|RECENT_REQUEST/);
    return checkpoint("REPAIRED_SOURCE");
  } }).compactNow(session.id, { signal: new AbortController().signal, repair: true });
  const saved = sessions.latestCheckpoint(session.id)!;
  assert.equal(saved.throughSequence, sourceEnd);
  assert.equal(compactionQuality(saved.compact).degraded, false);
  assert.equal((saved.compact.compaction_details as { source_checkpoint_sequence: number }).source_checkpoint_sequence, 2);
  assert.equal(count(), 1);
  assert.match(JSON.stringify(projectContext(sessions, session.id).input), /REPAIRED_SOURCE.*RECENT_REQUEST.*RECENT_ANSWER/);
});

for (const failure of ["outage", "too-large", "empty", "local", "trimmed", "incomplete", "inherited"] as const) {
  test(`source repair preserves checkpoint and continuity on ${failure}`, async (t) => {
    const { sessions, session, engine, seed } = fixture(t);
    seed();
    sessions.saveCheckpoint(session.id, 2, { ...checkpoint("PREVIOUS_CHECKPOINT"), compaction_details: { degraded: true } }, null);
    sessions.setLastResponseId(session.id, "PREVIOUS_ANCHOR");
    const saved = sessions.latestCheckpoint(session.id);
    let requests = 0;
    let updates = 0;
    await assert.rejects(engine({ async compact(request) {
      requests += 1;
      request.onPartialCheckpoint?.({ ...checkpoint("PARTIAL"), compaction_details: { total_parts: 2, local_parts: 1 } });
      if (failure === "outage") throw Object.assign(new Error("PRIVATE_PROVIDER_ERROR"), { code: "server_error", status: 503 });
      if (failure === "too-large") throw Object.assign(new Error("oversized"), { code: "compaction_input_too_large" });
      if (failure === "empty") return checkpoint(" ");
      return { ...checkpoint("NOT_A_REPAIR"), compaction_details: {
        total_parts: 2, local_parts: failure === "local" ? 1 : 0,
        quality: { truncated_parts: failure === "trimmed" ? 1 : 0, incomplete_parts: failure === "incomplete" ? 1 : 0,
          inherited_degradation: failure === "inherited" },
      } };
    } }).compactNow(session.id, { signal: new AbortController().signal, repair: true,
      callbacks: { onContextCompacted: () => { updates += 1; } } }), (error) => {
      assert.match(String(error), /Checkpoint repair.*No new checkpoint saved/);
      assert.doesNotMatch(String(error), /PRIVATE_PROVIDER_ERROR/);
      return true;
    });
    assert.ok(requests >= 1 && requests <= 2);
    assert.equal(updates, 0);
    assert.deepEqual(sessions.latestCheckpoint(session.id), saved);
    assert.equal(sessions.get(session.id)?.lastResponseId, "PREVIOUS_ANCHOR");
  });
}

for (const missing of ["prefix", "gap", "tool-output"] as const) {
  test(`repair rejects missing ${missing} before any model request`, async (t) => {
    const { sessions, session, engine, seed, db } = fixture(t);
    seed();
    sessions.saveCheckpoint(session.id, 2, { ...checkpoint("PREVIOUS"), compaction_details: { degraded: true } }, null);
    sessions.appendEvent(session.id, "note", {});
    if (missing === "tool-output") sessions.appendEvent(session.id, "tool_result", { callId: "missing-output", name: "inspect" });
    else db.prepare("DELETE FROM session_events WHERE session_id = ? AND sequence = ?").run(session.id, missing === "prefix" ? 1 : 2);
    const saved = sessions.latestCheckpoint(session.id);
    await assert.rejects(engine({ async compact() { assert.fail("no request with incomplete source"); } })
      .compactNow(session.id, { signal: new AbortController().signal, repair: true }), { code: "compaction_repair_source_unavailable" });
    assert.deepEqual(sessions.latestCheckpoint(session.id), saved);
  });
}

test("repair preflights source size before building model replay", async (t) => {
  const { sessions, session, engine, seed } = fixture(t);
  seed();
  sessions.saveCheckpoint(session.id, 2, { ...checkpoint("PREVIOUS"), compaction_details: { degraded: true } }, null);
  const saved = sessions.latestCheckpoint(session.id);
  t.mock.method(sessions, "sourceHistoryStats", () => ({ events: 2, characters: COMPACTION_REPAIR_MAX_SOURCE_CHARACTERS + 1, missingToolOutputs: 0 }));
  t.mock.method(sessions, "events", () => { assert.fail("oversized history must not be materialized"); });
  await assert.rejects(engine({ async compact() { assert.fail("no request for oversized source"); } })
    .compactNow(session.id, { signal: new AbortController().signal, repair: true }), { code: "compaction_input_too_large" });
  assert.deepEqual(sessions.latestCheckpoint(session.id), saved);
});

test("source repair retains the existing part limit and never replaces an oversized source with excerpts", async (t) => {
  const { sessions, session, engine, config } = fixture(t);
  sessions.appendEvent(session.id, "user", { item: user("x".repeat(32_768 * 33)) });
  sessions.saveCheckpoint(session.id, 1, { ...checkpoint("PREVIOUS"), compaction_details: { degraded: true } }, null);
  const saved = sessions.latestCheckpoint(session.id);
  t.mock.method(globalThis, "fetch", () => { assert.fail("over 32 parts must fail before HTTP"); });
  await assert.rejects(engine(new CodexLbClient(config)).compactNow(session.id, {
    signal: new AbortController().signal, repair: true,
  }), { code: "compaction_input_too_large" });
  assert.deepEqual(sessions.latestCheckpoint(session.id), saved);
});

test("repair source preflight accounts for out-of-line tool outputs without double-counting inline results", (t) => {
  const { sessions, session } = fixture(t);
  assert.ok(sessions.acquireOperationLease(session.id, "owner", "token", "turn"));
  sessions.beginToolCall(session.id, "stored", "inspect", {}, "token");
  sessions.finishToolCall(session.id, "stored", "completed", "x".repeat(1_000), null);
  sessions.releaseOperationLease(session.id, "owner", "token");
  const reference = { callId: "stored", name: "inspect" };
  const inline = { ...reference, output: "inline result" };
  const referenced = sessions.appendEvent(session.id, "tool_result", reference).sequence;
  const inlined = sessions.appendEvent(session.id, "tool_result", inline).sequence;
  assert.deepEqual(sessions.sourceHistoryStats(session.id, referenced - 1, inlined), {
    events: 2, characters: JSON.stringify(reference).length + JSON.stringify(inline).length + 1_000,
    missingToolOutputs: 0,
  });
  assert.deepEqual(sessions.sourceHistoryStats(session.id, referenced, inlined), {
    events: 1, characters: JSON.stringify(inline).length, missingToolOutputs: 0,
  });
});

test("repair preserves explicit uncertainty without executing historical tools", async (t) => {
  const { sessions, session, engine, seed } = fixture(t);
  seed();
  sessions.saveCheckpoint(session.id, 2, { ...checkpoint("PREVIOUS"), compaction_details: { degraded: true } }, null);
  sessions.appendEvent(session.id, "response", { response: { ...answer("pending", ""), output: [call("pending")] } });
  const registry = new ToolRegistry().register({
    name: "inspect", risk: "read", description: "test", parameters: { type: "object", properties: {} },
    summarize: () => "inspect", async execute() { assert.fail("must never execute a historical call"); },
  });
  await engine({ async compact() { return checkpoint("REPAIRED"); } }, registry)
    .compactNow(session.id, { signal: new AbortController().signal, repair: true });
  const replay = projectContext(sessions, session.id).input;
  assert.match(JSON.stringify(replay), /REPAIRED.*No durable tool result was recorded/);
  assert.equal(replay.filter((item) => item.type === "function_call_output").length, 1);
  assert.equal(sessions.getToolCall(session.id, "pending")?.state, "unknown");
});

for (const interruption of ["cancel", "lease-loss"] as const) {
  test(`repair does not commit after ${interruption}`, async (t) => {
    const { sessions, session, engine, seed, db } = fixture(t);
    seed();
    sessions.saveCheckpoint(session.id, 2, { ...checkpoint("PREVIOUS"), compaction_details: { degraded: true } }, null);
    sessions.setLastResponseId(session.id, "PREVIOUS_ANCHOR");
    const saved = sessions.latestCheckpoint(session.id);
    const controller = new AbortController();
    const reason = new Error("cancelled repair");
    await assert.rejects(engine({ async compact() {
      if (interruption === "cancel") controller.abort(reason);
      else db.prepare("DELETE FROM session_operation_leases WHERE session_id = ?").run(session.id);
      return checkpoint("MUST_NOT_COMMIT");
    } }).compactNow(session.id, { signal: controller.signal, repair: true }), (error) => interruption === "cancel"
      ? error === reason : (error as { code?: string }).code === "session_operation_lease_lost");
    assert.deepEqual(sessions.latestCheckpoint(session.id), saved);
    assert.equal(sessions.get(session.id)?.lastResponseId, "PREVIOUS_ANCHOR");
  });
}

test("source repair deadline discards partial and late summaries without changing continuity", async (t) => {
  const { sessions, session, engine, seed } = fixture(t);
  seed();
  sessions.saveCheckpoint(session.id, 2, { ...checkpoint("PREVIOUS"), compaction_details: { degraded: true } }, null);
  sessions.setLastResponseId(session.id, "PREVIOUS_ANCHOR");
  const saved = sessions.latestCheckpoint(session.id);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolveLate!: (compact: Record<string, unknown>) => void;
  const pending = engine({ compact(request) {
    request.onPartialCheckpoint?.({ ...checkpoint("PARTIAL"), compaction_details: { total_parts: 2, local_parts: 1 } });
    return new Promise((resolve) => { resolveLate = resolve; });
  } }).compactNow(session.id, { signal: new AbortController().signal, repair: true });
  t.mock.timers.tick(COMPACTION_MAX_ELAPSED_MS);
  await assert.rejects(pending, { code: "automated_provider_retry_exhausted" });
  resolveLate(checkpoint("LATE_REPAIR"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(sessions.latestCheckpoint(session.id), saved);
  assert.equal(sessions.get(session.id)?.lastResponseId, "PREVIOUS_ANCHOR");
});

test("real client empty-part exhaustion becomes a usable engine recovery checkpoint", async (t) => {
  const { config, sessions, session, engine } = fixture(t);
  sessions.appendEvent(session.id, "user", { item: user("RETAIN_ME") });
  let semanticCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/responses/compact")) return globalThis.Response.json({}, { status: 404 });
    semanticCalls += 1;
    return globalThis.Response.json({ output: [] });
  });
  await engine(new CodexLbClient(config)).compactNow(session.id, { signal: new AbortController().signal });
  assert.equal(semanticCalls, 3);
  assert.equal(sessions.latestCheckpoint(session.id)?.compact.id, "compact_local_recovery");
  const diagnostic = diagnosticsOf(sessions.latestCheckpoint(session.id)?.compact);
  assert.equal(diagnostic.attempts, 1);
  assert.deepEqual(diagnostic.failures.filter((failure) => failure.code === "empty_response").map((failure) => [failure.part, failure.attempt]),
    [[1, 1], [1, 2], [1, 3]]);
  assert.match(JSON.stringify(projectContext(sessions, session.id).input), /RETAIN_ME/);
});

test("failure diagnostics are bounded classifications, never raw provider text", () => {
  const diagnostics = new CompactionDiagnostics();
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    diagnostics.record(Object.assign(new Error("PRIVATE_HISTORY https://host/token Bearer synthetic-private-token"), {
      code: "synthetic-private-token", kind: "availability", status: 503,
      param: "PRIVATE_HISTORY", body: "PRIVATE_HISTORY",
    }), "semantic", { part: 1, attempt });
  }
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.failure_count, 30);
  assert.equal((snapshot.failures as unknown[]).length, 16);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_HISTORY|synthetic-private-token|https|Bearer|body|param/);
  assert.match(diagnostics.summary(), /availability.*HTTP 503/);
  assert.deepEqual(compactionFailure({ code: "empty_response", kind: "protocol" }, "semantic"),
    { stage: "semantic", kind: "protocol", code: "empty_response" });
});

test("non-codex part deadlines are diagnosed as timeouts, not caller cancellations", async (t) => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.provider = "custom";
  const deadlines: AbortController[] = [];
  const controller = new AbortController();
  const reason = new Error("stop after observing timeout");
  const failures: unknown[] = [];
  t.mock.method(AbortSignal, "timeout", () => {
    const deadline = new AbortController();
    deadlines.push(deadline);
    return deadline.signal;
  });
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => new Promise((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  }));
  const pending = new CodexLbClient(config).compact({ model: "leaf", input: [user("history")],
    instructions: "summarize", promptCacheKey: "test", fast: false, semanticOnly: true, signal: controller.signal,
    onFailure: (failure) => { failures.push(failure); controller.abort(reason); },
  });
  deadlines[0]!.abort(new DOMException("deadline", "TimeoutError"));
  await assert.rejects(pending, (error) => error === reason);
  assert.deepEqual(failures, [{ stage: "semantic", kind: "timeout", part: 1, attempt: 1 }]);
});

test("local fallback persists HTTP failure diagnostics and reports the leaf without provider text", async (t) => {
  const { sessions, session, engine, seed } = fixture(t);
  seed();
  sessions.updateSettings(session.id, { agentModel: "cheap-leaf" });
  const warnings: string[] = [];
  const result = await engine({ async compact() {
    throw Object.assign(new Error("PRIVATE_PROVIDER_BODY"), { code: "server_error", status: 503 });
  } }).compactNow(session.id, { signal: new AbortController().signal, callbacks: { onWarning: (s) => warnings.push(s) } });
  assert.equal(result?.degraded, true);
  const saved = sessions.latestCheckpoint(session.id)!;
  const diagnostic = diagnosticsOf(saved.compact);
  assert.equal(diagnostic.attempts, 2);
  assert.ok(diagnostic.failures.some((failure) => failure.code === "server_error" && failure.status === 503));
  assert.match(warnings.join(" "), /cheap-leaf.*HTTP 503/);
  assert.doesNotMatch(JSON.stringify([saved, sessions.events(session.id), warnings]), /PRIVATE_PROVIDER_BODY/);
  assert.doesNotMatch(JSON.stringify(projectContext(sessions, session.id).input), /diagnostics|server_error|HTTP 503/);
});

test("hard compaction failures save safe diagnostics without replacing the checkpoint", async (t) => {
  const { sessions, session, engine, seed } = fixture(t);
  seed();
  sessions.saveCheckpoint(session.id, 2, checkpoint("PREVIOUS_SUMMARY"), 10);
  const saved = sessions.latestCheckpoint(session.id);
  await assert.rejects(engine({ async compact() {
    throw Object.assign(new Error("PRIVATE_PROVIDER_BODY"), { code: "invalid_api_key", status: 401 });
  } }).compactNow(session.id, { signal: new AbortController().signal }), (error) => {
    assert.match(String(error), /invalid_api_key.*HTTP 401/);
    assert.doesNotMatch(String(error), /PRIVATE_PROVIDER_BODY/);
    return true;
  });
  assert.deepEqual(sessions.latestCheckpoint(session.id), saved);
  const note = sessions.events(session.id).find((event) => (event.payload as { code?: string }).code === "compaction_failed");
  assert.ok(note);
  assert.match(JSON.stringify(note), /invalid_api_key/);
  assert.doesNotMatch(JSON.stringify(note), /PRIVATE_PROVIDER_BODY/);
});

test("leaf model resolution failures are diagnosed before any summary request", async (t) => {
  const { sessions, session, engine, seed } = fixture(t);
  seed();
  await assert.rejects(engine({ async compact() { assert.fail("no summary without leaf metadata"); } }, undefined, async () => {
    throw Object.assign(new Error("PRIVATE_CATALOG_ERROR"), { code: "model_not_found" });
  }).compactNow(session.id, { signal: new AbortController().signal }), { code: "model_not_found" });
  const note = sessions.events(session.id).find((event) => (event.payload as { code?: string }).code === "compaction_failed");
  assert.match(JSON.stringify(note), /"stage":"model"/);
  assert.doesNotMatch(JSON.stringify(note), /PRIVATE_CATALOG_ERROR/);
});

test("incomplete or shortened remote summaries warn even without local excerpts", async (t) => {
  const { engine, session, seed } = fixture(t);
  seed();
  const warnings: string[] = [];
  const result = await engine({ async compact() { return { ...checkpoint("SHORTENED"), compaction_details: {
    total_parts: 2, semantic_parts: 2, local_parts: 0, quality: { truncated_parts: 1, incomplete_parts: 1 },
  } }; } }).compactNow(session.id, { signal: new AbortController().signal, callbacks: { onWarning: (s) => warnings.push(s) } });
  assert.equal(result?.degraded, true);
  assert.match(warnings.join(" "), /1 trimmed, 1 incomplete/);
  assert.doesNotMatch(warnings.join(" "), /local recovery|local excerpts/);
});

test("compaction checkpoints redact configured credentials before persistence", async (t) => {
  const { sessions, session, config, engine, seed } = fixture(t);
  seed();
  const name = "GLASS_COMPACTION_TEST_CREDENTIAL";
  const previous = process.env[name];
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  process.env[name] = "synthetic-compaction-credential";
  config.gateway.apiKeyEnv = name;
  await engine({ async compact() { return checkpoint("Keep safety; synthetic-compaction-credential must not persist"); } })
    .compactNow(session.id, { signal: new AbortController().signal });
  assert.doesNotMatch(JSON.stringify(sessions.latestCheckpoint(session.id)), /synthetic-compaction-credential/);
  assert.match(JSON.stringify(sessions.latestCheckpoint(session.id)), /Keep safety/);
});

for (const status of [200, 503]) {
  test(`native HTTP ${status} authentication failures never trigger semantic recovery`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls += 1;
      return globalThis.Response.json({ error: { code: "invalid_api_key", message: "invalid credentials" } }, { status });
    });
    await assert.rejects(new CodexLbClient(structuredClone(DEFAULT_CONFIG)).compact({ model: "test", instructions: "summarize",
      input: [user("history")], promptCacheKey: "test", fast: false }), { code: "invalid_api_key" });
    assert.equal(calls, 1);
  });
}

test("caller cancellation during native compaction never starts semantic recovery", async (t) => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    calls += 1;
    return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
  });
  const pending = new CodexLbClient(structuredClone(DEFAULT_CONFIG)).compact({ model: "test", instructions: "summarize",
    input: [user("history")], promptCacheKey: "test", fast: false, signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(calls, 1);
});

test("native timeout reaches semantic fallback with a separate unexpired signal", async (t) => {
  const config = structuredClone(DEFAULT_CONFIG);
  const timers: { milliseconds: number; controller: AbortController }[] = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    const controller = new AbortController();
    timers.push({ milliseconds, controller });
    return controller.signal;
  });
  let semanticCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/responses/compact")) {
      return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
    }
    semanticCalls += 1;
    assert.equal(init.signal?.aborted, false);
    return globalThis.Response.json(answer("summary", "SEMANTIC_RECOVERY"));
  });
  const pending = new CodexLbClient(config).compact({ model: "test", instructions: "summarize", input: [user("history")],
    promptCacheKey: "test", fast: false });
  assert.equal(timers[0]?.milliseconds, 30_000);
  timers[0]?.controller.abort(new DOMException("timeout", "TimeoutError"));
  const compact = await pending;
  assert.equal(semanticCalls, 1);
  assert.match(JSON.stringify(compact), /SEMANTIC_RECOVERY/);
});

for (const nativeResult of ["unavailable", "empty"] as const) {
  test(`native ${nativeResult} response reaches semantic fallback`, async (t) => {
    let semanticCalls = 0;
    t.mock.method(globalThis, "fetch", async (url: string) => {
      if (url.endsWith("/responses/compact")) return nativeResult === "unavailable"
        ? globalThis.Response.json({ error: { code: "server_error", message: "unavailable" } }, { status: 503 })
        : globalThis.Response.json({ output: [] });
      semanticCalls += 1;
      return globalThis.Response.json(answer("summary", "SEMANTIC_RECOVERY"));
    });
    await new CodexLbClient(structuredClone(DEFAULT_CONFIG)).compact({ model: "test", instructions: "summarize",
      input: [user("history")], promptCacheKey: "test", fast: false });
    assert.equal(semanticCalls, 1);
  });
}
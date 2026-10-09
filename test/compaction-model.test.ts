import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { CodexLbClient, type CompactRequest } from "../src/model/codex-lb.js";
import { compactionFailure, CompactionDiagnostics } from "../src/model/compaction-diagnostics.js";

const answer = (text = "DURABLE_SUMMARY") => ({
  id: "summary", status: "completed", output: [{ type: "message", role: "assistant",
    content: [{ type: "output_text", text }] }],
  usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
});
const request = (characters = 100): CompactRequest => ({
  model: "gpt-6-astra", instructions: "Preserve requirements and tool outcomes",
  input: [{ role: "user", content: [{ type: "input_text", text: "x".repeat(characters) }] }],
  promptCacheKey: "DO_NOT_SEND_AFFINITY", fast: false, semanticOnly: true,
});
const limits = { contextWindow: 272_000, maxOutputTokens: null };

for (const profile of [
  { label: "Astra", model: "gpt-6-astra", supportsReasoning: true,
    reasoningEfforts: ["medium", "ultra", "xhigh", "low", "high", "max"] as const, expected: "low" },
  { label: "Luna", model: "gpt-5.6-luna", supportsReasoning: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] as const, expected: "low" },
  { label: "optional reasoning", model: "optional", supportsReasoning: true,
    reasoningEfforts: ["high", "none", "low"] as const, expected: "none" },
  { label: "minimal reasoning", model: "minimal", supportsReasoning: true,
    reasoningEfforts: ["medium", "minimal"] as const, expected: "minimal" },
  { label: "mandatory medium", model: "mandatory", supportsReasoning: true,
    reasoningEfforts: ["high", "medium"] as const, expected: "medium" },
  { label: "nonreasoning", model: "nonreasoning", supportsReasoning: false,
    reasoningEfforts: ["none"] as const, expected: undefined },
  { label: "unknown", model: "unknown", supportsReasoning: undefined,
    reasoningEfforts: undefined, expected: undefined },
] as const) {
  test(`semantic compaction respects ${profile.label} capabilities on every part`, async (t) => {
    const config = structuredClone(DEFAULT_CONFIG);
    const client = new CodexLbClient(config);
    t.after(() => client.close());
    const bodies: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      assert.ok(url.endsWith("/responses"));
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      assert.equal(body.model, profile.model);
      assert.deepEqual(body.tools, []);
      assert.equal(body.store, false);
      assert.deepEqual(body.text, { verbosity: "low" });
      assert.equal("previous_response_id" in body, false);
      assert.equal("prompt_cache_key" in body, false);
      assert.equal("include" in body, false);
      assert.equal("service_tier" in body, false);
      // Reproduce strict gateways: an unadvertised effort is an HTTP 400.
      if (body.reasoning && !profile.reasoningEfforts?.some(e => e === body.reasoning.effort)) {
        return Response.json({ error: { type: "invalid_request_error", code: "unsupported_value",
          param: "reasoning.effort", message: "unsupported reasoning effort" } }, { status: 400 });
      }
      return Response.json(answer());
    });
    const compact = await client.compact({ ...request(70_000), model: profile.model, modelInfo: {
      ...limits,
      ...(profile.supportsReasoning !== undefined ? { supportsReasoning: profile.supportsReasoning } : {}),
      ...(profile.reasoningEfforts ? { reasoningEfforts: [...profile.reasoningEfforts] } : {}),
    } });
    assert.equal(bodies.length, 3);
    for (const body of bodies) assert.deepEqual(body.reasoning, profile.expected ? { effort: profile.expected } : undefined);
    assert.equal((compact.compaction_details as { local_parts: number }).local_parts, 0);
    assert.match(JSON.stringify(compact.output), /DURABLE_SUMMARY/);
  });
}

test("reasoning-only output exhaustion grows the part allowance within the leaf ceiling", async (t) => {
  const client = new CodexLbClient(structuredClone(DEFAULT_CONFIG));
  t.after(() => client.close());
  const budgets: number[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.reasoning, { effort: "low" });
    budgets.push(body.max_output_tokens);
    if (body.max_output_tokens < 8_192) return Response.json({
      status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "reasoning", summary: [] }], usage: { input_tokens: 10, output_tokens: 4_096 },
    });
    return Response.json(answer());
  });
  const compact = await client.compact({ ...request(40_000), modelInfo: {
    ...limits, maxOutputTokens: 8_192, supportsReasoning: true, reasoningEfforts: ["low", "high"],
  } });
  assert.deepEqual(budgets, [4_096, 4_096, 8_192, 8_192]);
  assert.deepEqual(compact.usage, { input_tokens: 40, output_tokens: 8_196, total_tokens: 8_236 });
  const details = compact.compaction_details as { local_parts: number; quality: { max_output_tokens_per_part: number } };
  assert.equal(details.local_parts, 0);
  assert.equal(details.quality.max_output_tokens_per_part, 8_192);
});

test("large reasoning compactions reach the leaf ceiling before exhausting part retries", async (t) => {
  const client = new CodexLbClient(structuredClone(DEFAULT_CONFIG));
  t.after(() => client.close());
  const budgets = new Map<number, number[]>();
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const part = Number(/transcript part (\d+) of/u.exec(body.instructions)?.[1]);
    budgets.set(part, [...(budgets.get(part) ?? []), body.max_output_tokens]);
    assert.ok(body.max_output_tokens <= 8_192);
    if (body.max_output_tokens < 8_192) return Response.json({
      status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "reasoning", summary: [] }],
    });
    return Response.json(answer());
  });
  const compact = await client.compact({ ...request(300_000), modelInfo: {
    ...limits, maxOutputTokens: 8_192, supportsReasoning: true, reasoningEfforts: ["low", "high"],
  } });
  assert.equal(budgets.size, 10);
  for (const attempts of budgets.values()) assert.deepEqual(attempts, [1_024, 2_048, 8_192]);
  assert.equal((compact.compaction_details as { semantic_parts: number }).semantic_parts, 10);
  assert.equal((compact.compaction_details as { local_parts: number }).local_parts, 0);
});

test("semantic requests respect explicit output ceilings", async (t) => {
  const client = new CodexLbClient(structuredClone(DEFAULT_CONFIG));
  t.after(() => client.close());
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    assert.equal(JSON.parse(String(init.body)).max_output_tokens, 128);
    return Response.json(answer());
  });
  await client.compact({ ...request(), maxOutputTokens: 128, modelInfo: limits });
});

for (const status of [400, 401]) {
  test(`permanent HTTP ${status} rejects promptly and cancels hung siblings without late progress`, async (t) => {
    const client = new CodexLbClient(structuredClone(DEFAULT_CONFIG));
    t.after(() => client.close());
    const signals: AbortSignal[] = [];
    let resolveLate!: (value: Response) => void;
    let fail!: (value: Response) => void;
    let markProgress!: () => void;
    const progress = new Promise<void>((resolve) => { markProgress = resolve; });
    const partials: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      signals.push(init.signal!);
      const body = JSON.parse(String(init.body));
      if (body.instructions.includes("transcript part 1 of")) return Response.json(answer("FIRST_PART"));
      if (body.instructions.includes("transcript part 2 of")) return new Promise<Response>((resolve) => { fail = resolve; });
      return new Promise<Response>((resolve) => { resolveLate = resolve; });
    });
    const pending = client.compact({ ...request(70_000), onPartialCheckpoint: (snapshot) => {
      partials.push(snapshot); markProgress();
    } });
    const rejected = assert.rejects(pending, { status });
    await progress;
    fail(Response.json({ error: { code: status === 400 ? "invalid_request_error" : "invalid_api_key" } }, { status }));
    await rejected;
    assert.equal(signals.length, 3);
    assert.ok(signals.every((signal) => signal.aborted));
    assert.equal(partials.length, 1);
    resolveLate(Response.json(answer("LATE_MUST_NOT_COMMIT")));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(partials.length, 1);
    assert.doesNotMatch(JSON.stringify(partials), /LATE_MUST_NOT_COMMIT/);
  });
}

for (const hang of ["fetch", "body"] as const) {
  test(`caller cancellation promptly settles an abort-ignoring ${hang}`, async (t) => {
    const client = new CodexLbClient(structuredClone(DEFAULT_CONFIG));
    t.after(() => client.close());
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let resolveLate!: () => void;
    t.mock.method(globalThis, "fetch", async () => {
      if (hang === "fetch") {
        markStarted();
        return new Promise<Response>((resolve) => { resolveLate = () => resolve(Response.json(answer())); });
      }
      return { ok: true, text: () => {
        markStarted();
        return new Promise<string>((resolve) => { resolveLate = () => resolve(JSON.stringify(answer())); });
      } } as Response;
    });
    let progress = 0;
    const pending = client.compact({ ...request(), signal: controller.signal, onPartialCheckpoint: () => { progress += 1; } });
    const rejected = assert.rejects(pending, (error) => error === reason);
    await started;
    controller.abort(reason);
    await rejected;
    resolveLate();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(progress, 0);
  });
}

test("pre-cancelled compaction never contacts the provider", async (t) => {
  const client = new CodexLbClient(structuredClone(DEFAULT_CONFIG));
  t.after(() => client.close());
  const reason = new Error("already cancelled");
  t.mock.method(globalThis, "fetch", async () => assert.fail("cancelled request must not dispatch"));
  await assert.rejects(client.compact({ ...request(), signal: AbortSignal.abort(reason) }), (error) => error === reason);
});

test("throwing semantic progress observers cannot discard completed parts", async (t) => {
  const client = new CodexLbClient(structuredClone(DEFAULT_CONFIG));
  t.after(() => client.close());
  t.mock.method(globalThis, "fetch", async () => Response.json(answer()));
  const compact = await client.compact({ ...request(),
    onStatus: () => { throw new Error("status observer"); },
    onPartialCheckpoint: () => { throw new Error("partial observer"); },
  });
  assert.equal((compact.compaction_details as { semantic_parts: number }).semantic_parts, 1);
});

test("compaction diagnostics retain only allowlisted parameters and give a safe reasoning hint", () => {
  const error = { status: 400, error: { code: "unsupported_value", type: "invalid_request_error",
    param: "reasoning.effort", message: "PRIVATE_REQUEST Bearer secret-value" } };
  const failure = compactionFailure(error, "semantic", { part: 2, attempt: 1 });
  assert.equal(failure.param, "reasoning.effort");
  const diagnostics = new CompactionDiagnostics();
  diagnostics.record(failure, "semantic", failure);
  assert.match(diagnostics.summary(), /HTTP 400.*reasoning.effort.*check leaf model reasoning support/);
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE_REQUEST|secret-value/);
  assert.equal(compactionFailure({ ...error, error: { ...error.error, param: "input.PRIVATE_REQUEST" } }, "semantic").param, undefined);
});
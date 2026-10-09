import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { CodexLbClient, type CompactRequest } from "../src/model/codex-lb.js";

const answer = (text: string, incomplete = false) => ({
  id: "summary", status: incomplete ? "incomplete" : "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
  usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
});
const request = (parts = 11): CompactRequest => ({
  model: "gpt-6-astra", instructions: "Preserve requirements and tool outcomes",
  input: [{ role: "user", content: [{ type: "input_text", text: "x".repeat(32_768 * parts - "USER: ".length) }] }],
  promptCacheKey: "DO_NOT_SEND_AFFINITY", fast: false, semanticOnly: true,
  modelInfo: { contextWindow: 272_000, maxOutputTokens: null, supportsReasoning: true, reasoningEfforts: ["low", "high"] },
});
const textOf = (compact: Record<string, unknown>) =>
  (compact.output as { content: { text: string }[] }[])[0]!.content[0]!.text;
const detailsOf = (compact: Record<string, unknown>) => compact.compaction_details as {
  total_parts: number; semantic_parts: number; local_parts: number; attempts: number;
  protocol_failures: number; transient_failures: number;
  quality: { truncated_parts: number; incomplete_parts: number; max_output_tokens_per_part: number;
    checkpoint_character_budget: number; checkpoint_characters: number };
};

for (const provider of ["codex-lb", "custom"] as const) {
  test(`${provider} shortens nine overflowing summaries without cutting their durable facts`, async (t) => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.gateway.provider = provider;
    const client = new CodexLbClient(config);
    t.after(() => client.close());
    const calls = new Map<number, number>();
    const inputs = new Map<number, unknown>();
    const snapshots: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const part = Number(/transcript part (\d+) of 11/u.exec(body.instructions)?.[1]);
      assert.ok(part >= 1 && part <= 11);
      const attempt = (calls.get(part) ?? 0) + 1;
      calls.set(part, attempt);
      assert.equal(body.max_output_tokens, 1_024);
      if (provider === "codex-lb") assert.deepEqual(body.reasoning, { effort: "low" });
      if (attempt === 1) inputs.set(part, body.input);
      else {
        assert.match(body.instructions, /previous summary was too long/);
        assert.deepEqual(body.input, inputs.get(part), "shortening must rebuild from source, not an already cut summary");
      }
      const length = attempt > 1 ? 2_000 : part <= 9 ? 3_600 : part === 10 ? 2_700 : 700;
      return Response.json(answer(`HEAD_${part} ${"x".repeat(length)} DURABLE_FACT_${part} TAIL_${part}`));
    });
    const compact = await client.compact({ ...request(), onPartialCheckpoint: (snapshot) => snapshots.push(snapshot) });
    assert.equal(detailsOf(compact).quality.truncated_parts, 0);
    assert.equal(detailsOf(compact).quality.incomplete_parts, 0);
    assert.equal(detailsOf(compact).total_parts, 11);
    assert.equal(detailsOf(compact).semantic_parts, 11);
    assert.equal(detailsOf(compact).local_parts, 0);
    assert.equal(detailsOf(compact).attempts, 20);
    for (let part = 1; part <= 11; part += 1) {
      assert.equal(calls.get(part), part <= 9 ? 2 : 1);
      assert.match(textOf(compact), new RegExp(`DURABLE_FACT_${part} TAIL_${part}`));
    }
    assert.deepEqual(compact.usage, { input_tokens: 200, output_tokens: 40, total_tokens: 240 });
    assert.ok(snapshots.some((snapshot) => detailsOf(snapshot).semantic_parts === 11
      && detailsOf(snapshot).quality.truncated_parts === 9));
    for (const snapshot of snapshots) {
      assert.ok(textOf(snapshot).length <= 32_768);
      assert.equal(detailsOf(snapshot).quality.checkpoint_character_budget, 32_768);
      assert.equal(detailsOf(snapshot).quality.checkpoint_characters, textOf(snapshot).length);
    }
    assert.doesNotMatch(textOf(compact), /\.\.\.\[truncated\]\.\.\./);
  });
}

for (const priorFailures of [1, 2]) {
  test(`shortening shares the three-attempt budget after ${priorFailures} initial failures`, async (t) => {
    const client = new CodexLbClient(structuredClone(DEFAULT_CONFIG));
    t.after(() => client.close());
    const calls = new Map<number, number[]>();
    let rewrites = 0;
    t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const part = Number(/transcript part (\d+) of 2/u.exec(body.instructions)?.[1]);
      const budgets = calls.get(part) ?? [];
      budgets.push(body.max_output_tokens);
      calls.set(part, budgets);
      if (budgets.length <= priorFailures) return Response.json({
        status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [],
      });
      if (body.instructions.includes("previous summary was too long")) {
        rewrites += 1;
        return Response.json(answer(`SHORT_${part}`));
      }
      return Response.json(answer(`HEAD_${part} ${"x".repeat(18_000)} TAIL_${part}`));
    });
    const compact = await client.compact(request(2));
    assert.equal(calls.size, 2);
    for (const budgets of calls.values()) assert.deepEqual(budgets, [4_096, 8_192, 8_192]);
    assert.equal(rewrites, priorFailures === 1 ? 2 : 0);
    assert.equal(detailsOf(compact).attempts, 6);
    assert.equal(detailsOf(compact).semantic_parts, 2);
    assert.equal(detailsOf(compact).local_parts, 0);
    assert.equal(detailsOf(compact).quality.truncated_parts, priorFailures === 1 ? 0 : 2);
    assert.equal(detailsOf(compact).quality.max_output_tokens_per_part, 8_192);
  });
}

for (const outcome of ["larger", "incomplete", "empty", "outage"] as const) {
  test(`a ${outcome} shortening preserves the previous summary and truthful trimming`, async (t) => {
    const client = new CodexLbClient(structuredClone(DEFAULT_CONFIG));
    t.after(() => client.close());
    let calls = 0;
    const failures: unknown[] = [];
    t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      assert.equal(body.max_output_tokens, 8_192);
      if (++calls === 1) return Response.json(answer(`ORIGINAL_HEAD ${"😀".repeat(18_000)} ORIGINAL_TAIL`));
      if (outcome === "outage") return Response.json({ error: { code: "server_error" } }, { status: 503 });
      return Response.json(answer(outcome === "larger" ? `WRONG ${"x".repeat(40_000)}`
        : outcome === "empty" ? "" : "WRONG_INCOMPLETE", outcome === "incomplete"));
    });
    const compact = await client.compact({ ...request(1), onFailure: (failure) => failures.push(failure) });
    assert.equal(calls, outcome === "empty" || outcome === "outage" ? 3 : 2);
    assert.equal(detailsOf(compact).attempts, calls);
    assert.equal(detailsOf(compact).local_parts, 0);
    assert.equal(detailsOf(compact).semantic_parts, 1);
    assert.equal(detailsOf(compact).quality.truncated_parts, 1);
    assert.equal(detailsOf(compact).quality.incomplete_parts, 0);
    assert.equal(detailsOf(compact).protocol_failures, outcome === "empty" ? 2 : 0);
    assert.equal(detailsOf(compact).transient_failures, outcome === "outage" ? 2 : 0);
    assert.equal(failures.length, outcome === "empty" || outcome === "outage" ? 2 : 0);
    assert.match(textOf(compact), /ORIGINAL_HEAD/);
    assert.match(textOf(compact), /ORIGINAL_TAIL/);
    assert.doesNotMatch(textOf(compact), /WRONG|[\uD800-\uDFFF]/u);
    assert.ok(textOf(compact).length <= 32_768);
  });
}

for (const incomplete of [false, true]) {
  test(`rebuilding a ${incomplete ? "incomplete" : "complete"} oversized part clears only repaired quality flags`, async (t) => {
    const client = new CodexLbClient(structuredClone(DEFAULT_CONFIG));
    t.after(() => client.close());
    let calls = 0;
    const inputs: unknown[] = [];
    t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      inputs.push(body.input);
      return Response.json(++calls === 1 ? answer("x".repeat(40_000), incomplete) : answer("REBUILT_FROM_SOURCE"));
    });
    const compact = await client.compact(request(1));
    assert.equal(calls, 2);
    assert.deepEqual(inputs[0], inputs[1]);
    assert.equal(detailsOf(compact).quality.truncated_parts, 0);
    assert.equal(detailsOf(compact).quality.incomplete_parts, 0);
    assert.match(textOf(compact), /REBUILT_FROM_SOURCE/);
  });
}

for (const failure of ["cancel", 400, 401] as const) {
  test(`shortening ${failure} cancels hung siblings without committing late output`, async (t) => {
    const client = new CodexLbClient(structuredClone(DEFAULT_CONFIG));
    t.after(() => client.close());
    const controller = new AbortController();
    const reason = new Error("cancelled shortening");
    const signals: AbortSignal[] = [];
    const late = new Map<number, (response: Response) => void>();
    let started!: () => void;
    const shortening = new Promise<void>((resolve) => { started = resolve; });
    const snapshots: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const part = Number(/transcript part (\d+) of 2/u.exec(body.instructions)?.[1]);
      if (!body.instructions.includes("previous summary was too long")) {
        return Response.json(answer(`HEAD_${part} ${"x".repeat(18_000)} TAIL_${part}`));
      }
      signals.push(init.signal!);
      return new Promise<Response>((resolve) => {
        late.set(part, resolve);
        if (late.size === 2) started();
      });
    });
    const pending = client.compact({ ...request(2), signal: controller.signal,
      onPartialCheckpoint: (snapshot) => snapshots.push(snapshot) });
    const rejected = failure === "cancel" ? assert.rejects(pending, (error) => error === reason)
      : assert.rejects(pending, { status: failure });
    await shortening;
    assert.equal(snapshots.length, 2);
    assert.equal(detailsOf(snapshots.at(-1)!).semantic_parts, 2);
    assert.equal(detailsOf(snapshots.at(-1)!).quality.truncated_parts, 2);
    if (failure === "cancel") controller.abort(reason);
    else late.get(1)!(Response.json({ error: { code: failure === 400 ? "invalid_request_error" : "invalid_api_key" } }, { status: failure }));
    await rejected;
    assert.ok(signals.every((signal) => signal.aborted));
    if (failure === "cancel") late.get(1)!(Response.json(answer("LATE_MUST_NOT_COMMIT")));
    late.get(2)!(Response.json(answer("LATE_MUST_NOT_COMMIT")));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(snapshots.length, 2);
    assert.doesNotMatch(JSON.stringify(snapshots), /LATE_MUST_NOT_COMMIT/);
  });
}
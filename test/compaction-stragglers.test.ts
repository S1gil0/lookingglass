import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { CodexLbClient, type CompactRequest } from "../src/model/codex-lb.js";

const answer = (text: string) => ({
  id: "summary", status: "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
  usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
});
const request = (parts: number): CompactRequest => ({
  model: "gpt-6-astra", instructions: "Preserve requirements and tool outcomes",
  input: [{ role: "user", content: [{ type: "input_text", text: "x".repeat(32_768 * parts - "USER: ".length) }] }],
  promptCacheKey: "DO_NOT_SEND_AFFINITY", fast: false, semanticOnly: true,
  modelInfo: { contextWindow: 272_000, maxOutputTokens: null, supportsReasoning: true, reasoningEfforts: ["low", "high"] },
});
const textOf = (compact: Record<string, unknown>) =>
  (compact.output as { content: { text: string }[] }[])[0]!.content[0]!.text;
const detailsOf = (compact: Record<string, unknown>) => compact.compaction_details as {
  total_parts: number; semantic_parts: number; local_parts: number; attempts: number; protocol_failures: number;
  quality: { truncated_parts: number; max_output_tokens_per_part: number; checkpoint_characters: number };
};
const summary = (part: number, length: number, rewritten = false): string => {
  const head = `${rewritten ? "REWRITTEN" : "ORIGINAL"}_${part} `;
  const tail = ` DURABLE_FACT_${part}`;
  return `${head}${"x".repeat(length - head.length - tail.length)}${tail}`;
};
// Never await a dispatch/progress promise: the old completion barrier must fail
// an assertion promptly, rather than leave the test waiting for a straggler.
const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 3; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

interface Call {
  part: number;
  shortening: boolean;
  ceiling: number;
  tokens: number;
  input: unknown;
  signal: AbortSignal;
  responded: boolean;
  reply(response: Response): void;
}

function controlledCompaction(t: TestContext, parts = 6) {
  const client = new CodexLbClient(structuredClone(DEFAULT_CONFIG));
  const controller = new AbortController();
  const calls: Call[] = [];
  const snapshots: Record<string, unknown>[] = [];
  const state: { settled: boolean; result?: Record<string, unknown>; error?: unknown } = { settled: false };
  let active = 0;
  let peak = 0;
  // Caller deadlines and fetch completions are driven manually, not by real
  // 120-second attempt timers. Node's test mock tracker restores both methods.
  t.mock.method(AbortSignal, "timeout", () => new AbortController().signal);
  t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    active += 1;
    peak = Math.max(peak, active);
    return new Promise<Response>((resolve) => {
      const call: Call = {
        part: Number(/transcript part (\d+) of/u.exec(body.instructions)?.[1]),
        shortening: body.instructions.includes("previous summary was too long"),
        ceiling: Number(/at or below (\d+) characters/u.exec(body.instructions)?.[1]),
        tokens: body.max_output_tokens, input: body.input, signal: init.signal!, responded: false,
        reply(response) {
          assert.equal(call.responded, false, "each controlled fetch is resolved only once");
          call.responded = true;
          active -= 1;
          resolve(response);
        },
      };
      calls.push(call);
    });
  });
  const pending = client.compact({ ...request(parts), signal: controller.signal,
    onPartialCheckpoint: (snapshot) => snapshots.push(snapshot) });
  void pending.then((result) => { state.result = result; state.settled = true; },
    (error: unknown) => { state.error = error; state.settled = true; });
  t.after(async () => {
    controller.abort(new Error("controlled compaction cleanup"));
    for (const call of calls.filter((call) => !call.responded)) call.reply(Response.json(answer("CLEANUP")));
    await flush();
    client.close();
  });
  return {
    calls, snapshots, state, controller,
    active: () => active,
    peak: () => peak,
    initial(part: number): Call {
      const call = calls.find((call) => call.part === part && !call.shortening);
      assert.ok(call, `initial part ${part} should have been dispatched`);
      return call;
    },
    rewrites: () => calls.filter((call) => call.shortening),
    result(): Record<string, unknown> {
      assert.equal(state.settled, true, "compaction should settle after bounded event-loop flushing");
      assert.ifError(state.error);
      assert.ok(state.result);
      return state.result;
    },
  };
}

test("six-part compaction publishes shorter completed material before a hung initial part's deadline", async (t) => {
  const run = controlledCompaction(t);
  // These five summaries fit without framing, but overflow even if part 6 is
  // empty once the checkpoint prefix, separators, and all six labels count.
  assert.ok(5 * 6_530 < 32_768);
  for (let part = 1; part <= 4; part += 1) run.initial(part).reply(Response.json(answer(summary(part, 6_530))));
  await flush();
  run.initial(5).reply(Response.json(answer(summary(5, 6_530))));
  await flush();
  assert.equal(run.initial(6).responded, false);
  assert.ok(run.rewrites().length > 0, "completed overflow must shorten while initial part 6 is still pending");
  const firstRewrite = run.rewrites()[0]!;
  assert.equal(firstRewrite.ceiling, run.initial(firstRewrite.part).ceiling,
    "shortening must reserve the actual partial checkpoint's local placeholder, not borrow its space");
  for (let wave = 0; wave < 3; wave += 1) {
    for (const call of run.rewrites().filter((call) => !call.responded)) {
      assert.deepEqual(call.input, run.initial(call.part).input, "rewrite from the original transcript");
      assert.equal(call.tokens, 1_365, "shortening does not raise the six-part output cap");
      call.reply(Response.json(answer(summary(call.part, 2_000, true))));
    }
    await flush();
  }
  assert.deepEqual(run.rewrites().map((call) => call.part).sort(), [1, 2, 3, 4, 5]);
  assert.equal(run.state.settled, false);
  assert.ok(run.snapshots.some((snapshot) => detailsOf(snapshot).semantic_parts === 5
    && detailsOf(snapshot).quality.truncated_parts === 5));
  const repaired = run.snapshots.at(-1)!;
  assert.equal(detailsOf(repaired).semantic_parts, 5);
  assert.equal(detailsOf(repaired).local_parts, 1);
  assert.equal(detailsOf(repaired).quality.truncated_parts, 0);
  for (let part = 1; part <= 5; part += 1) {
    assert.match(textOf(repaired), new RegExp(`REWRITTEN_${part}`));
    assert.match(textOf(repaired), new RegExp(`DURABLE_FACT_${part}`));
  }
  assert.ok(run.snapshots.every((snapshot) => textOf(snapshot).length <= 32_768
    && detailsOf(snapshot).quality.checkpoint_characters === textOf(snapshot).length));
  assert.ok(run.peak() <= 4);

  const deadline = new DOMException("compaction deadline", "TimeoutError");
  run.controller.abort(deadline);
  await flush();
  assert.equal(run.state.settled, true);
  assert.equal(run.state.error, deadline);
  assert.ok(run.initial(6).signal.aborted);
  const snapshotsBeforeLateResponse = run.snapshots.length;
  run.initial(6).reply(Response.json(answer("LATE_INITIAL_MUST_NOT_COMMIT")));
  await flush();
  assert.equal(run.snapshots.length, snapshotsBeforeLateResponse);
  assert.doesNotMatch(JSON.stringify(run.snapshots), /LATE_INITIAL_MUST_NOT_COMMIT/);
});

test("local placeholders cannot trigger speculative shortening when completed summaries fit", async (t) => {
  const run = controlledCompaction(t);
  for (let part = 1; part <= 4; part += 1) run.initial(part).reply(Response.json(answer(summary(part, 6_000))));
  await flush();
  run.initial(5).reply(Response.json(answer(summary(5, 6_000))));
  await flush();
  const partial = run.snapshots.at(-1)!;
  assert.equal(detailsOf(partial).semantic_parts, 5);
  assert.equal(detailsOf(partial).local_parts, 1);
  assert.equal(detailsOf(partial).quality.truncated_parts, 5, "the local placeholder really clips completed material");
  assert.equal(run.calls.length, 6);
  assert.equal(run.rewrites().length, 0, "pending-empty demand fits despite the placeholder's temporary clipping");
  assert.equal(run.state.settled, false);

  run.initial(6).reply(Response.json(answer("SMALL_LAST_PART")));
  await flush();
  const compact = run.result();
  assert.equal(run.calls.length, 6, "the final small summary removes clipping without any rewrite");
  assert.equal(detailsOf(compact).semantic_parts, 6);
  assert.equal(detailsOf(compact).quality.truncated_parts, 0);
  for (let part = 1; part <= 5; part += 1) assert.ok(textOf(compact).includes(summary(part, 6_000)));
});

test("undispatched initial parts outrank shortening in the fixed four-request pool", async (t) => {
  const run = controlledCompaction(t);
  assert.equal(run.active(), 4);
  run.initial(1).reply(Response.json(answer(summary(1, 20_000))));
  await flush();
  assert.deepEqual(run.calls.map((call) => call.part), [1, 2, 3, 4, 5]);
  run.initial(2).reply(Response.json(answer(summary(2, 20_000))));
  await flush();
  assert.deepEqual(run.calls.map((call) => call.part), [1, 2, 3, 4, 5, 6]);
  assert.ok(run.calls.every((call) => !call.shortening), "part 6 takes the slot even though parts 1 and 2 already overflow");
  assert.equal(run.active(), 4);

  run.initial(3).reply(Response.json(answer("SMALL_3")));
  await flush();
  assert.equal(run.rewrites().length, 1, "only one slot is free while three initial siblings hang");
  run.initial(4).reply(Response.json(answer("SMALL_4")));
  await flush();
  assert.equal(run.rewrites().length, 2);
  assert.equal(run.active(), 4);
  assert.equal(run.peak(), 4);
  for (const call of run.rewrites()) call.reply(Response.json(answer(summary(call.part, 19_000, true))));
  run.initial(5).reply(Response.json(answer("SMALL_5")));
  run.initial(6).reply(Response.json(answer("SMALL_6")));
  await flush();
  const compact = run.result();
  assert.equal(detailsOf(compact).semantic_parts, 6);
  assert.equal(detailsOf(compact).quality.truncated_parts, 2);
  assert.equal(run.calls.length, 8, "a noncompliant but shorter rewrite must not schedule another shortening pass");
  assert.deepEqual(run.rewrites().map((call) => call.part).sort(), [1, 2]);
  assert.equal(run.peak(), 4);
});

test("staggered initial completions wake idle workers to shorten in parallel with a straggler", async (t) => {
  const run = controlledCompaction(t);
  for (let part = 1; part <= 3; part += 1) {
    run.initial(part).reply(Response.json(answer(summary(part, 7_000))));
    await flush();
  }
  assert.equal(run.calls.length, 6);
  assert.equal(run.active(), 3);
  assert.equal(run.rewrites().length, 0);
  run.initial(4).reply(Response.json(answer(summary(4, 7_000))));
  await flush();
  assert.equal(run.active(), 2, "two workers now wait with no proven overflow");
  assert.equal(run.rewrites().length, 0);

  run.initial(5).reply(Response.json(answer(summary(5, 7_000))));
  await flush();
  assert.equal(run.rewrites().length, 3, "the completing worker must wake both idle workers, not shorten alone");
  assert.equal(run.active(), 4, "three rewrites share the pool with the hung initial part");
  for (const call of run.rewrites()) call.reply(Response.json(answer(summary(call.part, 1_000, true))));
  await flush();
  assert.equal(run.rewrites().length, 5, "already scheduled parts are each serviced once");
  for (const call of run.rewrites().filter((call) => !call.responded)) {
    call.reply(Response.json(answer(summary(call.part, 1_000, true))));
  }
  await flush();
  assert.equal(detailsOf(run.snapshots.at(-1)!).quality.truncated_parts, 0);
  assert.equal(run.active(), 1);
  assert.equal(run.state.settled, false);
  run.initial(6).reply(Response.json(answer("SMALL_6")));
  await flush();
  assert.equal(detailsOf(run.result()).semantic_parts, 6);
  assert.equal(run.calls.length, 11);
  assert.equal(run.peak(), 4);
});
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Response } from "openai/resources/responses/responses";
import { DEFAULT_CONFIG } from "../src/config.js";
import { ConversationEngine, extractRefusalNotice, type TurnMetrics } from "../src/engine/engine.js";
import type { CodexLbClient, ResponseRequest } from "../src/model/codex-lb.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { openDatabase } from "../src/storage/database.js";
import { SessionStore } from "../src/storage/session-store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { GlassTool } from "../src/tools/types.js";
import type { ModelInfo } from "../src/types.js";

const modelInfo: ModelInfo = {
  id: "test-model",
  name: "Test",
  description: "",
  contextWindow: 100_000,
  maxOutputTokens: null,
  reasoningEfforts: ["medium"],
  defaultReasoningEffort: "medium",
  defaultVerbosity: "low",
  supportsReasoning: true,
  supportsImages: false,
  supportsParallelToolCalls: true,
  supportsFast: false,
  priority: 1,
};

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-turn-metrics-"));
  const db = openDatabase(join(root, "state.db"));
  mkdirSync(join(root, "artifacts"));
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const sessions = new SessionStore(db);
  const session = sessions.create({ workspace: root, model: "test-model", reasoningEffort: "medium", verbosity: "low", fast: false });
  return { root, sessions, session, artifacts: new ArtifactStore(db, join(root, "artifacts")) };
}

function response(id: string, output: unknown[], text = ""): Response {
  return { id, status: "completed", output, output_text: text, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } as unknown as Response;
}

function toolCall(id: string, name: string): unknown {
  return { id: `function-${id}`, type: "function_call", status: "completed", name, arguments: "{}", call_id: `call-${id}` };
}

test("turn metrics count logical rounds, tools, leaf tasks, and bounded refusals", async (t) => {
  const { root, sessions, session, artifacts } = fixture(t);
  const runAgents: GlassTool<Record<string, never>> = {
    name: "run_agents",
    description: "test agent runner",
    risk: "read",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    summarize: () => "run agents",
    async execute() {
      return { output: "agent results", metadata: { agentTasksAttempted: 3 } };
    },
  };
  let requests = 0;
  const client = {
    supportsResponseContinuity: () => true,
    async stream(_request: ResponseRequest) {
      requests += 1;
      if (requests === 1) return response("tools", [toolCall("one", "run_agents")]);
      return response("refusal", [
        {
          id: "reasoning-summary",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "**Summarizing the delegated result**" }],
        },
        {
          id: "message-refusal",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "refusal", refusal: "Cannot do this\twithout exposing details." }],
        },
      ]);
    },
  } as unknown as CodexLbClient;
  const engine = new ConversationEngine(
    structuredClone(DEFAULT_CONFIG), root, sessions, artifacts, client,
    new ToolRegistry().register(runAgents), "instructions",
  );
  const callbacks: TurnMetrics[] = [];
  const reasoningSummaries: string[] = [];
  const result = await engine.turn(session.id, "delegate", {
    signal: new AbortController().signal,
    interaction: { approve: async () => "once", ask: async () => "" },
    callbacks: {
      onTurnComplete(metrics) {
        callbacks.push(metrics);
        throw new Error("observer failure");
      },
      onReasoningSummary(summary) {
        reasoningSummaries.push(summary);
      },
    },
    modelInfo,
  });

  assert.equal(result.metrics?.modelRounds, 2);
  assert.equal(result.metrics?.toolCalls, 1);
  assert.equal(result.metrics?.leafAgents, 3);
  assert.equal(result.metrics?.responseStatus, "completed");
  assert.equal(result.metrics?.refusalNotice, "Cannot do this without exposing details.");
  assert.deepEqual(reasoningSummaries, ["**Summarizing the delegated result**"]);
  assert.ok((result.metrics?.durationMs ?? -1) >= 0);
  assert.equal(callbacks.length, 1);
});

test("turn-complete metrics are emitted for incomplete failures", async (t) => {
  const { root, sessions, session, artifacts } = fixture(t);
  const error = Object.assign(new Error("provider payload omitted"), {
    responseStatus: "incomplete",
    incompleteReason: "max_output_tokens",
  });
  const client = {
    async stream() {
      throw error;
    },
  } as unknown as CodexLbClient;
  const engine = new ConversationEngine(
    structuredClone(DEFAULT_CONFIG), root, sessions, artifacts, client, new ToolRegistry(), "instructions",
  );
  let metrics: TurnMetrics | undefined;
  await assert.rejects(() => engine.turn(session.id, "incomplete", {
    signal: new AbortController().signal,
    interaction: { approve: async () => "once", ask: async () => "" },
    callbacks: {
      onTurnComplete(value) {
        metrics = value;
        throw new Error("observer failure");
      },
    },
    modelInfo,
  }), /provider payload omitted/);
  assert.equal(metrics?.modelRounds, 1);
  assert.equal(metrics?.responseStatus, "incomplete");
  assert.equal(metrics?.incompleteReason, "max_output_tokens");
  assert.ok((metrics?.durationMs ?? -1) >= 0);
});

test("refusal extraction ignores reasoning and bounds content", () => {
  const notice = extractRefusalNotice({ output: [
    { type: "reasoning", encrypted_content: "do not expose" },
    {
      type: "message",
      role: "user",
      content: [{ type: "refusal", refusal: "wrong role" }],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "refusal", refusal: `  ${"x".repeat(600)}  ` }],
    },
  ] } as unknown as Response);
  assert.equal(notice?.length, 512);
  assert.doesNotMatch(notice ?? "", /do not expose/);
});
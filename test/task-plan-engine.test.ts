import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Response } from "openai/resources/responses/responses";
import { DEFAULT_CONFIG } from "../src/config.js";
import { ConversationEngine } from "../src/engine/engine.js";
import type { CodexLbClient, ResponseRequest } from "../src/model/codex-lb.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { openDatabase } from "../src/storage/database.js";
import { SessionStore } from "../src/storage/session-store.js";
import { createCoreToolRegistry, createWorkerToolRegistry } from "../src/tools/index.js";
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

function fixture(t: TestContext, kind: "interactive" | "agent") {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-task-plan-engine-"));
  const artifactPath = join(root, "artifacts");
  mkdirSync(artifactPath);
  const db = openDatabase(join(root, "state.db"));
  const sessions = new SessionStore(db);
  const session = sessions.create({
    workspace: root,
    model: "test-model",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
    kind,
  });
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, db, sessions, session, artifacts: new ArtifactStore(db, artifactPath) };
}

function response(id: string, text: string): Response {
  return {
    id,
    status: "completed",
    output: text
      ? [{
          id: `message-${id}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
        }]
      : [],
    output_text: text,
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  } as unknown as Response;
}

function turnOptions() {
  return {
    signal: new AbortController().signal,
    interaction: { approve: async () => "once" as const, ask: async () => "" },
    modelInfo,
  };
}

test("main-session requests receive the saved task plan state and guidance", async (t) => {
  const { root, sessions, session, artifacts } = fixture(t, "interactive");
  const token = "task-plan-engine-token";
  assert.equal(sessions.acquireOperationLease(session.id, "test-owner", token, "turn"), true);
  const saved = sessions.saveTaskPlan(session.id, token, {
    items: [{
      id: "implement",
      content: "Implement the durable task plan integration",
      priority: "high",
      status: "in_progress",
    }],
  });
  assert.ok(saved);
  assert.equal(sessions.releaseOperationLease(session.id, "test-owner", token), true);

  const requests: ResponseRequest[] = [];
  const client = {
    async stream(request: ResponseRequest) {
      requests.push(request);
      if (requests.length === 1) {
        throw Object.assign(new Error("provider temporarily unavailable"), { status: 503 });
      }
      return response("main-response", "done");
    },
  } as unknown as CodexLbClient;
  const engine = new ConversationEngine(
    structuredClone(DEFAULT_CONFIG), root, sessions, artifacts, client, createCoreToolRegistry(), "base instructions",
    async () => undefined,
  );

  await engine.turn(session.id, "continue", turnOptions());

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.match(request.instructions, /TASK PLAN STATE/);
    assert.match(request.instructions, /snapshot sequence: 1/);
    assert.match(request.instructions, /Implement the durable task plan integration/);
    assert.match(request.instructions, /TASK PLAN GUIDANCE/);
    assert.ok(request.tools.some((tool) => tool.name === "task_plan"));
  }
});

test("agent-session requests omit task plan instructions and the task plan tool", async (t) => {
  const { root, sessions, session, artifacts } = fixture(t, "agent");
  const requests: ResponseRequest[] = [];
  const client = {
    async stream(request: ResponseRequest) {
      requests.push(request);
      return response("agent-response", "done");
    },
  } as unknown as CodexLbClient;
  const engine = new ConversationEngine(
    structuredClone(DEFAULT_CONFIG), root, sessions, artifacts, client, createWorkerToolRegistry(), "base instructions",
  );

  await engine.turn(session.id, "continue", turnOptions());

  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  assert.equal(request.instructions, "base instructions");
  assert.doesNotMatch(request.instructions, /TASK PLAN/);
  assert.equal(request.tools.some((tool) => tool.name === "task_plan"), false);
});
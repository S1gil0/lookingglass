import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Response } from "openai/resources/responses/responses";
import { AgentCoordinator } from "../src/agents/coordinator.js";
import { LookingGlassApp } from "../src/app.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { ResponseRequest, CodexLbClient } from "../src/model/codex-lb.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { openDatabase } from "../src/storage/database.js";
import { SessionStore } from "../src/storage/session-store.js";
import { createCoreToolRegistry, createWorkerToolRegistry } from "../src/tools/index.js";
import type { AgentBatchRunner } from "../src/tools/agents.js";
import type { ToolContext } from "../src/tools/types.js";
import type { GatewayModel } from "../src/types.js";

function response(id: string, text: string): Response {
  return {
    id: `response-${id}`,
    status: "completed",
    output: [{
      id: `message-${id}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
    }],
    output_text: text,
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  } as unknown as Response;
}

const agentModel: GatewayModel = {
  id: "gpt-luna",
  provider: "codex-lb",
  name: "GPT Luna",
  description: "",
  contextWindow: 100_000,
  maxOutputTokens: null,
  reasoningEfforts: ["low", "high"],
  defaultReasoningEffort: "low",
  defaultVerbosity: "low",
  supportsReasoning: true,
  supportsImages: false,
  supportsParallelToolCalls: true,
  supportsFast: false,
  priority: 1,
};

function toolCallResponse(id: string, name: string, args: unknown): Response {
  return {
    id: `response-${id}`,
    status: "completed",
    output: [{
      id: `function-${id}`,
      type: "function_call",
      status: "completed",
      name,
      arguments: JSON.stringify(args),
      call_id: `call-${id}`,
    }],
    output_text: "",
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  } as unknown as Response;
}

test("agent coordinator runs isolated tasks concurrently with configured model metadata", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-agents-"));
  const artifactDir = join(root, "artifacts");
  mkdirSync(artifactDir);
  const db = openDatabase(join(root, "state.db"));
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const sessions = new SessionStore(db);
  const artifacts = new ArtifactStore(db, artifactDir);
  const parent = sessions.create({
    workspace: root,
    provider: "codex-lb",
    model: "gpt-sol",
    reasoningEffort: "medium",
    agentProvider: "codex-lb",
    agentModel: "gpt-luna",
    agentReasoningEffort: "high",
    verbosity: "low",
    fast: false,
    approvalMode: "unrestricted",
  });
  sessions.appendEvent(parent.id, "user", {
    item: { role: "user", content: [{ type: "input_text", text: "PARENT_TRANSCRIPT_MUST_NOT_LEAK" }] },
  });
  let active = 0;
  let peak = 0;
  const requests: ResponseRequest[] = [];
  const client = {
    supportsResponseContinuity: () => true,
    async stream(request: ResponseRequest) {
      requests.push(request);
      active += 1;
      peak = Math.max(peak, active);
      const input = JSON.stringify(request.input);
      const id = input.includes("TASK_SLOW") ? "slow" : input.includes("TASK_FAST") ? "fast" : "third";
      await new Promise((resolve) => setTimeout(resolve, id === "slow" ? 40 : 10));
      active -= 1;
      return response(id, `result-${id}`);
    },
  } as unknown as CodexLbClient;
  let instructionLoads = 0;
  const coordinator = new AgentCoordinator(
    structuredClone(DEFAULT_CONFIG),
    root,
    sessions,
    artifacts,
    () => client,
    createWorkerToolRegistry(),
    () => `main instructions snapshot ${instructionLoads += 1}`,
    async () => agentModel,
  );
  const progress: string[] = [];
  const context: ToolContext = {
    workspace: root,
    sessionId: parent.id,
    config: structuredClone(DEFAULT_CONFIG),
    approvalMode: "unrestricted",
    artifacts,
    sessions,
    signal: new AbortController().signal,
    approve: async () => "deny",
    ask: async () => "",
    reportProgress: (message) => progress.push(message),
  };
  const result = await coordinator.run({
    tasks: [
      { id: "slow", prompt: "TASK_SLOW" },
      { id: "fast", prompt: "TASK_FAST" },
      { id: "third", prompt: "TASK_THIRD" },
    ],
    concurrency: 2,
  }, context);

  assert.equal(peak, 2);
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.model === "gpt-luna"));
  assert.ok(requests.every((request) => request.reasoningEffort === "high"));
  assert.ok(requests.every((request) => !JSON.stringify(request.input).includes("PARENT_TRANSCRIPT_MUST_NOT_LEAK")));
  assert.ok(requests.every((request) => request.instructions.includes("fresh conversation context")));
  assert.ok(requests.every((request) => JSON.stringify(request.input).includes("Context contract")));
  assert.ok(result.output.indexOf("## slow") < result.output.indexOf("## fast"));
  assert.ok(result.output.indexOf("## fast") < result.output.indexOf("## third"));
  assert.match(result.output, /codex-lb:gpt-luna \| reasoning high/);
  assert.match(result.output, /child_session_id:/);
  assert.equal(instructionLoads, 3);
  assert.ok(progress.some((message) => /gpt-luna.*reasoning high.*agent fast \[starting\]/.test(message)));
  assert.equal(sessions.list(root).length, 1);
  const children = db.prepare("SELECT * FROM sessions WHERE parent_session_id = ?").all(parent.id) as { session_kind: string; model: string; reasoning_effort: string }[];
  assert.equal(children.length, 3);
  assert.ok(children.every((child) => child.session_kind === "agent"));
  assert.ok(children.every((child) => child.model === "gpt-luna" && child.reasoning_effort === "high"));
});

test("agent coordinator propagates read-only context to code-mode child turns", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-agents-readonly-"));
  const artifactDir = join(root, "artifacts");
  mkdirSync(artifactDir);
  const db = openDatabase(join(root, "state.db"));
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const sessions = new SessionStore(db);
  const artifacts = new ArtifactStore(db, artifactDir);
  const parent = sessions.create({
    workspace: root,
    provider: "codex-lb",
    model: "gpt-sol",
    reasoningEffort: "medium",
    agentProvider: "codex-lb",
    agentModel: "gpt-luna",
    agentReasoningEffort: "high",
    verbosity: "low",
    fast: false,
    approvalMode: "code",
  });
  let requests = 0;
  const client = {
    supportsResponseContinuity: () => true,
    async stream() {
      requests += 1;
      return requests === 1
        ? toolCallResponse("write", "apply_patch", {
          patch: "*** Begin Patch\n*** Add File: delegated-write.txt\n+should not be written\n*** End Patch",
        })
        : response("done", "done");
    },
  } as unknown as CodexLbClient;
  const coordinator = new AgentCoordinator(
    structuredClone(DEFAULT_CONFIG),
    root,
    sessions,
    artifacts,
    () => client,
    createWorkerToolRegistry(),
    "main instructions",
    async () => agentModel,
  );
  const context: ToolContext = {
    workspace: root,
    sessionId: parent.id,
    config: structuredClone(DEFAULT_CONFIG),
    approvalMode: "code",
    artifacts,
    sessions,
    signal: new AbortController().signal,
    readOnly: true,
    approve: async () => "deny",
    ask: async () => "",
  };

  const result = await coordinator.run({
    tasks: [{ id: "readonly", prompt: "Attempt the delegated write." }],
    concurrency: 1,
  }, context);

  assert.match(result.output, /succeeded/);
  assert.equal(requests, 2);
  assert.equal(existsSync(join(root, "delegated-write.txt")), false);
});

test("main registry exposes agents while leaf registry prevents recursive delegation", async () => {
  const runner: AgentBatchRunner = {
    async run() {
      return { output: "done" };
    },
  };
  assert.ok(createCoreToolRegistry(undefined, runner).get("run_agents"));
  assert.equal(createWorkerToolRegistry().get("run_agents"), null);
  assert.equal(createWorkerToolRegistry().get("ask_user"), null);
  assert.equal(createWorkerToolRegistry().get("schedule_create"), null);
});

test("model catalog bounds failed gateways and cools them down", async () => {
  let codexCalls = 0;
  let studioCalls = 0;
  let studioOnline = false;
  const { provider: _provider, ...catalogModel } = agentModel;
  const codex = {
    async models() {
      codexCalls += 1;
      return [catalogModel];
    },
  };
  const studio = {
    async models(signal?: AbortSignal) {
      studioCalls += 1;
      if (studioOnline) return [catalogModel];
      return new Promise<never>((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error("test timeout")), 1_000);
        const abort = () => {
          clearTimeout(keepAlive);
          reject(signal?.reason ?? new Error("aborted"));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    },
  };
  const app = Object.create(LookingGlassApp.prototype) as LookingGlassApp;
  Object.assign(app as unknown as Record<string, unknown>, {
    clients: new Map([
      ["codex-lb", codex],
      ["lm-studio", studio],
    ]),
    modelCache: new Map(),
    modelCacheTimes: new Map(),
    modelRequests: new Map(),
    modelFailures: new Map(),
    modelCatalogTimeoutMs: 20,
    modelCacheTtlMs: 30_000,
    probeGateway: async () => {},
  });

  const started = Date.now();
  const first = await app.models();
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(first.map((model) => `${model.provider}:${model.id}`), ["codex-lb:gpt-luna"]);
  assert.equal(codexCalls, 1);
  assert.equal(studioCalls, 1);

  const secondStarted = Date.now();
  const second = await app.models();
  assert.ok(Date.now() - secondStarted < 100);
  assert.equal(second.length, 1);
  assert.equal(codexCalls, 1);
  assert.equal(studioCalls, 1);

  await assert.rejects(app.catalogModel("gpt-luna", "lm-studio"), /temporarily unavailable/);
  studioOnline = true;
  const internals = app as unknown as { modelFailures: Map<string, number> };
  internals.modelFailures.set("lm-studio", Date.now() - 31_000);
  const recovered = await app.catalogModel("gpt-luna", "lm-studio");
  assert.equal(recovered.provider, "lm-studio");
  assert.equal(studioCalls, 2);
});

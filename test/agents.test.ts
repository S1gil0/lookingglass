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
import { ToolPreflightError } from "../src/tools/registry.js";
import type { AgentBatchRunner } from "../src/tools/agents.js";
import type { GlassTool, ToolContext } from "../src/tools/types.js";
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
  assert.equal(result.metadata?.agentTasksAttempted, 3);
  assert.ok(progress.some((message) => /gpt-luna.*reasoning high.*agent "fast" \[starting\]/.test(message)));
  assert.equal(sessions.list(root).length, 1);
  const children = db.prepare("SELECT * FROM sessions WHERE parent_session_id = ?").all(parent.id) as { session_kind: string; model: string; reasoning_effort: string }[];
  assert.equal(children.length, 3);
  assert.ok(children.every((child) => child.session_kind === "agent"));
  assert.ok(children.every((child) => child.model === "gpt-luna" && child.reasoning_effort === "high"));
});

test("agent coordinator redacts credentials from successful aggregate and oversized results", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-agents-redaction-"));
  const artifactDir = join(root, "artifacts");
  mkdirSync(artifactDir);
  const db = openDatabase(join(root, "state.db"));
  const apiKeyEnv = "LOOKING_GLASS_AGENT_TEST_API_KEY";
  const previousApiKey = process.env[apiKeyEnv];
  const secret = "agent-result-secret-123456";
  process.env[apiKeyEnv] = secret;
  t.after(() => {
    if (previousApiKey === undefined) delete process.env[apiKeyEnv];
    else process.env[apiKeyEnv] = previousApiKey;
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
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.apiKeyEnv = apiKeyEnv;
  const client = {
    supportsResponseContinuity: () => true,
    async stream(request: ResponseRequest) {
      const input = JSON.stringify(request.input);
      return input.includes("OVERSIZED_RESULT")
        ? response("oversized", `${secret}\n${"large-result ".repeat(100)}`)
        : response("aggregate", `successful leaf response: ${secret}`);
    },
  } as unknown as CodexLbClient;
  const coordinator = new AgentCoordinator(
    config,
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
    config,
    approvalMode: "unrestricted",
    artifacts,
    sessions,
    signal: new AbortController().signal,
    approve: async () => "deny",
    ask: async () => "",
  };

  config.tools.maxOutputBytes = 2_048;
  const aggregate = await coordinator.run({
    tasks: [{ id: "aggregate", prompt: "Return the successful response." }],
    concurrency: 1,
  }, context);
  assert.match(aggregate.output, /\[REDACTED\]/);
  assert.equal(aggregate.output.includes(secret), false);
  assert.equal(aggregate.artifactUri, undefined);

  config.tools.maxOutputBytes = 128;
  const oversized = await coordinator.run({
    tasks: [{ id: "oversized", prompt: "OVERSIZED_RESULT" }],
    concurrency: 1,
  }, context);
  assert.equal(oversized.truncated, true);
  assert.ok(oversized.artifactUri);
  assert.equal(oversized.output.includes(secret), false);
  const artifactContents = artifacts.read(oversized.artifactUri!).toString("utf8");
  assert.equal(artifactContents.includes(secret), false);
  assert.match(artifactContents, /\[REDACTED\]/);
});

test("agent coordinator forwards child tool callbacks as agent progress actions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-agents-callbacks-"));
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
  let requests = 0;
  const client = {
    supportsResponseContinuity: () => true,
    async stream() {
      requests += 1;
      return requests === 1
        ? toolCallResponse("progress", "progress_tool", { value: "sample" })
        : response("done", "agent done");
    },
  } as unknown as CodexLbClient;
  const progressTool: GlassTool<{ value: string }> = {
    name: "progress_tool",
    description: "Emit progress from a child tool.",
    risk: "read",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    summarize: ({ value }) => value,
    execute: async ({ value }, context) => {
      context.reportProgress?.(`progress ${value}`);
      return { output: `result ${value}` };
    },
  };
  const coordinator = new AgentCoordinator(
    structuredClone(DEFAULT_CONFIG),
    root,
    sessions,
    artifacts,
    () => client,
    createWorkerToolRegistry().register(progressTool),
    "main instructions",
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
    tasks: [{ id: "callbacks", prompt: "Use the progress tool." }],
    concurrency: 1,
  }, context);

  assert.equal(requests, 2);
  assert.match(result.output, /agent done/);
  assert.ok(progress.some((message) => /agent "callbacks" \[tool progress_tool started\]: sample/.test(message)));
  assert.ok(progress.some((message) => /agent "callbacks" \[tool progress_tool progress\]: progress sample/.test(message)));
  assert.ok(progress.some((message) => /agent "callbacks" \[tool progress_tool finished\]: result sample/.test(message)));
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

test("agent model lookup failures are safe preflight failures", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-agent-model-preflight-"));
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
  });
  const coordinator = new AgentCoordinator(
    structuredClone(DEFAULT_CONFIG),
    root,
    sessions,
    artifacts,
    () => ({}) as CodexLbClient,
    createWorkerToolRegistry(),
    "instructions",
    async () => { throw new Error("catalog unavailable"); },
  );

  await assert.rejects(coordinator.run({
    tasks: [{ id: "lookup", prompt: "Inspect the project." }],
    concurrency: 1,
  }, {
    workspace: root,
    sessionId: parent.id,
    config: structuredClone(DEFAULT_CONFIG),
    approvalMode: "review",
    artifacts,
    sessions,
    signal: new AbortController().signal,
    approve: async () => "deny",
    ask: async () => "",
  }), (error: unknown) => {
    assert.ok(error instanceof ToolPreflightError);
    assert.match(error.message, /Agent model could not be resolved: catalog unavailable/);
    return true;
  });
  const children = db.prepare("SELECT COUNT(*) count FROM sessions WHERE parent_session_id = ?").get(parent.id) as { count: number };
  assert.equal(children.count, 0);
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
  let codexOnline = true;
  let studioCalls = 0;
  let studioOnline = false;
  const { provider: _provider, ...catalogModel } = agentModel;
  const codex = {
    async models() {
      codexCalls += 1;
      if (!codexOnline) throw new Error("codex catalog timeout");
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

  codexOnline = false;
  const catalogInternals = app as unknown as {
    modelCacheTimes: Map<string, number>;
  };
  catalogInternals.modelCacheTimes.set("codex-lb", Date.now() - 31_000);
  const stale = await app.catalogModel("gpt-luna", "codex-lb");
  assert.equal(stale.id, "gpt-luna");
  assert.equal(codexCalls, 2);
  const cooledStale = await app.catalogModel("gpt-luna", "codex-lb");
  assert.equal(cooledStale.id, "gpt-luna");
  assert.equal(codexCalls, 2);
  const stopped = new AbortController();
  stopped.abort(new Error("caller stopped"));
  await assert.rejects(app.catalogModel("gpt-luna", "codex-lb", stopped.signal), /caller stopped/);

  await assert.rejects(app.catalogModel("gpt-luna", "lm-studio"), /temporarily unavailable/);
  studioOnline = true;
  const internals = app as unknown as { modelFailures: Map<string, number> };
  internals.modelFailures.set("lm-studio", Date.now() - 31_000);
  const recovered = await app.catalogModel("gpt-luna", "lm-studio");
  assert.equal(recovered.provider, "lm-studio");
  assert.equal(studioCalls, 2);
});

test("model catalog timeout bounds an existing shared request", async () => {
  const app = Object.create(LookingGlassApp.prototype) as LookingGlassApp;
  Object.assign(app as unknown as Record<string, unknown>, {
    clients: new Map([["codex-lb", {}]]),
    modelCache: new Map(),
    modelCacheTimes: new Map(),
    modelRequests: new Map([["codex-lb", new Promise(() => {})]]),
    modelFailures: new Map(),
    modelCatalogTimeoutMs: 20,
    modelCacheTtlMs: 30_000,
    probeGateway: async () => {},
  });

  const started = Date.now();
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    await assert.rejects(
      app.catalogModel("gpt-luna", "codex-lb"),
      /Gateway model catalog timed out after 20ms: codex-lb/,
    );
  } finally {
    clearTimeout(keepAlive);
  }
  assert.ok(Date.now() - started < 500);
  const internals = app as unknown as { modelRequests: Map<string, Promise<unknown>> };
  assert.equal(internals.modelRequests.has("codex-lb"), false);
});

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Response, ResponseInputItem } from "openai/resources/responses/responses";
import { DEFAULT_CONFIG } from "../src/config.js";
import { projectContext } from "../src/engine/context.js";
import { ConversationEngine } from "../src/engine/engine.js";
import type { StoredResponsePayload, StoredUserPayload } from "../src/engine/types.js";
import { isStaleResponseError, type CodexLbClient, type ResponseRequest } from "../src/model/codex-lb.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { SchedulerStore } from "../src/scheduler/store.js";
import { openDatabase } from "../src/storage/database.js";
import { SessionStore } from "../src/storage/session-store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { GlassTool } from "../src/tools/types.js";
import type { ModelInfo } from "../src/types.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-context-"));
  const artifactPath = join(root, "artifacts");
  mkdirSync(artifactPath);
  const db = openDatabase(join(root, "state.db"));
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const sessions = new SessionStore(db);
  const session = sessions.create({
    workspace: root,
    model: "test-model",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
  });
  return {
    root,
    sessions,
    session,
    db,
    artifacts: new ArtifactStore(db, artifactPath),
  };
}

function user(text: string): ResponseInputItem {
  return { role: "user", content: [{ type: "input_text", text }] };
}

function response(id: string, text: string): Response {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1_000),
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: "test-model",
    output: [{
      id: `msg_${id}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
    }],
    output_text: text,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: null,
    store: false,
    temperature: 1,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    metadata: {},
  } as unknown as Response;
}

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

test("eventless interactive sessions stay out of history and can be discarded", (t) => {
  const { root, sessions, session } = fixture(t);
  assert.equal(sessions.listWithMessages(root).length, 0);
  assert.equal(sessions.deleteIfEmpty(session.id), true);
  assert.equal(sessions.get(session.id), null);

  const used = sessions.create({
    workspace: root,
    model: "test-model",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
  });
  sessions.appendEvent<StoredUserPayload>(used.id, "user", { item: user("hello") });
  sessions.appendEvent<StoredResponsePayload>(used.id, "response", {
    response: {
      id: "resp_visible",
      status: "completed",
      output: response("resp_visible", "hi").output as unknown[],
      usage: { input_tokens: 42, output_tokens: 2, total_tokens: 44 },
    },
  });
  assert.deepEqual(sessions.listWithMessages(root).map((item) => item.id), [used.id]);
  assert.equal(sessions.deleteIfEmpty(used.id), false);
  assert.deepEqual(sessions.latestResponseUsage(used.id), { sequence: 2, inputTokens: 42 });
  assert.equal(sessions.semanticEventCount(used.id), 2);
});

test("context replay strips SDK-only parsed fields and normalizes compact summaries", (t) => {
  const { sessions, session } = fixture(t);
  sessions.saveCheckpoint(session.id, 0, {
    output: [
      {
        id: "msg_compact",
        type: "message",
        role: "user",
        status: "completed",
        content: [{ type: "input_text", text: "remember prism", parsed: null }],
      },
      { type: "compaction_summary", encrypted_content: "opaque" },
    ],
  }, 20);
  sessions.appendEvent<StoredResponsePayload>(session.id, "response", {
    response: {
      id: "response_after",
      status: "completed",
      output: [{
        id: "call_after",
        type: "function_call",
        call_id: "call_1",
        name: "read",
        arguments: "{}",
        parsed_arguments: null,
        status: "completed",
      }],
    },
  });

  const context = projectContext(sessions, session.id);
  assert.deepEqual(context.input.map((item) => item.type ?? "message"), ["message", "compaction", "function_call"]);
  assert.doesNotMatch(JSON.stringify(context.input), /parsed(?:_arguments)?/);
});

test("a turn without a response anchor replays prior semantic context", async (t) => {
  const { root, sessions, session, artifacts } = fixture(t);
  sessions.appendEvent<StoredUserPayload>(session.id, "user", { item: user("remember prism") });
  sessions.appendEvent<StoredResponsePayload>(session.id, "response", {
    response: { id: "old", status: "completed", output: response("old", "remembered").output },
  });
  const requests: ResponseRequest[] = [];
  const client = {
    async stream(request: ResponseRequest) {
      requests.push(request);
      return response("new", "ok");
    },
  } as unknown as CodexLbClient;
  const engine = new ConversationEngine(
    structuredClone(DEFAULT_CONFIG), root, sessions, artifacts, client, new ToolRegistry(), "instructions",
  );

  await engine.turn(session.id, "what was it?", {
    signal: new AbortController().signal,
    interaction: { approve: async () => "once", ask: async () => "" },
    modelInfo,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.previousResponseId, undefined);
  assert.equal(requests[0]?.input.length, 3);
  assert.match(JSON.stringify(requests[0]?.input), /remember prism/);
  assert.match(JSON.stringify(requests[0]?.input), /what was it/);
});

test("stateless providers replay full context after tool calls", async (t) => {
  const { root, sessions, session, artifacts } = fixture(t);
  const read: GlassTool<Record<string, never>> = {
    name: "read_test",
    description: "test read",
    risk: "read",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    summarize: () => "read test",
    async execute() {
      return { output: "TOOL_OK" };
    },
  };
  const requests: ResponseRequest[] = [];
  const client = {
    supportsResponseContinuity: () => false,
    async stream(request: ResponseRequest) {
      requests.push(request);
      if (requests.length === 1) {
        return {
          ...response("tool", ""),
          output: [{
            id: "fc_read",
            type: "function_call",
            call_id: "call_read",
            name: "read_test",
            arguments: "{}",
            status: "completed",
          }],
          output_text: "",
        } as unknown as Response;
      }
      return response("final", "STATELESS_OK");
    },
  } as unknown as CodexLbClient;
  const engine = new ConversationEngine(
    structuredClone(DEFAULT_CONFIG), root, sessions, artifacts, client, new ToolRegistry().register(read), "instructions",
  );

  const result = await engine.turn(session.id, "use the tool", {
    signal: new AbortController().signal,
    interaction: { approve: async () => "once", ask: async () => "" },
    modelInfo,
  });

  assert.equal(result.text, "STATELESS_OK");
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.previousResponseId, undefined);
  assert.match(JSON.stringify(requests[1]?.input), /use the tool/);
  assert.match(JSON.stringify(requests[1]?.input), /read_test/);
  assert.match(JSON.stringify(requests[1]?.input), /TOOL_OK/);
});

test("high-usage tool rounds compact before the next model request", async (t) => {
  const { root, sessions, session, artifacts } = fixture(t);
  const read: GlassTool<Record<string, never>> = {
    name: "compact_read",
    description: "test compact read",
    risk: "read",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    summarize: () => "compact read",
    async execute() {
      return { output: "bounded" };
    },
  };
  const requests: ResponseRequest[] = [];
  let compactions = 0;
  const client = {
    supportsResponseContinuity: () => true,
    async stream(request: ResponseRequest) {
      requests.push(request);
      if (requests.length === 1) {
        return {
          ...response("tools", ""),
          output: ["one"].map((id) => ({
            id: `fc_${id}`,
            type: "function_call",
            call_id: `call_${id}`,
            name: "compact_read",
            arguments: "{}",
            status: "completed",
          })),
          output_text: "",
          usage: { input_tokens: 85_000, output_tokens: 10, total_tokens: 85_010 },
        } as unknown as Response;
      }
      return response("after-compact", "COMPACTED_CONTINUATION");
    },
    async compact() {
      compactions += 1;
      return {
        id: "compact_1",
        output: [{ type: "compaction_summary", encrypted_content: "bounded checkpoint" }],
        usage: { input_tokens: 1_000 },
      };
    },
  } as unknown as CodexLbClient;
  const model = { ...modelInfo, contextWindow: 100_000, maxOutputTokens: null };
  const engine = new ConversationEngine(
    structuredClone(DEFAULT_CONFIG), root, sessions, artifacts, client,
    new ToolRegistry().register(read), "instructions",
  );

  const result = await engine.turn(session.id, "use tools", {
    signal: new AbortController().signal,
    interaction: { approve: async () => "once", ask: async () => "" },
    modelInfo: model,
  });

  assert.equal(result.text, "COMPACTED_CONTINUATION");
  assert.equal(result.compacted, true);
  assert.equal(compactions, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.previousResponseId, undefined);
  assert.match(JSON.stringify(requests[1]?.input), /bounded checkpoint/);
});

test("long scoped turns can continue beyond forty tool rounds", async (t) => {
  const { root, sessions, session, artifacts } = fixture(t);
  const inspect: GlassTool<Record<string, never>> = {
    name: "long_inspect",
    description: "test long-running inspection",
    risk: "read",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    summarize: () => "long inspection",
    async execute() {
      return { output: "progress" };
    },
  };
  let requests = 0;
  const client = {
    supportsResponseContinuity: () => true,
    async stream() {
      requests += 1;
      if (requests <= 50) {
        return {
          ...response(`long-${requests}`, ""),
          output: [{
            id: `fc_${requests}`,
            type: "function_call",
            call_id: `call_${requests}`,
            name: "long_inspect",
            arguments: "{}",
            status: "completed",
          }],
          output_text: "",
        } as unknown as Response;
      }
      return response("long-complete", "LONG_WORK_COMPLETE");
    },
  } as unknown as CodexLbClient;
  const engine = new ConversationEngine(
    structuredClone(DEFAULT_CONFIG), root, sessions, artifacts, client,
    new ToolRegistry().register(inspect), "instructions",
  );
  const result = await engine.turn(session.id, "perform long scoped work", {
    signal: new AbortController().signal,
    interaction: { approve: async () => "once", ask: async () => "" },
    modelInfo,
  });
  assert.equal(result.text, "LONG_WORK_COMPLETE");
  assert.equal(result.toolCalls, 50);
  assert.equal(requests, 51);
});

test("disabled agents are omitted from requests and stale calls are denied", async (t) => {
  const { root, sessions, session, artifacts } = fixture(t);
  sessions.updateSettings(session.id, { agentsEnabled: false });
  let executed = false;
  const agents: GlassTool<Record<string, never>> = {
    name: "run_agents",
    description: "test agent runner",
    risk: "write",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    summarize: () => "run agents",
    async execute() {
      executed = true;
      return { output: "unexpected" };
    },
  };
  const requests: ResponseRequest[] = [];
  const client = {
    supportsResponseContinuity: () => true,
    async stream(request: ResponseRequest) {
      requests.push(request);
      if (requests.length === 1) {
        return {
          ...response("disabled-agents", ""),
          output: [{
            id: "fc_disabled_agents",
            type: "function_call",
            call_id: "call_disabled_agents",
            name: "run_agents",
            arguments: "{}",
            status: "completed",
          }],
          output_text: "",
        } as unknown as Response;
      }
      return response("disabled-complete", "AGENTS_DISABLED_OK");
    },
  } as unknown as CodexLbClient;
  const engine = new ConversationEngine(
    structuredClone(DEFAULT_CONFIG), root, sessions, artifacts, client,
    new ToolRegistry().register(agents), "instructions",
  );
  const result = await engine.turn(session.id, "work without agents", {
    signal: new AbortController().signal,
    interaction: { approve: async () => "once", ask: async () => "" },
    modelInfo,
  });
  assert.equal(result.text, "AGENTS_DISABLED_OK");
  assert.equal(executed, false);
  assert.ok(requests.every((request) => request.tools.every((tool) => tool.name !== "run_agents")));
  assert.match(JSON.stringify(requests[1]?.input), /Agents are disabled for this session/);
});

test("one-shot agent sessions skip terminal maintenance compaction", async (t) => {
  const { root, sessions, artifacts } = fixture(t);
  const child = sessions.create({
    workspace: root,
    model: "test-model",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
    kind: "agent",
  });
  for (let index = 0; index < 4; index += 1) {
    sessions.appendEvent(child.id, "note", { semantic: index });
  }
  const client = {
    async stream() {
      const final = response("agent-final", "AGENT_RESULT");
      final.usage = { input_tokens: 90_000, output_tokens: 10, total_tokens: 90_010 } as never;
      return final;
    },
    async compact() {
      assert.fail("terminal agent response must not compact");
    },
  } as unknown as CodexLbClient;
  const engine = new ConversationEngine(
    structuredClone(DEFAULT_CONFIG), root, sessions, artifacts, client, new ToolRegistry(), "instructions",
  );
  const result = await engine.turn(child.id, "finish", {
    signal: new AbortController().signal,
    interaction: { approve: async () => "once", ask: async () => "" },
    modelInfo: { ...modelInfo, contextWindow: 100_000 },
  });
  assert.equal(result.text, "AGENT_RESULT");
  assert.equal(result.compacted, false);
  assert.equal(sessions.latestCheckpoint(child.id), null);
});

test("provider context overflow compacts and retries exactly once", async (t) => {
  const { root, sessions, session, artifacts } = fixture(t);
  let requests = 0;
  let compactions = 0;
  const client = {
    supportsResponseContinuity: () => true,
    async stream() {
      requests += 1;
      if (requests === 1) {
        throw Object.assign(new Error("maximum context length exceeded"), { code: "context_length_exceeded" });
      }
      return response("overflow-recovered", "OVERFLOW_RECOVERED");
    },
    async compact() {
      compactions += 1;
      return {
        id: "compact_overflow",
        output: [{ type: "compaction_summary", encrypted_content: "overflow checkpoint" }],
        usage: { input_tokens: 1_000 },
      };
    },
  } as unknown as CodexLbClient;
  const engine = new ConversationEngine(
    structuredClone(DEFAULT_CONFIG), root, sessions, artifacts, client, new ToolRegistry(), "instructions",
  );
  const result = await engine.turn(session.id, "large request", {
    signal: new AbortController().signal,
    interaction: { approve: async () => "once", ask: async () => "" },
    modelInfo,
  });
  assert.equal(result.text, "OVERFLOW_RECOVERED");
  assert.equal(requests, 2);
  assert.equal(compactions, 1);
  assert.equal(result.compacted, true);
});

test("parallel tool calls share one aggregate model output budget", async (t) => {
  const { root, sessions, session, artifacts } = fixture(t);
  const large: GlassTool<Record<string, never>> = {
    name: "large_parallel_read",
    description: "large parallel test result",
    risk: "read",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    summarize: () => "large parallel read",
    async execute() {
      return { output: "x".repeat(10_000) };
    },
  };
  const requests: ResponseRequest[] = [];
  const client = {
    supportsResponseContinuity: () => true,
    async stream(request: ResponseRequest) {
      requests.push(request);
      if (requests.length === 1) {
        return {
          ...response("parallel-tools", ""),
          output: Array.from({ length: 20 }, (_, index) => ({
            id: `fc_${index}`,
            type: "function_call",
            call_id: `call_${index}`,
            name: "large_parallel_read",
            arguments: "{}",
            status: "completed",
          })),
          output_text: "",
        } as unknown as Response;
      }
      return response("parallel-done", "PARALLEL_DONE");
    },
  } as unknown as CodexLbClient;
  const config = structuredClone(DEFAULT_CONFIG);
  config.tools.maxOutputBytes = 4_096;
  const engine = new ConversationEngine(
    config, root, sessions, artifacts, client, new ToolRegistry().register(large), "instructions",
  );
  const result = await engine.turn(session.id, "parallel outputs", {
    signal: new AbortController().signal,
    interaction: { approve: async () => "once", ask: async () => "" },
    modelInfo,
  });
  assert.equal(result.text, "PARALLEL_DONE");
  const outputs = requests[1]?.input as { output: string }[];
  assert.ok(outputs.every((item) => Buffer.byteLength(item.output) <= Math.floor(4_096 / 20)));
  assert.ok(outputs.reduce((total, item) => total + Buffer.byteLength(item.output), 0) <= 4_096);
  assert.ok(outputs.every((item) => /artifact/.test(item.output)));
});

test("completed answers survive terminal maintenance compaction failure", async (t) => {
  const { root, sessions, session, artifacts } = fixture(t);
  for (let index = 0; index < 4; index += 1) {
    sessions.appendEvent<StoredUserPayload>(session.id, "user", { item: user(`seed ${index}`) });
  }
  const client = {
    async stream() {
      const final = response("maintenance", "ANSWER_SURVIVES");
      final.usage = { input_tokens: 250_000, output_tokens: 10, total_tokens: 250_010 } as never;
      return final;
    },
    async compact() {
      throw new Error("compactor unavailable");
    },
  } as unknown as CodexLbClient;
  const statuses: string[] = [];
  const engine = new ConversationEngine(
    structuredClone(DEFAULT_CONFIG), root, sessions, artifacts, client, new ToolRegistry(), "instructions",
  );
  const result = await engine.turn(session.id, "finish despite maintenance", {
    signal: new AbortController().signal,
    interaction: { approve: async () => "once", ask: async () => "" },
    callbacks: { onWarning: (status) => statuses.push(status) },
    modelInfo,
  });
  assert.equal(result.text, "ANSWER_SURVIVES");
  assert.equal(result.compacted, false);
  assert.ok(statuses.some((status) => /compaction deferred.*compactor unavailable/i.test(status)));
  assert.ok(sessions.events(session.id).some((event) => event.kind === "error"
    && (event.payload as { code?: string }).code === "compaction_deferred"));
});

test("invalid tool arguments survive UI summary callbacks and return validation output", async (t) => {
  const { root, sessions, session, artifacts } = fixture(t);
  const fragile: GlassTool<{ value: string }> = {
    name: "fragile",
    description: "test invalid arguments",
    risk: "read",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    summarize: ({ value }) => value.slice(0, 10),
    async execute({ value }) {
      return { output: value };
    },
  };
  const requests: ResponseRequest[] = [];
  const client = {
    supportsResponseContinuity: () => false,
    async stream(request: ResponseRequest) {
      requests.push(request);
      if (requests.length === 1) {
        return {
          ...response("invalid-tool", ""),
          output: [{
            id: "fc_invalid",
            type: "function_call",
            call_id: "call_invalid",
            name: "fragile",
            arguments: "{}",
            status: "completed",
          }],
          output_text: "",
        } as unknown as Response;
      }
      return response("after-invalid-tool", "RECOVERED");
    },
  } as unknown as CodexLbClient;
  const summaries: string[] = [];
  const engine = new ConversationEngine(
    structuredClone(DEFAULT_CONFIG), root, sessions, artifacts, client,
    new ToolRegistry().register(fragile), "instructions",
  );

  const result = await engine.turn(session.id, "use malformed arguments", {
    signal: new AbortController().signal,
    interaction: { approve: async () => "once", ask: async () => "" },
    callbacks: { onToolFinish: (notice) => summaries.push(notice.summary) },
    modelInfo,
  });

  assert.equal(result.text, "RECOVERED");
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1]?.input), /Tool argument error: Invalid arguments for fragile/);
  assert.equal(sessions.getToolCall(session.id, "call_invalid")?.state, "failed");
  assert.deepEqual(summaries, ["fragile"]);
  assert.equal(sessions.events(session.id).filter((event) => event.kind === "error").length, 0);
});

test("mutating preflight failures return to the model without becoming unknown", async (t) => {
  const { root, sessions, session, artifacts } = fixture(t);
  const mutating: GlassTool<Record<string, never>> = {
    name: "preflight_mutation",
    description: "test mutating preflight",
    risk: "write",
    classifyRisk() {
      throw new Error("invalid patch syntax");
    },
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    summarize: () => "preflight mutation",
    async execute() {
      assert.fail("preflight failure must prevent execution");
    },
  };
  const requests: ResponseRequest[] = [];
  const client = {
    supportsResponseContinuity: () => false,
    async stream(request: ResponseRequest) {
      requests.push(request);
      if (requests.length === 1) {
        return {
          ...response("preflight-tool", ""),
          output: [{
            id: "fc_preflight",
            type: "function_call",
            call_id: "call_preflight",
            name: "preflight_mutation",
            arguments: "{}",
            status: "completed",
          }],
          output_text: "",
        } as unknown as Response;
      }
      return response("after-preflight", "PREFLIGHT_RECOVERED");
    },
  } as unknown as CodexLbClient;
  const engine = new ConversationEngine(
    structuredClone(DEFAULT_CONFIG), root, sessions, artifacts, client,
    new ToolRegistry().register(mutating), "instructions",
  );

  const result = await engine.turn(session.id, "use invalid mutation", {
    signal: new AbortController().signal,
    interaction: { approve: async () => "once", ask: async () => "" },
    modelInfo,
  });

  assert.equal(result.text, "PREFLIGHT_RECOVERED");
  assert.match(JSON.stringify(requests[1]?.input), /Tool preflight error: invalid patch syntax/);
  assert.equal(sessions.getToolCall(session.id, "call_preflight")?.state, "failed");
  assert.equal(sessions.events(session.id).filter((event) => event.kind === "error").length, 0);
  assert.equal(sessions.events(session.id).filter((event) => event.kind === "tool_denied").length, 0);
});

test("stale anchored turns rotate affinity and retry once from local replay", async (t) => {
  const { root, sessions, session, artifacts } = fixture(t);
  sessions.appendEvent<StoredUserPayload>(session.id, "user", { item: user("prior fact") });
  sessions.appendEvent<StoredResponsePayload>(session.id, "response", {
    response: { id: "prior_response", status: "completed", output: response("prior_response", "remembered").output },
  });
  sessions.setLastResponseId(session.id, "stale_response");
  const originalKey = session.promptCacheKey;
  const requests: ResponseRequest[] = [];
  const client = {
    async stream(request: ResponseRequest) {
      requests.push(request);
      if (requests.length === 1) {
        throw Object.assign(new Error("Previous response owner account is unavailable; retry later."), {
          code: "previous_response_owner_unavailable",
          status: 502,
        });
      }
      return response("recovered", "ok");
    },
  } as unknown as CodexLbClient;
  const engine = new ConversationEngine(
    structuredClone(DEFAULT_CONFIG), root, sessions, artifacts, client, new ToolRegistry(), "instructions",
  );

  await engine.turn(session.id, "new fact", {
    signal: new AbortController().signal,
    interaction: { approve: async () => "once", ask: async () => "" },
    modelInfo,
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.previousResponseId, "stale_response");
  assert.equal(requests[1]?.previousResponseId, undefined);
  assert.notEqual(requests[1]?.promptCacheKey, originalKey);
  assert.match(JSON.stringify(requests[1]?.input), /prior fact/);
  assert.match(JSON.stringify(requests[1]?.input), /new fact/);
  assert.equal(sessions.get(session.id)?.lastResponseId, "recovered");
});

test("recognizes codex-lb anchored continuity failures", () => {
  assert.equal(isStaleResponseError({ code: "previous_response_owner_unavailable" }, true), true);
  assert.equal(isStaleResponseError(new Error("rsp.output is not iterable"), true), true);
  assert.equal(isStaleResponseError(Object.assign(new Error("gateway"), { status: 502 }), true), true);
  assert.equal(isStaleResponseError(new Error("rsp.output is not iterable"), false), false);
});

test("session operation leases serialize turns and fence expired owners", (t) => {
  const { sessions, session } = fixture(t);
  const now = 1_000;
  assert.equal(sessions.acquireOperationLease(session.id, "one", "token-one", "turn", now, 100), true);
  assert.equal(sessions.acquireOperationLease(session.id, "two", "token-two", "turn", now + 50, 100), false);
  assert.equal(sessions.renewOperationLease(session.id, "one", "token-one", now + 50, 100), true);
  assert.equal(sessions.acquireOperationLease(session.id, "two", "token-two", "turn", now + 149, 100), false);
  assert.equal(sessions.acquireOperationLease(session.id, "two", "token-two", "turn", now + 150, 100), true);
  assert.equal(sessions.releaseOperationLease(session.id, "one", "token-one"), false);
  assert.equal(sessions.assertOperationLease(session.id, "two", "token-two", now + 151), true);
});

test("explicit provider migration rotates continuity and cache identity", (t) => {
  const { sessions, session } = fixture(t);
  sessions.registerCommandApproval(session.id, '["bash-exec",1,"npm test","/workspace",120000]');
  assert.equal(sessions.updateSettings(session.id, { approvalMode: "unrestricted" }).approvalMode, "unrestricted");
  sessions.setLastResponseId(session.id, "response-old");
  sessions.appendEvent<StoredUserPayload>(session.id, "user", { item: user("retained history") });
  sessions.saveCheckpoint(session.id, 1, { output: [{ type: "compaction", encrypted_content: "provider-specific" }] }, 10);
  assert.ok(sessions.latestCheckpoint(session.id));
  const migrated = sessions.updateSettings(session.id, {
    provider: "lm-studio",
    model: "qwen/qwen3.6-35b-a3b",
    reasoningEffort: "none",
  });
  assert.equal(migrated.provider, "lm-studio");
  assert.equal(migrated.model, "qwen/qwen3.6-35b-a3b");
  assert.equal(migrated.lastResponseId, null);
  assert.notEqual(migrated.promptCacheKey, session.promptCacheKey);
  assert.equal(sessions.latestCheckpoint(session.id), null);
  assert.match(JSON.stringify(projectContext(sessions, session.id).input), /retained history/);
  assert.equal(sessions.listCommandApprovals(session.id).length, 1);
});

test("agent settings are durable without rotating primary continuity and hidden sessions stay hidden", (t) => {
  const { root, sessions, session } = fixture(t);
  sessions.setLastResponseId(session.id, "primary-response");
  sessions.saveCheckpoint(session.id, 0, { summary: "primary checkpoint" }, 10);
  const before = sessions.get(session.id)!;
  const updated = sessions.updateSettings(session.id, {
    agentProvider: "lm-studio",
    agentModel: "qwen/agent",
    agentReasoningEffort: "high",
  });
  assert.equal(updated.agentProvider, "lm-studio");
  assert.equal(updated.agentModel, "qwen/agent");
  assert.equal(updated.agentReasoningEffort, "high");
  assert.equal(updated.promptCacheKey, before.promptCacheKey);
  assert.equal(updated.lastResponseId, "primary-response");
  assert.ok(sessions.latestCheckpoint(session.id));

  const child = sessions.create({
    workspace: root,
    provider: updated.agentProvider,
    model: updated.agentModel,
    reasoningEffort: updated.agentReasoningEffort,
    verbosity: "low",
    fast: false,
    approvalMode: updated.approvalMode,
    kind: "agent",
    parentSessionId: session.id,
  });
  assert.equal(child.kind, "agent");
  assert.equal(child.parentSessionId, session.id);
  assert.equal(sessions.get(child.id)?.agentModel, updated.agentModel);
  assert.equal(sessions.list(root).some((item) => item.id === child.id), false);
  sessions.appendEvent(child.id, "note", { text: "child audit" });
  const summary = sessions.deletionSummary(session.id);
  assert.equal(summary.events, 1);
  assert.equal(summary.checkpoints, 1);
  const now = Date.now();
  assert.equal(sessions.acquireOperationLease(child.id, "agent", "child-token", "turn", now, 30_000), true);
  assert.throws(() => sessions.delete(session.id), /active turn/);
  assert.equal(sessions.releaseOperationLease(child.id, "agent", "child-token"), true);
});

test("session deletion removes attached state and refuses active operations", (t) => {
  const { db, sessions, session, artifacts } = fixture(t);
  sessions.updateSettings(session.id, { persistent: true });
  sessions.appendEvent(session.id, "note", { text: "delete me" });
  sessions.saveCheckpoint(session.id, 1, { summary: "checkpoint" }, 10);
  const artifact = artifacts.save(session.id, "tool-output", "retained");
  sessions.registerCommandApproval(session.id, '["bash-exec",1,"npm test","/workspace",120000]');
  const scheduler = new SchedulerStore(db);
  const now = Date.parse("2026-07-19T12:00:00Z");
  const job = scheduler.createSessionPrompt({
    sessionId: session.id,
    prompt: "scheduled cleanup",
    scheduleKind: "once",
    schedule: new Date(now + 60_000).toISOString(),
    timezone: "UTC",
    startGraceMs: 30_000,
    outputBytes: 1_024,
  }, now);
  const occurrence = scheduler.runNow(job.id, now + 1);
  db.prepare(`
    UPDATE scheduler_occurrences SET state = 'succeeded', finished_at = ? WHERE id = ?
  `).run(now + 2, occurrence.id);
  db.prepare(`
    INSERT INTO scheduler_inbox(kind, job_id, occurrence_id, message, created_at)
    VALUES ('command_result', ?, ?, 'Session turn succeeded', ?)
  `).run(job.id, occurrence.id, now + 2);

  const expected = {
    events: 1,
    checkpoints: 1,
    toolCalls: 0,
    schedules: 1,
    occurrences: 1,
    inboxItems: 1,
    commandApprovals: 1,
    retainedArtifacts: 1,
  };
  assert.deepEqual(sessions.deletionSummary(session.id), expected);
  assert.throws(() => sessions.delete(session.id, { ...expected, events: 2 }), /changed after deletion/);
  assert.ok(sessions.get(session.id));
  assert.deepEqual(sessions.delete(session.id, expected), expected);
  assert.equal(sessions.get(session.id), null);
  assert.equal(scheduler.getJob(job.id), null);
  assert.equal(db.prepare("SELECT 1 FROM scheduler_occurrences WHERE id = ?").get(occurrence.id), undefined);
  assert.equal(artifacts.get(artifact.id)?.path, artifact.path);
  assert.equal(db.prepare("SELECT 1 FROM session_command_approvals WHERE session_id = ?").get(session.id), undefined);
  const artifactOwner = db.prepare("SELECT session_id FROM artifacts WHERE id = ?").get(artifact.id) as { session_id: string | null };
  assert.equal(artifactOwner.session_id, null);

  const active = sessions.create({
    workspace: session.workspace,
    model: "test-model",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
  });
  assert.equal(sessions.acquireOperationLease(active.id, "owner", "token", "turn", Date.now(), 30_000), true);
  assert.throws(() => sessions.delete(active.id), /active turn/);
  assert.equal(sessions.releaseOperationLease(active.id, "owner", "token"), true);
  sessions.delete(active.id);
});

test("expired operation owners cannot append durable conversation state", (t) => {
  const { sessions, session } = fixture(t);
  const now = Date.now();
  assert.equal(sessions.acquireOperationLease(session.id, "old", "old-token", "turn", now - 1_000, 100), true);
  assert.equal(sessions.acquireOperationLease(session.id, "new", "new-token", "turn", now, 30_000), true);
  const payload: StoredUserPayload = { item: user("fenced") };
  assert.equal(sessions.appendUserAndSetTitleFenced(session.id, "old-token", "stale", payload), null);
  assert.ok(sessions.appendUserAndSetTitleFenced(session.id, "new-token", "current", payload));
  assert.equal(sessions.events(session.id).filter((event) => event.kind === "user").length, 1);
  assert.throws(
    () => sessions.beginToolCall(session.id, "call-old", "bash", {}, "old-token"),
    /lease was lost/,
  );
});

test("reconciles response/tool crash windows into a replayable unknown result", (t) => {
  const { sessions, session } = fixture(t);
  sessions.appendResponseAndSetContinuity<StoredResponsePayload>(session.id, {
    response: {
      id: "tool_response",
      status: "completed",
      output: [{
        id: "fc_crash",
        type: "function_call",
        call_id: "call_crash",
        name: "bash",
        arguments: '{"command":"touch marker"}',
        status: "completed",
      }],
    },
  }, "tool_response");

  assert.equal(sessions.acquireOperationLease(session.id, "reconciler", "reconcile-token", "turn"), true);
  assert.equal(sessions.reconcileToolCallEvents(session.id, "reconcile-token"), 1);
  assert.equal(sessions.getToolCall(session.id, "call_crash")?.state, "unknown");
  assert.equal(sessions.reconcileToolCallEvents(session.id, "reconcile-token"), 0);
  assert.equal(sessions.hasUnanchoredContext(session.id), true);
  const results = sessions.events(session.id).filter((event) => event.kind === "tool_denied");
  assert.equal(results.length, 1);
  const replay = projectContext(sessions, session.id);
  assert.deepEqual(replay.input.map((item) => item.type), ["function_call", "function_call_output"]);
});

test("interrupted mutating tools become unknown and stop the turn", async (t) => {
  const { root, sessions, session, artifacts } = fixture(t);
  const mutating: GlassTool<Record<string, never>> = {
    name: "mutate",
    description: "test mutation",
    risk: "write",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    summarize: () => "mutate",
    async execute(_args, context) {
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return { output: "unreachable" };
    },
  };
  const registry = new ToolRegistry().register(mutating);
  const toolResponse = {
    ...response("tool", ""),
    output: [{
      id: "fc_mutate",
      type: "function_call",
      call_id: "call_mutate",
      name: "mutate",
      arguments: "{}",
      status: "completed",
    }],
    output_text: "",
  } as unknown as Response;
  const client = { async stream() { return toolResponse; } } as unknown as CodexLbClient;
  const engine = new ConversationEngine(
    structuredClone(DEFAULT_CONFIG), root, sessions, artifacts, client, registry, "instructions",
  );
  const controller = new AbortController();
  const turn = engine.turn(session.id, "mutate", {
    signal: controller.signal,
    interaction: { approve: async () => "once", ask: async () => "" },
    modelInfo,
  });
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(turn, /aborted|interrupted/i);
  assert.equal(sessions.getToolCall(session.id, "call_mutate")?.state, "unknown");
  assert.equal(sessions.events(session.id).filter((event) => event.kind === "tool_denied").length, 1);
});

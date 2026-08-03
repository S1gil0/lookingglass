import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Response, ResponseInputItem } from "openai/resources/responses/responses";
import { DEFAULT_CONFIG } from "../src/config.js";
import { projectContext } from "../src/engine/context.js";
import { ConversationEngine } from "../src/engine/engine.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { openDatabase } from "../src/storage/database.js";
import { SessionStore } from "../src/storage/session-store.js";
import type { ResponseRequest, CodexLbClient } from "../src/model/codex-lb.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { GlassTool } from "../src/tools/types.js";
import type { ModelInfo } from "../src/types.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-tool-result-"));
  const db = openDatabase(join(root, "state.db"));
  const artifactPath = join(root, "artifacts");
  mkdirSync(artifactPath);
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
  return { root, sessions, session, artifacts: new ArtifactStore(db, artifactPath) };
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

test("legacy and compact tool-result payloads project the same function output", (t) => {
  const { sessions, session } = fixture(t);
  const compactSession = sessions.create({
    workspace: session.workspace,
    model: "test-model",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
  });
  const item: ResponseInputItem = {
    type: "function_call_output",
    call_id: "call_read",
    output: "TOOL_OK",
  };
  sessions.appendEvent(session.id, "tool_result", {
    name: "read_test",
    callId: "call_read",
    item,
    output: "TOOL_OK",
  });
  sessions.appendEvent(compactSession.id, "tool_result", {
    name: "read_test",
    callId: "call_read",
    output: "TOOL_OK",
  });

  assert.deepEqual(projectContext(sessions, session.id).input, projectContext(sessions, compactSession.id).input);
  assert.deepEqual(projectContext(sessions, compactSession.id).input, [item]);
});

test("new tool-result persistence omits the duplicated input item", async (t) => {
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
      return response("final", "DONE");
    },
  } as unknown as CodexLbClient;
  const engine = new ConversationEngine(
    structuredClone(DEFAULT_CONFIG),
    root,
    sessions,
    artifacts,
    client,
    new ToolRegistry().register(read),
    "instructions",
  );

  await engine.turn(session.id, "use the tool", {
    signal: new AbortController().signal,
    interaction: { approve: async () => "once", ask: async () => "" },
    modelInfo,
  });

  const event = sessions.events(session.id).find((candidate) => candidate.kind === "tool_result");
  assert.ok(event);
  assert.deepEqual(event.payload, { name: "read_test", callId: "call_read", output: "TOOL_OK" });
  assert.equal("item" in (event.payload as Record<string, unknown>), false);
  assert.equal(sessions.getToolCall(session.id, "call_read")?.output, "TOOL_OK");
  assert.deepEqual(projectContext(sessions, session.id).input.find((item) => item.type === "function_call_output"), {
    type: "function_call_output",
    call_id: "call_read",
    output: "TOOL_OK",
  });
});
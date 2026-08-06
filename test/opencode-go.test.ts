import assert from "node:assert/strict";
import test from "node:test";
import {
  openCodeGoModelInfo,
  openCodeGoProfile,
  openCodeGoReasoningParams,
} from "../src/model/opencode-go.js";

test("OpenCode Go profiles use the documented protocols and effort sets", () => {
  assert.equal(openCodeGoProfile("gpt-5.6-luna").protocol, "responses");
  assert.deepEqual(openCodeGoProfile("gpt-5.6-luna").reasoningEfforts, ["none", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(openCodeGoProfile("grok-4.5").reasoningEfforts, ["low", "medium", "high"]);
  assert.deepEqual(openCodeGoProfile("deepseek-v4-flash").reasoningEfforts, ["low", "high", "max"]);
  assert.deepEqual(openCodeGoProfile("glm-5.2").reasoningEfforts, ["high", "max"]);
  assert.deepEqual(openCodeGoProfile("hy3").reasoningEfforts, ["none", "low", "high"]);
  assert.deepEqual(openCodeGoProfile("kimi-k3").reasoningEfforts, ["max"]);
  assert.deepEqual(openCodeGoProfile("minimax-m3").reasoningEfforts, ["high"]);
  assert.equal(openCodeGoProfile("qwen3.7-plus").protocol, "messages");
  assert.deepEqual(openCodeGoProfile("qwen3.7-plus").reasoningEfforts, ["high", "max"]);
});

test("the profile table covers current and retained Go model IDs", () => {
  const ids = [
    "grok-4.5", "glm-5.2", "glm-5.1", "gpt-5.6-luna", "kimi-k3", "kimi-k2.7-code", "kimi-k2.6",
    "mimo-v2.5", "mimo-v2.5-pro", "minimax-m3", "minimax-m2.7", "qwen3.8-max", "qwen3.7-max",
    "qwen3.7-plus", "qwen3.6-plus", "deepseek-v4-pro", "deepseek-v4-flash", "hy3", "minimax-m2.5",
    "qwen3.5-plus", "kimi-k2.5", "mimo-v2-omni", "mimo-v2-pro", "glm-5",
  ];
  assert.equal(ids.length, 24);
  for (const id of ids) {
    const profile = openCodeGoProfile(id);
    assert.notEqual(profile.contextWindow, 32_768, id);
    assert.equal(profile.reasoningEfforts.includes(profile.defaultReasoningEffort), true, id);
    if (!profile.supportsReasoning) assert.deepEqual(profile.reasoningEfforts, ["none"], id);
  }
});

test("unknown Go models fall back conservatively", () => {
  const profile = openCodeGoProfile("future-model");
  assert.equal(profile.protocol, "chat");
  assert.equal(profile.supportsReasoning, false);
  assert.deepEqual(profile.reasoningEfforts, ["none"]);
  assert.deepEqual(openCodeGoReasoningParams("future-model", "high"), {});
});

test("catalog metadata is mapped to Looking Glass ModelInfo", () => {
  const model = openCodeGoModelInfo({
    id: "qwen3.7-plus",
    name: "Qwen3.7 Plus",
    description: "catalog description",
    attachment: true,
    tool_call: true,
    limit: { context: 1_000_000, output: 65_536 },
  });
  assert.deepEqual(model, {
    id: "qwen3.7-plus",
    name: "Qwen3.7 Plus",
    description: "catalog description",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    reasoningEfforts: ["high", "max"],
    defaultReasoningEffort: "high",
    defaultVerbosity: "low",
    supportsReasoning: true,
    supportsImages: true,
    supportsParallelToolCalls: false,
    supportsFast: false,
    priority: 1_000,
  });

  const unknown = openCodeGoModelInfo({ id: "future-model" });
  assert.equal(unknown.supportsReasoning, false);
  assert.equal(unknown.contextWindow, 32_768);
  assert.equal(unknown.maxOutputTokens, null);
  assert.deepEqual(unknown.reasoningEfforts, ["none"]);
});

test("reasoning parameters match each OpenCode Go wire protocol", () => {
  assert.deepEqual(openCodeGoReasoningParams("grok-4.5", "high"), { reasoning_effort: "high" });
  assert.deepEqual(openCodeGoReasoningParams("gpt-5.6-luna", "xhigh"), {
    reasoning: { effort: "xhigh", summary: "auto" },
  });
  assert.deepEqual(openCodeGoReasoningParams("kimi-k3", "max"), { reasoning_effort: "max" });
  assert.deepEqual(openCodeGoReasoningParams("minimax-m3", "high"), { thinking: { type: "adaptive" } });
  assert.deepEqual(openCodeGoReasoningParams("qwen3.7-max", "high"), {
    thinking: { type: "enabled", budget_tokens: 32_768 },
  });
  assert.deepEqual(openCodeGoReasoningParams("qwen3.7-max", "max"), {
    thinking: { type: "enabled", budget_tokens: 65_535 },
  });
});
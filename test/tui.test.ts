import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  ApprovalModal,
  AssistantMessage,
  ToolCard,
  UserMessage,
  activityLine,
  contextUsageLabel,
  defaultGatewayBaseURL,
  formatTokenCount,
  formatTurnSummary,
  formatCommandApproval,
  FullHeightRoot,
  inboxLine,
  initialTuiSession,
  markInboxItemsRead,
  Notice,
  mouseWheelDelta,
  parseTerminalMouse,
  parseSessionSchedule,
  ReasoningSummary,
  selectedScreenText,
  sessionMetadataLine,
  shouldAutoDisplayInbox,
  restoreApiKeyEnvironment,
  TaskPlanPanel,
} from "../src/ui/tui.js";
import { terminalSafe } from "../src/ui/stdio.js";
import type { InboxRecord, SchedulerJob } from "../src/scheduler/types.js";
import type { TaskPlanSnapshot } from "../src/task-plan.js";

test("parses one-shot and quoted or unquoted cron session schedules", () => {
  assert.deepEqual(parseSessionSchedule("once 2026-07-20T12:00:00Z inspect services"), {
    scheduleKind: "once",
    schedule: "2026-07-20T12:00:00Z",
    prompt: "inspect services",
  });
  assert.deepEqual(parseSessionSchedule('cron "0 9 * * *" inspect services'), {
    scheduleKind: "cron",
    schedule: "0 9 * * *",
    prompt: "inspect services",
  });
  assert.deepEqual(parseSessionSchedule("cron 0 9 * * * inspect services"), {
    scheduleKind: "cron",
    schedule: "0 9 * * *",
    prompt: "inspect services",
  });
  assert.throws(() => parseSessionSchedule("cron 0 9 * * *"), /Usage/);
});

test("bare TUI startup creates a new session while explicit ids resume", async () => {
  const created = { id: "new-session" };
  const resumed = { id: "existing-session" };
  let createCalls = 0;
  let resumedId: string | undefined;
  const app = {
    async createSession() {
      createCalls += 1;
      return created;
    },
    async currentOrNewSession(id?: string) {
      resumedId = id;
      return resumed;
    },
  };
  assert.equal((await initialTuiSession(app as never)).id, "new-session");
  assert.equal(createCalls, 1);
  assert.equal((await initialTuiSession(app as never, "existing-session")).id, "existing-session");
  assert.equal(resumedId, "existing-session");
  assert.equal(createCalls, 1);
});

test("provides sensible gateway onboarding defaults", () => {
  assert.equal(defaultGatewayBaseURL("codex-lb"), "http://127.0.0.1:2455/v1");
  assert.equal(defaultGatewayBaseURL("lm-studio"), "http://127.0.0.1:1234/v1");
  assert.equal(defaultGatewayBaseURL("openrouter"), "https://openrouter.ai/api/v1");
  assert.equal(defaultGatewayBaseURL("custom"), "http://127.0.0.1:8080/v1");
});

test("restores or clears the TUI API key environment snapshot", () => {
  const environmentName = "LOOKING_GLASS_TUI_TEST_API_KEY";
  const previous = process.env[environmentName];
  try {
    process.env[environmentName] = "temporary-value";
    restoreApiKeyEnvironment(environmentName, undefined);
    assert.equal(process.env[environmentName], undefined);
    restoreApiKeyEnvironment(environmentName, "previous-value");
    assert.equal(process.env[environmentName], "previous-value");
  } finally {
    if (previous === undefined) delete process.env[environmentName];
    else process.env[environmentName] = previous;
  }
});

test("recognizes SGR mouse wheel events", () => {
  assert.equal(mouseWheelDelta("\x1b[<64;10;20M"), 3);
  assert.equal(mouseWheelDelta("\x1b[<65;10;20M"), -3);
  assert.equal(mouseWheelDelta("ordinary input"), 0);
  assert.deepEqual(parseTerminalMouse("\x1b[<0;2;3M"), {
    action: "press", button: 0, column: 1, row: 2, shift: false, alt: false, ctrl: false,
  });
  assert.equal(parseTerminalMouse("\x1b[<32;4;5M")?.action, "drag");
  assert.equal(parseTerminalMouse("\x1b[<0;4;5m")?.action, "release");
  assert.equal(parseTerminalMouse("\x1b[<66;4;5M")?.action, "wheel_left");
  assert.equal(mouseWheelDelta("\x1b[<66;4;5M"), 0);
  assert.equal(parseTerminalMouse(`pasted\x1b[<0;4;5Mtext`), null);
});

test("extracts selected screen text without terminal styling", () => {
  assert.equal(selectedScreenText(
    ["\x1b[31mhello\x1b[39m", "world"],
    { column: 1, row: 0 },
    { column: 2, row: 1 },
  ), "ello\nwor");
  assert.equal(selectedScreenText(
    ["\x1b_pi:c\x07hello"],
    { column: 0, row: 0 },
    { column: 4, row: 0 },
  ), "hello");
  assert.equal(selectedScreenText(
    ["界x"],
    { column: 1, row: 0 },
    { column: 1, row: 0 },
  ), "界");
});

test("scopes automatic session inbox notices and includes session titles", () => {
  const item = {
    id: 7,
    kind: "command_result",
    jobId: "job",
    occurrenceId: 4,
    message: "Session turn succeeded",
    createdAt: Date.parse("2026-07-19T12:00:00Z"),
    acknowledgedAt: null,
    occurrence: { state: "succeeded" },
  } as InboxRecord;
  const job = {
    id: "job",
    kind: "session_prompt",
    sessionId: "source-session",
  } as SchedulerJob;
  assert.match(inboxLine(item, job, "Nightly maintenance"), /session:Nightly maintenance succeeded/);
  assert.equal(shouldAutoDisplayInbox(job, "other-session"), false);
  assert.equal(shouldAutoDisplayInbox(job, "source-session"), true);
  assert.equal(shouldAutoDisplayInbox(undefined, "other-session"), true);
  const acknowledged: number[] = [];
  assert.equal(markInboxItemsRead([item, { ...item, id: 8 }], (id) => {
    acknowledged.push(id);
    return true;
  }), 2);
  assert.deepEqual(acknowledged, [7, 8]);
});

test("strips terminal control sequences from model-controlled stdio text", () => {
  assert.equal(terminalSafe("safe\x1b[2Jforged\r\nnext"), "safe[2Jforged\nnext");
});

test("renders activity separately from ordered session metadata", () => {
  const metadata = sessionMetadataLine({
    id: "session",
    workspace: "/tmp",
    provider: "lm-studio",
    agentProvider: "codex-lb",
    title: "Session name",
    model: "qwen/model",
    agentModel: "gpt-luna",
    reasoningEffort: "medium",
    agentReasoningEffort: "high",
    agentsEnabled: true,
    verbosity: "low",
    fast: false,
    approvalMode: "unrestricted",
    showReasoning: true,
    persistent: true,
    promptCacheKey: "cache",
    lastResponseId: null,
    kind: "interactive",
    parentSessionId: null,
    createdAt: 1,
    updatedAt: 1,
  }, "unrestricted", "ctx:42%/1.2k");
  assert.equal(metadata, "qwen/model (medium) | agent: gpt-luna (high) | ctx:42%/1.2k | unrestricted | persist:on | Session name");
  const narrow = sessionMetadataLine({
    id: "session",
    workspace: "/tmp",
    provider: "lm-studio",
    agentProvider: "codex-lb",
    title: "A long session name",
    model: "qwen/qwen3.6-35b-a3b",
    agentModel: "gpt-luna",
    reasoningEffort: "medium",
    agentReasoningEffort: "high",
    agentsEnabled: false,
    verbosity: "low",
    fast: false,
    approvalMode: "unrestricted",
    showReasoning: true,
    persistent: false,
    promptCacheKey: "cache",
    lastResponseId: null,
    kind: "interactive",
    parentSessionId: null,
    createdAt: 1,
    updatedAt: 1,
  }, "unrestricted", "ctx:42%/1.2k", 79);
  assert.match(narrow, /^qwen\/.* \| agent: off \| ctx:42%\/1.2k \| unrestricted \| A/);
  assert.doesNotMatch(narrow, /(?:^|\| )p(?:ersist)?:/);
  assert.ok(narrow.length <= 79);
  assert.equal(formatTokenCount(512), "512");
  assert.equal(formatTokenCount(1_000), "1k");
  assert.equal(formatTokenCount(1_200), "1.2k");
  assert.equal(formatTokenCount(12_400), "12.4k");
  assert.equal(contextUsageLabel(512, 2_048), "ctx:25%/512");
  assert.equal(contextUsageLabel(1_200, 3_000), "ctx:40%/1.2k");
  assert.equal(contextUsageLabel(12_400, 15_500), "ctx:80%/12.4k");
  assert.equal(contextUsageLabel(null, 15_500), "ctx:?");
  assert.equal(contextUsageLabel(null, 0), "ctx:?");
  assert.equal(contextUsageLabel(1_200, 0), "ctx:?/1.2k");
  assert.equal(activityLine(true, "Thinking", 1, 12), "Thinking.. | scroll:+12");
  assert.equal(activityLine(false, "ignored", 0, 0), "Ready");
});

test("renders reasoning summaries as plain text on a distinct tonal background", () => {
  const lines = new ReasoningSummary("**Plan** the __safe__ path\nThen verify it.").render(32);
  const plain = lines.map(stripVTControlCharacters);

  assert.equal(plain.at(-1), "");
  assert.match(lines[0]!, /\x1b\[38;5;252;48;5;234m/);
  assert.equal(plain[0]?.trimEnd(), "Plan the safe path");
  assert.equal(plain[1]?.trimEnd(), "Then verify it.");
  assert.equal(plain[0]?.length, 32);
  assert.equal(plain[1]?.length, 32);
  assert.doesNotMatch(plain.join("\n"), /\*\*|__/);
  assert.doesNotMatch(plain.join("\n"), /Reasoning summary/);
  assert.doesNotMatch(lines.join("\n"), /\x1b\[2m/);
});

test("formats bounded turn summaries for narrow transcript notices", () => {
  const summary = formatTurnSummary({
    responseStatus: "incomplete",
    durationMs: 1_234,
    modelRounds: 2,
    toolCalls: 3,
    leafAgents: 4,
    compactions: 1,
    refusalNotice: `no\nreason ${"x".repeat(600)}`,
    incompleteReason: "max_output_tokens",
  });
  assert.match(summary, /^status:incomplete \| duration:1\.2s \| rounds:2 \| tools:3 \| agents:4 \| compactions:1/);
  assert.match(summary, /\| refusal:no reason x/);
  assert.match(summary, /\| incomplete:max_output_tokens$/);
  assert.ok(summary.length < 800);
  assert.doesNotMatch(summary, /\x1b/);
  const noticeLines = new Notice("turn", summary).render(32).map(stripVTControlCharacters);
  assert.ok(noticeLines.every((line) => line.length <= 32));
  assert.match(noticeLines.join("\n"), /status:incomplete/);
});

test("formats shell approval signatures as readable scopes", () => {
  const approvedAt = Date.parse("2026-07-19T12:00:00Z");
  assert.deepEqual(formatCommandApproval(
    JSON.stringify(["shell-executable", 1, "powershell", "Get-Process"]),
    approvedAt,
  ), {
    label: "All PowerShell commands starting with 'Get-Process'",
    description: "2026-07-19T12:00:00.000Z",
  });
  assert.deepEqual(formatCommandApproval(
    JSON.stringify(["shell-executable", 1, "bash", "git"]),
    approvedAt,
  ), {
    label: "All Bash commands starting with 'git'",
    description: "2026-07-19T12:00:00.000Z",
  });
  assert.deepEqual(formatCommandApproval(
    JSON.stringify(["shell-exec", 1, "powershell", "Get-Process", "C:\\workspace", 5_000]),
    approvedAt,
  ), {
    label: "Get-Process",
    description: "C:\\workspace | 5000ms | 2026-07-19T12:00:00.000Z",
  });
});

test("preserves legacy Bash approval signature formatting", () => {
  const approvedAt = Date.parse("2026-07-19T12:00:00Z");
  assert.deepEqual(formatCommandApproval(
    JSON.stringify(["bash-exec", 3, "git status", "/workspace", 120_000]),
    approvedAt,
  ), {
    label: "git status",
    description: "/workspace | 120000ms | 2026-07-19T12:00:00.000Z",
  });
});

test("uses distinct transcript tones without repeating the assistant title", () => {
  const width = 96;
  const user = new UserMessage("Inspect the service").render(width);
  const assistant = new AssistantMessage("The service is healthy.").render(width);
  const tool = new ToolCard("call-1", "bash", "Check service status");
  tool.progress("codex-lb:gpt-luna | reasoning high | agent api [Thinking]");
  assert.match(stripVTControlCharacters(tool.render(width).join("\n")), /gpt-luna.*reasoning high/);
  tool.finish("active", false);
  const toolLines = tool.render(width);

  assert.match(user[0]!, /\x1b\[38;5;252;48;5;17m/);
  assert.match(stripVTControlCharacters(user.join("\n")), /You/);
  assert.match(assistant[0]!, /\x1b\[38;5;252;48;5;234m/);
  assert.doesNotMatch(stripVTControlCharacters(assistant.join("\n")), /Looking Glass/i);
  assert.match(toolLines[0]!, /\x1b\[38;5;252;48;5;236m/);
  assert.match(stripVTControlCharacters(toolLines.join("\n")), /bash.*done.*Check service status/);
  assert.equal(stripVTControlCharacters(user[0]!).length, width);
  assert.equal(stripVTControlCharacters(assistant[0]!).length, width);
  assert.equal(stripVTControlCharacters(toolLines[0]!).length, width);
});

test("keeps agent progress oldest-first, grouped, bounded, and visible after finish", () => {
  const tool = new ToolCard("agents", "run_agents", "Run agents");
  const progress = (agent: string, action: string): void => {
    tool.progress(`codex-lb:gpt-luna | reasoning high | agent ${agent} [${action}]`);
  };
  progress("alpha", "older");
  progress("alpha", "newer");
  progress("beta", "separate");

  const initial = stripVTControlCharacters(tool.render(96).join("\n"));
  assert.ok(initial.indexOf("older") < initial.indexOf("newer"));
  assert.ok(initial.indexOf("agent alpha") < initial.indexOf("agent beta"));
  assert.match(initial, /agent beta[\s\S]*separate/);

  const bounded = new ToolCard("bounded", "run_agents", "Run agents");
  for (let index = 0; index < 12; index += 1) {
    bounded.progress(`codex-lb:gpt-luna | reasoning high | agent alpha [action-${index}]`);
  }
  const boundedText = stripVTControlCharacters(bounded.render(96).join("\n"));
  assert.equal((boundedText.match(/action-\d+/gu) ?? []).length, 5);
  assert.doesNotMatch(boundedText, /action-[0-6](?:\D|$)/u);
  assert.ok(boundedText.indexOf("action-10") < boundedText.indexOf("action-11"));

  bounded.finish("final agent output", false);
  const finished = stripVTControlCharacters(bounded.render(96).join("\n"));
  assert.match(finished, /action-11/);
  assert.match(finished, /final agent output/);
});

test("keeps encoded arbitrary agent ids distinct while rendering readable labels", () => {
  const tool = new ToolCard("encoded-agents", "run_agents", "Run agents");
  const progress = (agent: string, action: string): void => {
    tool.progress(`codex-lb:gpt-luna | reasoning high | agent ${JSON.stringify(agent)} [${action}]`);
  };
  const whitespaceId = "worker  id";
  const ordinaryId = "worker id";
  const bracketId = "worker [id]";
  const newlineId = "worker\nid";
  const longId = `long-${"a".repeat(100)}`;
  const similarLongId = `long-${"a".repeat(99)}b`;
  progress(whitespaceId, "whitespace");
  progress(ordinaryId, "ordinary");
  progress(bracketId, "bracket");
  progress(newlineId, "newline");
  for (let index = 0; index < 12; index += 1) progress(longId, `long-${index}`);
  progress(similarLongId, "similar-long");

  const rendered = stripVTControlCharacters(tool.render(400).join("\n"));
  assert.equal((rendered.match(/agent worker id \|/gu) ?? []).length, 3);
  assert.match(rendered, /agent worker \[id\] \|/u);
  assert.match(rendered, new RegExp(`agent ${longId} \\|`, "u"));
  assert.match(rendered, new RegExp(`agent ${similarLongId} \\|`, "u"));
  assert.match(rendered, /newline/u);
  assert.doesNotMatch(rendered, /\\n/u);
  assert.equal((rendered.match(/long-\d+/gu) ?? []).length, 5);
  assert.doesNotMatch(rendered, /long-[0-6](?:\D|$)/u);
  assert.match(rendered, /similar-long/u);
});

test("renders approval actions as clickable buttons", () => {
  const terminal = { rows: 24, columns: 80 } as never;
  const modal = new ApprovalModal(terminal, {
    tool: "bash",
    risk: "critical",
    summary: "Delete generated files",
    details: "rm -rf generated",
    canAlwaysApprove: true,
  });
  const width = 68;
  const lines = modal.render(width);
  const plain = lines.map(stripVTControlCharacters);
  assert.match(plain.join("\n"), /Confirm command/);
  const actionRow = plain.findIndex((line) => line.includes("[ Deny ]") && line.includes("[ Approve once ]"));
  assert.ok(actionRow >= 0);
  const approveColumn = plain[actionRow]!.indexOf("[ Approve once ]") + 1;
  const overlayColumn = 1 + Math.floor((78 - width) / 2);
  const overlayRow = 1 + Math.floor((22 - lines.length) / 2);
  let approved: string | null = null;
  modal.onDone = (value) => {
    approved = value;
  };
  const point = {
    button: 0,
    column: overlayColumn + approveColumn,
    row: overlayRow + actionRow,
    shift: false,
    alt: false,
    ctrl: false,
  };
  assert.equal(modal.handleMouse({ ...point, action: "press" }), true);
  assert.equal(modal.handleMouse({ ...point, action: "release" }), true);
  assert.equal(approved, "once");

  const canceled = new ApprovalModal(terminal, {
    tool: "bash",
    risk: "critical",
    summary: "Delete generated files",
    details: "rm -rf generated",
    canAlwaysApprove: true,
  });
  const canceledLines = canceled.render(width).map(stripVTControlCharacters);
  const canceledActionRow = canceledLines.findIndex((line) => line.includes("[ Deny ]") && line.includes("[ Approve once ]"));
  const denyColumn = canceledLines[canceledActionRow]!.indexOf("[ Deny ]") + 1;
  const canceledApproveColumn = canceledLines[canceledActionRow]!.indexOf("[ Approve once ]") + 1;
  let canceledResult: string | null = null;
  canceled.onDone = (value) => {
    canceledResult = value;
  };
  const base = { button: 0, row: overlayRow + canceledActionRow, shift: false, alt: false, ctrl: false };
  canceled.handleMouse({ ...base, action: "press", column: overlayColumn + denyColumn });
  canceled.handleMouse({ ...base, action: "drag", column: overlayColumn + canceledApproveColumn });
  canceled.handleMouse({ ...base, action: "release", column: overlayColumn + canceledApproveColumn });
  assert.equal(canceledResult, null);
  canceled.handleInput("\r");
  assert.equal(canceledResult, "deny");
});

test("offers always approval for shell and critical actions", () => {
  const terminal = { rows: 24, columns: 80 } as never;
  const eligible = new ApprovalModal(terminal, {
    tool: "bash",
    risk: "shell",
    summary: "List files",
    details: '{"command":"ls -la","workdir":null,"timeout_ms":null}',
    canAlwaysApprove: true,
  });
  const width = 68;
  const lines = eligible.render(width);
  const plain = lines.map(stripVTControlCharacters);
  const actionRow = plain.findIndex((line) => line.includes("[ Always approve ]"));
  assert.ok(actionRow >= 0);
  const actionColumn = plain[actionRow]!.indexOf("[ Always approve ]") + 1;
  const overlayColumn = 1 + Math.floor((78 - width) / 2);
  const overlayRow = 1 + Math.floor((22 - lines.length) / 2);
  let clicked: string | null = null;
  eligible.onDone = (decision) => {
    clicked = decision;
  };
  const point = {
    action: "press" as const,
    button: 0,
    column: overlayColumn + actionColumn,
    row: overlayRow + actionRow,
    shift: false,
    alt: false,
    ctrl: false,
  };
  eligible.handleMouse(point);
  eligible.handleMouse({ ...point, action: "release" });
  assert.equal(clicked, "always");

  const keyboard = new ApprovalModal(terminal, {
    tool: "bash",
    risk: "shell",
    summary: "List files",
    details: "ls -la",
    canAlwaysApprove: true,
  });
  let keyboardDecision: string | null = null;
  keyboard.onDone = (decision) => {
    keyboardDecision = decision;
  };
  keyboard.handleInput("\t");
  keyboard.handleInput("\t");
  keyboard.handleInput("\r");
  assert.equal(keyboardDecision, "always");

  const critical = new ApprovalModal(terminal, {
    tool: "bash",
    risk: "critical",
    summary: "Delete files",
    details: "rm -rf data",
    canAlwaysApprove: true,
  });
  assert.match(stripVTControlCharacters(critical.render(width).join("\n")), /\[ Always approve \]/);
});

test("stacks all eligible approval buttons within the minimum viewport", () => {
  const terminal = { rows: 12, columns: 32 } as never;
  const modal = new ApprovalModal(terminal, {
    tool: "bash",
    risk: "shell",
    summary: "List files",
    details: "ls -la",
    canAlwaysApprove: true,
  });
  const plain = modal.render(27).map(stripVTControlCharacters);
  const buttonRows = ["[ Deny ]", "[ Approve once ]", "[ Always approve ]"]
    .map((label) => plain.findIndex((line) => line.includes(label)));
  assert.ok(buttonRows.every((row) => row >= 0));
  assert.equal(new Set(buttonRows).size, 3);
  assert.equal(plain.length, 9);
  assert.ok(plain.every((line) => line.length <= 27));
});

test("stacks approval buttons safely at minimum terminal width", () => {
  const terminal = { rows: 12, columns: 32 } as never;
  const modal = new ApprovalModal(terminal, {
    tool: "bash",
    risk: "critical",
    summary: "Delete generated files",
    details: "rm -rf generated",
    canAlwaysApprove: true,
  });
  const width = 27;
  const lines = modal.render(width);
  const plain = lines.map(stripVTControlCharacters);
  const approveRow = plain.findIndex((line) => line.includes("[ Approve once ]"));
  assert.ok(approveRow > 0);
  assert.notEqual(approveRow, plain.findIndex((line) => line.includes("[ Deny ]")));
  assert.ok(plain.every((line) => line.length <= width));
  const overlayColumn = 1 + Math.floor((30 - width) / 2);
  const overlayRow = 1 + Math.floor((10 - lines.length) / 2);
  let result: string | null = null;
  modal.onDone = (value) => {
    result = value;
  };
  const border = {
    button: 0,
    column: overlayColumn + width - 1,
    row: overlayRow + approveRow,
    shift: false,
    alt: false,
    ctrl: false,
  };
  assert.equal(modal.handleMouse({ ...border, action: "press" }), false);
  assert.equal(modal.handleMouse({ ...border, action: "release" }), false);
  assert.equal(result, null);
});

function taskPlanSnapshot(items: TaskPlanSnapshot["plan"]["items"]): TaskPlanSnapshot {
  return { plan: { items }, sequence: 1, createdAt: 1 };
}

test("renders no task-plan panel without a snapshot", () => {
  const panel = new TaskPlanPanel();
  assert.deepEqual(panel.render(40), []);
  panel.setSnapshot(null);
  assert.deepEqual(panel.render(40), []);
  panel.setSnapshot(taskPlanSnapshot([]));
  assert.deepEqual(panel.render(40), []);
});

test("hides completed task plans so resumed transcript content is not pushed below them", () => {
  const panel = new TaskPlanPanel();
  panel.setSnapshot(taskPlanSnapshot([
    { id: "done", content: "Finished work", priority: "medium", status: "completed" },
    { id: "canceled", content: "Canceled work", priority: "low", status: "cancelled" },
  ]));
  assert.deepEqual(panel.render(40), []);

  panel.setSnapshot(taskPlanSnapshot([
    { id: "active", content: "Work in progress", priority: "high", status: "in_progress" },
  ]));
  assert.notDeepEqual(panel.render(40), []);
  // End-of-turn cleanup clears even a plan whose terminal status was never
  // recorded by the model.
  panel.setSnapshot(null);
  assert.deepEqual(panel.render(40), []);

  const terminal = { rows: 12, columns: 40 } as never;
  const editor = {
    invalidate() {},
    render() { return ["editor input"]; },
  } as never;
  const root = new FullHeightRoot(terminal, editor, panel, () => "activity", () => "metadata");
  root.addEntry(new AssistantMessage("The turn has resumed."));
  const plain = root.render(40).map(stripVTControlCharacters);
  assert.ok(plain.some((line) => line.includes("The turn has resumed.")));
  assert.equal(plain.some((line) => line.includes("Task plan")), false);
});

test("renders task-plan checkmarks without status or priority text", () => {
  const panel = new TaskPlanPanel();
  panel.setSnapshot(taskPlanSnapshot([
    { id: "pending", content: "Pending work", priority: "low", status: "pending" },
    { id: "active", content: "Active work", priority: "high", status: "in_progress" },
    { id: "done", content: "Finished work", priority: "medium", status: "completed" },
    { id: "canceled", content: "Canceled work", priority: "low", status: "cancelled" },
  ]));
  const raw = panel.render(80).join("\n");
  const rendered = stripVTControlCharacters(raw);
  assert.match(rendered, /Task plan 1\/4 complete/);
  assert.match(rendered, /☐ Pending work/);
  assert.match(rendered, /> Active work/);
  assert.match(rendered, /✓ Finished work/);
  assert.match(rendered, /× Canceled work/);
  assert.doesNotMatch(rendered, /pending|in_progress|completed|cancelled|priority|high|medium|low/);
  assert.match(raw, /\x1b\[33m>/);
  assert.match(raw, /\x1b\[32m✓/);
  assert.match(raw, /48;5;234m/);
});

test("wraps task-plan content to a bounded width and neutralizes controls", () => {
  const panel = new TaskPlanPanel();
  panel.setSnapshot(taskPlanSnapshot([{
    id: "bounded",
    content: `long ${"content ".repeat(25)}\x1b[31m\nnext\tpart\u0007`,
    priority: "high",
    status: "in_progress",
  }]));
  const width = 28;
  const lines = panel.render(width);
  const plain = lines.map(stripVTControlCharacters);
  assert.ok(plain.length > 2);
  assert.ok(plain.every((line) => line.length <= width));
  assert.doesNotMatch(lines.join("\n"), /\x1b\[31m/);
  assert.match(plain.join("\n"), /next/);
  assert.match(plain.join("\n"), /part/);
});

test("caps an oversized task plan so the checklist stays above the editor viewport", () => {
  const rows = 12;
  const columns = 32;
  const terminal = { rows, columns } as never;
  const panel = new TaskPlanPanel();
  panel.setSnapshot(taskPlanSnapshot(Array.from({ length: 32 }, (_, index) => ({
    id: `item-${index}`,
    content: `Item ${index} ${"word ".repeat(35)}`,
    priority: "low" as const,
    status: "pending" as const,
  }))));
  const editor = {
    invalidate() {},
    render() { return ["editor input"]; },
  } as never;
  const root = new FullHeightRoot(terminal, editor, panel, () => "activity", () => "metadata");

  const frame = root.render(columns);
  const plain = frame.map(stripVTControlCharacters);
  assert.equal(frame.length, rows);
  assert.equal(plain.at(-1), " metadata");
  assert.ok(plain.some((line) => line.includes("editor input")));
  assert.match(plain.join("\n"), /\[\.\.\. \d+ more plan lines\]/);
  assert.ok(plain.every((line) => line.length <= columns));
});

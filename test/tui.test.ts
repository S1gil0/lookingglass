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
  inboxLine,
  initialTuiSession,
  markInboxItemsRead,
  mouseWheelDelta,
  parseTerminalMouse,
  parseSessionSchedule,
  selectedScreenText,
  sessionMetadataLine,
  shouldAutoDisplayInbox,
} from "../src/ui/tui.js";
import { terminalSafe } from "../src/ui/stdio.js";
import type { InboxRecord, SchedulerJob } from "../src/scheduler/types.js";

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
  }, "unrestricted", "ctx:42%");
  assert.equal(metadata, "qwen/model | medium | ctx:42% | agents:on | unrestricted | persist:on | Session name");
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
    persistent: true,
    promptCacheKey: "cache",
    lastResponseId: null,
    kind: "interactive",
    parentSessionId: null,
    createdAt: 1,
    updatedAt: 1,
  }, "unrestricted", "ctx:42%", 79);
  assert.match(narrow, /^qwen\/.* \| medium \| ctx:42% \| agents:off \| unrestricted \| p:on \| A/);
  assert.ok(narrow.length <= 79);
  assert.equal(contextUsageLabel(65_536, 262_144), "ctx:25%");
  assert.equal(contextUsageLabel(1, 0), "ctx:?");
  assert.equal(activityLine(true, "Thinking", 1, 12), "Thinking.. | scroll:+12");
  assert.equal(activityLine(false, "ignored", 0, 0), "Ready");
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

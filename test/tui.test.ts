import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import {
  ApprovalModal,
  SelectorModal,
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
  RepeatedPressConfirmation,
  renderStartupScreen,
  renderFrame,
  selectedScreenText,
  sessionMetadataLine,
  shouldAutoDisplayInbox,
  startupPanelWidth,
  StartupScreenState,
  startupSessionEligible,
  isPlainPromptSubmission,
  restoreApiKeyEnvironment,
  TaskPlanPanel,
  type TerminalMouseEvent,
  detectActiveSelectorCommand,
  expandActiveSelectorCommand,
} from "../src/ui/tui.js";
import { terminalSafe } from "../src/ui/stdio.js";
import { prepareQueuedValue, SubmissionQueue, type PreparedSubmission } from "../src/ui/submission-queue.js";
import { findModelChoice, SelectorPresentationQueue } from "../src/ui/setting-picker.js";
import type { InboxRecord, SchedulerJob } from "../src/scheduler/types.js";
import type { TaskPlanSnapshot } from "../src/task-plan.js";

function selectorMouseEvent(
  action: TerminalMouseEvent["action"],
  column: number,
  row: number,
  button = 0,
): TerminalMouseEvent {
  return { action, button, column, row, shift: false, alt: false, ctrl: false };
}

test("serializes queued submissions in FIFO order without overlap", async () => {
  const events: string[] = [];
  let active = 0;
  let maximumActive = 0;
  let releaseFirst!: () => void;
  const firstTurn = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const queue = new SubmissionQueue<string>(async (value) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    events.push(`start:${value}`);
    try {
      if (value === "first") await firstTurn;
      events.push(`finish:${value}`);
    } finally {
      active -= 1;
    }
  });

  const first = queue.enqueue("first");
  const second = queue.enqueue("second");
  const third = queue.enqueue("third");
  assert.equal(first.queued, false);
  assert.equal(second.position, 2);
  assert.equal(third.position, 3);
  assert.equal(queue.size, 3);

  releaseFirst();
  await Promise.all([first.promise, second.promise, third.promise]);
  await queue.whenIdle();

  assert.equal(maximumActive, 1);
  assert.deepEqual(events, [
    "start:first",
    "finish:first",
    "start:second",
    "finish:second",
    "start:third",
    "finish:third",
  ]);
  assert.equal(queue.size, 0);
});

test("continues draining submissions after one item fails", async () => {
  const completed: string[] = [];
  const queue = new SubmissionQueue<string>(async (value) => {
    if (value === "bad") throw new Error("bad submission");
    completed.push(value);
  });
  const failed = queue.enqueue("bad");
  const next = queue.enqueue("next");

  await assert.rejects(failed.promise, /bad submission/);
  await next.promise;
  assert.deepEqual(completed, ["next"]);
});

test("prepared selector values reserve their FIFO position before later prompts", async () => {
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstTurn = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let resolvePicker!: (value: string | null) => void;
  const picker = prepareQueuedValue(new Promise<string | null>((resolve) => {
    resolvePicker = resolve;
  }));
  type Item = string | PreparedSubmission<string | null>;
  const queue = new SubmissionQueue<Item>(async (item) => {
    const value = typeof item === "string" ? item : await item.ready;
    if (value === null) return;
    events.push(value);
    if (value === "first") await firstTurn;
  });

  queue.enqueue("first");
  const setting = queue.enqueue(picker);
  const later = queue.enqueue("later");
  assert.equal(setting.position, 2);
  assert.equal(later.position, 3);
  releaseFirst();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first"]);
  resolvePicker("/model provider:chosen");
  await Promise.all([setting.promise, later.promise]);
  assert.deepEqual(events, ["first", "/model provider:chosen", "later"]);
});

test("cancelled prepared selector values let later submissions continue", async () => {
  const completed: string[] = [];
  let resolvePicker!: (value: string | null) => void;
  const picker = prepareQueuedValue(new Promise<string | null>((resolve) => {
    resolvePicker = resolve;
  }));
  const queue = new SubmissionQueue<string | PreparedSubmission<string | null>>(async (item) => {
    const value = typeof item === "string" ? item : await item.ready;
    if (value !== null) completed.push(value);
  });
  const cancelled = queue.enqueue(picker);
  const later = queue.enqueue("later");
  resolvePicker(null);
  await cancelled.promise;
  await later.promise;
  assert.deepEqual(completed, ["later"]);
});

test("detects only bare active selector commands and expands captured values", () => {
  assert.deepEqual(detectActiveSelectorCommand(" /MODEL  "), { name: "model" });
  assert.deepEqual(detectActiveSelectorCommand("/agentreasoning"), { name: "agentreasoning" });
  assert.equal(detectActiveSelectorCommand("/model provider:id"), null);
  assert.equal(detectActiveSelectorCommand("/reasoning high now"), null);
  assert.equal(expandActiveSelectorCommand({ name: "reasoning" }, " high "), "/reasoning high");
});

test("selector presentation slots preserve submission order across readiness races", async () => {
  const presentations = new SelectorPresentationQueue();
  const first = presentations.reserve();
  const second = presentations.reserve();
  let secondReady = false;
  void second.wait.then(() => {
    secondReady = true;
  });

  await Promise.resolve();
  assert.equal(secondReady, false);
  first.release();
  await second.wait;
  assert.equal(secondReady, true);
  first.release();
  second.release();
});

test("early selector releases cascade in reservation order", async () => {
  const presentations = new SelectorPresentationQueue();
  const first = presentations.reserve();
  const later = presentations.reserve();
  const last = presentations.reserve();
  const ready: string[] = [];
  void later.wait.then(() => ready.push("later"));
  void last.wait.then(() => ready.push("last"));

  // Model catalog failure/cancellation can happen before the predecessor is
  // ready. Those releases must remain pending rather than skipping the slot.
  later.release();
  last.release();
  await Promise.resolve();
  assert.deepEqual(ready, []);

  first.release();
  await last.wait;
  assert.deepEqual(ready, ["later", "last"]);
  later.release();
  last.release();
});

test("qualified model choices prefer complete keys and support colon ids", () => {
  const models = [
    { provider: "current", id: "plain" },
    { provider: "current", id: "model:free" },
    { provider: "other", id: "model:free" },
  ];
  assert.deepEqual(findModelChoice(models, "other:model:free", "current"), models[2]);
  assert.deepEqual(findModelChoice(models, "model:free", "current"), models[1]);
  assert.deepEqual(findModelChoice(models, "plain", "current"), models[0]);
});

test("requires a repeated interrupt key press within the confirmation window", () => {
  const confirmation = new RepeatedPressConfirmation(10_000);

  assert.equal(confirmation.press(1_000), false);
  assert.equal(confirmation.press(11_000), true);
  assert.equal(confirmation.press(12_000), false);
  assert.equal(confirmation.press(22_001), false);
  assert.equal(confirmation.press(23_000), true);

  assert.equal(confirmation.press(30_000), false);
  confirmation.reset();
  assert.equal(confirmation.press(30_001), false);
});

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

test("startup eligibility follows durable events and accepted plain prompts", () => {
  assert.equal(startupSessionEligible(0, false), true);
  assert.equal(startupSessionEligible(1, false), false);
  assert.equal(startupSessionEligible(0, true), false);
  assert.equal(isPlainPromptSubmission(" inspect the project "), true);
  assert.equal(isPlainPromptSubmission("/model"), false);
  assert.equal(isPlainPromptSubmission("   "), false);

  const state = new StartupScreenState();
  assert.equal(state.shouldShow("empty", 0), true);
  assert.equal(state.markPromptAccepted("empty", "/model"), false);
  assert.equal(state.shouldShow("empty", 0), true);
  assert.equal(state.markPromptAccepted("empty", "inspect the project"), true);
  assert.equal(state.shouldShow("empty", 0), false);
  assert.equal(state.shouldShow("durable", 1), false);
  assert.equal(state.shouldShow("new-empty", 0), true);
  // A prompt queued behind /new is accepted once for the old session and
  // again when it executes against the newly selected empty session.
  assert.equal(state.markPromptAccepted("new-empty", "continue in the new session"), true);
  assert.equal(state.shouldShow("new-empty", 0), false);
});

test("startup screen centers ANSI content and keeps minimum terminals bounded", () => {
  for (const [width, height] of [[120, 36], [32, 12]] as const) {
    const panelWidth = startupPanelWidth(width);
    const frame = renderStartupScreen(width, height, [
      "─".repeat(panelWidth),
      `${" ".repeat(Math.max(0, panelWidth - 2))}${CURSOR_MARKER} `,
      "─".repeat(panelWidth),
    ], {
      panelWidth,
      metadataLine: "qwen/model (medium) | unrestricted | persist:on | Session name",
      statusLines: ["[model] gateway status remains inside the panel"],
    });
    const plain = frame.map(stripVTControlCharacters);
    assert.equal(frame.length, height);
    assert.ok(frame.every((line) => visibleWidth(line) <= width));
    assert.ok(plain.some((line) => line.includes("███")));
    assert.ok(plain.some((line) => line.includes("describe a task")));
    assert.ok(plain.some((line) => line.includes("qwen/model (medium)")));
    assert.ok(frame.some((line) => line.includes(CURSOR_MARKER)));
    const panelRowIndex = plain.findIndex((line) => line.includes("─".repeat(panelWidth)));
    assert.ok(panelRowIndex >= 0);
    const panelRow = plain[panelRowIndex]!;
    const panelStart = panelRow.indexOf("─");
    assert.equal(panelStart, Math.floor((width - panelWidth) / 2));
    assert.ok(visibleWidth(frame.find((line) => line.includes(CURSOR_MARKER)) ?? "") <= width);

    if (width >= 64) {
      const statusRow = plain.find((line) => line.includes("gateway status"));
      assert.ok(statusRow);
      const statusStart = statusRow!.search(/\S/u);
      assert.ok(statusStart >= panelStart);
      assert.ok(statusStart + visibleWidth(statusRow!.slice(statusStart)) <= panelStart + panelWidth);
    }
  }
});

test("startup logo renders the neon block wordmark without separate subtext", () => {
  for (const [width, height] of [[120, 36], [50, 15], [32, 20]] as const) {
    const frame = renderStartupScreen(width, height, [], { inputEmpty: false });
    const plain = frame.map(stripVTControlCharacters).join("\n");

    assert.equal(frame.length, height);
    assert.ok(frame.every((line) => visibleWidth(line) <= width));
    assert.ok(plain.includes("█░░ ███ ███"));
    assert.ok(plain.includes("███ ███ █░█ ███ ███"));
    assert.equal(plain.includes("LOOKING GLASS"), false);
    assert.equal(plain.includes("❯_"), false);
  }
});

test("startup truncation keeps the latest notice label before its tail", () => {
  const width = 40;
  const panelWidth = startupPanelWidth(width);
  const frame = renderStartupScreen(width, 12, [
    "─".repeat(panelWidth),
    `${CURSOR_MARKER}${" ".repeat(Math.max(0, panelWidth - 1))}`,
    "─".repeat(panelWidth),
  ], {
    panelWidth,
    metadataLine: "model (high)",
    statusLines: ["[model] updated", "continuation", "unexplained tail"],
  }).map(stripVTControlCharacters);

  assert.ok(frame.some((line) => line.includes("[model] updated")));
  assert.equal(frame.some((line) => line.includes("unexplained tail")), false);
});

test("dismissing startup returns the existing full-height transcript layout", () => {
  const terminal = { rows: 12, columns: 40 } as never;
  const editor = {
    invalidate() {},
    render() { return ["editor input"]; },
  } as never;
  const root = new FullHeightRoot(
    terminal,
    editor,
    new TaskPlanPanel(),
    () => "activity",
    () => "metadata",
    { startupVisible: true },
  );
  const startup = root.render(40).map(stripVTControlCharacters);
  assert.ok(startup.some((line) => line.includes("███")));
  assert.ok(startup.some((line) => line.includes("metadata")));
  root.setStartupVisible(false);
  root.addEntry(new AssistantMessage("The normal transcript is active."));
  const normal = root.render(40).map(stripVTControlCharacters);
  assert.equal(normal.some((line) => line.includes("███")), false);
  assert.ok(normal.some((line) => line.includes("The normal transcript is active.")));
  assert.equal(normal.at(-1), " metadata");
});

test("startup keeps the existing minimum-terminal diagnostic", () => {
  const terminal = { rows: 11, columns: 31 } as never;
  const editor = { invalidate() {}, render() { return ["editor input"]; } } as never;
  const root = new FullHeightRoot(terminal, editor, new TaskPlanPanel(), () => "activity", () => "metadata", {
    startupVisible: true,
  });
  const frame = root.render(31).map(stripVTControlCharacters);
  assert.equal(frame.length, 11);
  assert.match(frame.join("\n"), /Terminal too small \(31x11\); nee/);
  assert.equal(frame.some((line) => line.includes("LOOKING GLASS")), false);
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

test("formats long turn durations with hour, minute, and second components", () => {
  const metrics = {
    responseStatus: "completed",
    modelRounds: 1,
    toolCalls: 0,
    leafAgents: 0,
    compactions: 0,
  };
  assert.match(formatTurnSummary({ ...metrics, durationMs: 59_949 }), /duration:59\.9s/);
  assert.match(formatTurnSummary({ ...metrics, durationMs: 59_950 }), /duration:1m 0s/);
  assert.match(formatTurnSummary({ ...metrics, durationMs: 61_000 }), /duration:1m 1s/);
  assert.match(formatTurnSummary({ ...metrics, durationMs: 22_891_000 }), /duration:6h 21m 31s/);
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

test("renders modal frames with rounded box-drawing borders and a glass accent", () => {
  const frame = renderFrame("Confirm command", ["Details", "Choose an action"], 28);
  const plain = frame.map(stripVTControlCharacters);

  assert.equal(frame.length, 6);
  assert.match(plain[0]!, /^╭─+╮$/u);
  assert.match(plain[1]!, /^│ ◇ Confirm command\s+│$/u);
  assert.match(plain[2]!, /^├─+┤$/u);
  assert.match(plain[3]!, /^│Details\s+│$/u);
  assert.match(plain[4]!, /^│Choose an action\s+│$/u);
  assert.match(plain[5]!, /^╰─+╯$/u);
  assert.ok(frame.every((line) => visibleWidth(line) === 28));
});

test("truncates ANSI-styled frame content and titles to the requested width", () => {
  const frame = renderFrame(
    `A very long modal title ${"x".repeat(20)}`,
    [`\x1b[32m${"body ".repeat(12)}\x1b[39m`],
    18,
  );
  const plain = frame.map(stripVTControlCharacters);

  assert.ok(frame.every((line) => visibleWidth(line) <= 18));
  assert.ok(frame.every((line) => visibleWidth(line) === 18));
  assert.match(plain[1]!, /^│ ◇ A very long /u);
  assert.match(plain[1]!, /│$/u);
  assert.match(frame[1]!, /\x1b\[1m/u);
  assert.match(frame[3]!, /\x1b\[32m/u);
});

test("falls back to unframed ANSI-aware lines for widths below four cells", () => {
  for (const width of [1, 2, 3]) {
    const frame = renderFrame("Title", [`\x1b[36m${"abcdef"}\x1b[39m`, "body"], width);
    assert.equal(frame.length, 2);
    assert.ok(frame.every((line) => visibleWidth(line) <= width));
    assert.doesNotMatch(stripVTControlCharacters(frame.join("\n")), /[╭╮╰╯│]/u);
  }
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

test("selector clicks highlight on press and select only on a matching release", () => {
  const terminal = { rows: 24, columns: 80 };
  const modal = new SelectorModal(terminal, "Pick one", [
    { value: "first", label: "First" },
    { value: "second", label: "Second" },
    { value: "third", label: "Third" },
  ], 3);
  const width = 52;
  const plain = modal.render(width).map(stripVTControlCharacters);
  const itemRow = plain.findIndex((line) => line.includes("Second"));
  assert.ok(itemRow >= 0);
  const overlayColumn = 1 + Math.floor((terminal.columns - 2 - width) / 2);
  const overlayRow = 1 + Math.floor((terminal.rows - 2 - plain.length) / 2);
  const point = selectorMouseEvent("press", overlayColumn + 2, overlayRow + itemRow);
  let selected: string | null = null;
  modal.onSelect = (value) => {
    selected = value;
  };

  assert.equal(modal.handleMouse(point), true);
  assert.equal(modal.list.getSelectedItem()?.value, "second");
  assert.equal(selected, null);
  assert.equal(modal.handleMouse({ ...point, action: "release" }), true);
  assert.equal(selected, "second");

  const mismatch = new SelectorModal(terminal, "Pick one", [
    { value: "first", label: "First" },
    { value: "second", label: "Second" },
  ], 2);
  const mismatchLines = mismatch.render(width).map(stripVTControlCharacters);
  const mismatchOriginRow = 1 + Math.floor((terminal.rows - 2 - mismatchLines.length) / 2);
  const mismatchFirst = mismatchLines.findIndex((line) => line.includes("First"));
  const mismatchSecond = mismatchLines.findIndex((line) => line.includes("Second"));
  let mismatchValue: string | null = null;
  mismatch.onSelect = (value) => {
    mismatchValue = value;
  };
  mismatch.handleMouse(selectorMouseEvent("press", overlayColumn + 2, mismatchOriginRow + mismatchFirst));
  mismatch.handleMouse(selectorMouseEvent("release", overlayColumn + 2, mismatchOriginRow + mismatchSecond));
  assert.equal(mismatchValue, null);

  const foreignRelease = selectorMouseEvent("press", overlayColumn + 2, mismatchOriginRow + mismatchFirst);
  mismatch.handleMouse(foreignRelease);
  assert.equal(mismatch.handleMouse({ ...foreignRelease, action: "release", button: 1 }), false);
  mismatch.handleMouse({ ...foreignRelease, action: "release", button: 3 });
  assert.equal(mismatchValue, null);
});

test("selector ignores frame, prompt, hint, scroll indicator, and outside clicks", () => {
  const terminal = { rows: 24, columns: 80 };
  const modal = new SelectorModal(terminal, "Pick one", [
    { value: "one", label: "One" },
    { value: "two", label: "Two" },
    { value: "three", label: "Three" },
    { value: "four", label: "Four" },
  ], 2, "Choose an option from this prompt");
  const width = 52;
  const plain = modal.render(width).map(stripVTControlCharacters);
  const overlayColumn = 1 + Math.floor((terminal.columns - 2 - width) / 2);
  const overlayRow = 1 + Math.floor((terminal.rows - 2 - plain.length) / 2);
  const hintRow = plain.findIndex((line) => line.includes("Enter select"));
  const scrollRow = plain.findIndex((line) => line.includes("(1/4)"));
  const promptRow = plain.findIndex((line) => line.includes("Choose an option"));
  assert.ok(hintRow >= 0);
  assert.ok(scrollRow >= 0);
  assert.ok(promptRow >= 0);
  let selected: string | null = null;
  modal.onSelect = (value) => {
    selected = value;
  };
  const ignored = [
    selectorMouseEvent("press", overlayColumn + 2, overlayRow),
    selectorMouseEvent("press", overlayColumn + 2, overlayRow + promptRow),
    selectorMouseEvent("press", overlayColumn + 2, overlayRow + scrollRow),
    selectorMouseEvent("press", overlayColumn + 2, overlayRow + hintRow),
    selectorMouseEvent("press", overlayColumn - 1, overlayRow + promptRow),
  ];
  for (const press of ignored) {
    modal.handleMouse(press);
    modal.handleMouse({ ...press, action: "release" });
  }
  assert.equal(selected, null);
});

test("selector wheel movement follows keyboard scrolling and survives prompt offsets and resize", () => {
  const terminal = { rows: 24, columns: 80 };
  const modal = new SelectorModal(terminal, "Pick one", Array.from({ length: 6 }, (_, index) => ({
    value: `value-${index}`,
    label: `Value ${index}`,
  })), 3, "A prompt that wraps across multiple rows in the selector");
  const width = 52;
  let plain = modal.render(width).map(stripVTControlCharacters);
  const overlayColumn = 1 + Math.floor((terminal.columns - 2 - width) / 2);
  let overlayRow = 1 + Math.floor((terminal.rows - 2 - plain.length) / 2);
  const wheelPoint = selectorMouseEvent("wheel_down", overlayColumn + 2, overlayRow + 3);
  assert.equal(modal.handleMouse(wheelPoint), true);
  assert.equal(modal.list.getSelectedItem()?.value, "value-1");
  modal.handleInput("\x1b[B");
  assert.equal(modal.list.getSelectedItem()?.value, "value-2");
  plain = modal.render(width).map(stripVTControlCharacters);
  overlayRow = 1 + Math.floor((terminal.rows - 2 - plain.length) / 2);
  const visibleRow = plain.findIndex((line) => line.includes("Value 2"));
  assert.ok(visibleRow >= 0);
  let selected: string | null = null;
  modal.onSelect = (value) => {
    selected = value;
  };
  const outside = selectorMouseEvent("wheel_down", overlayColumn - 1, overlayRow + visibleRow);
  assert.equal(modal.handleMouse(outside), false);
  assert.equal(modal.list.getSelectedItem()?.value, "value-2");
  const option = selectorMouseEvent("press", overlayColumn + 2, overlayRow + visibleRow);
  modal.handleMouse(option);
  modal.handleMouse({ ...option, action: "release" });
  assert.equal(selected, "value-2");

  terminal.columns = 64;
  terminal.rows = 20;
  const resizedWidth = 42;
  plain = modal.render(resizedWidth).map(stripVTControlCharacters);
  overlayRow = 1 + Math.floor((terminal.rows - 2 - plain.length) / 2);
  const resizedRow = plain.findIndex((line) => line.includes("Value 2"));
  assert.ok(resizedRow >= 0);
  const resizedColumn = 1 + Math.floor((terminal.columns - 2 - resizedWidth) / 2) + 2;
  const resizedPoint = selectorMouseEvent("press", resizedColumn, overlayRow + resizedRow);
  modal.handleMouse(resizedPoint);
  modal.handleMouse({ ...resizedPoint, action: "release" });
  assert.equal(selected, "value-2");
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

test("refreshes a mutable transcript entry without rerendering session history", () => {
  const terminal = { rows: 12, columns: 40 } as never;
  const editor = {
    invalidate() {},
    render() { return ["editor input"]; },
  } as never;
  const panel = new TaskPlanPanel();
  const root = new FullHeightRoot(terminal, editor, panel, () => "activity", () => "metadata");
  let historyRenders = 0;
  let liveRenders = 0;
  let tailRenders = 0;
  let liveLines = ["running"];
  const history = {
    invalidate() {},
    render() {
      historyRenders += 1;
      return ["historical entry"];
    },
  };
  const live = {
    invalidate() {},
    render() {
      liveRenders += 1;
      return liveLines;
    },
  };
  const tail = {
    invalidate() {},
    render() {
      tailRenders += 1;
      return ["tail entry"];
    },
  };
  root.addEntry(history);
  root.addEntry(live);
  root.addEntry(tail);

  root.render(40);
  assert.deepEqual([historyRenders, liveRenders, tailRenders], [1, 1, 1]);
  liveLines = ["updated progress", "second progress line"];
  root.refreshEntry(live);
  const updated = root.render(40).map(stripVTControlCharacters);
  assert.deepEqual([historyRenders, liveRenders, tailRenders], [1, 2, 1]);
  assert.ok(updated.some((line) => line.includes("updated progress")));
  assert.ok(updated.some((line) => line.includes("second progress line")));
  assert.ok(updated.some((line) => line.includes("tail entry")));

  root.invalidate();
  root.render(40);
  assert.deepEqual([historyRenders, liveRenders, tailRenders], [2, 3, 2]);
});

test("large transcripts keep frequent progress refreshes bounded to the live entry", () => {
  const terminal = { rows: 12, columns: 40 } as never;
  const editor = {
    invalidate() {},
    render() { return ["editor input"]; },
  } as never;
  const root = new FullHeightRoot(
    terminal,
    editor,
    new TaskPlanPanel(),
    () => "activity",
    () => "metadata",
  );
  let historyRenders = 0;
  const historyEntries = 10_000;
  for (let index = 0; index < historyEntries; index += 1) {
    root.addEntry({
      invalidate() {},
      render() {
        historyRenders += 1;
        return [`history ${index}`];
      },
    });
  }
  let progressRenders = 0;
  let progress = 0;
  const live = {
    invalidate() {},
    render() {
      progressRenders += 1;
      return [`progress ${progress}`];
    },
  };
  root.addEntry(live);
  root.render(40);

  for (progress = 1; progress <= 250; progress += 1) root.refreshEntry(live);
  const frame = root.render(40).map(stripVTControlCharacters);
  assert.equal(historyRenders, historyEntries);
  assert.equal(progressRenders, 251);
  assert.ok(frame.some((line) => line.includes("progress 250")));
});

test("evicts the oldest transcript entries before and after the render cache is built", () => {
  const terminal = { rows: 12, columns: 40 } as never;
  const editor = {
    invalidate() {},
    render() { return ["editor input"]; },
  } as never;
  const evicted: string[] = [];
  const entry = (text: string) => ({
    invalidate() {},
    render() { return [text]; },
  });
  const first = entry("first");
  const second = entry("second");
  const third = entry("third");
  const fourth = entry("fourth");
  const root = new FullHeightRoot(
    terminal,
    editor,
    new TaskPlanPanel(),
    () => "activity",
    () => "metadata",
    { maxEntries: 2, onEvict: (component) => evicted.push(component === first ? "first" : "second") },
  );
  root.addEntry(first);
  root.addEntry(second);
  root.addEntry(third);
  let frame = root.render(40).map(stripVTControlCharacters);
  assert.deepEqual(evicted, ["first"]);
  assert.equal(frame.some((line) => line.includes("first")), false);
  assert.ok(frame.some((line) => line.includes("second")));
  assert.ok(frame.some((line) => line.includes("third")));

  root.addEntry(fourth);
  frame = root.render(40).map(stripVTControlCharacters);
  assert.deepEqual(evicted, ["first", "second"]);
  assert.equal(frame.some((line) => line.includes("second")), false);
  assert.ok(frame.some((line) => line.includes("third")));
  assert.ok(frame.some((line) => line.includes("fourth")));
});

test("live transcript eviction preserves a scrolled viewport anchor", () => {
  const terminal = { rows: 12, columns: 40 } as never;
  const editor = {
    invalidate() {},
    render() { return ["editor input"]; },
  } as never;
  const root = new FullHeightRoot(
    terminal,
    editor,
    new TaskPlanPanel(),
    () => "activity",
    () => "metadata",
    { maxEntries: 20 },
  );
  for (let index = 0; index < 20; index += 1) {
    root.addEntry({ invalidate() {}, render() { return [`entry ${index}`]; } });
  }
  root.render(40);
  root.scrollPage(-1);
  const before = root.render(40).map(stripVTControlCharacters);
  const anchoredRow = before.findIndex((line) => line.includes("entry 10"));
  assert.ok(anchoredRow >= 0);

  root.addEntry({ invalidate() {}, render() { return ["entry 20"]; } });
  const after = root.render(40).map(stripVTControlCharacters);
  assert.equal(after.findIndex((line) => line.includes("entry 10")), anchoredRow);
});

test("refreshing an evicted mutable entry does not invalidate retained history", () => {
  const terminal = { rows: 12, columns: 40 } as never;
  const editor = {
    invalidate() {},
    render() { return ["editor input"]; },
  } as never;
  let retainedRenders = 0;
  const mutable = { invalidate() {}, render() { return ["mutable"]; } };
  const retained = {
    invalidate() {},
    render() {
      retainedRenders += 1;
      return ["retained"];
    },
  };
  const root = new FullHeightRoot(
    terminal,
    editor,
    new TaskPlanPanel(),
    () => "activity",
    () => "metadata",
    { maxEntries: 2 },
  );
  root.addEntry(mutable);
  root.addEntry(retained);
  root.render(40);
  root.addEntry({ invalidate() {}, render() { return ["new tail"]; } });
  assert.equal(retainedRenders, 1);

  root.refreshEntry(mutable);
  root.render(40);
  assert.equal(retainedRenders, 1);
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

test("selects text rendered in the command editor area", () => {
  const terminal = { rows: 12, columns: 40 } as never;
  const editor = {
    invalidate() {},
    render() { return ["editor input"]; },
  } as never;
  const root = new FullHeightRoot(terminal, editor, new TaskPlanPanel(), () => "activity", () => "metadata");
  const frame = root.render(40).map(stripVTControlCharacters);
  const editorRow = frame.findIndex((line) => line.includes("editor input"));
  assert.ok(editorRow >= 0);
  assert.equal(root.startSelection({ row: editorRow, column: 0 }), true);
  assert.equal(root.updateSelection({ row: editorRow, column: "editor input".length - 1 }), true);
  assert.equal(root.selectionText(), "editor input");
});

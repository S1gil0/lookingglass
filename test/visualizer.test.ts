import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  FullHeightRoot,
  handleVisualizerTabMouse,
  handleVisualizerWheelMouse,
  resolveVisualizerCommand,
  TaskPlanPanel,
  type TerminalMouseEvent,
} from "../src/ui/tui.js";
import {
  VisualizerPane,
  VISUALIZER_VIEWS,
  visualizerTabAt,
  visualizerTabHitboxes,
  visualizerSplitLayout,
} from "../src/ui/visualizer.js";
import {
  toolCodeChanges,
  toolFiles,
  VisualizerEventBus,
  type VisualizerEventInput,
} from "../src/visualizer/events.js";
import { VisualizerStore, createVisualizerState, reduceVisualizerEvent } from "../src/visualizer/state.js";

function sampleEvents(): VisualizerEventInput[] {
  return [
    {
      type: "turn.start", timestamp: 1_000, sessionId: "main", turnId: "turn-1", entityId: "turn-1",
      model: "sol", provider: "codex-lb", reasoningEffort: "high", status: "active", contextWindow: 128_000,
    },
    {
      type: "model.request", timestamp: 1_010, sessionId: "main", turnId: "turn-1", entityId: "model-1",
      parentId: "turn-1", model: "sol", provider: "codex-lb", reasoningEffort: "high", status: "active",
      contextTokens: 38_000,
    },
    {
      type: "model.reasoning.start", timestamp: 1_020, sessionId: "main", turnId: "turn-1",
      entityId: "reasoning:model-1", parentId: "model-1", status: "active",
    },
    {
      type: "model.reasoning.summary", timestamp: 1_030, sessionId: "main", turnId: "turn-1",
      entityId: "reasoning:model-1", parentId: "model-1", status: "complete", summary: "Inspecting files",
    },
    {
      type: "model.reasoning.end", timestamp: 1_040, sessionId: "main", turnId: "turn-1",
      entityId: "reasoning:model-1", parentId: "model-1", status: "complete", reasoningTokens: 800,
    },
    {
      type: "model.response", timestamp: 1_050, sessionId: "main", turnId: "turn-1", entityId: "model-1",
      parentId: "turn-1", model: "sol", provider: "codex-lb", reasoningEffort: "high", status: "complete",
      duration: 40, inputTokens: 38_000, outputTokens: 1_200, reasoningTokens: 800,
    },
    {
      type: "context.update", timestamp: 1_051, sessionId: "main", turnId: "turn-1", entityId: "context:main",
      parentId: "turn-1", inputTokens: 38_000, outputTokens: 1_200,
      reasoningTokens: 800, contextTokens: 38_000, contextWindow: 128_000, status: "complete",
    },
    {
      type: "tool.request", timestamp: 1_060, sessionId: "main", turnId: "turn-1", entityId: "tool:call-1",
      parentId: "model-1", tool: "read", status: "waiting", files: ["src/engine/engine.ts"], summary: "read engine",
    },
    {
      type: "tool.start", timestamp: 1_061, sessionId: "main", turnId: "turn-1", entityId: "tool:call-1",
      parentId: "model-1", tool: "read", status: "active",
    },
    {
      type: "agent.spawn", timestamp: 1_062, sessionId: "main", entityId: "agent:child", agentId: "inspect",
      parentId: "tool:call-1", model: "qwen", provider: "openrouter", reasoningEffort: "medium", status: "waiting",
    },
    {
      type: "agent.start", timestamp: 1_063, sessionId: "child", entityId: "agent:child", agentId: "inspect",
      parentId: "tool:call-1", model: "qwen", provider: "openrouter", reasoningEffort: "medium", status: "active",
    },
    {
      type: "agent.end", timestamp: 1_080, sessionId: "child", entityId: "agent:child", agentId: "inspect",
      parentId: "tool:call-1", model: "qwen", provider: "openrouter", reasoningEffort: "medium",
      status: "complete", duration: 17,
    },
    {
      type: "tool.output", timestamp: 1_081, sessionId: "main", turnId: "turn-1", entityId: "tool:call-1",
      parentId: "model-1", tool: "read", status: "active", summary: "120 bytes",
    },
    {
      type: "tool.end", timestamp: 1_082, sessionId: "main", turnId: "turn-1", entityId: "tool:call-1",
      parentId: "model-1", tool: "read", status: "complete", duration: 22,
    },
    {
      type: "turn.end", timestamp: 1_100, sessionId: "main", turnId: "turn-1", entityId: "turn-1",
      model: "sol", provider: "codex-lb", reasoningEffort: "high", status: "complete", duration: 100,
    },
  ];
}

function populatedStore(): VisualizerStore {
  const bus = new VisualizerEventBus();
  const store = new VisualizerStore();
  bus.subscribe((event) => store.dispatch(event));
  for (const event of sampleEvents()) bus.emit(event);
  return store;
}

function storeWith(events: readonly VisualizerEventInput[]): VisualizerStore {
  const bus = new VisualizerEventBus();
  const store = new VisualizerStore();
  bus.subscribe((event) => store.dispatch(event));
  for (const event of events) bus.emit(event);
  return store;
}

test("visualizer event bus is ordered, unsubscribable, and observer-failure isolated", () => {
  const bus = new VisualizerEventBus();
  const seen: string[] = [];
  bus.subscribe(() => {
    throw new Error("observer failure");
  });
  const unsubscribe = bus.subscribe((event) => seen.push(`${event.sequence}:${event.type}`));
  const first = bus.emit({ type: "turn.start", sessionId: "s", turnId: "t", status: "active", timestamp: 10 });
  unsubscribe();
  const second = bus.emit({ type: "turn.end", sessionId: "s", turnId: "t", status: "complete", timestamp: 20 });

  assert.deepEqual(seen, [`${first.sequence}:turn.start`]);
  assert.ok(second.sequence > first.sequence);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(first.timestamp, 10);
});

test("visualizer reducer derives causal nodes, files, token metrics, and bounded timeline state", () => {
  const bus = new VisualizerEventBus();
  let state = createVisualizerState();
  for (const input of sampleEvents()) state = reduceVisualizerEvent(state, bus.emit(input));

  assert.equal(state.turns.get("turn-1")?.status, "complete");
  assert.equal(state.modelCalls.get("model-1")?.inputTokens, 38_000);
  assert.equal(state.toolCalls.get("tool:call-1")?.status, "complete");
  assert.equal(state.agents.get("agent:child")?.status, "complete");
  assert.ok(state.edges.some((edge) => edge.from === "model-1" && edge.to === "tool:call-1"));
  assert.ok(state.edges.some((edge) => edge.from === "tool:call-1" && edge.to === "agent:child"));
  assert.equal(state.activeFiles.get("src/engine/engine.ts")?.count, 1);
  assert.equal(state.tokenMetrics.get("main")?.contextTokens, 38_000);
  assert.equal(state.timeline.length, sampleEvents().length);
});

test("file attention extracts deterministic paths without retaining file contents", () => {
  assert.deepEqual(toolFiles("read", { path: "src/ui/tui.ts", offset: 1 }), ["src/ui/tui.ts"]);
  assert.deepEqual(toolFiles("grep", { path: "src", pattern: "secret contents" }), ["src"]);
  assert.deepEqual(toolFiles("bash", { cwd: "src", command: "cat hidden.ts" }), []);
  assert.deepEqual(toolFiles("apply_patch", {
    patch: "*** Begin Patch\n*** Update File: src/app.ts\n*** Move to: src/application.ts\n-secret\n+replacement\n*** Add File: test/new.ts\n+value\n*** End Patch",
  }), ["src/app.ts", "src/application.ts", "test/new.ts"]);
});

test("code-change telemetry keeps bounded apply_patch additions and removals in source order", () => {
  const changes = toolCodeChanges("apply_patch", {
    patch: [
      "*** Begin Patch",
      "*** Update File: src/old.ts",
      "*** Move to: src/new.ts",
      "@@",
      "-const oldValue = true;",
      "+const newValue = true;\u001b[2J",
      "*** Add File: test/new.test.ts",
      "+test('new', () => {});",
      "*** Delete File: src/dead.ts",
      "*** End Patch",
    ].join("\n"),
  });
  assert.deepEqual(changes, [
    {
      path: "src/old.ts",
      operation: "update",
      moveTo: "src/new.ts",
      lines: [
        { kind: "remove", text: "const oldValue = true;" },
        { kind: "add", text: "const newValue = true;[2J" },
      ],
    },
    {
      path: "test/new.test.ts",
      operation: "add",
      lines: [{ kind: "add", text: "test('new', () => {});" }],
    },
    { path: "src/dead.ts", operation: "delete", lines: [] },
  ]);
  assert.deepEqual(toolCodeChanges("bash", { command: "git diff" }), []);

  const bounded = toolCodeChanges("apply_patch", {
    patch: `*** Begin Patch\n*** Add File: huge.ts\n${Array.from({ length: 241 }, (_, index) => `+${index}`).join("\n")}\n*** End Patch`,
  });
  assert.equal(bounded[0]?.lines.length, 240);
  assert.equal(bounded[0]?.truncated, true);

  const retained = storeWith(Array.from({ length: 9 }, (_, index) => ({
    type: "tool.end" as const,
    timestamp: 2_000 + index,
    sessionId: "main",
    entityId: `tool:large-patch-${index}`,
    tool: "apply_patch",
    status: "complete" as const,
    codeChanges: [{
      path: `src/large-${index}.ts`,
      operation: "update" as const,
      lines: Array.from({ length: 240 }, () => ({ kind: "add" as const, text: "line" })),
    }],
  }))).state.timeline;
  assert.equal(retained.length, 9);
  assert.equal(retained.filter((event) => event.codeChanges !== undefined).length, 8);
  assert.equal(retained[0]?.codeChanges, undefined);
  assert.ok(retained.at(-1)?.codeChanges);
});

test("visualizer pane renders every view at an exact portable terminal size", () => {
  const pane = new VisualizerPane(populatedStore());
  pane.setSession("main");
  for (const definition of VISUALIZER_VIEWS) {
    pane.setView(definition.view);
    pane.setFrame(definition.number);
    const lines = pane.render(80, 18);
    assert.equal(lines.length, 18, definition.label);
    assert.ok(lines.every((line) => visibleWidth(line) === 80), definition.label);
    const plain = lines.map(stripVTControlCharacters).join("\n");
    assert.match(plain, /visualizer/iu, definition.label);
    assert.match(plain, new RegExp(definition.label, "iu"), definition.label);
    assert.doesNotMatch(plain, /[╭╮╰╯├]/u, definition.label);
    assert.match(lines[0] ?? "", /\x1b\[38;5;252;48;5;235m/u, definition.label);
    assert.match(lines[1] ?? "", /\x1b\[38;5;252;48;5;236m/u, definition.label);
    assert.match(lines[2] ?? "", /\x1b\[38;5;252;48;5;234m/u, definition.label);
    assert.match(lines.at(-1) ?? "", /\x1b\[38;5;252;48;5;235m/u, definition.label);
    assert.match(
      stripVTControlCharacters(lines.at(-1) ?? ""),
      new RegExp(`${definition.label}(?: \\d+-\\d+/\\d+ · wheel)?$`, "u"),
      definition.label,
    );
  }
});

test("visualizer metadata cannot inject terminal controls or extra rows", () => {
  const pane = new VisualizerPane(storeWith([
    {
      type: "model.request",
      timestamp: 1_000,
      sessionId: "main\u001b[2J\nforged-session",
      entityId: "model-unsafe",
      model: "unsafe\u001b[2J\nforged-model",
      provider: "provider\u001b[8m",
      status: "active",
    },
    {
      type: "model.reasoning.summary",
      timestamp: 1_001,
      sessionId: "main",
      entityId: "reasoning:model-unsafe",
      status: "complete",
      summary: "safe thought\u001b[2J\nforged thought",
    },
    {
      type: "tool.end",
      timestamp: 1_002,
      sessionId: "main",
      entityId: "tool:unsafe",
      tool: "apply_patch",
      status: "complete",
      codeChanges: [{
        path: "unsafe\u001b[8m.ts",
        operation: "update",
        lines: [{ kind: "add", text: "safe code\u001b[2J\nforged code" }],
      }],
    },
  ]));
  pane.setSession("main\u001b[2J\nforged-session");
  for (const view of ["graph", "timeline", "trace", "calls", "code", "thinking"] as const) {
    pane.setView(view);
    const rendered = pane.render(70, 14);
    assert.equal(rendered.length, 14);
    assert.equal(rendered.some((line) => line.includes("\u001b[2J") || line.includes("\u001b[8m")), false);
    assert.equal(rendered.map(stripVTControlCharacters).some((line) => line.includes("\n")), false);
  }
});

test("visualizer views are full-width and Graph shows only the current causal flow", () => {
  const events: VisualizerEventInput[] = [
    ...sampleEvents(),
    { type: "turn.start", timestamp: 2_000, sessionId: "main", turnId: "turn-live", entityId: "turn-live", status: "active" },
    {
      type: "model.request", timestamp: 2_010, sessionId: "main", turnId: "turn-live", entityId: "model-live",
      parentId: "turn-live", model: "sol", provider: "codex-lb", status: "active",
    },
    {
      type: "tool.start", timestamp: 2_020, sessionId: "main", turnId: "turn-live", entityId: "tool:agents-live",
      parentId: "model-live", tool: "run_agents", status: "active",
    },
    {
      type: "agent.start", timestamp: 2_030, sessionId: "child-live", entityId: "agent:live", agentId: "review",
      parentId: "tool:agents-live", model: "luna", provider: "codex-lb", status: "active",
    },
  ];
  const pane = new VisualizerPane(storeWith(events));
  pane.setSession("main");
  pane.setView("graph");
  const graph = pane.render(80, 22).map(stripVTControlCharacters).join("\n");
  assert.match(graph, /LIVE FLOW/);
  assert.match(graph, /MAIN/);
  assert.match(graph, /TOOL run_agents/);
  assert.match(graph, /AGENT review/);
  assert.doesNotMatch(graph, /OPERATION TIMELINE|EVENT TRACE/);

  pane.setView("trace");
  const trace = pane.render(80, 22).map(stripVTControlCharacters).join("\n");
  assert.match(trace, /EVENT TRACE/);
  assert.match(trace, /tool\.end/);
  assert.doesNotMatch(trace, /LIVE FLOW|current causal path/);

  for (const view of ["timeline", "trace", "context", "files", "calls"] as const) {
    pane.setView(view);
    const frame = pane.render(80, 22).map(stripVTControlCharacters);
    const body = frame.slice(2, -1);
    assert.equal(body.some((line) => line.startsWith("│") || line.endsWith("│")), false, view);
  }
});

test("long-session Timeline remains a readable operation ledger instead of a compressed bar", () => {
  const hour = 60 * 60_000;
  const events: VisualizerEventInput[] = [
    { type: "turn.start", timestamp: 1_000, sessionId: "main", turnId: "early", entityId: "early", status: "active" },
    { type: "turn.end", timestamp: 2_000, sessionId: "main", turnId: "early", entityId: "early", status: "complete" },
    {
      type: "model.request", timestamp: 2 * hour + 1_000, sessionId: "main", turnId: "late", entityId: "late-model",
      model: "sol", provider: "codex-lb", status: "active",
    },
    {
      type: "model.response", timestamp: 2 * hour + 4_000, sessionId: "main", turnId: "late", entityId: "late-model",
      model: "sol", provider: "codex-lb", status: "complete", duration: 3_000,
    },
  ];
  const pane = new VisualizerPane(storeWith(events));
  pane.setView("timeline");
  const rendered = pane.render(80, 16).map(stripVTControlCharacters).join("\n");
  assert.match(rendered, /OPERATION TIMELINE/);
  assert.match(rendered, /START\s+DURATION\s+KIND\s+OPERATION/);
  assert.match(rendered, /\+2h00m/);
  assert.match(rendered, /MODEL codex-lb:sol/);
  assert.doesNotMatch(rendered, /[▁▂▃▄▅▆▇█]{8,}/u);
});

test("Code and Thinking render ordered available data and scroll independently", () => {
  const events: VisualizerEventInput[] = Array.from({ length: 12 }, (_, index) => [
    {
      type: "model.reasoning.summary" as const,
      timestamp: 1_000 + index * 10,
      sessionId: index % 2 === 0 ? "main" : "child",
      entityId: `reasoning:model-${index}`,
      model: "sol",
      provider: "codex-lb",
      reasoningEffort: "high",
      status: "complete" as const,
      summary: `Plan summary ${index}`,
    },
    {
      type: "tool.end" as const,
      timestamp: 1_001 + index * 10,
      sessionId: "main",
      entityId: `tool:patch-${index}`,
      tool: "apply_patch",
      status: "complete" as const,
      codeChanges: [{
        path: `src/file-${String(index).padStart(2, "0")}.ts`,
        operation: "update" as const,
        lines: [
          { kind: "remove" as const, text: `old value ${index}` },
          { kind: "add" as const, text: `new value ${index}` },
        ],
      }],
    },
  ]).flat();
  const pane = new VisualizerPane(storeWith(events));

  pane.setView("code");
  const newestCodeFrame = pane.render(60, 10);
  const newestCode = newestCodeFrame.map(stripVTControlCharacters).join("\n");
  assert.match(newestCode, /CODE CHANGES/);
  assert.match(newestCode, /diff --git a\/src\/file-11\.ts b\/src\/file-11\.ts/);
  assert.match(newestCode, /--- a\/src\/file-11\.ts/);
  assert.match(newestCode, /\+\+\+ b\/src\/file-11\.ts/);
  assert.match(newestCode, /-old value 11/);
  assert.match(newestCode, /\+new value 11/);
  const removedLine = newestCodeFrame.find((line) => stripVTControlCharacters(line).startsWith("-old value 11"));
  const addedLine = newestCodeFrame.find((line) => stripVTControlCharacters(line).startsWith("+new value 11"));
  assert.match(removedLine ?? "", /\x1b\[38;5;224;48;5;52m/);
  assert.match(addedLine ?? "", /\x1b\[38;5;194;48;5;22m/);
  assert.doesNotMatch(newestCode, /file-00\.ts/);
  pane.scrollLines(100);
  const oldestCode = pane.render(60, 10).map(stripVTControlCharacters).join("\n");
  assert.match(oldestCode, /file-00\.ts/);
  assert.doesNotMatch(oldestCode, /file-11\.ts/);

  pane.setView("thinking");
  const newestThinking = pane.render(60, 10).map(stripVTControlCharacters).join("\n");
  assert.match(newestThinking, /THINKING SUMMARIES/);
  assert.match(newestThinking, /private chain-of-thought hidden/);
  assert.match(newestThinking, /Plan summary 11/);
  assert.match(newestThinking, /session child/);
  assert.doesNotMatch(newestThinking, /Plan summary 0(?:\D|$)/);
  pane.scrollLines(100);
  const oldestThinking = pane.render(60, 10).map(stripVTControlCharacters).join("\n");
  assert.match(oldestThinking, /Plan summary 0(?:\D|$)/);
  assert.doesNotMatch(oldestThinking, /Plan summary 11/);

  pane.setView("code");
  assert.ok(pane.scrollOffset > 0);
});

test("Code uses unified diff filenames for added, deleted, and moved files", () => {
  const pane = new VisualizerPane(storeWith([{
    type: "tool.end",
    timestamp: 1_000,
    sessionId: "main",
    entityId: "tool:patch-files",
    tool: "apply_patch",
    status: "complete",
    codeChanges: [
      {
        path: "src/created.ts",
        operation: "add",
        lines: [{ kind: "add", text: "export const created = true;" }],
      },
      {
        path: "src/deleted.ts",
        operation: "delete",
        lines: [{ kind: "remove", text: "export const deleted = true;" }],
      },
      {
        path: "src/before.ts",
        moveTo: "src/after.ts",
        operation: "update",
        lines: [
          { kind: "remove", text: "export const name = 'before';" },
          { kind: "add", text: "export const name = 'after';" },
        ],
      },
    ],
  }]));
  pane.setView("code");

  const rendered = pane.render(80, 20).map(stripVTControlCharacters).join("\n");
  assert.match(rendered, /diff --git a\/src\/created\.ts b\/src\/created\.ts/);
  assert.match(rendered, /--- \/dev\/null\s*\n\+\+\+ b\/src\/created\.ts/);
  assert.match(rendered, /diff --git a\/src\/deleted\.ts b\/src\/deleted\.ts/);
  assert.match(rendered, /--- a\/src\/deleted\.ts\s*\n\+\+\+ \/dev\/null/);
  assert.match(rendered, /diff --git a\/src\/before\.ts b\/src\/after\.ts/);
  assert.match(rendered, /--- a\/src\/before\.ts\s*\n\+\+\+ b\/src\/after\.ts/);
});

test("Files lists individual paths and per-view scrolling reaches old and new rows", () => {
  const events: VisualizerEventInput[] = Array.from({ length: 16 }, (_, index) => ({
    type: "tool.request" as const,
    timestamp: 1_000 + index,
    sessionId: "main",
    entityId: `tool:file-${index}`,
    tool: "read",
    status: "waiting" as const,
    files: [`src/features/file-${String(index).padStart(2, "0")}.ts`],
  }));
  const pane = new VisualizerPane(storeWith(events));
  pane.setSession("main");
  pane.setView("files");

  const newest = pane.render(60, 10).map(stripVTControlCharacters).join("\n");
  assert.match(newest, /file-15\.ts/);
  assert.doesNotMatch(newest, /file-00\.ts/);
  pane.scrollLines(100);
  const oldest = pane.render(60, 10).map(stripVTControlCharacters).join("\n");
  assert.ok(pane.scrollOffset > 0);
  assert.match(oldest, /FILE ACTIVITY/);
  assert.match(oldest, /file-00\.ts/);
  assert.doesNotMatch(oldest, /file-15\.ts/);

  pane.setView("trace");
  pane.render(60, 10);
  assert.equal(pane.scrollOffset, 0);
  pane.setView("files");
  assert.ok(pane.scrollOffset > 0);
  pane.scrollLines(-100);
  assert.equal(pane.scrollOffset, 0);
  assert.match(pane.render(60, 10).map(stripVTControlCharacters).join("\n"), /file-15\.ts/);
});

test("visualizer tab hitboxes match rendered labels at wide and compact pane widths", () => {
  const pane = new VisualizerPane(populatedStore());
  const labelsByWidth = new Map([
    [80, VISUALIZER_VIEWS.map((definition) => definition.label)],
    [50, ["Graph", "Time", "Trace", "Ctx", "Files", "Calls", "Code", "Think"]],
    [42, ["G", "Time", "Tr", "Ctx", "File", "Call", "Code", "Think"]],
    [38, ["G", "Time", "Tr", "Ctx", "File", "Call", "Code", "Think"]],
  ]);
  for (const [width, labels] of labelsByWidth) {
    const line = stripVTControlCharacters(pane.render(width, 18)[1] ?? "");
    const hitboxes = visualizerTabHitboxes(width);
    assert.deepEqual(hitboxes.map((hitbox) => hitbox.view), VISUALIZER_VIEWS.map((definition) => definition.view));
    for (const [index, hitbox] of hitboxes.entries()) {
      const label = labels[index];
      assert.equal(line.slice(hitbox.startColumn, hitbox.endColumn), label);
      assert.equal(visualizerTabAt(width, hitbox.startColumn, 1), hitbox.view);
    }
    assert.equal(visualizerTabAt(width, hitboxes[0]!.endColumn, 1), undefined);
    assert.equal(visualizerTabAt(width, hitboxes[0]!.startColumn, 2), undefined);
  }
});

test("TUI mouse routing switches only visible visualizer tabs on left press", () => {
  const pane = new VisualizerPane(populatedStore());
  const width = 120;
  const split = visualizerSplitLayout(width, true);
  const timeline = visualizerTabHitboxes(split.rightWidth).find((hitbox) => hitbox.view === "timeline");
  const thinking = visualizerTabHitboxes(split.rightWidth).find((hitbox) => hitbox.view === "thinking");
  assert.ok(timeline);
  assert.ok(thinking);
  const event = (overrides: Partial<TerminalMouseEvent> = {}): TerminalMouseEvent => ({
    action: "press",
    button: 0,
    column: split.leftWidth + split.separatorWidth + timeline.startColumn,
    row: 1,
    shift: false,
    alt: false,
    ctrl: false,
    ...overrides,
  });

  assert.equal(handleVisualizerTabMouse(event(), width, true, pane), true);
  assert.equal(pane.view, "timeline");
  assert.equal(handleVisualizerTabMouse(event({
    column: split.leftWidth + split.separatorWidth + thinking.startColumn,
  }), width, true, pane), true);
  assert.equal(pane.view, "thinking");
  assert.equal(handleVisualizerTabMouse(event({ action: "release" }), width, true, pane), false);
  assert.equal(handleVisualizerTabMouse(event({ button: 1 }), width, true, pane), false);
  assert.equal(handleVisualizerTabMouse(event({ row: 3 }), width, true, pane), false);
  assert.equal(handleVisualizerTabMouse(event(), width, false, pane), false);
  assert.equal(handleVisualizerTabMouse(event(), 99, true, pane), false);
  assert.equal(pane.view, "thinking");
});

test("TUI wheel routing scrolls the visualizer only when the pointer is over its pane", () => {
  const events: VisualizerEventInput[] = Array.from({ length: 20 }, (_, index) => ({
    type: "tool.request" as const,
    timestamp: 1_000 + index,
    sessionId: "main",
    entityId: `tool:scroll-${index}`,
    tool: "read",
    status: "waiting" as const,
    files: [`src/file-${index}.ts`],
  }));
  const pane = new VisualizerPane(storeWith(events));
  pane.setView("files");
  const width = 120;
  const split = visualizerSplitLayout(width, true);
  pane.render(split.rightWidth, 10);
  const wheel = (column: number, action: "wheel_up" | "wheel_down" = "wheel_up"): TerminalMouseEvent => ({
    action,
    button: 0,
    column,
    row: 5,
    shift: false,
    alt: false,
    ctrl: false,
  });

  assert.equal(handleVisualizerWheelMouse(wheel(split.leftWidth - 1), width, true, pane), false);
  assert.equal(pane.scrollOffset, 0);
  assert.equal(handleVisualizerWheelMouse(wheel(split.leftWidth + split.separatorWidth), width, true, pane), true);
  assert.equal(pane.scrollOffset, 3);
  assert.equal(handleVisualizerWheelMouse(wheel(split.leftWidth + split.separatorWidth, "wheel_down"), width, true, pane), true);
  assert.equal(pane.scrollOffset, 0);
  assert.equal(handleVisualizerWheelMouse(wheel(split.leftWidth + split.separatorWidth), width, false, pane), false);
});

test("responsive visualizer split preserves the CLI and collapses below its width threshold", () => {
  assert.deepEqual(visualizerSplitLayout(99, true), {
    visible: false, leftWidth: 99, rightWidth: 0, separatorWidth: 0,
  });
  const wide = visualizerSplitLayout(140, true);
  assert.equal(wide.visible, true);
  assert.ok(wide.leftWidth >= 50);
  assert.ok(wide.rightWidth >= 38);
  assert.equal(wide.leftWidth + wide.rightWidth + wide.separatorWidth, 140);

  const terminal = { rows: 18, columns: 120 };
  const editor = { invalidate() {}, render() { return ["editor input"]; } } as never;
  const pane = new VisualizerPane(populatedStore());
  pane.setSession("main");
  let enabled = true;
  const root = new FullHeightRoot(
    terminal as never,
    editor,
    new TaskPlanPanel(),
    () => "activity",
    () => "metadata",
    { visualizer: pane, visualizerEnabled: () => enabled },
  );
  root.addEntry({ invalidate() {}, render: () => ["normal transcript"] });
  const splitFrame = root.render(120);
  assert.equal(splitFrame.length, 18);
  assert.ok(splitFrame.every((line) => visibleWidth(line) === 120));
  assert.equal(
    stripVTControlCharacters(splitFrame[0] ?? "").charAt(visualizerSplitLayout(120, true).leftWidth),
    " ",
  );
  const splitText = splitFrame.map(stripVTControlCharacters).join("\n");
  assert.match(splitText, /normal transcript/iu);
  assert.match(splitText, /visualizer/iu);

  terminal.columns = 90;
  const collapsed = root.render(90).map(stripVTControlCharacters);
  assert.ok(collapsed.some((line) => line.includes("normal transcript")));
  assert.equal(collapsed.some((line) => line.includes("visualizer")), false);
  enabled = false;
  terminal.columns = 120;
  assert.equal(root.render(120).map(stripVTControlCharacters).some((line) => line.includes("visualizer")), false);
});

test("visualizer command toggles and selects all numbered or named views", () => {
  assert.deepEqual(resolveVisualizerCommand("", { enabled: true, view: "graph" }), {
    enabled: false, view: "graph",
  });
  assert.deepEqual(resolveVisualizerCommand("2", { enabled: false, view: "graph" }), {
    enabled: true, view: "timeline",
  });
  assert.deepEqual(resolveVisualizerCommand("calls", { enabled: false, view: "graph" }), {
    enabled: true, view: "calls",
  });
  assert.deepEqual(resolveVisualizerCommand("7", { enabled: false, view: "graph" }), {
    enabled: true, view: "code",
  });
  assert.deepEqual(resolveVisualizerCommand("thinking", { enabled: false, view: "graph" }), {
    enabled: true, view: "thinking",
  });
  assert.deepEqual(resolveVisualizerCommand("8", { enabled: false, view: "graph" }), {
    enabled: true, view: "thinking",
  });
  assert.throws(
    () => resolveVisualizerCommand("unknown", { enabled: true, view: "graph" }),
    /accepts on, off/,
  );
});
/**
 * Live visualizer pane: a portable @earendil-works/pi-tui Component that
 * renders typed telemetry from VisualizerStore across eight views.
 *
 * Purely observational: no timers, no model calls, no side effects. All time
 * references derive from event timestamps except live call latency; the only
 * mutable levers are setSession/setView/nextView and the subtle frame pulse.
 */
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import type {
  VisualizerCodeChange,
  VisualizerEvent,
  VisualizerEventType,
  VisualizerStatus,
} from "../visualizer/events.js";
import {
  VisualizerStore,
  type VisualizerNode,
  type VisualizerState,
  type VisualizerTokenMetrics,
} from "../visualizer/state.js";

export type VisualizerView = "graph" | "timeline" | "trace" | "context" | "files" | "calls" | "code" | "thinking";

export interface VisualizerViewDef {
  readonly number: number;
  readonly view: VisualizerView;
  readonly label: string;
}

/** The eight views in numbered order. */
export const VISUALIZER_VIEWS: readonly VisualizerViewDef[] = [
  { number: 1, view: "graph", label: "Graph" },
  { number: 2, view: "timeline", label: "Timeline" },
  { number: 3, view: "trace", label: "Trace" },
  { number: 4, view: "context", label: "Context" },
  { number: 5, view: "files", label: "Files" },
  { number: 6, view: "calls", label: "Calls" },
  { number: 7, view: "code", label: "Code" },
  { number: 8, view: "thinking", label: "Thinking" },
];

export interface VisualizerTabHitbox {
  readonly view: VisualizerView;
  readonly startColumn: number;
  readonly endColumn: number;
}

interface VisualizerTabsLayout {
  readonly gap: string;
  readonly padding: string;
  readonly labels: readonly string[];
  readonly hitboxes: readonly VisualizerTabHitbox[];
}

const VISUALIZER_TABS_ROW = 1;

function visualizerTabsLayout(width: number): VisualizerTabsLayout {
  const outerWidth = Math.max(0, Math.floor(width));
  if (outerWidth < 8) return { gap: "", padding: "", labels: [], hitboxes: [] };
  const fullLabels = VISUALIZER_VIEWS.map((definition) => definition.label);
  const compactLabels = ["Graph", "Time", "Trace", "Ctx", "Files", "Calls", "Code", "Think"];
  const tightLabels = ["G", "Time", "Tr", "Ctx", "File", "Call", "Code", "Think"];
  const minimumWidth = (labels: readonly string[]) => (
    labels.reduce((total, label) => total + visibleWidth(label), 0) + Math.max(0, labels.length - 1)
  );
  const labels = minimumWidth(fullLabels) <= outerWidth
    ? fullLabels
    : minimumWidth(compactLabels) <= outerWidth
      ? compactLabels
      : tightLabels;
  const labelsWidth = labels.reduce((total, label) => total + visibleWidth(label), 0);
  const expandedWidth = labelsWidth + Math.max(0, VISUALIZER_VIEWS.length - 1) * 2 + 2;
  const gap = outerWidth >= expandedWidth ? "  " : " ";
  const tabsWidth = labelsWidth + Math.max(0, VISUALIZER_VIEWS.length - 1) * gap.length;
  const padding = outerWidth >= tabsWidth + 2 ? " " : "";
  let column = padding.length;
  const hitboxes: VisualizerTabHitbox[] = [];
  for (const [index, definition] of VISUALIZER_VIEWS.entries()) {
    const label = labels[index] ?? definition.label;
    const endColumn = Math.min(outerWidth, column + visibleWidth(label));
    if (column < endColumn) {
      hitboxes.push({ view: definition.view, startColumn: column, endColumn });
    }
    column += visibleWidth(label) + gap.length;
  }
  return { gap, padding, labels, hitboxes };
}

/** Visible tab ranges in pane-local, zero-based terminal columns. End columns are exclusive. */
export function visualizerTabHitboxes(width: number): readonly VisualizerTabHitbox[] {
  return visualizerTabsLayout(width).hitboxes;
}

/** Resolve a pane-local terminal position to a visible visualizer tab. */
export function visualizerTabAt(width: number, column: number, row: number): VisualizerView | undefined {
  if (Math.floor(row) !== VISUALIZER_TABS_ROW) return undefined;
  const target = Math.floor(column);
  return visualizerTabHitboxes(width).find((hitbox) => (
    target >= hitbox.startColumn && target < hitbox.endColumn
  ))?.view;
}

/** Plain view ids in the same fixed order (Graph … Thinking). */
export const VISUALIZER_VIEW_IDS: readonly VisualizerView[] = [
  "graph",
  "timeline",
  "trace",
  "context",
  "files",
  "calls",
  "code",
  "thinking",
];

/** Terminal glyphs for each telemetry status: ○ waiting, ◉ active, ● complete, × failed/cancelled. */
export const VISUALIZER_STATUS_GLYPHS: Record<VisualizerStatus, string> = {
  waiting: "○",
  active: "◉",
  complete: "●",
  failed: "×",
  cancelled: "×",
};

/**
 * Internal split layout of the pane body: the causal tree on the left and the
 * active view on the right. `visible` is false when the region is too narrow
 * (or splitting is disabled), in which case callers should render the active
 * view full-width.
 */
export interface VisualizerSplitLayout {
  visible: boolean;
  leftWidth: number;
  rightWidth: number;
  separatorWidth: number;
}

const SPLIT_COLLAPSE_WIDTH = 100;
const SPLIT_DEFAULT_LEFT_RATIO = 0.58;
const SPLIT_MIN_LEFT = 50;
const SPLIT_MIN_RIGHT = 38;

/**
 * Responsive split layout for the visualizer body.
 * - Collapses (visible=false) below ~100 columns or when `enabled` is false.
 * - Defaults to roughly 58/42 split.
 * - Preserves a minimum left pane of ~50 and right pane of ~38 columns.
 */
export function visualizerSplitLayout(totalWidth: number, enabled: boolean): VisualizerSplitLayout {
  const width = Math.max(0, Math.floor(totalWidth));
  if (!enabled || width < SPLIT_COLLAPSE_WIDTH) {
    return { visible: false, leftWidth: width, rightWidth: 0, separatorWidth: 0 };
  }
  const separatorWidth = 1;
  const available = width - separatorWidth;
  let leftWidth = Math.round(available * SPLIT_DEFAULT_LEFT_RATIO);
  let rightWidth = available - leftWidth;
  if (leftWidth < SPLIT_MIN_LEFT) {
    rightWidth -= SPLIT_MIN_LEFT - leftWidth;
    leftWidth = SPLIT_MIN_LEFT;
  }
  if (rightWidth < SPLIT_MIN_RIGHT) {
    leftWidth -= SPLIT_MIN_RIGHT - rightWidth;
    rightWidth = SPLIT_MIN_RIGHT;
  }
  return {
    visible: true,
    leftWidth: Math.max(0, leftWidth),
    rightWidth: Math.max(0, rightWidth),
    separatorWidth,
  };
}

const FRAME_LINES = 3;
const HEADER_BACKGROUND = 235;
const TABS_BACKGROUND = 236;
const BODY_BACKGROUND = 234;
const ADDED_LINE_BACKGROUND = 22;
const REMOVED_LINE_BACKGROUND = 52;
const ADDED_LINE_FOREGROUND = 194;
const REMOVED_LINE_FOREGROUND = 224;
const MAX_TREE_DEPTH = 32;

function paint(open: number, close: number): (text: string) => string {
  return (text) => `\x1b[${open}m${text}\x1b[${close}m`;
}

const bold = paint(1, 22);
const dim = paint(2, 22);
const red = paint(31, 39);
const green = paint(32, 39);
const yellow = paint(33, 39);
const magenta = paint(35, 39);
const cyan = paint(36, 39);

function isClosedStatus(status: VisualizerStatus): boolean {
  return status === "complete" || status === "failed" || status === "cancelled";
}

function activePulseGlyph(frame: number): string {
  return yellow("◉◍◉◔".charAt(Math.max(0, Math.floor(frame)) % 4));
}

function statusMark(status: VisualizerStatus, frame: number): string {
  const glyph = VISUALIZER_STATUS_GLYPHS[status];
  switch (status) {
    case "active":
      return activePulseGlyph(frame);
    case "complete":
      return green(glyph);
    case "failed":
      return red(glyph);
    case "cancelled":
      return dim(glyph);
    case "waiting":
      return dim(glyph);
    default:
      return dim(glyph);
  }
}

function sanitize(text: string): string {
  return text.replace(/\t/g, " ").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function oneLine(text: string, limit: number): string {
  return sanitize(text).replace(/\s+/g, " ").trim().slice(0, Math.max(0, limit));
}

function fit(text: string, width: number): string {
  return truncateToWidth(text, Math.max(1, Math.floor(width)), "");
}

function padLine(text: string, width: number): string {
  const target = Math.max(0, Math.floor(width));
  const fitted = fit(text, target);
  return `${fitted}${" ".repeat(Math.max(0, target - visibleWidth(fitted)))}`;
}

function tonalLine(text: string, width: number, background: number): string {
  const base = `\x1b[38;5;252;48;5;${background}m`;
  const content = padLine(text, width).replace(/\x1b\[(?:0|39|49)m/g, (reset) => `${reset}${base}`);
  return `${base}${content}\x1b[39;49m`;
}

function diffCodeLine(text: string, width: number, kind: "add" | "remove"): string {
  const foreground = kind === "add" ? ADDED_LINE_FOREGROUND : REMOVED_LINE_FOREGROUND;
  const background = kind === "add" ? ADDED_LINE_BACKGROUND : REMOVED_LINE_BACKGROUND;
  const base = `\x1b[38;5;${foreground};48;5;${background}m`;
  const content = padLine(text, width).replace(/\x1b\[(?:0|39|49)m/g, (reset) => `${reset}${base}`);
  return `${base}${content}\x1b[39;49m`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function formatTokens(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "";
  const count = Math.round(value);
  if (count < 1_000) return String(count);
  return `${(count / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
}

function formatDuration(value: number): string {
  const duration = Math.max(0, Number.isFinite(value) ? value : 0);
  if (duration < 1_000) return `${Math.round(duration)}ms`;
  if (duration < 60_000) return `${(duration / 1_000).toFixed(1)}s`;
  const total = Math.round(duration / 1_000);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}m`;
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

function relativeTime(timestamp: number, origin: number): string {
  const delta = Math.max(0, timestamp - origin);
  return `+${formatDuration(delta)}`;
}

function formatAgo(timestamp: number, now: number): string {
  const delta = Math.max(0, now - timestamp);
  if (delta < 1_000) return "just now";
  return `${formatDuration(delta)} ago`;
}

function effectiveNow(state: VisualizerState): number {
  let last = 0;
  for (const node of state.nodes.values()) {
    if (node.startedAt > last) last = node.startedAt;
    if (node.endedAt !== undefined && node.endedAt > last) last = node.endedAt;
  }
  const tail = state.timeline[state.timeline.length - 1];
  if (tail !== undefined && tail.timestamp > last) last = tail.timestamp;
  return last;
}

function countEvents(state: VisualizerState, type: VisualizerEventType): number {
  let count = 0;
  for (const event of state.timeline) if (event.type === type) count += 1;
  return count;
}

function latestMetrics(state: VisualizerState): VisualizerTokenMetrics | undefined {
  let best: VisualizerTokenMetrics | undefined;
  for (const metrics of state.tokenMetrics.values()) {
    if (best === undefined || metrics.updatedAt > best.updatedAt) best = metrics;
  }
  return best;
}

function shortPath(path: string): string {
  const segments = sanitize(path).split("/").filter((segment) => segment.length > 0);
  if (segments.length <= 3) return segments.join("/");
  return segments.slice(-3).join("/");
}

function toolSummary(tools: ReadonlyMap<string, number>, width: number): string {
  const entries = [...tools.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 3)
    .map(([tool, count]) => `${oneLine(tool, 40)}:${count}`);
  const summary = entries.join(" ");
  return summary ? dim(fit(summary, width)) : "";
}

interface TreeRow {
  id: string;
  depth: number;
  lasts: readonly boolean[];
}

interface Forest {
  readonly roots: readonly string[];
  readonly children: ReadonlyMap<string, readonly string[]>;
}

function buildForest(state: VisualizerState, allowed: ReadonlySet<string>): Forest {
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const edge of state.edges) {
    if (!allowed.has(edge.from) || !allowed.has(edge.to)) continue;
    if (edge.from === edge.to || edge.kind === "returns") continue;
    if (hasParent.has(edge.to)) continue;
    hasParent.add(edge.to);
    const list = children.get(edge.from);
    if (list === undefined) children.set(edge.from, [edge.to]);
    else list.push(edge.to);
  }
  const roots: string[] = [];
  for (const turn of [...state.turns.values()].sort((a, b) => a.startedAt - b.startedAt)) {
    if (allowed.has(turn.id) && !hasParent.has(turn.id) && state.nodes.has(turn.id)) roots.push(turn.id);
  }
  const rooted = new Set(roots);
  for (const node of [...state.nodes.values()].sort((a, b) => a.startedAt - b.startedAt)) {
    if (allowed.has(node.id) && !hasParent.has(node.id) && !rooted.has(node.id)) roots.push(node.id);
  }
  return { roots, children };
}

function buildTreeRows(state: VisualizerState, allowed: ReadonlySet<string>): TreeRow[] {
  const { roots, children } = buildForest(state, allowed);
  const nodes = state.nodes;
  const rows: TreeRow[] = [];
  const visited = new Set<string>();
  const stack: Array<{ id: string; depth: number; lasts: boolean[] }> = [];
  for (let i = roots.length - 1; i >= 0; i -= 1) {
    const root = roots[i];
    if (root !== undefined) stack.push({ id: root, depth: 0, lasts: [] });
  }
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined || visited.has(entry.id) || entry.depth > MAX_TREE_DEPTH) continue;
    visited.add(entry.id);
    const node = nodes.get(entry.id);
    if (node === undefined) continue;
    const kids = (children.get(entry.id) ?? [])
      .filter((kid) => kid !== entry.id && nodes.has(kid) && !visited.has(kid));
    rows.push({
      id: node.id,
      depth: entry.depth,
      lasts: entry.lasts,
    });
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      const kid = kids[i];
      if (kid === undefined) continue;
      stack.push({ id: kid, depth: entry.depth + 1, lasts: [...entry.lasts, i === kids.length - 1] });
    }
  }
  return rows;
}

function indentFor(depth: number, lasts: readonly boolean[], selfLast: boolean): string {
  if (depth <= 0) return "";
  const parts: string[] = [];
  for (let i = 0; i < depth - 1; i += 1) {
    parts.push(lasts[i] === true ? "   " : "│  ");
  }
  parts.push(selfLast ? "└─ " : "├─ ");
  return parts.join("");
}

function displayNodeLabel(node: VisualizerNode): string {
  if (node.kind === "turn") return node.agentId ? `AGENT TURN ${oneLine(node.agentId, 80)}` : "MAIN";
  if (node.kind === "agent") return `AGENT ${oneLine(node.agentId ?? node.label, 80)}`;
  if (node.kind === "model") return `MODEL ${oneLine([node.provider, node.model].filter(Boolean).join(":") || node.label, 120)}`;
  if (node.kind === "reasoning") return "THINKING";
  if (node.kind === "tool") return `TOOL ${oneLine(node.tool ?? node.label, 80)}`;
  if (node.kind === "context") return oneLine(node.label, 80).toUpperCase();
  return oneLine(node.label, 80).toUpperCase();
}

function graphNodeDetail(node: VisualizerNode, now: number): string {
  const details: string[] = [];
  if (node.status === "active") details.push(formatDuration(Math.max(0, now - node.startedAt)));
  else if (node.duration !== undefined) details.push(formatDuration(node.duration));
  if (node.kind === "reasoning" && node.reasoningEffort) details.push(oneLine(node.reasoningEffort, 40));
  if (node.kind === "tool" && node.files.length > 0) details.push(shortPath(node.files[0] ?? ""));
  if (node.status === "complete") details.push("returned");
  if (node.status === "failed") details.push("failed");
  if (node.status === "cancelled") details.push("cancelled");
  return details.join(" · ");
}

function liveGraphIds(state: VisualizerState): Set<string> {
  const ids = new Set<string>();
  for (const node of state.nodes.values()) {
    if (node.status === "active" || node.status === "waiting") ids.add(node.id);
  }
  if (ids.size === 0) return ids;
  const parentByChild = new Map<string, string>();
  for (const edge of state.edges) {
    if (edge.kind !== "returns" && edge.from !== edge.to && !parentByChild.has(edge.to)) {
      parentByChild.set(edge.to, edge.from);
    }
  }
  for (const id of [...ids]) {
    let parent = parentByChild.get(id);
    let depth = 0;
    while (parent !== undefined && depth < MAX_TREE_DEPTH) {
      if (ids.has(parent)) break;
      ids.add(parent);
      parent = parentByChild.get(parent);
      depth += 1;
    }
  }
  const now = Date.now();
  for (const edge of state.edges) {
    if (!ids.has(edge.from) || ids.has(edge.to)) continue;
    const child = state.nodes.get(edge.to);
    if (child?.endedAt !== undefined && now - child.endedAt <= 8_000) ids.add(child.id);
  }
  return ids;
}

function renderLiveGraph(state: VisualizerState, width: number, frame: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const ids = liveGraphIds(state);
  if (ids.size === 0) {
    const latest = state.timeline[state.timeline.length - 1];
    return [
      fit(`${dim("○")} ${bold("IDLE")}`, w),
      fit(dim("No model, agent, or tool operation is running."), w),
      ...(latest ? [fit(dim(`last · ${latest.type} · ${formatAgo(latest.timestamp, effectiveNow(state))}`), w)] : []),
    ];
  }
  let active = 0;
  let agents = 0;
  let tools = 0;
  for (const id of ids) {
    const node = state.nodes.get(id);
    if (node?.status === "active") active += 1;
    if (node?.kind === "agent" && !isClosedStatus(node.status)) agents += 1;
    if (node?.kind === "tool" && !isClosedStatus(node.status)) tools += 1;
  }
  const now = Date.now();
  const lines = [
    fit(`${activePulseGlyph(frame)} ${bold("LIVE FLOW")} ${dim(`· ${active} active · ${agents} agents · ${tools} tools`)}`, w),
    dim(fit("current causal path · completed history is kept in Timeline and Trace", w)),
    "",
  ];
  for (const row of buildTreeRows(state, ids)) {
    const node = state.nodes.get(row.id);
    if (node === undefined) continue;
    const indent = indentFor(row.depth, row.lasts, row.lasts[row.depth - 1] ?? true);
    const detail = graphNodeDetail(node, now);
    lines.push(fit(`${indent}${statusMark(node.status, frame)} ${displayNodeLabel(node)}${detail ? ` ${dim(detail)}` : ""}`, w));
  }
  return lines;
}

function renderTimeline(state: VisualizerState, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const nodes = [...state.nodes.values()]
    .filter((node) => node.kind !== "context" && node.kind !== "error")
    .sort((a, b) => a.startedAt - b.startedAt);
  if (nodes.length === 0) return [dim("no activity yet")];
  const origin = nodes[0]?.startedAt ?? 0;
  const now = Date.now();
  const lines = [
    fit(`${bold("OPERATION TIMELINE")} ${dim(`· ${nodes.length} retained operations`)}`, w),
    dim(fit("START      DURATION  KIND       OPERATION", w)),
  ];
  for (const node of nodes) {
    const start = padLine(relativeTime(node.startedAt, origin), 10);
    const elapsed = node.duration ?? (node.status === "active" ? Math.max(0, now - node.startedAt) : 0);
    const duration = padLine(elapsed > 0 ? formatDuration(elapsed) : "—", 9);
    const kind = padLine(node.kind.toUpperCase(), 10);
    lines.push(fit(`${start} ${duration} ${statusMark(node.status, 0)} ${kind} ${displayNodeLabel(node)}`, w));
  }
  return lines;
}

function eventIdentity(event: VisualizerEvent): string {
  if (event.tool) return oneLine(event.tool, 80);
  if (event.agentId) return oneLine(event.agentId, 80);
  if (event.model) return oneLine(event.model, 80);
  const id = event.entityId ?? event.turnId ?? event.eventId;
  const safe = oneLine(id, 120);
  return safe.length > 18 ? `…${safe.slice(-17)}` : safe;
}

function eventSummary(event: VisualizerEvent): string {
  if (!event.summary || event.type.startsWith("model.reasoning.")) return "";
  return oneLine(event.summary, 80);
}

function renderTrace(state: VisualizerState, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  if (state.timeline.length === 0) return [dim("no events yet")];
  const origin = state.timeline[0]?.timestamp ?? 0;
  const lines = [
    fit(`${bold("EVENT TRACE")} ${dim(`· ${state.timeline.length} retained lifecycle events`)}`, w),
    dim(fit("SEQ    TIME       EVENT                    ENTITY", w)),
  ];
  for (const event of state.timeline) {
    const sequence = `#${event.sequence}`.padEnd(6, " ");
    const time = padLine(relativeTime(event.timestamp, origin), 10);
    const type = padLine(event.type, 24);
    const mark = event.status ? statusMark(event.status, 0) : dim("·");
    const summary = eventSummary(event);
    lines.push(fit(`${sequence} ${time} ${mark} ${type} ${eventIdentity(event)}${summary ? ` ${dim(`· ${summary}`)}` : ""}`, w));
  }
  return lines;
}

function renderContext(state: VisualizerState, sessionId: string | null, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const metrics = sessionId !== null ? state.tokenMetrics.get(sessionId) : latestMetrics(state);
  const contextEvents = state.timeline.filter((event) => event.type === "context.update" || event.type === "context.compact");
  const origin = contextEvents[0]?.timestamp ?? 0;
  const lines: string[] = [
    fit(`${bold("CONTEXT HISTORY")} ${dim(`· ${contextEvents.length} retained updates`)}`, w),
  ];
  for (const event of contextEvents) {
    const action = event.type === "context.compact" ? magenta("COMPACT") : cyan("UPDATE ");
    const tokens = event.contextTokens !== undefined ? ` · ${formatTokens(event.contextTokens)} tokens` : "";
    lines.push(fit(`${padLine(relativeTime(event.timestamp, origin), 10)} ${action}${tokens}`, w));
  }
  if (contextEvents.length === 0) lines.push(dim("no context events yet"));
  lines.push("", bold("CURRENT CONTEXT"));
  if (metrics !== undefined) {
    const tokenParts = [
      `in ${formatTokens(metrics.inputTokens)}`,
      `out ${formatTokens(metrics.outputTokens)}`,
      `rz ${formatTokens(metrics.reasoningTokens)}`,
    ];
    lines.push(`tokens: ${dim(tokenParts.join(" · "))}`);
    if (metrics.contextWindow > 0) {
      const ratio = clamp01(metrics.contextTokens / metrics.contextWindow);
      const barLength = Math.max(4, Math.min(24, w - 30));
      const filled = Math.round(ratio * barLength);
      const bar = `${green("█").repeat(filled)}${dim("░").repeat(Math.max(0, barLength - filled))}`;
      lines.push(`ctx ${bar} ${Math.round(ratio * 100)}% (${formatTokens(metrics.contextTokens)}/${formatTokens(metrics.contextWindow)})`);
    }
    lines.push(dim(`updated ${formatAgo(metrics.updatedAt, Math.max(Date.now(), effectiveNow(state)))}`));
  } else {
    lines.push(dim("token metrics: none recorded yet"));
  }
  const updates = countEvents(state, "context.update");
  const compacts = countEvents(state, "context.compact");
  if (updates === 0 && compacts === 0) {
    lines.push(dim("context events: none"));
  } else {
    lines.push(`context events: ${cyan(`update ×${updates}`)}  ${magenta(`compact ×${compacts}`)}`);
  }
  return lines.map((line) => fit(line, w));
}

function renderFiles(state: VisualizerState, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const files = [...state.activeFiles.values()];
  if (files.length === 0) return [dim("no file activity yet")];
  files.sort((a, b) => a.lastTimestamp - b.lastTimestamp || a.path.localeCompare(b.path));
  const lines = [
    fit(`${bold("FILE ACTIVITY")} ${dim(`· ${files.length} observed paths · oldest → newest`)}`, w),
  ];
  for (const file of files) {
    const count = cyan(`×${file.count}`);
    const tools = toolSummary(file.tools, Math.max(0, Math.min(20, Math.floor(w * 0.35))));
    const suffixWidth = visibleWidth(count) + visibleWidth(tools) + (tools ? 4 : 2);
    const path = fit(shortPath(file.path), Math.max(8, w - suffixWidth));
    lines.push(fit(`${path}  ${count}${tools ? ` · ${tools}` : ""}`, w));
  }
  return lines;
}

function renderCalls(state: VisualizerState, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const calls = [...state.modelCalls.values()].sort((a, b) => a.startedAt - b.startedAt);
  if (calls.length === 0) return [dim("no model calls yet")];
  const now = Date.now();
  const lines = [fit(`${bold("MODEL CALLS")} ${dim(`· ${calls.length} retained calls`)}`, w)];
  lines.push(...calls.map((call) => {
    const mark = statusMark(call.status, 0);
    const elapsed = call.duration ?? (call.status === "active" ? Math.max(0, now - call.startedAt) : undefined);
    const duration = elapsed !== undefined ? fit(formatDuration(elapsed), 7) : " ".repeat(7);
    const provider = call.provider !== undefined ? dim(oneLine(call.provider, 80)) : "";
    const model = oneLine(call.model ?? "?", 120);
    const tokens: string[] = [];
    if (call.inputTokens !== undefined) tokens.push(`in:${formatTokens(call.inputTokens)}`);
    if (call.outputTokens !== undefined) tokens.push(`out:${formatTokens(call.outputTokens)}`);
    if (call.reasoningTokens !== undefined) tokens.push(`rz:${formatTokens(call.reasoningTokens)}`);
    const outcome = call.status === "failed" ? red(" error") : call.status === "cancelled" ? dim(" cancelled") : "";
    const row = `${mark} ${duration} ${provider} ${model}${tokens.length > 0 ? ` ${dim(tokens.join(" "))}` : ""}${outcome}`;
    return call.status === "waiting" ? dim(row) : row;
  }));
  return lines.map((line) => fit(line, w));
}

function gitDiffPath(prefix: "a" | "b", path: string): string {
  const value = `${prefix}/${oneLine(path, 512)}`;
  return /\s/u.test(value) ? JSON.stringify(value) : value;
}

function codeChangePaths(change: VisualizerCodeChange): {
  diffSource: string;
  diffDestination: string;
  oldFile: string;
  newFile: string;
} {
  const diffSource = gitDiffPath("a", change.path);
  const diffDestination = gitDiffPath("b", change.moveTo ?? change.path);
  return {
    diffSource,
    diffDestination,
    oldFile: change.operation === "add" ? "/dev/null" : diffSource,
    newFile: change.operation === "delete" ? "/dev/null" : diffDestination,
  };
}

function renderCode(state: VisualizerState, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const events = state.timeline.filter((event) => event.codeChanges !== undefined && event.codeChanges.length > 0);
  const changeCount = events.reduce((total, event) => total + (event.codeChanges?.length ?? 0), 0);
  const lines = [
    fit(`${bold("CODE CHANGES")} ${dim(`· ${changeCount} retained file changes · oldest → newest`)}`, w),
    dim(fit("successful apply_patch operations · bounded changed lines", w)),
  ];
  if (events.length === 0) {
    lines.push(dim("no successful code changes yet"));
    return lines;
  }
  for (const event of events) {
    for (const change of event.codeChanges ?? []) {
      const paths = codeChangePaths(change);
      lines.push(fit(`${bold("diff --git")} ${paths.diffSource} ${paths.diffDestination}`, w));
      lines.push(fit(`${red("---")} ${paths.oldFile}`, w));
      lines.push(fit(`${green("+++")} ${paths.newFile}`, w));
      if (change.lines.length === 0) {
        lines.push(dim(change.operation === "delete" ? "  file deleted" : "  no changed lines retained"));
      }
      for (const line of change.lines) {
        const text = sanitize(line.text).replace(/[\r\n]+/g, " ");
        lines.push(diffCodeLine(`${line.kind === "add" ? "+" : "-"}${text}`, w, line.kind));
      }
      if (change.truncated) lines.push(dim("  … additional changed lines omitted"));
    }
  }
  return lines;
}

function renderThinking(state: VisualizerState, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const events = state.timeline.filter((event) => event.type === "model.reasoning.summary" && Boolean(event.summary));
  const lines = [
    fit(`${bold("THINKING SUMMARIES")} ${dim(`· ${events.length} available · oldest → newest`)}`, w),
    dim(fit("provider summaries · private chain-of-thought hidden", w)),
  ];
  if (events.length === 0) {
    lines.push(dim("no reasoning summaries were provided"));
    return lines;
  }
  const origin = events[0]?.timestamp ?? 0;
  for (const event of events) {
    const node = event.entityId ? state.nodes.get(event.entityId) : undefined;
    const identity = oneLine([event.provider, event.model].filter(Boolean).join(":") || "model", 120);
    const details = [
      event.reasoningEffort ? oneLine(event.reasoningEffort, 40) : "",
      node?.duration !== undefined ? formatDuration(node.duration) : "",
      node?.reasoningTokens !== undefined ? `${formatTokens(node.reasoningTokens)} rz` : "",
      `session ${oneLine(event.sessionId, 48)}`,
    ].filter(Boolean).join(" · ");
    lines.push(fit(
      `#${event.sequence} ${padLine(relativeTime(event.timestamp, origin), 10)} ${magenta("THINKING")} ${identity}${details ? ` ${dim(`· ${details}`)}` : ""}`,
      w,
    ));
    const summary = sanitize(event.summary ?? "").replace(/\s+/g, " ").trim();
    for (const wrapped of wrapTextWithAnsi(summary, Math.max(1, w - 2))) {
      lines.push(fit(`  ${wrapped}`, w));
    }
  }
  return lines;
}

/**
 * Live visualizer pane. Implements the @earendil-works/pi-tui Component
 * contract and additionally accepts an optional height for exact-height
 * rendering (e.g. inside overlays).
 */
export class VisualizerPane implements Component {
  private sessionId: string | null = null;
  private currentView: VisualizerView = "graph";
  private frame = 0;
  private readonly scrollFromBottom = new Map<VisualizerView, number>();
  private contentRows = 0;
  private viewportRows = 0;
  private visibleStart = 0;

  constructor(private readonly store: VisualizerStore) {}

  /** Point the pane at a session; unset sessions fall back to latest data. */
  setSession(sessionId: string): void {
    this.sessionId = sessionId;
    this.scrollFromBottom.clear();
  }

  setView(view: VisualizerView): void {
    this.currentView = view;
  }

  /** Select a tab from pane-local terminal coordinates. */
  handleTabClick(column: number, row: number, width: number): boolean {
    const view = visualizerTabAt(width, column, row);
    if (view === undefined) return false;
    this.setView(view);
    return true;
  }

  nextView(delta: number): void {
    const index = VISUALIZER_VIEWS.findIndex((def) => def.view === this.currentView);
    const count = VISUALIZER_VIEWS.length;
    const base = index < 0 ? 0 : index;
    const next = VISUALIZER_VIEWS[(((base + Math.trunc(delta)) % count) + count) % count];
    if (next !== undefined) this.currentView = next.view;
  }

  get view(): VisualizerView {
    return this.currentView;
  }

  /** Scroll toward older rows with a positive amount and toward live rows with a negative amount. */
  scrollLines(lines: number): void {
    const current = this.scrollFromBottom.get(this.currentView) ?? 0;
    const maximum = Math.max(0, this.contentRows - this.viewportRows);
    const next = Math.max(0, Math.min(maximum, current + Math.trunc(lines)));
    this.scrollFromBottom.set(this.currentView, next);
  }

  scrollPage(direction: -1 | 1): void {
    const amount = Math.max(1, this.viewportRows - 1);
    this.scrollLines(direction < 0 ? amount : -amount);
  }

  get scrollOffset(): number {
    return this.scrollFromBottom.get(this.currentView) ?? 0;
  }

  /** Drive the subtle pulse animation; call each render frame with an incrementing frame number. */
  setFrame(frame: number): void {
    this.frame = Math.max(0, Math.floor(frame));
  }

  invalidate(): void {
    // Rendering is cache-free; nothing to invalidate.
  }

  render(width: number, height?: number): string[] {
    const w = Math.max(1, Math.floor(width));
    const h = height === undefined ? undefined : Math.max(1, Math.floor(height));
    if (w < 8) return this.renderNarrow(w, h);
    const state = this.store.state;
    const capacity = h === undefined ? Number.POSITIVE_INFINITY : Math.max(0, h - FRAME_LINES);
    const content = this.renderView(state, w);
    const stickyCount = Math.min(content.length, this.stickyRows());
    const sticky = content.slice(0, stickyCount);
    const scrollable = content.slice(stickyCount);
    this.contentRows = scrollable.length;
    this.viewportRows = Number.isFinite(capacity) ? Math.max(0, capacity - sticky.length) : scrollable.length;
    const maximum = Math.max(0, this.contentRows - this.viewportRows);
    const offset = Math.min(this.scrollFromBottom.get(this.currentView) ?? 0, maximum);
    this.scrollFromBottom.set(this.currentView, offset);
    const end = Math.max(0, scrollable.length - offset);
    const start = Number.isFinite(capacity) ? Math.max(0, end - this.viewportRows) : 0;
    this.visibleStart = start;
    let body = [...sticky, ...scrollable.slice(start, end)];
    if (Number.isFinite(capacity) && body.length < capacity) {
      body = [...body, ...new Array<string>(capacity - body.length).fill("")];
    }
    if (Number.isFinite(capacity)) body = body.slice(0, capacity);
    const lines = this.composeFrame(state, w, body);
    if (h !== undefined) {
      if (lines.length > h) return lines.slice(0, h);
      while (lines.length < h) lines.push("");
      return lines;
    }
    return lines;
  }

  private renderNarrow(w: number, h: number | undefined): string[] {
    const lines = [fit(`${bold("◈")} ${this.viewLabel()}`, w)];
    lines.push(...this.renderView(this.store.state, w).slice(0, 1));
    if (h !== undefined) {
      while (lines.length < h) lines.push("");
      return lines.slice(0, h);
    }
    return lines;
  }

  private composeFrame(state: VisualizerState, width: number, body: readonly string[]): string[] {
    return [
      tonalLine(this.titleLine(state, width), width, HEADER_BACKGROUND),
      tonalLine(this.tabsLine(width), width, TABS_BACKGROUND),
      ...body.map((line) => tonalLine(line, width, BODY_BACKGROUND)),
      tonalLine(this.footerLine(state, width), width, HEADER_BACKGROUND),
    ];
  }

  private titleLine(state: VisualizerState, width: number): string {
    const session = this.sessionId !== null ? dim(` · ${oneLine(this.sessionId, 120)}`) : dim(" · no session");
    const left = `${cyan("◇")} ${bold("visualizer")} ${session}`;
    const right = this.gauge(state);
    const free = Math.max(1, width - visibleWidth(left) - visibleWidth(right) - 2);
    return `${left}${" ".repeat(free)}${right}`;
  }

  private tabsLine(width: number): string {
    const layout = visualizerTabsLayout(width);
    const tabs = VISUALIZER_VIEWS.map((def, index) => {
      const label = layout.labels[index] ?? def.label;
      if (def.view === this.currentView) return `\x1b[7m${bold(label)}\x1b[27m`;
      return dim(label);
    });
    return `${layout.padding}${tabs.join(layout.gap)}${layout.padding}`;
  }

  private gauge(state: VisualizerState): string {
    let active = 0;
    for (const node of state.nodes.values()) if (node.status === "active") active += 1;
    if (active > 0) return `${yellow("◐◓◑◒".charAt(this.frame % 4))} ${active} active`;
    return dim(`○ ${state.turns.size} turns`);
  }

  private footerLine(state: VisualizerState, width: number): string {
    let failed = 0;
    let active = 0;
    for (const node of state.nodes.values()) {
      if (node.status === "failed") failed += 1;
      else if (node.status === "active") active += 1;
    }
    const left = [
      `turns ${state.turns.size}`,
      `agents ${state.agents.size}`,
      `tools ${state.toolCalls.size}`,
      `files ${state.activeFiles.size}`,
      ...(active > 0 ? [yellow(`live ${active}`)] : []),
      ...(failed > 0 ? [red(`err ${failed}`)] : []),
    ].join(" · ");
    const rangeStart = this.contentRows === 0 ? 0 : this.visibleStart + 1;
    const rangeEnd = Math.min(this.contentRows, this.visibleStart + this.viewportRows);
    const range = this.contentRows > this.viewportRows ? ` ${rangeStart}-${rangeEnd}/${this.contentRows} · wheel` : "";
    const right = cyan(`${this.viewLabel()}${range}`);
    const leftWidth = Math.max(0, width - visibleWidth(right) - 2);
    const shownLeft = leftWidth > 0 ? fit(dim(left), leftWidth) : "";
    const free = Math.max(1, width - visibleWidth(shownLeft) - visibleWidth(right));
    return `${shownLeft}${" ".repeat(free)}${right}`;
  }

  private viewLabel(): string {
    return VISUALIZER_VIEWS.find((def) => def.view === this.currentView)?.label ?? this.currentView;
  }

  private stickyRows(): number {
    if (this.currentView === "graph") return 3;
    if (["timeline", "trace", "code", "thinking"].includes(this.currentView)) return 2;
    return 1;
  }

  private renderView(state: VisualizerState, width: number): string[] {
    switch (this.currentView) {
      case "graph":
        return renderLiveGraph(state, width, this.frame);
      case "timeline":
        return renderTimeline(state, width);
      case "trace":
        return renderTrace(state, width);
      case "context":
        return renderContext(state, this.sessionId, width);
      case "files":
        return renderFiles(state, width);
      case "calls":
        return renderCalls(state, width);
      case "code":
        return renderCode(state, width);
      case "thinking":
        return renderThinking(state, width);
    }
  }
}
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { stdin, stdout } from "node:process";
import { stripVTControlCharacters } from "node:util";
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Input,
  Key,
  Markdown,
  ProcessTerminal,
  SelectList,
  TUI,
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type AutocompleteSuggestions,
  type EditorTheme,
  type Focusable,
  type MarkdownTheme,
  type OverlayHandle,
  type SelectItem,
  type SelectListTheme,
  type SlashCommand,
} from "@earendil-works/pi-tui";
import type { LookingGlassApp } from "../app.js";
import type {
  EngineCallbacks,
  EngineInteraction,
} from "../engine/engine.js";
import { projectContext } from "../engine/context.js";
import type { InboxRecord, SchedulerJob } from "../scheduler/types.js";
import { initialDue } from "../scheduler/schedule.js";
import type { ApprovalDecision, ApprovalRequest, QuestionRequest } from "../tools/types.js";
import { isWithin } from "../tools/paths.js";
import type {
  ApprovalMode,
  GatewayModel,
  SessionEvent,
  SessionRecord,
} from "../types.js";

const MIN_COLUMNS = 32;
const MIN_ROWS = 12;
const STREAM_RENDER_MS = 40;
const INBOX_POLL_MS = 2_000;
const MODEL_AVAILABILITY_RETRY_MS = 30_000;
const MAX_TOOL_PREVIEW = 320;
const ACTIVITY_RENDER_MS = 1_000;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const DELETE_SELECTION_PREFIX = "\0delete:";

interface ScreenPoint {
  column: number;
  row: number;
}

export interface TerminalMouseEvent extends ScreenPoint {
  action: "press" | "drag" | "release" | "wheel_up" | "wheel_down" | "wheel_left" | "wheel_right";
  button: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

type Style = (text: string) => string;

const style = (open: number, close = 39): Style => (text) => `\x1b[${open}m${text}\x1b[${close}m`;
const bold = style(1, 22);
const dim = style(2, 22);
const red = style(31);
const green = style(32);
const yellow = style(33);
const blue = style(34);
const magenta = style(35);
const cyan = style(36);

function tonalLine(line: string, width: number, background: number): string {
  const base = `\x1b[38;5;252;48;5;${background}m`;
  const content = pad(line, width).replace(/\x1b\[(?:0|39|49)m/g, (reset) => `${reset}${base}`);
  return `${base}${content}\x1b[39;49m`;
}

const selectTheme: SelectListTheme = {
  selectedPrefix: cyan,
  selectedText: (text) => `\x1b[7m${text}\x1b[27m`,
  description: dim,
  scrollInfo: dim,
  noMatch: dim,
};

const editorTheme: EditorTheme = {
  borderColor: cyan,
  selectList: selectTheme,
};

const markdownTheme: MarkdownTheme = {
  heading: (text) => bold(cyan(text)),
  link: blue,
  linkUrl: dim,
  code: yellow,
  codeBlock: (text) => text,
  codeBlockBorder: dim,
  quote: dim,
  quoteBorder: cyan,
  hr: dim,
  listBullet: cyan,
  bold,
  italic: (text) => `\x1b[3m${text}\x1b[23m`,
  strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
  underline: (text) => `\x1b[4m${text}\x1b[24m`,
  codeBlockIndent: "  ",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function displaySafe(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (character) => {
      return `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`;
    });
}

function oneLine(text: string, limit = MAX_TOOL_PREVIEW): string {
  const compact = displaySafe(text).replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, Math.max(0, limit - 3))}...` : compact;
}

export function contextUsageLabel(inputTokens: number, contextWindow: number): string {
  if (contextWindow <= 0) return "ctx:?";
  const percent = Math.max(0, Math.min(999, Math.round((inputTokens / contextWindow) * 100)));
  return `ctx:${percent}%`;
}

export function sessionMetadataLine(
  session: SessionRecord,
  approval: ApprovalMode,
  contextUsage: string,
  width = Number.POSITIVE_INFINITY,
): string {
  const narrow = Number.isFinite(width) && width < 100;
  const middle = [
    session.reasoningEffort,
    contextUsage,
    `agents:${session.agentsEnabled ? "on" : "off"}`,
    approval,
    `${narrow ? "p" : "persist"}:${session.persistent ? "on" : "off"}`,
  ];
  const separators = 3 * (middle.length + 1);
  const available = Number.isFinite(width)
    ? Math.max(8, Math.floor(width) - middle.reduce((sum, value) => sum + value.length, 0) - separators)
    : session.model.length + session.title.length;
  let modelWidth = Math.max(4, Math.floor(available * 0.6));
  let titleWidth = Math.max(4, available - modelWidth);
  if (session.model.length < modelWidth) {
    titleWidth += modelWidth - session.model.length;
    modelWidth = session.model.length;
  } else if (session.title.length < titleWidth) {
    modelWidth += titleWidth - session.title.length;
    titleWidth = session.title.length;
  }
  return [
    oneLine(session.model, modelWidth),
    ...middle,
    oneLine(session.title, titleWidth),
  ].join(" | ");
}

export function activityLine(active: boolean, status: string, frame: number, scrollOffset: number): string {
  const activity = active ? `${status}${".".repeat((frame % 3) + 1)}` : "Ready";
  return scrollOffset > 0 ? `${activity} | scroll:+${scrollOffset}` : activity;
}

function orderedSelection(anchor: ScreenPoint, focus: ScreenPoint): [ScreenPoint, ScreenPoint] {
  if (anchor.row < focus.row || (anchor.row === focus.row && anchor.column <= focus.column)) {
    return [anchor, focus];
  }
  return [focus, anchor];
}

function stripTerminalFormatting(text: string): string {
  return stripVTControlCharacters(text.replace(/\x1b_[\s\S]*?(?:\x07|\x1b\\)/g, ""));
}

function snapColumn(line: string, column: number, direction: "floor" | "ceil"): number {
  const text = stripTerminalFormatting(line);
  const segments = graphemeSegmenter.segment(text);
  let current = 0;
  for (const { segment } of segments) {
    const next = current + visibleWidth(segment);
    if (column > current && column < next) return direction === "floor" ? current : next;
    if (column <= current) return current;
    current = next;
  }
  return current;
}

export function selectedScreenText(lines: string[], anchor: ScreenPoint, focus: ScreenPoint): string {
  if (lines.length === 0) return "";
  const [start, end] = orderedSelection(anchor, focus);
  const firstRow = Math.max(0, Math.min(lines.length - 1, start.row));
  const lastRow = Math.max(firstRow, Math.min(lines.length - 1, end.row));
  const selected: string[] = [];
  for (let row = firstRow; row <= lastRow; row += 1) {
    const line = lines[row] ?? "";
    const width = visibleWidth(line);
    const from = row === firstRow ? snapColumn(line, Math.max(0, Math.min(width, start.column)), "floor") : 0;
    const to = row === lastRow
      ? snapColumn(line, Math.max(from, Math.min(width, end.column + 1)), "ceil")
      : width;
    selected.push(stripTerminalFormatting(sliceByColumn(line, from, Math.max(0, to - from))).trimEnd());
  }
  return selected.join("\n");
}

function jsonPreview(value: unknown): string {
  try {
    return oneLine(JSON.stringify(value));
  } catch {
    return oneLine(String(value));
  }
}

function fit(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width), "");
}

function pad(line: string, width: number): string {
  const fitted = fit(line, width);
  return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

function wrap(text: string, width: number): string[] {
  return wrapTextWithAnsi(displaySafe(text), Math.max(1, width));
}

function renderFrame(title: string, body: string[], width: number): string[] {
  const frameWidth = Math.max(1, width);
  if (frameWidth < 4) return body.map((line) => fit(line, frameWidth));
  const innerWidth = frameWidth - 2;
  const border = `+${"-".repeat(innerWidth)}+`;
  return [
    border,
    `|${pad(` ${bold(displaySafe(title))}`, innerWidth)}|`,
    `|${"-".repeat(innerWidth)}|`,
    ...body.map((line) => `|${pad(line, innerWidth)}|`),
    border,
  ].map((line) => fit(line, frameWidth));
}

class AlternateScreenTerminal extends ProcessTerminal {
  private active = false;
  private alternate = false;

  get isActive(): boolean {
    return this.active;
  }

  copy(text: string): void {
    if (!text) return;
    const sequence = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;
    if (process.env.TMUX) this.write(`\x1bPtmux;\x1b${sequence}\x1b\\`);
    else if (process.env.STY) this.write(`\x1bP${sequence}\x1b\\`);
    else this.write(sequence);

    let command: string | undefined;
    let args: string[] = [];
    if (platform() === "darwin") command = "pbcopy";
    else if (platform() === "win32") command = "clip.exe";
    else if (process.env.WAYLAND_DISPLAY) command = "wl-copy";
    else if (process.env.DISPLAY) {
      command = "xclip";
      args = ["-selection", "clipboard"];
    }
    if (!command) return;
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.stdin?.end(text);
  }

  override start(onInput: (data: string) => void, onResize: () => void): void {
    if (this.active) return;
    try {
      super.start(onInput, onResize);
      this.active = true;
      this.write("\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[2J\x1b[H");
      this.alternate = true;
    } catch (error) {
      try {
        super.stop();
      } finally {
        if (this.alternate) this.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1049l");
        this.active = false;
        this.alternate = false;
      }
      throw error;
    }
  }

  override async drainInput(maxMs?: number, idleMs?: number): Promise<void> {
    if (!this.active) return;
    await super.drainInput(maxMs, idleMs);
  }

  override stop(): void {
    if (!this.active && !this.alternate) return;
    try {
      if (this.active) super.stop();
    } finally {
      if (this.alternate) this.write("\x1b[0m\x1b[?25h\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1049l");
      this.active = false;
      this.alternate = false;
    }
  }
}

class SafeAutocompleteProvider extends CombinedAutocompleteProvider {
  override async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    try {
      return await super.getSuggestions(lines, cursorLine, cursorCol, options);
    } catch {
      return null;
    }
  }
}

class TurnEditor extends Editor {
  private enabled = true;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.disableSubmit = !enabled;
    this.borderColor = enabled ? editorTheme.borderColor : dim;
  }

  override handleInput(data: string): void {
    if (this.enabled) super.handleInput(data);
  }
}

export class UserMessage implements Component {
  constructor(private readonly text: string) {}

  invalidate(): void {}

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 2);
    const lines = [bold(blue("You")), ...wrap(this.text, contentWidth).map((line) => `  ${line}`)];
    return [...lines.map((line) => tonalLine(line, width, 17)), ""];
  }
}

export class AssistantMessage implements Component {
  protected readonly markdown: Markdown;
  protected text: string;

  constructor(text = "") {
    this.text = displaySafe(text);
    this.markdown = new Markdown(this.text, 2, 0, markdownTheme);
  }

  get empty(): boolean {
    return this.text.length === 0;
  }

  setText(text: string): void {
    this.text = displaySafe(text);
    this.markdown.setText(this.text);
  }

  invalidate(): void {
    this.markdown.invalidate();
  }

  render(width: number): string[] {
    if (this.empty) return [];
    return [...this.markdown.render(width).map((line) => tonalLine(line, width, 234)), ""];
  }
}

class StreamingAssistant extends AssistantMessage {
  private raw = "";
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly requestRender: () => void) {
    super();
  }

  append(delta: string): void {
    this.raw += delta;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.setText(this.raw);
      this.requestRender();
    }, STREAM_RENDER_MS);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.setText(this.raw);
    this.requestRender();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

class ReasoningSummary implements Component {
  protected text: string;

  constructor(text = "") {
    this.text = displaySafe(text);
  }

  setText(text: string): void {
    this.text = displaySafe(text);
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.text) return [];
    const contentWidth = Math.max(1, width - 2);
    return [dim("Reasoning summary"), ...wrap(this.text, contentWidth).map((line) => `  ${dim(line)}`), ""]
      .map((line) => fit(line, width));
  }
}

class StreamingReasoning extends ReasoningSummary {
  private raw = "";
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly requestRender: () => void) {
    super();
  }

  append(delta: string): void {
    this.raw += delta;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.setText(this.raw);
      this.requestRender();
    }, STREAM_RENDER_MS);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.setText(this.raw);
    this.requestRender();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export class ToolCard implements Component {
  private output: string | null = null;
  private failed = false;
  private finished = false;

  constructor(
    readonly callId: string,
    private readonly name: string,
    private readonly summary: string,
  ) {}

  finish(output: string, failed: boolean): void {
    this.output = oneLine(output) || "No output";
    this.failed = failed;
    this.finished = true;
  }

  progress(output: string): void {
    if (!this.finished) this.output = oneLine(output) || null;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const state = this.finished ? (this.failed ? red("failed") : green("done")) : yellow("running");
    const header = `${dim("tool")} ${cyan(oneLine(this.name))} [${state}] ${oneLine(this.summary)}`;
    const lines = [fit(header, width)];
    if (this.output) lines.push(fit(`  ${dim(this.output)}`, width));
    return [...lines.map((line) => tonalLine(line, width, 236)), ""];
  }
}

class Notice implements Component {
  constructor(
    private readonly label: string,
    private readonly text: string,
    private readonly color: Style = magenta,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const prefix = `${this.color(`[${displaySafe(this.label)}]`)} `;
    const prefixWidth = visibleWidth(prefix);
    const contentWidth = Math.max(1, width - prefixWidth);
    const lines = wrap(this.text, contentWidth);
    const first = lines[0] ?? "";
    return [
      fit(prefix + first, width),
      ...lines.slice(1).map((line) => fit(`${" ".repeat(prefixWidth)}${line}`, width)),
      "",
    ];
  }
}

class FullHeightRoot extends Container {
  private readonly entries: Component[] = [];
  private transcriptCache: string[] | null = null;
  private transcriptCacheWidth = 0;
  private scrollFromBottom = 0;
  private lastTranscriptLines = 0;
  private lastWidth = 0;
  private viewportRows = 1;
  private maxScroll = 0;
  private selectionAnchor: ScreenPoint | null = null;
  private selectionFocus: ScreenPoint | null = null;
  private lastFrame: string[] = [];
  private selectableRows = 0;

  constructor(
    private readonly terminal: AlternateScreenTerminal,
    readonly editor: TurnEditor,
    private readonly activityText: () => string,
    private readonly metadataText: (width: number) => string,
  ) {
    super();
    this.addChild(editor);
  }

  addEntry(component: Component): void {
    this.entries.push(component);
    this.invalidateTranscript();
  }

  invalidateTranscript(): void {
    this.transcriptCache = null;
  }

  clearTranscript(): void {
    for (const entry of this.entries) entry.invalidate();
    this.entries.length = 0;
    this.invalidateTranscript();
    this.scrollFromBottom = 0;
    this.lastTranscriptLines = 0;
  }

  scrollPage(direction: -1 | 1): void {
    const amount = Math.max(1, this.viewportRows - 2);
    this.scrollFromBottom = direction < 0
      ? Math.min(this.maxScroll, this.scrollFromBottom + amount)
      : Math.max(0, this.scrollFromBottom - amount);
  }

  scrollLines(lines: number): void {
    this.scrollFromBottom = Math.max(0, Math.min(this.maxScroll, this.scrollFromBottom + lines));
  }

  get scrollOffset(): number {
    return this.scrollFromBottom;
  }

  startSelection(point: ScreenPoint): boolean {
    if (point.row < 0 || point.row >= this.selectableRows) return false;
    this.selectionAnchor = this.clampPoint(point);
    this.selectionFocus = this.selectionAnchor;
    return true;
  }

  updateSelection(point: ScreenPoint): boolean {
    if (!this.selectionAnchor) return false;
    this.selectionFocus = this.clampPoint(point);
    return true;
  }

  selectionText(): string {
    if (!this.selectionAnchor || !this.selectionFocus) return "";
    return selectedScreenText(this.lastFrame, this.selectionAnchor, this.selectionFocus);
  }

  clearSelection(): void {
    this.selectionAnchor = null;
    this.selectionFocus = null;
  }

  private clampPoint(point: ScreenPoint): ScreenPoint {
    return {
      column: Math.max(0, Math.min(this.terminal.columns - 1, point.column)),
      row: Math.max(0, Math.min(Math.max(0, this.selectableRows - 1), point.row)),
    };
  }

  private renderSelection(frame: string[]): string[] {
    this.lastFrame = frame;
    if (!this.selectionAnchor || !this.selectionFocus) return frame;
    const [start, end] = orderedSelection(this.selectionAnchor, this.selectionFocus);
    return frame.map((line, row) => {
      if (row < start.row || row > end.row) return line;
      const width = visibleWidth(line);
      const from = row === start.row
        ? snapColumn(line, Math.max(0, Math.min(width, start.column)), "floor")
        : 0;
      const to = row === end.row
        ? snapColumn(line, Math.max(from, Math.min(width, end.column + 1)), "ceil")
        : width;
      if (to <= from) return line;
      const before = sliceByColumn(line, 0, from);
      const selected = stripVTControlCharacters(sliceByColumn(line, from, to - from));
      const after = sliceByColumn(line, to, Math.max(0, width - to));
      return `${before}\x1b[7m${selected}\x1b[27m${after}`;
    });
  }

  override invalidate(): void {
    this.editor.invalidate();
    for (const entry of this.entries) entry.invalidate();
    this.invalidateTranscript();
  }

  override render(width: number): string[] {
    const height = Math.max(1, this.terminal.rows);
    const safeWidth = Math.max(1, width);
    if (safeWidth < MIN_COLUMNS || height < MIN_ROWS) {
      this.selectableRows = 0;
      const lines = Array.from<string>({ length: height }).fill("");
      const message = `Terminal too small (${safeWidth}x${height}); need ${MIN_COLUMNS}x${MIN_ROWS}`;
      lines[Math.floor(height / 2)] = fit(yellow(message), safeWidth);
      return this.renderSelection(lines);
    }

    let editorLines = this.editor.render(safeWidth).map((line) => fit(line, safeWidth));
    const maxEditorRows = Math.max(3, height - 4);
    if (editorLines.length > maxEditorRows) editorLines = editorLines.slice(0, maxEditorRows);
    this.viewportRows = Math.max(0, height - editorLines.length - 2);

    if (!this.transcriptCache || this.transcriptCacheWidth !== safeWidth) {
      this.transcriptCache = this.entries.flatMap((entry) => entry.render(safeWidth).map((line) => fit(line, safeWidth)));
      this.transcriptCacheWidth = safeWidth;
    }
    const transcript = this.transcriptCache;
    if (this.lastWidth === safeWidth && this.scrollFromBottom > 0 && transcript.length > this.lastTranscriptLines) {
      this.scrollFromBottom += transcript.length - this.lastTranscriptLines;
    }
    this.lastWidth = safeWidth;
    this.lastTranscriptLines = transcript.length;
    this.maxScroll = Math.max(0, transcript.length - this.viewportRows);
    this.scrollFromBottom = Math.min(this.scrollFromBottom, this.maxScroll);

    const end = Math.max(0, transcript.length - this.scrollFromBottom);
    const start = Math.max(0, end - this.viewportRows);
    const visibleTranscript = transcript.slice(start, end);
    const topPadding = Array.from<string>({
      length: Math.max(0, this.viewportRows - visibleTranscript.length),
    }).fill("");
    this.selectableRows = topPadding.length + visibleTranscript.length;
    const activity = fit(dim(` ${oneLine(this.activityText(), 10_000)}`), safeWidth);
    const metadata = fit(dim(` ${oneLine(this.metadataText(Math.max(1, safeWidth - 1)), 10_000)}`), safeWidth);
    return this.renderSelection([...topPadding, ...visibleTranscript, activity, ...editorLines, metadata]);
  }
}

class SelectorModal implements Component {
  readonly list: SelectList;
  onSelect?: (value: string) => void;
  onDelete?: (value: string) => void;
  onCancel?: () => void;

  constructor(
    title: string,
    items: SelectItem[],
    maxVisible: number,
    private readonly prompt?: string,
  ) {
    this.title = title;
    const safeItems = items.map((item) => ({
      value: item.value,
      label: oneLine(item.label, 500),
      ...(item.description ? { description: oneLine(item.description, 1_000) } : {}),
    }));
    this.list = new SelectList(safeItems, maxVisible, selectTheme, {
      minPrimaryColumnWidth: 12,
      maxPrimaryColumnWidth: 34,
    });
    this.list.onSelect = (item) => this.onSelect?.(item.value);
    this.list.onCancel = () => this.onCancel?.();
  }

  private readonly title: string;

  invalidate(): void {
    this.list.invalidate();
  }

  handleInput(data: string): void {
    if (this.onDelete && matchesKey(data, Key.delete)) {
      const selected = this.list.getSelectedItem();
      if (selected) this.onDelete(selected.value);
      return;
    }
    this.list.handleInput(data);
  }

  render(width: number): string[] {
    const prompt = this.prompt ? [...wrap(this.prompt, Math.max(1, width - 4)), ""] : [];
    return renderFrame(this.title, [
      ...prompt,
      ...this.list.render(Math.max(1, width - 2)),
      dim(` Enter select${this.onDelete ? " | Delete remove" : ""} | Esc cancel`),
    ], width);
  }
}

export class ApprovalModal implements Component {
  onDone?: (decision: ApprovalDecision) => void;
  private selected: ApprovalDecision = "deny";
  private scrollOffset = 0;
  private pageSize = 1;
  private maxScroll = 0;
  private renderedWidth = 1;
  private renderedHeight = 1;
  private readonly hitboxes = new Map<ApprovalDecision, { row: number; range: [number, number] }>();
  private pressed: ApprovalDecision | null = null;

  constructor(
    private readonly terminal: AlternateScreenTerminal,
    private readonly request: ApprovalRequest,
  ) {}

  invalidate(): void {}

  private actions(): ApprovalDecision[] {
    return this.request.canAlwaysApprove ? ["deny", "once", "always"] : ["deny", "once"];
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      const actions = this.actions();
      const current = actions.indexOf(this.selected);
      const direction = matchesKey(data, Key.left) ? -1 : 1;
      this.selected = actions[(current + direction + actions.length) % actions.length] ?? "deny";
    } else if (matchesKey(data, Key.up)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (matchesKey(data, Key.down)) {
      this.scrollOffset = Math.min(this.maxScroll, this.scrollOffset + 1);
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - this.pageSize);
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset = Math.min(this.maxScroll, this.scrollOffset + this.pageSize);
    } else if (matchesKey(data, Key.enter)) {
      this.onDone?.(this.selected);
    } else if (matchesKey(data, "y")) {
      this.onDone?.("once");
    } else if (this.request.canAlwaysApprove && matchesKey(data, "a")) {
      this.onDone?.("always");
    } else if (matchesKey(data, "n") || matchesKey(data, Key.escape)) {
      this.onDone?.("deny");
    }
  }

  handleMouse(event: TerminalMouseEvent): boolean {
    if (event.action === "wheel_up" || event.action === "wheel_down") {
      this.scrollOffset = Math.max(
        0,
        Math.min(this.maxScroll, this.scrollOffset + (event.action === "wheel_up" ? -1 : 1)),
      );
      return true;
    }
    if (event.button !== 0 && event.action !== "release") return false;
    const target = this.actionAt(event);
    if (event.action === "press") {
      this.pressed = target;
      this.selected = target ?? "deny";
      return Boolean(target);
    }
    if (event.action === "drag") {
      return Boolean(this.pressed);
    }
    if (event.action === "release") {
      const pressed = this.pressed;
      this.pressed = null;
      if (pressed && target === pressed) this.onDone?.(pressed);
      else this.selected = "deny";
      return Boolean(pressed || target);
    }
    return false;
  }

  private actionAt(event: ScreenPoint): ApprovalDecision | null {
    const margin = 1;
    const availableWidth = Math.max(1, this.terminal.columns - margin * 2);
    const availableHeight = Math.max(1, this.terminal.rows - margin * 2);
    const overlayColumn = margin + Math.floor((availableWidth - this.renderedWidth) / 2);
    const overlayRow = margin + Math.floor((availableHeight - this.renderedHeight) / 2);
    const row = event.row - overlayRow;
    const column = event.column - overlayColumn;
    for (const [action, hitbox] of this.hitboxes) {
      if (row === hitbox.row && column >= hitbox.range[0] && column < hitbox.range[1]) return action;
    }
    return null;
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 4);
    const risk = this.request.risk === "critical"
      ? bold(red(`[ ${this.request.risk.toUpperCase()} ]`))
      : bold(yellow(`[ ${this.request.risk.toUpperCase()} ]`));
    const exactContent = [
      `${risk}  ${bold(displaySafe(this.request.tool))}`,
      "",
      bold(cyan("Action")),
      ...wrap(this.request.summary, contentWidth),
      "",
      bold(cyan("Command / details")),
      ...wrap(this.request.details, contentWidth).map(dim),
      ...(this.request.canAlwaysApprove ? [
        "",
        ...wrap("Always approve remembers the displayed scope for this session, including agents and scheduled work.", contentWidth).map(yellow),
      ] : []),
    ];
    const actionDefinitions: { action: ApprovalDecision; label: string }[] = [
      { action: "deny", label: "[ Deny ]" },
      { action: "once", label: "[ Approve once ]" },
      ...(this.request.canAlwaysApprove ? [{ action: "always" as const, label: "[ Always approve ]" }] : []),
    ];
    const gap = 4;
    const innerWidth = Math.max(1, width - 2);
    const actionsWidth = actionDefinitions.reduce((total, item) => total + item.label.length, 0)
      + gap * (actionDefinitions.length - 1);
    const horizontalActions = innerWidth >= actionsWidth;
    const styleAction = ({ action, label }: { action: ApprovalDecision; label: string }): string => {
      if (this.selected !== action) {
        if (action === "deny") return red(label);
        if (action === "always") return yellow(label);
        return green(label);
      }
      if (action === "deny") return `\x1b[41;97;1m${label}\x1b[0m`;
      if (action === "always") return `\x1b[43;30;1m${label}\x1b[0m`;
      return `\x1b[42;30;1m${label}\x1b[0m`;
    };
    const starts = new Map<ApprovalDecision, number>();
    const actionLines = horizontalActions
      ? (() => {
          let column = Math.max(0, Math.floor((innerWidth - actionsWidth) / 2));
          const parts: string[] = [" ".repeat(column)];
          for (const item of actionDefinitions) {
            starts.set(item.action, column);
            parts.push(styleAction(item));
            column += item.label.length;
            if (item !== actionDefinitions.at(-1)) {
              parts.push(" ".repeat(gap));
              column += gap;
            }
          }
          return [parts.join("")];
        })()
      : actionDefinitions.map((item) => {
          const padding = Math.max(0, Math.floor((innerWidth - item.label.length) / 2));
          starts.set(item.action, padding);
          return `${" ".repeat(padding)}${styleAction(item)}`;
        });
    const maximumHeight = Math.max(9, Math.min(this.terminal.rows - 2, Math.floor(this.terminal.rows * 0.8)));
    const showHint = maximumHeight - 4 - 1 - actionLines.length >= 2;
    const fixedBodyLines = 1 + actionLines.length + (showHint ? 1 : 0);
    this.pageSize = Math.max(1, maximumHeight - 4 - fixedBodyLines);
    this.maxScroll = Math.max(0, exactContent.length - this.pageSize);
    this.scrollOffset = Math.min(this.scrollOffset, this.maxScroll);
    const visible = exactContent.slice(this.scrollOffset, this.scrollOffset + this.pageSize);
    const scroll = this.maxScroll > 0
      ? dim(` ${this.scrollOffset + 1}-${Math.min(exactContent.length, this.scrollOffset + this.pageSize)}/${exactContent.length} | scroll for more`)
      : "";
    const body = [
      ...visible,
      scroll,
      ...actionLines,
      ...(showHint ? [dim(` Click an action | Left/Right or Tab | Enter${this.request.canAlwaysApprove ? " | A always" : ""}`)] : []),
    ];
    const lines = renderFrame("Confirm command", body, width);
    this.renderedWidth = width;
    this.renderedHeight = lines.length;
    const firstActionRow = 3 + visible.length + 1;
    this.hitboxes.clear();
    actionDefinitions.forEach((item, index) => {
      const start = 1 + (starts.get(item.action) ?? 0);
      this.hitboxes.set(item.action, {
        row: firstActionRow + (horizontalActions ? 0 : index),
        range: [start, start + item.label.length],
      });
    });
    return lines;
  }
}

class QuestionInputModal implements Component, Focusable {
  private readonly input = new Input();
  onDone?: (answer: string) => void;

  constructor(
    private readonly terminal: AlternateScreenTerminal,
    private readonly question: string,
  ) {
    this.input.onSubmit = (answer) => this.onDone?.(answer);
    this.input.onEscape = () => this.onDone?.("");
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  invalidate(): void {
    this.input.invalidate();
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 4);
    const questionLines = wrap(this.question, contentWidth);
    const maximumQuestionRows = Math.max(1, Math.floor(this.terminal.rows * 0.6) - 6);
    const visibleQuestion = questionLines.slice(0, maximumQuestionRows);
    if (questionLines.length > visibleQuestion.length) visibleQuestion.push(dim("... question continues beyond this viewport"));
    const inputLine = this.input.render(Math.max(1, contentWidth - 2))[0] ?? "";
    return renderFrame("Question", [...visibleQuestion, "", `> ${inputLine}`], width);
  }
}

interface ActiveModal {
  cancel(): void;
  mouse?(event: TerminalMouseEvent): boolean;
}

function userText(event: SessionEvent): string | null {
  if (!isRecord(event.payload) || !isRecord(event.payload.item)) return null;
  const content = event.payload.item.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((part) => {
    if (!isRecord(part) || part.type !== "input_text" || typeof part.text !== "string") return [];
    return [part.text];
  });
  return parts.length > 0 ? parts.join("\n") : null;
}

function assistantText(event: SessionEvent): string | null {
  if (!isRecord(event.payload) || !isRecord(event.payload.response)) return null;
  const output = event.payload.response.output;
  if (!Array.isArray(output)) return null;
  const messages = output.flatMap((item) => {
    if (!isRecord(item) || item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) return [];
    const parts = item.content.flatMap((part) => {
      if (!isRecord(part) || part.type !== "output_text" || typeof part.text !== "string") return [];
      return [part.text];
    });
    return parts.length > 0 ? [parts.join("")] : [];
  });
  return messages.length > 0 ? messages.join("\n\n") : null;
}

function reasoningSummary(event: SessionEvent): string | null {
  if (!isRecord(event.payload) || !isRecord(event.payload.response)) return null;
  const output = event.payload.response.output;
  if (!Array.isArray(output)) return null;
  const summaries = output.flatMap((item) => {
    if (!isRecord(item) || item.type !== "reasoning" || !Array.isArray(item.summary)) return [];
    return item.summary.flatMap((part) => {
      if (!isRecord(part) || part.type !== "summary_text" || typeof part.text !== "string") return [];
      return [part.text];
    });
  });
  return summaries.length > 0 ? summaries.join("\n") : null;
}

function schedulerJobLine(job: SchedulerJob): string {
  const state = job.blockedReason ? `blocked: ${job.blockedReason}` : (job.enabled ? "enabled" : "disabled");
  const action = job.kind === "reminder" ? job.message : job.kind === "session_prompt" ? job.prompt : job.command;
  const due = job.nextDue === null ? "no next run" : new Date(job.nextDue).toISOString();
  return `${job.id.slice(0, 8)} ${job.kind} ${state} | ${job.scheduleKind}:${job.schedule} | ${due} | ${oneLine(action ?? "")}`;
}

function schedulerJobDetails(job: SchedulerJob): string {
  const action = job.kind === "reminder" ? job.message : job.kind === "session_prompt" ? job.prompt : job.command;
  return [
    `ID: ${job.id}`,
    `Kind: ${job.kind}`,
    `State: ${job.blockedReason ?? (job.enabled ? "enabled" : "disabled")}`,
    `Schedule: ${job.scheduleKind}:${job.schedule} (${job.timezone})`,
    job.cwd ? `Working directory: ${job.cwd}` : "",
    `Exact action:\n${action ?? ""}`,
  ].filter(Boolean).join("\n");
}

interface ParsedSessionSchedule {
  scheduleKind: "once" | "cron";
  schedule: string;
  prompt: string;
}

export function parseSessionSchedule(argument: string): ParsedSessionSchedule {
  const trimmed = argument.trim();
  if (trimmed.startsWith("once ")) {
    const match = /^once\s+(\S+)\s+([\s\S]+)$/.exec(trimmed);
    if (!match?.[1] || !match[2]?.trim()) throw new Error("Usage: /schedule once <ISO timestamp> <prompt>");
    return { scheduleKind: "once", schedule: match[1], prompt: match[2].trim() };
  }
  if (trimmed.startsWith("cron ")) {
    const rest = trimmed.slice(5).trim();
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const quote = rest[0]!;
      const end = rest.indexOf(quote, 1);
      if (end < 0) throw new Error("Cron expression is missing its closing quote");
      const schedule = rest.slice(1, end).trim();
      const prompt = rest.slice(end + 1).trim();
      if (!schedule || !prompt) throw new Error('Usage: /schedule cron "<five fields>" <prompt>');
      return { scheduleKind: "cron", schedule, prompt };
    }
    const tokens = rest.split(/\s+/);
    if (tokens.length < 6) throw new Error('Usage: /schedule cron "<five fields>" <prompt>');
    return { scheduleKind: "cron", schedule: tokens.slice(0, 5).join(" "), prompt: tokens.slice(5).join(" ") };
  }
  throw new Error('Usage: /schedule once <ISO> <prompt> or /schedule cron "<five fields>" <prompt>');
}

export function parseTerminalMouse(data: string): TerminalMouseEvent | null {
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([mM])$/.exec(data);
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return null;
  const code = Number(match[1]);
  const column = Math.max(0, Number(match[2]) - 1);
  const row = Math.max(0, Number(match[3]) - 1);
  const button = code & 3;
  const motion = (code & 32) !== 0;
  const wheel = (code & 64) !== 0;
  const action = wheel
    ? (["wheel_up", "wheel_down", "wheel_left", "wheel_right"] as const)[button]!
    : match[4] === "m" || button === 3
      ? "release"
      : motion
        ? "drag"
        : "press";
  return {
    action,
    button,
    column,
    row,
    shift: (code & 4) !== 0,
    alt: (code & 8) !== 0,
    ctrl: (code & 16) !== 0,
  };
}

export function mouseWheelDelta(data: string): number {
  const mouse = parseTerminalMouse(data);
  if (mouse?.action === "wheel_up") return 3;
  if (mouse?.action === "wheel_down") return -3;
  return 0;
}

export function inboxLine(item: InboxRecord, job?: SchedulerJob | null, sessionTitle?: string): string {
  const source = job?.kind === "session_prompt"
    ? `session:${oneLine(sessionTitle ?? job.sessionId ?? "unknown", 60)}`
    : job?.kind ?? item.kind;
  return `#${item.id} ${source} ${item.occurrence.state} | ${new Date(item.createdAt).toISOString()} | ${oneLine(item.message)}`;
}

export function shouldAutoDisplayInbox(job: SchedulerJob | null | undefined, currentSessionId: string): boolean {
  return job?.kind !== "session_prompt" || job.sessionId === currentSessionId;
}

export function markInboxItemsRead(items: InboxRecord[], acknowledge: (id: number) => boolean): number {
  let count = 0;
  for (const item of items) if (acknowledge(item.id)) count += 1;
  return count;
}

function inboxIdentity(item: InboxRecord): string {
  return `${item.jobId}:${item.occurrenceId}`;
}

export async function initialTuiSession(app: LookingGlassApp, initialSessionId?: string): Promise<SessionRecord> {
  return initialSessionId
    ? app.currentOrNewSession(initialSessionId)
    : app.createSession();
}

/** Run the interactive Looking Glass chat interface until the user exits. */
export async function runTui(app: LookingGlassApp, initialSessionId?: string): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Interactive TUI requires a TTY");

  let session = await initialTuiSession(app, initialSessionId);
  const terminal = new AlternateScreenTerminal();
  const tui = new TUI(terminal, false);
  const toolCards = new Map<string, ToolCard>();
  const streaming = new Set<StreamingAssistant>();
  const streamingReasoning = new Set<StreamingReasoning>();
  const seenInbox = new Set<string>();
  const suppressedInbox = new Map<string, string>();
  const pendingTasks = new Set<Promise<void>>();
  let activeModal: ActiveModal | null = null;
  let activeController: AbortController | null = null;
  let engineStatus = "Ready";
  let activeOperation = false;
  let submissionBusy = false;
  let stopping = false;
  let pollErrorShown = false;
  let pollTimer: NodeJS.Timeout | null = null;
  let activityTimer: NodeJS.Timeout | null = null;
  let activityFrame = 0;
  let selectionDragging = false;
  let contextInputTokens = 0;
  let contextWindow = 0;
  let unavailableModelKey: string | null = null;
  let nextModelAvailabilityCheckAt = 0;
  let resolveStopped: (() => void) | null = null;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const activityText = (): string => activityLine(activeOperation, engineStatus, activityFrame, root.scrollOffset);
  const metadataText = (width: number): string => sessionMetadataLine(
    session,
    session.approvalMode,
    contextUsageLabel(contextInputTokens, contextWindow),
    width,
  );
  const editor = new TurnEditor(tui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 7 });
  const root = new FullHeightRoot(terminal, editor, activityText, metadataText);
  tui.addChild(root);
  tui.setFocus(editor);
  tui.setClearOnShrink(true);

  const requestRender = (): void => {
    if (!stopping) tui.requestRender();
  };
  const requestTranscriptRender = (): void => {
    root.invalidateTranscript();
    requestRender();
  };

  const refreshContextWindow = async (): Promise<void> => {
    const sessionId = session.id;
    const provider = session.provider;
    const modelId = session.model;
    try {
      const model = await app.catalogModel(modelId, provider);
      if (session.id === sessionId && session.provider === provider && session.model === modelId) {
        contextWindow = model.contextWindow;
        if (unavailableModelKey === `${provider}:${modelId}`) {
          addNotice("model available", `${provider}:${modelId} is available again.`, green);
        }
        unavailableModelKey = null;
        nextModelAvailabilityCheckAt = 0;
        requestRender();
      }
    } catch (error) {
      if (session.id === sessionId && session.provider === provider && session.model === modelId) {
        contextWindow = 0;
        const key = `${provider}:${modelId}`;
        if (unavailableModelKey !== key) {
          addNotice(
            "model unavailable",
            `${key} could not be reached: ${errorMessage(error)}. Input and session commands remain available; use /model to switch models.`,
            yellow,
          );
          unavailableModelKey = key;
        }
        nextModelAvailabilityCheckAt = Date.now() + MODEL_AVAILABILITY_RETRY_MS;
        requestRender();
      }
    }
  };

  const refreshContextUsage = (): void => {
    const latestUsage = app.sessions.latestResponseUsage(session.id);
    const checkpoint = app.sessions.latestCheckpoint(session.id);
    if (latestUsage && (!checkpoint || latestUsage.sequence > checkpoint.throughSequence)) {
      contextInputTokens = latestUsage.inputTokens;
      return;
    }
    contextInputTokens = Math.ceil(JSON.stringify(projectContext(app.sessions, session.id).input).length / 4);
  };

  const add = (component: Component): void => {
    root.addEntry(component);
    requestRender();
  };

  const addNotice = (label: string, text: string, color?: Style): void => {
    add(new Notice(label, text, color));
  };

  const schedulerInboxLine = (item: InboxRecord): string => {
    const job = app.scheduler.getJob(item.jobId);
    const sessionTitle = job?.sessionId ? app.sessions.get(job.sessionId)?.title : undefined;
    return inboxLine(item, job, sessionTitle);
  };

  const refreshSession = (): void => {
    session = app.sessions.get(session.id) ?? session;
  };

  const restoreEditor = (): void => {
    if (stopping) return;
    tui.setFocus(editor);
    requestRender();
  };

  const settleModal = <T>(
    handle: OverlayHandle,
    modalToken: ActiveModal,
    resolve: (value: T) => void,
    value: T,
  ): void => {
    if (activeModal !== modalToken) return;
    activeModal = null;
    handle.hide();
    restoreEditor();
    resolve(value);
  };

  const selectValue = (
    title: string,
    items: SelectItem[],
    prompt?: string,
    options: { deletable?: boolean } = {},
  ): Promise<string | null> => {
    if (stopping || items.length === 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const modal = new SelectorModal(
        title,
        items,
        Math.max(3, Math.min(10, Math.floor(terminal.rows * 0.8) - 6)),
        prompt,
      );
      const handle = tui.showOverlay(modal, { width: "80%", maxHeight: "80%", margin: 1 });
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        settleModal(handle, token, resolve, value);
      };
      const token: ActiveModal = { cancel: () => finish(null) };
      activeModal = token;
      modal.onSelect = (value) => finish(value);
      if (options.deletable) modal.onDelete = (value) => finish(`${DELETE_SELECTION_PREFIX}${value}`);
      modal.onCancel = () => finish(null);
    });
  };

  const interaction: EngineInteraction = {
    approve(request: ApprovalRequest): Promise<ApprovalDecision> {
      if (stopping) return Promise.resolve("deny");
      return new Promise((resolve) => {
        let settled = false;
        const modal = new ApprovalModal(terminal, request);
        const handle = tui.showOverlay(modal, { width: "85%", maxHeight: "80%", margin: 1 });
        const finish = (decision: ApprovalDecision): void => {
          if (settled) return;
          settled = true;
          settleModal(handle, token, resolve, decision);
        };
        const token: ActiveModal = {
          cancel: () => finish("deny"),
          mouse: (event) => modal.handleMouse(event),
        };
        activeModal = token;
        modal.onDone = finish;
      });
    },
    ask(request: QuestionRequest): Promise<string> {
      if (stopping) return Promise.resolve("");
      if (request.options && request.options.length > 0) {
        return selectValue(
          "Question",
          request.options.map((option) => ({ value: option, label: displaySafe(option) })),
          request.question,
        ).then((answer) => answer ?? "");
      }
      return new Promise((resolve) => {
        let settled = false;
        const modal = new QuestionInputModal(terminal, request.question);
        const handle = tui.showOverlay(modal, { width: "80%", maxHeight: "80%", margin: 1 });
        const finish = (answer: string): void => {
          if (settled) return;
          settled = true;
          settleModal(handle, token, resolve, answer);
        };
        const token: ActiveModal = { cancel: () => finish("") };
        activeModal = token;
        modal.onDone = finish;
      });
    },
  };

  const loadSessionEvents = (): void => {
    root.clearTranscript();
    toolCards.clear();
    for (const event of app.sessions.events(session.id)) {
      if (event.kind === "user") {
        const text = userText(event);
        if (text) root.addEntry(new UserMessage(text));
        continue;
      }
      if (event.kind === "response") {
        const summary = reasoningSummary(event);
        if (session.showReasoning && summary) root.addEntry(new ReasoningSummary(summary));
        const text = assistantText(event);
        if (text) root.addEntry(new AssistantMessage(text));
        continue;
      }
      if (event.kind === "tool_started" && isRecord(event.payload)) {
        const callId = typeof event.payload.callId === "string" ? event.payload.callId : `event-${event.sequence}`;
        const name = typeof event.payload.name === "string" ? event.payload.name : "tool";
        const summary = "arguments" in event.payload ? jsonPreview(event.payload.arguments) : name;
        const card = new ToolCard(callId, name, summary);
        toolCards.set(callId, card);
        root.addEntry(card);
        continue;
      }
      if ((event.kind === "tool_result" || event.kind === "tool_denied") && isRecord(event.payload)) {
        const callId = typeof event.payload.callId === "string" ? event.payload.callId : `event-${event.sequence}`;
        const name = typeof event.payload.name === "string" ? event.payload.name : "tool";
        const output = typeof event.payload.output === "string" ? event.payload.output : "No recorded output";
        let card = toolCards.get(callId);
        if (!card) {
          card = new ToolCard(callId, name, name);
          toolCards.set(callId, card);
          root.addEntry(card);
        }
        card.finish(output, event.kind === "tool_denied" || /^Tool (?:argument )?error:/i.test(output));
        continue;
      }
      if (event.kind === "error" && isRecord(event.payload) && typeof event.payload.message === "string") {
        root.addEntry(new Notice("error", event.payload.message, red));
      }
    }
    refreshContextUsage();
    requestRender();
  };

  const callbacks = (): EngineCallbacks => {
    let currentAssistant: StreamingAssistant | null = null;
    let currentReasoning: StreamingReasoning | null = null;
    return {
      onResponseStart(round) {
        currentAssistant?.flush();
        currentReasoning?.flush();
        currentReasoning = new StreamingReasoning(requestTranscriptRender);
        streamingReasoning.add(currentReasoning);
        if (session.showReasoning) add(currentReasoning);
        currentAssistant = new StreamingAssistant(requestTranscriptRender);
        streaming.add(currentAssistant);
        add(currentAssistant);
        if (round > 0) engineStatus = `Response round ${round + 1}`;
      },
      onTextDelta(delta) {
        if (!currentAssistant) {
          currentAssistant = new StreamingAssistant(requestTranscriptRender);
          streaming.add(currentAssistant);
          add(currentAssistant);
        }
        currentAssistant.append(delta);
      },
      onReasoningDelta(delta) {
        engineStatus = "Reasoning";
        currentReasoning?.append(delta);
      },
      onStatus(status) {
        engineStatus = displaySafe(status);
        requestRender();
      },
      onWarning(message) {
        addNotice("warning", message, yellow);
      },
      onToolStart(notice) {
        currentAssistant?.flush();
        const card = new ToolCard(notice.callId, notice.name, notice.summary);
        toolCards.set(notice.callId, card);
        add(card);
      },
      onToolProgress(notice) {
        const card = toolCards.get(notice.callId);
        if (card && notice.output) card.progress(notice.output);
        requestTranscriptRender();
      },
      onToolFinish(notice) {
        let card = toolCards.get(notice.callId);
        if (!card) {
          card = new ToolCard(notice.callId, notice.name, notice.summary);
          toolCards.set(notice.callId, card);
          add(card);
        }
        card.finish(notice.output ?? "No output", notice.failed ?? false);
        requestTranscriptRender();
      },
    };
  };

  const beginOperation = (status: string): AbortController => {
    activeOperation = true;
    activeController = new AbortController();
    engineStatus = status;
    editor.setEnabled(false);
    tui.setFocus(null);
    requestRender();
    return activeController;
  };

  const endOperation = (): void => {
    activeController = null;
    activeOperation = false;
    engineStatus = "Ready";
    editor.setEnabled(true);
    refreshSession();
    restoreEditor();
  };

  const runTurn = async (text: string): Promise<void> => {
    const controller = beginOperation("Thinking");
    try {
      const model = await app.catalogModel(session.model, session.provider, controller.signal);
      contextWindow = model.contextWindow;
      if (controller.signal.aborted || stopping) return;
      add(new UserMessage(text));
      const turn = app.engine.turn(session.id, text, {
        signal: controller.signal,
        interaction,
        callbacks: callbacks(),
        modelInfo: model,
      });
      refreshSession();
      requestRender();
      await turn;
      refreshContextUsage();
    } catch (error) {
      if (controller.signal.aborted) addNotice("cancelled", "Active operation cancelled.", yellow);
      else addNotice("error", errorMessage(error), red);
    } finally {
      for (const assistant of streaming) assistant.flush();
      for (const reasoning of streamingReasoning) reasoning.flush();
      streaming.clear();
      streamingReasoning.clear();
      refreshContextUsage();
      endOperation();
    }
  };

  const runCompact = async (): Promise<void> => {
    const controller = beginOperation("Compacting context");
    try {
      await app.engine.compactNow(session.id, { signal: controller.signal, callbacks: callbacks() });
      refreshContextUsage();
      if (!controller.signal.aborted) addNotice("compact", "Conversation context compacted.", green);
    } catch (error) {
      if (controller.signal.aborted) addNotice("cancelled", "Compaction cancelled.", yellow);
      else addNotice("error", errorMessage(error), red);
    } finally {
      endOperation();
    }
  };

  const switchSession = async (id: string): Promise<void> => {
    const previousSessionId = session.id;
    session = await app.currentOrNewSession(id);
    if (previousSessionId !== session.id) app.sessions.deleteIfEmpty(previousSessionId);
    for (const [identity, ownerSessionId] of suppressedInbox) {
      if (ownerSessionId === session.id) suppressedInbox.delete(identity);
    }
    contextWindow = 0;
    unavailableModelKey = null;
    nextModelAvailabilityCheckAt = 0;
    loadSessionEvents();
    trackTask(refreshContextWindow());
  };

  const setModel = (model: GatewayModel): void => {
    const effort = model.reasoningEfforts.includes(session.reasoningEffort)
      ? session.reasoningEffort
      : (model.reasoningEfforts.includes(model.defaultReasoningEffort)
        ? model.defaultReasoningEffort
        : model.reasoningEfforts[0]);
    if (!effort) throw new Error(`Model ${model.id} does not advertise a reasoning effort`);
    session = app.sessions.updateSettings(session.id, {
      provider: model.provider,
      model: model.id,
      reasoningEffort: effort,
      fast: session.fast && model.supportsFast,
    });
    contextWindow = model.contextWindow;
    unavailableModelKey = null;
    nextModelAvailabilityCheckAt = 0;
    refreshContextUsage();
    addNotice("model", `Using ${model.name} (${model.provider}:${model.id}); response anchor reset.`, cyan);
  };

  const setAgentModel = (model: GatewayModel): void => {
    const effort = model.reasoningEfforts.includes(session.agentReasoningEffort)
      ? session.agentReasoningEffort
      : (model.reasoningEfforts.includes(model.defaultReasoningEffort)
        ? model.defaultReasoningEffort
        : model.reasoningEfforts[0]);
    if (!effort) throw new Error(`Model ${model.id} does not advertise a reasoning effort`);
    session = app.sessions.updateSettings(session.id, {
      agentProvider: model.provider,
      agentModel: model.id,
      agentReasoningEffort: effort,
    });
    addNotice("agent model", `Agents will use ${model.name} (${model.provider}:${model.id}) with ${effort} reasoning.`, cyan);
  };

  const showInbox = (): void => {
    const inbox = app.scheduler.listInbox({ unackedOnly: true, limit: 10_000 });
    if (inbox.length === 0) {
      addNotice("inbox", "No unread scheduler items.", cyan);
      return;
    }
    if (inbox.some((item) => {
      const job = app.scheduler.getJob(item.jobId);
      return job?.kind === "session_prompt" && job.sessionId === session.id;
    })) loadSessionEvents();
    addNotice("inbox", `${inbox.length} scheduler item${inbox.length === 1 ? "" : "s"}:`, cyan);
    for (const item of inbox.slice().reverse()) {
      const identity = inboxIdentity(item);
      seenInbox.add(identity);
      suppressedInbox.delete(identity);
      addNotice("inbox", schedulerInboxLine(item), magenta);
    }
    const marked = markInboxItemsRead(inbox, (id) => app.scheduler.ackInbox(id));
    addNotice("inbox", `${marked} item${marked === 1 ? "" : "s"} marked read.`, green);
  };

  const setPersistence = (enabled: boolean): void => {
    session = app.sessions.updateSettings(session.id, { persistent: enabled });
    const jobs = app.scheduler.setSessionJobsEnabled(session.id, enabled);
    addNotice(
      "session",
      `Persistence ${enabled ? "enabled" : "disabled"}; ${jobs.length} session schedule${jobs.length === 1 ? "" : "s"} ${enabled ? "enabled where resumable" : "paused"}.`,
      enabled ? green : yellow,
    );
  };

  const createSessionSchedule = async (argument: string): Promise<void> => {
    if (!argument) {
      addNotice("schedule", [
        "Create a scheduled AI turn in this session:",
        "/schedule once 2026-07-20T12:00:00Z Check system inventory",
        '/schedule cron "0 9 * * *" Review service health and act on problems',
        "The session must be persistent. Scheduled AI turns inherit this session's permissions and cannot request interactive approval.",
      ].join("\n"), cyan);
      return;
    }
    const parsed = parseSessionSchedule(argument);
    initialDue(parsed.scheduleKind, parsed.schedule, app.config.scheduler.timezone, Date.now());
    if (!session.persistent) {
      const enable = await selectValue("Enable persistent session", [
        { value: "yes", label: "Enable persistence", description: "Allow scheduled model/tool turns" },
        { value: "no", label: "Cancel" },
      ], "Scheduled prompts require an explicitly persistent session.");
      if (enable !== "yes" || stopping) return;
      setPersistence(true);
    }
    const job = app.scheduler.createSessionPrompt({
      sessionId: session.id,
      prompt: parsed.prompt,
      scheduleKind: parsed.scheduleKind,
      schedule: parsed.schedule,
      timezone: app.config.scheduler.timezone,
      startGraceMs: app.config.scheduler.commandStartGraceMs,
      outputBytes: app.config.scheduler.commandOutputBytes,
    });
    addNotice("schedule", `Created ${schedulerJobLine(job)}`, green);
  };

  const showCronBrowser = async (sessionOnly = false): Promise<void> => {
    const jobs = sessionOnly
      ? app.scheduler.listJobsForSession(session.id)
      : app.scheduler.listJobs().filter((job) => {
          if (job.kind === "reminder") return true;
          if (job.kind === "session_prompt") return job.sessionId === session.id;
          return job.cwd !== null && isWithin(app.workspace, job.cwd);
        });
    if (jobs.length === 0) {
      addNotice("cron", sessionOnly
        ? "This session has no schedules. Use /schedule to create one."
        : "No scheduled jobs. Use /schedule for session prompts or ask Looking Glass to create a reminder/command.", cyan);
      return;
    }
    const selectedId = await selectValue(sessionOnly ? "Session schedules" : "Schedules", jobs.map((job) => ({
      value: job.id,
      label: `${job.enabled ? "[on]" : "[off]"} ${job.kind} ${oneLine(job.prompt ?? job.message ?? job.command ?? "", 48)}`,
      description: `${job.scheduleKind}:${job.schedule} | ${job.nextDue ? new Date(job.nextDue).toISOString() : "no next run"}`,
    })), "Select a schedule to manage it.");
    if (!selectedId || stopping) return;
    const job = app.scheduler.getJob(selectedId);
    if (!job) throw new Error(`Schedule not found: ${selectedId}`);
    const actions: SelectItem[] = [
      job.enabled
        ? { value: "pause", label: "Pause", description: "Disable future runs" }
        : { value: "resume", label: "Resume", description: "Enable future runs" },
      ...(job.enabled ? [{ value: "run", label: "Run now", description: "Queue one immediate occurrence" }] : []),
      ...(job.blockedReason?.includes("unknown outcome")
        ? [{ value: "resolve", label: "Resolve unknown", description: "Acknowledge uncertain prior outcome" }]
        : []),
      { value: "delete", label: "Delete", description: "Disable and hide this schedule" },
    ];
    const action = await selectValue("Schedule action", actions, schedulerJobLine(job));
    if (!action || stopping) return;
    if (action === "run" || action === "resume" || action === "resolve") {
      const title = action === "run" ? "Run schedule now" : action === "resume" ? "Resume schedule" : "Resolve unknown outcome";
      const label = action === "run" ? "Run exact action" : action === "resume" ? "Resume exact schedule" : "Resolve and resume";
      const confirmed = await selectValue(title, [
        { value: "yes", label },
        { value: "no", label: "Cancel" },
      ], schedulerJobDetails(job));
      if (confirmed !== "yes") return;
    }
    let updated: SchedulerJob | null = null;
    if (action === "pause") updated = app.scheduler.pauseJob(job.id);
    else if (action === "resume") updated = app.scheduler.resumeJob(job.id);
    else if (action === "resolve") updated = app.scheduler.acknowledgeUnknown(job.id);
    else if (action === "run") {
      const run = app.scheduler.runNow(job.id);
      addNotice("cron", `Queued occurrence ${run.id} (${run.state}).`, green);
      return;
    } else if (action === "delete") {
      const confirmed = await selectValue("Delete schedule", [
        { value: "yes", label: "Delete schedule" },
        { value: "no", label: "Cancel" },
      ], schedulerJobDetails(job));
      if (confirmed !== "yes") return;
      updated = app.scheduler.deleteJob(job.id);
    }
    if (updated) addNotice("cron", schedulerJobLine(updated), action === "delete" ? yellow : green);
  };

  const showCommandApprovals = async (): Promise<void> => {
    while (!stopping) {
      const approvals = app.sessions.listCommandApprovals(session.id);
      if (approvals.length === 0) {
        addNotice("approvals", "No actions are always approved for this session.", cyan);
        return;
      }
      const selected = await selectValue("Always-approved actions", approvals.map((approval) => {
        let command = approval.signature;
        let detail = new Date(approval.approvedAt).toISOString();
        try {
          const parsed = JSON.parse(approval.signature) as unknown;
          if (Array.isArray(parsed) && parsed[0] === "bash-exec" && typeof parsed[2] === "string") {
            command = parsed[2];
            detail = `${String(parsed[3])} | ${String(parsed[4])}ms | ${detail}`;
          } else if (Array.isArray(parsed) && parsed[0] === "tool-action" && typeof parsed[2] === "string") {
            const args = parsed[3] as Record<string, unknown> | undefined;
            command = parsed[2] === "bash" && typeof args?.command === "string"
              ? args.command
              : `${parsed[2]}: ${JSON.stringify(args ?? {})}`;
          }
        } catch {
          // Retain the raw signature for forward-compatible records.
        }
        return {
          value: approval.signature,
          label: oneLine(command, 240),
          description: detail,
        };
      }), "Delete/Supr revokes the highlighted action approval.", { deletable: true });
      if (!selected || stopping) return;
      if (!selected.startsWith(DELETE_SELECTION_PREFIX)) return;
      const signature = selected.slice(DELETE_SELECTION_PREFIX.length);
      if (app.sessions.revokeCommandApproval(session.id, signature)) {
        addNotice("approvals", "Always approval revoked for the selected action.", yellow);
      }
    }
  };

  const showSessionMenu = async (): Promise<void> => {
    const jobs = app.scheduler.listJobsForSession(session.id);
    const approvals = app.sessions.listCommandApprovals(session.id);
    const action = await selectValue("Session", [
      {
        value: "persist",
        label: session.persistent ? "Disable persistence" : "Enable persistence",
        description: `${jobs.length} schedule${jobs.length === 1 ? "" : "s"}`,
      },
      { value: "rename", label: "Rename session", description: session.title },
      { value: "schedules", label: "Manage schedules", description: `${jobs.length} attached` },
      { value: "approvals", label: "Manage always approvals", description: `${approvals.length} registered` },
      {
        value: "thinking",
        label: session.showReasoning ? "Hide reasoning summaries" : "Show reasoning summaries",
      },
    ], `${session.id}\n${session.model}`);
    if (!action || stopping) return;
    if (action === "persist") setPersistence(!session.persistent);
    else if (action === "schedules") await showCronBrowser(true);
    else if (action === "approvals") await showCommandApprovals();
    else if (action === "thinking") {
      session = app.sessions.updateSettings(session.id, { showReasoning: !session.showReasoning });
      loadSessionEvents();
    } else if (action === "rename") {
      const title = await interaction.ask({ question: "New session title" });
      if (title.trim()) {
        session = app.sessions.rename(session.id, title);
        addNotice("session", `Renamed to ${session.title}.`, green);
      }
    }
  };

  const showSessionBrowser = async (): Promise<void> => {
    while (!stopping) {
      const sessions = app.sessions.listWithMessages(app.workspace, 100)
        .filter((item) => app.hasProvider(item.provider));
      const selected = await selectValue("Sessions", sessions.map((item) => ({
        value: item.id,
        label: `${item.persistent ? "[persistent] " : ""}${item.title}`,
        description: `${app.scheduler.listJobsForSession(item.id).length} schedules | ${item.model} | ${new Date(item.updatedAt).toISOString()} | ${item.id.slice(0, 8)}`,
      })), "Enter switches session. Delete/Supr removes the highlighted session.", { deletable: true });
      if (!selected || stopping) return;
      if (!selected.startsWith(DELETE_SELECTION_PREFIX)) {
        await switchSession(selected);
        return;
      }

      const id = selected.slice(DELETE_SELECTION_PREFIX.length);
      const target = app.sessions.get(id);
      if (!target) {
        addNotice("session", "The selected session no longer exists.", yellow);
        continue;
      }
      const summary = app.sessions.deletionSummary(id);
      const attached = [
        `${summary.events} transcript event${summary.events === 1 ? "" : "s"}`,
        `${summary.toolCalls} tool call${summary.toolCalls === 1 ? "" : "s"}`,
        `${summary.checkpoints} checkpoint${summary.checkpoints === 1 ? "" : "s"}`,
        `${summary.schedules} schedule${summary.schedules === 1 ? "" : "s"}`,
        `${summary.occurrences} scheduled occurrence${summary.occurrences === 1 ? "" : "s"}`,
        `${summary.inboxItems} inbox item${summary.inboxItems === 1 ? "" : "s"}`,
        `${summary.commandApprovals} always approval${summary.commandApprovals === 1 ? "" : "s"}`,
      ].join(" | ");
      const confirmed = await selectValue("Delete session", [
        { value: "yes", label: "Delete permanently", description: "This cannot be undone" },
        { value: "no", label: "Cancel" },
      ], [
        target.title,
        target.id,
        attached,
        `${summary.retainedArtifacts} artifact file${summary.retainedArtifacts === 1 ? "" : "s"} will be retained without the session link.`,
      ].join("\n"));
      if (confirmed !== "yes" || stopping) continue;

      const deletingCurrent = target.id === session.id;
      let deleted = summary;
      try {
        deleted = app.sessions.delete(target.id, summary);
      } catch (error) {
        if (errorMessage(error).includes("changed after deletion was confirmed")) {
          addNotice("session", errorMessage(error), yellow);
          continue;
        }
        throw error;
      }
      if (deletingCurrent) {
        const replacement = app.sessions.create({
          workspace: target.workspace,
          provider: target.provider,
          model: target.model,
          reasoningEffort: target.reasoningEffort,
          agentProvider: target.agentProvider,
          agentModel: target.agentModel,
          agentReasoningEffort: target.agentReasoningEffort,
          verbosity: target.verbosity,
          fast: target.fast,
          approvalMode: target.approvalMode,
        });
        await switchSession(replacement.id);
      }
      addNotice(
        "session",
        `Deleted ${target.title}: ${deleted.events} events, ${deleted.schedules} schedules, and ${deleted.commandApprovals} always approvals removed; ${deleted.retainedArtifacts} artifacts retained.`,
        yellow,
      );
      if (deletingCurrent) return;
    }
  };

  const handleCommand = async (input: string, signal: AbortSignal): Promise<void> => {
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(input.trim());
    if (!match) throw new Error("Invalid slash command");
    const command = match[1]?.toLowerCase() ?? "";
    const argument = match[2]?.trim() ?? "";

    if (command === "exit") {
      requestStop();
      return;
    }
    if (command === "new") {
      const created = await app.createSession(signal);
      if (!stopping) await switchSession(created.id);
      return;
    }
    if (command === "sessions") {
      if (argument) {
        await switchSession(argument);
        return;
      }
      await showSessionBrowser();
      return;
    }
    if (command === "session") {
      await showSessionMenu();
      return;
    }
    if (command === "persist") {
      let enabled: boolean;
      if (!argument) enabled = !session.persistent;
      else if (["on", "true", "1"].includes(argument.toLowerCase())) enabled = true;
      else if (["off", "false", "0"].includes(argument.toLowerCase())) enabled = false;
      else throw new Error("/persist accepts on or off");
      setPersistence(enabled);
      return;
    }
    if (command === "model") {
      const models = await app.models(false, signal);
      if (stopping) return;
      let id = argument;
      if (!id) {
        id = await selectValue("Models", models.map((model) => ({
          value: `${model.provider}:${model.id}`,
          label: `[${model.provider}] ${model.name}`,
          description: `${model.id} | context ${model.contextWindow.toLocaleString()}${model.supportsFast ? " | fast" : ""}`,
        }))) ?? "";
      }
      if (!id || stopping) return;
      const model = models.find((candidate) => `${candidate.provider}:${candidate.id}` === id)
        ?? models.find((candidate) => candidate.provider === session.provider && candidate.id === id);
      if (!model) throw new Error(`Model is not available: ${id}`);
      setModel(model);
      return;
    }
    if (command === "agents") {
      let enabled: boolean;
      if (!argument) enabled = !session.agentsEnabled;
      else if (["on", "true", "1"].includes(argument.toLowerCase())) enabled = true;
      else if (["off", "false", "0"].includes(argument.toLowerCase())) enabled = false;
      else throw new Error("/agents accepts on or off");
      session = app.sessions.updateSettings(session.id, { agentsEnabled: enabled });
      addNotice("agents", `Agents ${enabled ? "enabled" : "disabled"} for this session.`, cyan);
      return;
    }
    if (command === "agentmodel") {
      const models = await app.models(false, signal);
      if (stopping) return;
      let id = argument;
      if (!id) {
        id = await selectValue("Agent models", models.map((model) => ({
          value: `${model.provider}:${model.id}`,
          label: `[${model.provider}] ${model.name}`,
          description: `${model.id} | context ${model.contextWindow.toLocaleString()}`,
        }))) ?? "";
      }
      if (!id || stopping) return;
      const model = models.find((candidate) => `${candidate.provider}:${candidate.id}` === id)
        ?? models.find((candidate) => candidate.provider === session.agentProvider && candidate.id === id);
      if (!model) throw new Error(`Agent model is not available: ${id}`);
      setAgentModel(model);
      return;
    }
    if (command === "reasoning") {
      const model = await app.catalogModel(session.model, session.provider, signal);
      if (stopping) return;
      let effort = argument;
      if (!effort) {
        effort = await selectValue("Reasoning effort", model.reasoningEfforts.map((value) => ({
          value,
          label: value,
          description: value === session.reasoningEffort ? "current" : "",
        }))) ?? "";
      }
      const supported = model.reasoningEfforts.find((value) => value === effort);
      if (!supported) throw new Error(`${model.id} does not support reasoning effort '${effort}'`);
      session = app.sessions.updateSettings(session.id, { reasoningEffort: supported });
      addNotice("reasoning", `Reasoning effort set to ${supported}.`, cyan);
      return;
    }
    if (command === "agentreasoning") {
      const model = await app.catalogModel(session.agentModel, session.agentProvider, signal);
      if (stopping) return;
      let effort = argument;
      if (!effort) {
        effort = await selectValue("Agent reasoning effort", model.reasoningEfforts.map((value) => ({
          value,
          label: value,
          description: value === session.agentReasoningEffort ? "current" : "",
        }))) ?? "";
      }
      if (!effort || stopping) return;
      const supported = model.reasoningEfforts.find((value) => value === effort);
      if (!supported) throw new Error(`${model.id} does not support agent reasoning effort '${effort}'`);
      session = app.sessions.updateSettings(session.id, { agentReasoningEffort: supported });
      addNotice("agent reasoning", `Agent reasoning effort set to ${supported}.`, cyan);
      return;
    }
    if (command === "thinking" || command === "show-reasoning") {
      let enabled: boolean;
      if (!argument) enabled = !session.showReasoning;
      else if (["on", "true", "1"].includes(argument.toLowerCase())) enabled = true;
      else if (["off", "false", "0"].includes(argument.toLowerCase())) enabled = false;
      else throw new Error(`/${command} accepts on or off`);
      session = app.sessions.updateSettings(session.id, { showReasoning: enabled });
      loadSessionEvents();
      addNotice("reasoning", `Reasoning summaries ${enabled ? "shown" : "hidden"}.`, cyan);
      return;
    }
    if (command === "fast") {
      const model = await app.catalogModel(session.model, session.provider, signal);
      if (stopping) return;
      let enabled: boolean;
      if (!argument) enabled = !session.fast;
      else if (["on", "true", "1"].includes(argument.toLowerCase())) enabled = true;
      else if (["off", "false", "0"].includes(argument.toLowerCase())) enabled = false;
      else throw new Error("/fast accepts on or off");
      if (enabled && !model.supportsFast) throw new Error(`${model.id} does not support fast service`);
      session = app.sessions.updateSettings(session.id, { fast: enabled });
      addNotice("fast", `Fast service ${enabled ? "enabled" : "disabled"}.`, cyan);
      return;
    }
    if (command === "compact") {
      await runCompact();
      return;
    }
    if (command === "permissions") {
      const modes: ApprovalMode[] = ["review", "code", "unrestricted"];
      let mode: ApprovalMode;
      if (argument) {
        const selected = modes.find((candidate) => candidate === argument.toLowerCase());
        if (!selected) throw new Error("/permissions accepts review, code, or unrestricted");
        mode = selected;
      } else {
        const current = modes.indexOf(session.approvalMode);
        mode = modes[(current + 1) % modes.length] ?? "review";
      }
      session = app.sessions.updateSettings(session.id, { approvalMode: mode });
      addNotice("permissions", mode === "unrestricted"
        ? "Approval mode set to unrestricted for this session. Tool confirmations are disabled."
        : `Approval mode set to ${mode} for this session. Critical actions require approval or a remembered matching scope.`, yellow);
      return;
    }
    if (command === "cron") {
      await showCronBrowser(argument.toLowerCase() === "session");
      return;
    }
    if (command === "schedule") {
      await createSessionSchedule(argument);
      return;
    }
    if (command === "inbox") {
      showInbox();
      return;
    }
    throw new Error(`Unknown command: /${command}`);
  };

  const handleSubmission = async (text: string): Promise<void> => {
    if (!text || submissionBusy || activeOperation || stopping) return;
    submissionBusy = true;
    editor.setEnabled(false);
    editor.addToHistory(text);
    requestRender();
    try {
      if (text.startsWith("/")) {
        const controller = new AbortController();
        activeController = controller;
        try {
          await handleCommand(text, controller.signal);
        } finally {
          if (activeController === controller) activeController = null;
        }
      } else await runTurn(text);
    } catch (error) {
      if (!stopping) addNotice("error", errorMessage(error), red);
    } finally {
      submissionBusy = false;
      if (!activeOperation && !stopping) {
        editor.setEnabled(true);
        restoreEditor();
      }
    }
  };

  const slashCommands: SlashCommand[] = [
    { name: "new", description: "Start a new session" },
    { name: "session", description: "Manage current session" },
    {
      name: "persist",
      description: "Enable or disable persistent scheduled turns",
      argumentHint: "[on|off]",
      getArgumentCompletions: (prefix) => ["on", "off"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    },
    {
      name: "sessions",
      description: "Switch session",
      argumentHint: "[id]",
      getArgumentCompletions: (prefix) => app.sessions.listWithMessages(app.workspace, 100)
        .filter((item) => app.hasProvider(item.provider))
        .filter((item) => item.id.startsWith(prefix))
        .map((item) => ({ value: item.id, label: item.title, description: item.id })),
    },
    {
      name: "model",
      description: "Select model",
      argumentHint: "[id]",
      getArgumentCompletions: async (prefix) => (await app.models())
        .filter((model) => `${model.provider}:${model.id}`.toLowerCase().includes(prefix.toLowerCase()))
        .map((model) => ({
          value: `${model.provider}:${model.id}`,
          label: `[${model.provider}] ${model.name}`,
          description: model.id,
        })),
    },
    {
      name: "agents",
      description: "Enable or disable agent delegation",
      argumentHint: "[on|off]",
      getArgumentCompletions: (prefix) => ["on", "off"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    },
    {
      name: "agentmodel",
      description: "Select the model used by spawned agents",
      argumentHint: "[id]",
      getArgumentCompletions: async (prefix) => (await app.models())
        .filter((model) => `${model.provider}:${model.id}`.toLowerCase().includes(prefix.toLowerCase()))
        .map((model) => ({
          value: `${model.provider}:${model.id}`,
          label: `[${model.provider}] ${model.name}`,
          description: model.id,
        })),
    },
    {
      name: "reasoning",
      description: "Select a supported reasoning effort",
      argumentHint: "[effort]",
      getArgumentCompletions: async (prefix) => (await app.catalogModel(session.model, session.provider)).reasoningEfforts
        .filter((effort) => effort.startsWith(prefix))
        .map((effort) => ({ value: effort, label: effort })),
    },
    {
      name: "agentreasoning",
      description: "Select reasoning effort for spawned agents",
      argumentHint: "[effort]",
      getArgumentCompletions: async (prefix) => (await app.catalogModel(
        session.agentModel,
        session.agentProvider,
      )).reasoningEfforts
        .filter((effort) => effort.startsWith(prefix))
        .map((effort) => ({ value: effort, label: effort })),
    },
    {
      name: "thinking",
      description: "Show or hide reasoning summaries",
      argumentHint: "[on|off]",
      getArgumentCompletions: (prefix) => ["on", "off"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    },
    {
      name: "fast",
      description: "Toggle fast service",
      argumentHint: "[on|off]",
      getArgumentCompletions: (prefix) => ["on", "off"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    },
    { name: "compact", description: "Compact conversation context" },
    {
      name: "permissions",
      description: "Set approval mode",
      argumentHint: "[review|code|unrestricted]",
      getArgumentCompletions: (prefix) => ["review", "code", "unrestricted"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    },
    { name: "schedule", description: "Create a scheduled prompt in this session", argumentHint: "[once|cron] ..." },
    { name: "cron", description: "Browse and manage schedules", argumentHint: "[session]" },
    { name: "inbox", description: "Read all unread scheduler items" },
    { name: "exit", description: "Exit Looking Glass" },
  ];
  editor.setAutocompleteProvider(new SafeAutocompleteProvider(slashCommands, app.workspace));
  const trackTask = (task: Promise<void>): void => {
    pendingTasks.add(task);
    void task.then(
      () => pendingTasks.delete(task),
      () => pendingTasks.delete(task),
    );
  };
  editor.onSubmit = (text) => trackTask(handleSubmission(text));

  const cancelActiveInteraction = (): void => {
    activeController?.abort();
    activeModal?.cancel();
    activeModal = null;
  };

  function requestStop(): void {
    if (stopping) return;
    stopping = true;
    cancelActiveInteraction();
    if (pollTimer) clearInterval(pollTimer);
    if (activityTimer) clearInterval(activityTimer);
    pollTimer = null;
    activityTimer = null;
    resolveStopped?.();
  }

  const onSignal = (): void => requestStop();

  const pollInbox = (): void => {
    if (stopping) return;
    try {
      if (unavailableModelKey && Date.now() >= nextModelAvailabilityCheckAt && !activeOperation) {
        nextModelAvailabilityCheckAt = Date.now() + MODEL_AVAILABILITY_RETRY_MS;
        trackTask(refreshContextWindow());
      }
      const latestSession = app.sessions.get(session.id);
      if (latestSession && latestSession.updatedAt > session.updatedAt && !activeOperation) {
        const modelChanged = latestSession.provider !== session.provider || latestSession.model !== session.model;
        session = latestSession;
        if (modelChanged) {
          contextWindow = 0;
          trackTask(refreshContextWindow());
        }
        loadSessionEvents();
      }
      const unread = app.scheduler.listInbox({ unackedOnly: true, limit: 200 });
      const unseen = unread.filter((item) => {
        const identity = inboxIdentity(item);
        return !seenInbox.has(identity) && !suppressedInbox.has(identity);
      }).reverse();
      const refreshCurrent = unseen.some((item) => {
        const job = app.scheduler.getJob(item.jobId);
        return job?.kind === "session_prompt" && job.sessionId === session.id;
      });
      if (refreshCurrent && !activeOperation) loadSessionEvents();
      for (const item of unseen) {
        const job = app.scheduler.getJob(item.jobId);
        if (!shouldAutoDisplayInbox(job, session.id)) {
          if (job?.kind === "session_prompt" && job.sessionId) {
            suppressedInbox.set(inboxIdentity(item), job.sessionId);
          }
          continue;
        }
        if (job?.kind === "session_prompt" && job.sessionId === session.id) {
          if (activeOperation) continue;
        }
        seenInbox.add(inboxIdentity(item));
        addNotice("scheduler", schedulerInboxLine(item), magenta);
      }
      pollErrorShown = false;
    } catch (error) {
      if (!pollErrorShown) addNotice("scheduler error", errorMessage(error), red);
      pollErrorShown = true;
    }
  };

  tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c"))) {
      root.clearSelection();
      selectionDragging = false;
      if (activeOperation) {
        activeController?.abort();
        activeModal?.cancel();
      } else {
        requestStop();
      }
      return { consume: true };
    }
    if (terminal.columns < MIN_COLUMNS || terminal.rows < MIN_ROWS) return { consume: true };
    const mouse = parseTerminalMouse(data);
    if (mouse) {
      if (activeModal) {
        root.clearSelection();
        selectionDragging = false;
        activeModal.mouse?.(mouse);
        requestRender();
        return { consume: true };
      }
      if (mouse.action === "wheel_up" || mouse.action === "wheel_down") {
        root.clearSelection();
        selectionDragging = false;
        root.scrollLines(mouse.action === "wheel_up" ? 3 : -3);
        requestRender();
        return { consume: true };
      }
      if (mouse.action === "press" && mouse.button === 0) {
        root.startSelection(mouse);
        selectionDragging = false;
        requestRender();
        return { consume: true };
      }
      if (mouse.action === "drag" && mouse.button === 0) {
        selectionDragging = root.updateSelection(mouse);
        requestRender();
        return { consume: true };
      }
      if (mouse.action === "release") {
        root.updateSelection(mouse);
        if (selectionDragging) terminal.copy(root.selectionText());
        root.clearSelection();
        selectionDragging = false;
        requestRender();
        return { consume: true };
      }
      return { consume: true };
    }
    if (activeModal) return undefined;
    if (matchesKey(data, Key.ctrl("pageUp")) || matchesKey(data, Key.pageUp)) {
      root.scrollPage(-1);
      requestRender();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("pageDown")) || matchesKey(data, Key.pageDown)) {
      root.scrollPage(1);
      requestRender();
      return { consume: true };
    }
    return undefined;
  });

  loadSessionEvents();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let started = false;
  try {
    started = true;
    tui.start();
    trackTask(refreshContextWindow());
    pollInbox();
    pollTimer = setInterval(pollInbox, INBOX_POLL_MS);
    activityTimer = setInterval(() => {
      if (!activeOperation || stopping) return;
      activityFrame += 1;
      requestRender();
    }, ACTIVITY_RENDER_MS);
    await stopped;
  } finally {
    stopping = true;
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    if (pollTimer) clearInterval(pollTimer);
    if (activityTimer) clearInterval(activityTimer);
    cancelActiveInteraction();
    for (const assistant of streaming) assistant.dispose();
    for (const reasoning of streamingReasoning) reasoning.dispose();
    if (started) {
      try {
        await terminal.drainInput();
      } finally {
        if (terminal.isActive) tui.stop();
        else terminal.stop();
      }
    }
    await Promise.allSettled([...pendingTasks]);
    app.sessions.deleteIfEmpty(session.id);
  }
}

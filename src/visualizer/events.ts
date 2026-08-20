export type VisualizerEventType =
  | "turn.start"
  | "turn.end"
  | "model.request"
  | "model.reasoning.start"
  | "model.reasoning.summary"
  | "model.reasoning.end"
  | "model.response"
  | "agent.spawn"
  | "agent.start"
  | "agent.result"
  | "agent.end"
  | "tool.request"
  | "tool.start"
  | "tool.output"
  | "tool.end"
  | "tool.error"
  | "context.update"
  | "context.compact"
  | "retry"
  | "error";

export type VisualizerStatus = "waiting" | "active" | "complete" | "failed" | "cancelled";

export type VisualizerCodeLineKind = "add" | "remove";

export interface VisualizerCodeLine {
  readonly kind: VisualizerCodeLineKind;
  readonly text: string;
}

export interface VisualizerCodeChange {
  readonly path: string;
  readonly operation: "add" | "update" | "delete";
  readonly moveTo?: string;
  readonly lines: readonly VisualizerCodeLine[];
  readonly truncated?: boolean;
}

/**
 * Ephemeral runtime telemetry. It is intentionally independent of durable
 * session state so an observer can never affect replay or execution.
 */
export interface VisualizerEvent {
  readonly type: VisualizerEventType;
  readonly timestamp: number;
  readonly sequence: number;
  readonly eventId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly parentId?: string;
  readonly entityId?: string;
  readonly agentId?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly reasoningEffort?: string;
  readonly tool?: string;
  readonly duration?: number;
  readonly status?: VisualizerStatus;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly contextTokens?: number;
  readonly contextWindow?: number;
  readonly summary?: string;
  readonly files?: readonly string[];
  readonly codeChanges?: readonly VisualizerCodeChange[];
}

export type VisualizerEventInput = Omit<VisualizerEvent, "timestamp" | "sequence" | "eventId"> & {
  timestamp?: number;
  eventId?: string;
};

export type VisualizerEventListener = (event: VisualizerEvent) => void;

/** Synchronous, ordered, and failure-isolated to keep telemetry off the critical path. */
export class VisualizerEventBus {
  private readonly listeners = new Set<VisualizerEventListener>();
  private sequence = 0;
  private idSequence = 0;

  nextId(prefix = "node"): string {
    this.idSequence += 1;
    return `${prefix}-${this.idSequence}`;
  }

  emit(input: VisualizerEventInput): VisualizerEvent {
    const sequence = ++this.sequence;
    const event: VisualizerEvent = Object.freeze({
      ...input,
      timestamp: input.timestamp ?? Date.now(),
      sequence,
      eventId: input.eventId ?? `event-${sequence}`,
      ...(input.files ? { files: Object.freeze([...input.files]) } : {}),
      ...(input.codeChanges ? {
        codeChanges: Object.freeze(input.codeChanges.map((change) => Object.freeze({
          ...change,
          lines: Object.freeze(change.lines.map((line) => Object.freeze({ ...line }))),
        }))),
      } : {}),
    });
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Visualization is observational. A broken subscriber must be inert.
      }
    }
    return event;
  }

  subscribe(listener: VisualizerEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function addPath(paths: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const path = value.trim();
  if (!path || path.includes("\n") || path.length > 512) return;
  paths.add(path.replaceAll("\\", "/"));
}

/** Extract only path-like arguments; never retain command bodies or file contents. */
export function toolFiles(tool: string, args: unknown): string[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const record = args as Record<string, unknown>;
  const paths = new Set<string>();
  for (const key of ["path", "file", "filename"]) addPath(paths, record[key]);
  if (Array.isArray(record.paths)) for (const path of record.paths) addPath(paths, path);
  if (tool === "grep" || tool === "glob") addPath(paths, record.path);
  if (tool === "apply_patch" && typeof record.patch === "string") {
    for (const match of record.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu)) addPath(paths, match[1]);
    for (const match of record.patch.matchAll(/^\*\*\* Move to: (.+)$/gmu)) addPath(paths, match[1]);
  }
  return [...paths].sort();
}

const MAX_CODE_CHANGES = 32;
const MAX_CODE_LINES = 240;
const MAX_CODE_LINE_CHARS = 240;

function codePath(value: string): string | undefined {
  const path = value.trim().replaceAll("\\", "/");
  if (!path || path.includes("\n") || path.length > 512) return undefined;
  return path;
}

function codeLineText(value: string): { text: string; truncated: boolean } {
  const safe = value.replace(/\t/g, "  ").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  if (safe.length <= MAX_CODE_LINE_CHARS) return { text: safe, truncated: false };
  return { text: `${safe.slice(0, MAX_CODE_LINE_CHARS - 1)}…`, truncated: true };
}

/** Extract a bounded, ordered +/- projection from an apply_patch argument. */
export function toolCodeChanges(tool: string, args: unknown): VisualizerCodeChange[] {
  if (tool !== "apply_patch" || !args || typeof args !== "object" || Array.isArray(args)) return [];
  const patch = (args as Record<string, unknown>).patch;
  if (typeof patch !== "string") return [];

  type MutableChange = {
    path: string;
    operation: VisualizerCodeChange["operation"];
    moveTo?: string;
    lines: VisualizerCodeLine[];
    truncated: boolean;
  };
  const changes: MutableChange[] = [];
  let current: MutableChange | undefined;
  let retainedLines = 0;

  for (const line of patch.split(/\r?\n/u)) {
    const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/u);
    if (header) {
      if (changes.length >= MAX_CODE_CHANGES) {
        changes.at(-1)!.truncated = true;
        current = undefined;
        continue;
      }
      const path = codePath(header[2] ?? "");
      if (!path) {
        current = undefined;
        continue;
      }
      const operation = (header[1] ?? "").toLowerCase() as VisualizerCodeChange["operation"];
      current = { path, operation, lines: [], truncated: false };
      changes.push(current);
      continue;
    }
    const move = line.match(/^\*\*\* Move to: (.+)$/u);
    if (move && current) {
      const moveTo = codePath(move[1] ?? "");
      if (moveTo) current.moveTo = moveTo;
      continue;
    }
    if (!current || (line[0] !== "+" && line[0] !== "-") || line.startsWith("*** ")) continue;
    if (retainedLines >= MAX_CODE_LINES) {
      current.truncated = true;
      continue;
    }
    const bounded = codeLineText(line.slice(1));
    current.lines.push({ kind: line[0] === "+" ? "add" : "remove", text: bounded.text });
    current.truncated ||= bounded.truncated;
    retainedLines += 1;
  }

  return changes.map(({ truncated, ...change }) => ({
    ...change,
    ...(truncated ? { truncated: true } : {}),
  }));
}
import type { VisualizerEvent, VisualizerStatus } from "./events.js";

export type VisualizerNodeKind = "turn" | "agent" | "model" | "reasoning" | "tool" | "context" | "error";

export interface VisualizerNode {
  id: string;
  kind: VisualizerNodeKind;
  label: string;
  sessionId: string;
  turnId?: string;
  parentId?: string;
  agentId?: string;
  status: VisualizerStatus;
  startedAt: number;
  endedAt?: number;
  duration?: number;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  tool?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  contextTokens?: number;
  contextWindow?: number;
  summary?: string;
  files: readonly string[];
}

export interface VisualizerEdge {
  from: string;
  to: string;
  kind: "contains" | "delegates" | "calls" | "returns";
  timestamp: number;
}

export interface VisualizerFileActivity {
  path: string;
  count: number;
  lastTimestamp: number;
  tools: ReadonlyMap<string, number>;
}

export interface VisualizerTokenMetrics {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  contextTokens: number;
  contextWindow: number;
  updatedAt: number;
}

export interface VisualizerState {
  turns: ReadonlyMap<string, VisualizerNode>;
  agents: ReadonlyMap<string, VisualizerNode>;
  modelCalls: ReadonlyMap<string, VisualizerNode>;
  toolCalls: ReadonlyMap<string, VisualizerNode>;
  nodes: ReadonlyMap<string, VisualizerNode>;
  edges: readonly VisualizerEdge[];
  activeFiles: ReadonlyMap<string, VisualizerFileActivity>;
  tokenMetrics: ReadonlyMap<string, VisualizerTokenMetrics>;
  timeline: readonly VisualizerEvent[];
}

const MAX_TIMELINE_EVENTS = 2_000;
const MAX_EDGES = 2_000;
const MAX_NODES = 2_000;
const MAX_FILES = 1_000;
const MAX_TOKEN_SESSIONS = 256;
const MAX_RETAINED_CODE_LINES = 2_000;

export function createVisualizerState(): VisualizerState {
  return {
    turns: new Map(),
    agents: new Map(),
    modelCalls: new Map(),
    toolCalls: new Map(),
    nodes: new Map(),
    edges: [],
    activeFiles: new Map(),
    tokenMetrics: new Map(),
    timeline: [],
  };
}

function nodeKind(event: VisualizerEvent): VisualizerNodeKind | null {
  if (event.type.startsWith("turn.")) return "turn";
  if (event.type.startsWith("agent.")) return "agent";
  if (event.type.startsWith("model.reasoning.")) return "reasoning";
  if (event.type.startsWith("model.")) return "model";
  if (event.type.startsWith("tool.")) return "tool";
  if (event.type.startsWith("context.")) return "context";
  if (event.type === "error" || event.type === "retry") return "error";
  return null;
}

function identity(event: VisualizerEvent): string {
  if (event.entityId) return event.entityId;
  if (event.type.startsWith("turn.") && event.turnId) return event.turnId;
  if (event.type.startsWith("agent.") && event.agentId) return event.agentId;
  return event.eventId;
}

function label(event: VisualizerEvent, kind: VisualizerNodeKind): string {
  if (kind === "turn") return event.agentId ? `AGENT ${event.agentId}` : "MAIN";
  if (kind === "agent") return event.agentId ? `AGENT ${event.agentId}` : "AGENT";
  if (kind === "model") return event.model ?? "MODEL";
  if (kind === "reasoning") return "reasoning";
  if (kind === "tool") return event.tool ?? "tool";
  if (kind === "context") return event.type === "context.compact" ? "compaction" : "context";
  return event.type === "retry" ? "retry" : "error";
}

function isEnding(event: VisualizerEvent): boolean {
  if (event.status === "active" || event.status === "waiting") return false;
  return event.type === "turn.end" || event.type === "agent.end" || event.type === "model.response"
    || event.type === "model.reasoning.end" || event.type === "tool.end" || event.type === "tool.error"
    || event.type === "context.compact" || event.type === "error";
}

function mergeNode(previous: VisualizerNode | undefined, event: VisualizerEvent, kind: VisualizerNodeKind): VisualizerNode {
  const ending = isEnding(event);
  const status = event.status ?? (ending ? (event.type === "error" || event.type === "tool.error" ? "failed" : "complete") : "active");
  const startedAt = previous?.startedAt ?? event.timestamp;
  const endedAt = ending ? event.timestamp : previous?.endedAt;
  const duration = event.duration ?? (endedAt === undefined ? previous?.duration : Math.max(0, endedAt - startedAt));
  return {
    ...(previous ?? {
      id: identity(event),
      kind,
      label: label(event, kind),
      sessionId: event.sessionId,
      status,
      startedAt,
      files: [],
    }),
    status,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.parentId ? { parentId: event.parentId } : {}),
    ...(event.agentId ? { agentId: event.agentId } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.reasoningEffort ? { reasoningEffort: event.reasoningEffort } : {}),
    ...(event.tool ? { tool: event.tool } : {}),
    ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
    ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
    ...(event.reasoningTokens !== undefined ? { reasoningTokens: event.reasoningTokens } : {}),
    ...(event.contextTokens !== undefined ? { contextTokens: event.contextTokens } : {}),
    ...(event.contextWindow !== undefined ? { contextWindow: event.contextWindow } : {}),
    ...(event.summary ? { summary: event.summary } : {}),
    ...(event.files ? { files: event.files } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(duration !== undefined ? { duration } : {}),
  };
}

function updateFiles(state: VisualizerState, event: VisualizerEvent): ReadonlyMap<string, VisualizerFileActivity> {
  if (!event.files?.length || !event.tool) return state.activeFiles;
  const files = new Map(state.activeFiles);
  for (const path of event.files) {
    const previous = files.get(path);
    const tools = new Map(previous?.tools ?? []);
    tools.set(event.tool, (tools.get(event.tool) ?? 0) + 1);
    files.set(path, {
      path,
      count: (previous?.count ?? 0) + 1,
      lastTimestamp: event.timestamp,
      tools,
    });
  }
  if (files.size > MAX_FILES) {
    const oldest = [...files.values()]
      .sort((left, right) => left.lastTimestamp - right.lastTimestamp || left.path.localeCompare(right.path));
    for (const file of oldest.slice(0, files.size - MAX_FILES)) files.delete(file.path);
  }
  return files;
}

function updateTokens(state: VisualizerState, event: VisualizerEvent): ReadonlyMap<string, VisualizerTokenMetrics> {
  if (event.inputTokens === undefined && event.outputTokens === undefined && event.reasoningTokens === undefined
    && event.contextTokens === undefined && event.contextWindow === undefined) return state.tokenMetrics;
  const metrics = new Map(state.tokenMetrics);
  const previous = metrics.get(event.sessionId);
  metrics.set(event.sessionId, {
    sessionId: event.sessionId,
    inputTokens: event.inputTokens ?? previous?.inputTokens ?? 0,
    outputTokens: event.outputTokens ?? previous?.outputTokens ?? 0,
    reasoningTokens: event.reasoningTokens ?? previous?.reasoningTokens ?? 0,
    contextTokens: event.contextTokens ?? event.inputTokens ?? previous?.contextTokens ?? 0,
    contextWindow: event.contextWindow ?? previous?.contextWindow ?? 0,
    updatedAt: event.timestamp,
  });
  if (metrics.size > MAX_TOKEN_SESSIONS) {
    const oldest = [...metrics.values()]
      .sort((left, right) => left.updatedAt - right.updatedAt || left.sessionId.localeCompare(right.sessionId));
    for (const metric of oldest.slice(0, metrics.size - MAX_TOKEN_SESSIONS)) metrics.delete(metric.sessionId);
  }
  return metrics;
}

function boundTimelineCode(events: readonly VisualizerEvent[]): VisualizerEvent[] {
  const timeline = [...events];
  let remaining = MAX_RETAINED_CODE_LINES;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const event = timeline[index];
    if (!event?.codeChanges?.length) continue;
    const units = event.codeChanges.reduce((total, change) => total + Math.max(1, change.lines.length), 0);
    if (units <= remaining) {
      remaining -= units;
      continue;
    }
    const { codeChanges: _omitted, ...withoutCode } = event;
    timeline[index] = withoutCode;
  }
  return timeline;
}

/** Pure reducer: all visual state is reconstructed from the event sequence. */
export function reduceVisualizerEvent(state: VisualizerState, event: VisualizerEvent): VisualizerState {
  const kind = nodeKind(event);
  const id = identity(event);
  const nodes = new Map(state.nodes);
  const turns = new Map(state.turns);
  const agents = new Map(state.agents);
  const modelCalls = new Map(state.modelCalls);
  const toolCalls = new Map(state.toolCalls);
  let edges = state.edges;

  if (kind) {
    const node = mergeNode(nodes.get(id), event, kind);
    nodes.set(id, node);
    if (kind === "turn") turns.set(id, node);
    if (kind === "agent") agents.set(id, node);
    if (kind === "model") modelCalls.set(id, node);
    if (kind === "tool") toolCalls.set(id, node);
    if (!state.nodes.has(id) && event.parentId && event.parentId !== id) {
      const edge: VisualizerEdge = {
        from: event.parentId,
        to: id,
        kind: kind === "agent" ? "delegates" : kind === "tool" || kind === "model" ? "calls" : "contains",
        timestamp: event.timestamp,
      };
      edges = [...state.edges, edge].slice(-MAX_EDGES);
    }
  }

  if (nodes.size > MAX_NODES) {
    const removable = [...nodes.values()]
      .filter((node) => node.status !== "active" && node.status !== "waiting" && node.id !== id)
      .sort((left, right) => (left.endedAt ?? left.startedAt) - (right.endedAt ?? right.startedAt)
        || left.id.localeCompare(right.id));
    for (const node of removable.slice(0, nodes.size - MAX_NODES)) {
      nodes.delete(node.id);
      turns.delete(node.id);
      agents.delete(node.id);
      modelCalls.delete(node.id);
      toolCalls.delete(node.id);
    }
    edges = edges.filter((edge) => nodes.has(edge.from) && nodes.has(edge.to));
  }

  return {
    turns,
    agents,
    modelCalls,
    toolCalls,
    nodes,
    edges,
    activeFiles: updateFiles(state, event),
    tokenMetrics: updateTokens(state, event),
    timeline: boundTimelineCode([...state.timeline, event].slice(-MAX_TIMELINE_EVENTS)),
  };
}

export class VisualizerStore {
  private current = createVisualizerState();

  get state(): VisualizerState {
    return this.current;
  }

  dispatch(event: VisualizerEvent): VisualizerState {
    this.current = reduceVisualizerEvent(this.current, event);
    return this.current;
  }

  clear(): void {
    this.current = createVisualizerState();
  }
}
export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export type ApprovalMode = "review" | "code" | "unrestricted";
export type Verbosity = "low" | "medium" | "high";
export type GatewayProvider = "codex-lb" | "lm-studio" | "openrouter";
export type SessionKind = "interactive" | "agent";

export interface GatewayConfig {
  provider: GatewayProvider;
  baseURL: string;
  apiKeyEnv: string;
  timeoutMs: number;
}

export interface ToolConfig {
  approval: ApprovalMode;
  shellTimeoutMs: number;
  maxOutputBytes: number;
  maxReadLines: number;
  maxToolRounds: number;
}

export interface SchedulerConfig {
  timezone: string;
  pollIntervalMs: number;
  leaseMs: number;
  maxConcurrentCommands: number;
  commandStartGraceMs: number;
  commandTimeoutMs: number;
  commandOutputBytes: number;
}

export interface GlassConfig {
  gateway: GatewayConfig;
  gateways: GatewayConfig[];
  model: string | null;
  reasoningEffort: ReasoningEffort;
  verbosity: Verbosity;
  fast: boolean;
  instructions: string[];
  tools: ToolConfig;
  scheduler: SchedulerConfig;
}

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  contextWindow: number;
  maxOutputTokens: number | null;
  reasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
  defaultVerbosity: Verbosity;
  supportsReasoning: boolean;
  supportsImages: boolean;
  supportsParallelToolCalls: boolean;
  supportsFast: boolean;
  priority: number;
  isFree?: boolean;
}

export interface GatewayModel extends ModelInfo {
  provider: GatewayProvider;
}

export interface SessionRecord {
  id: string;
  workspace: string;
  provider: GatewayProvider;
  agentProvider: GatewayProvider;
  title: string;
  model: string;
  agentModel: string;
  reasoningEffort: ReasoningEffort;
  agentReasoningEffort: ReasoningEffort;
  agentsEnabled: boolean;
  verbosity: Verbosity;
  fast: boolean;
  approvalMode: ApprovalMode;
  showReasoning: boolean;
  persistent: boolean;
  promptCacheKey: string;
  lastResponseId: string | null;
  kind: SessionKind;
  parentSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type EventKind =
  | "user"
  | "response"
  | "tool_started"
  | "tool_result"
  | "tool_denied"
  | "error"
  | "note";

export interface SessionEvent<T = unknown> {
  id: number;
  sessionId: string;
  sequence: number;
  kind: EventKind;
  payload: T;
  createdAt: number;
}

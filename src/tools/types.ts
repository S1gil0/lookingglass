import type { FunctionTool } from "openai/resources/responses/responses";
import type { ApprovalMode, GlassConfig } from "../types.js";
import type { ArtifactStore } from "../storage/artifact-store.js";
import type { SessionStore } from "../storage/session-store.js";

export type ToolRisk = "read" | "write" | "shell" | "persistent" | "critical";
export type ApprovalDecision = "deny" | "once" | "always";

export interface ApprovalRequest {
  tool: string;
  risk: ToolRisk;
  summary: string;
  details: string;
  canAlwaysApprove: boolean;
}

export interface QuestionRequest {
  question: string;
  options?: string[];
}

export interface ToolContext {
  workspace: string;
  sessionId: string;
  authorizationSessionId?: string;
  callId?: string;
  config: GlassConfig;
  approvalMode?: ApprovalMode;
  artifacts: ArtifactStore;
  sessions: SessionStore;
  signal: AbortSignal;
  readOnly?: boolean;
  automated?: boolean;
  modelOutputBytes?: number;
  reportProgress?(message: string): void;
  approve(request: ApprovalRequest): Promise<ApprovalDecision>;
  ask(request: QuestionRequest): Promise<string>;
}

export interface ToolResult {
  output: string;
  display?: string;
  artifactUri?: string;
  truncated?: boolean;
}

export interface GlassTool<TArgs = unknown> {
  name: string;
  description: string;
  risk: ToolRisk;
  classifyRisk?(args: TArgs, context: ToolContext): ToolRisk;
  approvalSignature?(args: TArgs, context: ToolContext): string;
  legacyApprovalSignatures?(args: TArgs, context: ToolContext): string[];
  approvalDescription?(args: TArgs, context: ToolContext): string;
  parameters: Record<string, unknown>;
  summarize(args: TArgs): string;
  execute(args: TArgs, context: ToolContext): Promise<ToolResult>;
}

export function toFunctionTool(tool: GlassTool): FunctionTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: true,
  };
}

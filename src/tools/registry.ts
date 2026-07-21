import { Ajv, type ValidateFunction } from "ajv";
import type { FunctionTool } from "openai/resources/responses/responses";
import type { ApprovalMode } from "../types.js";
import type { GlassTool, ToolContext, ToolResult } from "./types.js";
import { toFunctionTool } from "./types.js";
import { configuredCredentialValues, redactSensitiveText, redactSensitiveValue } from "../security.js";

interface RegisteredTool {
  tool: GlassTool;
  validate: ValidateFunction;
}

const RISK_RANK: Record<GlassTool["risk"], number> = {
  read: 0,
  write: 1,
  shell: 2,
  persistent: 3,
  critical: 4,
};

function effectiveRisk(tool: GlassTool, args: unknown, context: ToolContext): GlassTool["risk"] {
  const classified = tool.classifyRisk?.(args, context) ?? tool.risk;
  if (!(classified in RISK_RANK)) throw new Error(`Tool ${tool.name} returned an invalid risk classification`);
  return RISK_RANK[classified] >= RISK_RANK[tool.risk] ? classified : tool.risk;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

export function toolApprovalSignature(tool: string, args: unknown): string {
  return JSON.stringify(["tool-action", 1, tool, canonicalValue(args)]);
}

function utf8Prefix(value: string, maxBytes: number): string {
  const data = Buffer.from(value);
  let end = Math.min(data.length, Math.max(0, maxBytes));
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      return decoder.decode(data.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

function boundToolResult(name: string, result: ToolResult, context: ToolContext): ToolResult {
  result = { ...result, output: redactSensitiveText(result.output, configuredCredentialValues(context.config)) };
  const limit = Math.max(1, context.modelOutputBytes ?? context.config.tools.maxOutputBytes);
  if (Buffer.byteLength(result.output) <= limit) return result;
  const artifact = (result.artifactUri ? context.artifacts.get(result.artifactUri) : null)
    ?? context.artifacts.save(context.sessionId, `${name}-output`, result.output, { tool: name });
  const artifactUri = artifact.uri;
  const suffix = `\n\n[Output truncated to the model budget. Full output: ${artifactUri}]`;
  const output = Buffer.byteLength(suffix) >= limit
    ? utf8Prefix(`[Truncated: ${artifactUri}]`, limit)
    : `${utf8Prefix(result.output, limit - Buffer.byteLength(suffix))}${suffix}`;
  return {
    ...result,
    output,
    artifactUri,
    truncated: true,
  };
}

export class ToolDeniedError extends Error {
  constructor(message = "Tool execution denied by user") {
    super(message);
    this.name = "ToolDeniedError";
  }
}

export class ToolPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolPreflightError";
  }
}

function needsApproval(mode: ApprovalMode, risk: GlassTool["risk"]): boolean {
  if (mode === "unrestricted") return false;
  if (risk === "critical") return true;
  if (mode === "review") return risk !== "read";
  return risk === "shell" || risk === "persistent";
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });

  register(tool: GlassTool): this {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, { tool, validate: this.ajv.compile(tool.parameters) });
    return this;
  }

  definitions(): FunctionTool[] {
    return [...this.tools.values()].map(({ tool }) => toFunctionTool(tool));
  }

  get(name: string): GlassTool | null {
    return this.tools.get(name)?.tool ?? null;
  }

  parseArguments(name: string, raw: string): unknown {
    const registered = this.tools.get(name);
    if (!registered) throw new Error(`Unknown tool: ${name}`);
    let args: unknown;
    try {
      args = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`Invalid JSON arguments for ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!registered.validate(args)) {
      const detail = this.ajv.errorsText(registered.validate.errors, { separator: "; " });
      throw new Error(`Invalid arguments for ${name}: ${detail}`);
    }
    return args;
  }

  async execute(name: string, args: unknown, context: ToolContext): Promise<ToolResult> {
    const registered = this.tools.get(name);
    if (!registered) throw new Error(`Unknown tool: ${name}`);
    context.signal.throwIfAborted();
    let risk: GlassTool["risk"];
    try {
      risk = effectiveRisk(registered.tool, args, context);
    } catch (error) {
      throw new ToolPreflightError(error instanceof Error ? error.message : String(error));
    }
    const approvalArgs = redactSensitiveValue(args, configuredCredentialValues(context.config));
    let signature: string;
    let legacySignatures: string[];
    try {
      signature = registered.tool.approvalSignature?.(approvalArgs, context) ?? toolApprovalSignature(name, approvalArgs);
      legacySignatures = registered.tool.legacyApprovalSignatures?.(approvalArgs, context) ?? [];
    } catch (error) {
      throw new ToolPreflightError(error instanceof Error ? error.message : String(error));
    }
    const mode = context.approvalMode ?? context.config.tools.approval;
    const authorizationSessionId = context.authorizationSessionId ?? context.sessionId;
    const remembered = [signature, ...legacySignatures]
      .some((candidate) => context.sessions.hasCommandApproval(authorizationSessionId, candidate));
    const automatedRemembered = Boolean(context.automated && remembered);
    const execute = async (): Promise<ToolResult> => {
      return boundToolResult(name, await registered.tool.execute(args, context), context);
    };
    if (context.readOnly && mode !== "unrestricted" && risk !== "read" && !automatedRemembered) {
      throw new ToolDeniedError("Tool execution denied by read-only session policy");
    }
    if (context.automated && (name === "ask_user" || name === "schedule_create") && !automatedRemembered) {
      throw new ToolDeniedError("Tool execution denied by noninteractive scheduled-session policy");
    }
    if (remembered && (!context.automated || automatedRemembered)) {
      context.signal.throwIfAborted();
      return execute();
    }
    if (needsApproval(mode, risk)) {
      if (context.automated) {
        throw new ToolDeniedError("Tool execution requires an interactive or remembered approval");
      }
      const decision = await context.approve({
        tool: name,
        risk,
          summary: registered.tool.summarize(approvalArgs),
        details: [
          JSON.stringify(approvalArgs, null, 2),
          registered.tool.approvalDescription
            ? `Always approve scope:\n${registered.tool.approvalDescription(approvalArgs, context)}`
            : "",
        ].filter(Boolean).join("\n\n"),
        canAlwaysApprove: true,
      });
      context.signal.throwIfAborted();
      if (decision === "always") {
        const currentSignature = registered.tool.approvalSignature?.(approvalArgs, context);
        if (currentSignature && currentSignature !== signature) {
          throw new ToolPreflightError("Command execution context changed while approval was pending; review it again");
        }
        context.sessions.registerCommandApproval(authorizationSessionId, signature);
      } else if (decision !== "once") {
        throw new ToolDeniedError();
      }
    }
    context.signal.throwIfAborted();
    return execute();
  }
}

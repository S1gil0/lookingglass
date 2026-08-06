import type { ModelInfo, ReasoningEffort } from "../types.js";

export type OpenCodeGoProtocol = "chat" | "responses" | "messages";

export interface OpenCodeGoProfile {
  protocol: OpenCodeGoProtocol;
  reasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
  supportsReasoning: boolean;
  contextWindow: number;
  maxOutputTokens: number | null;
  supportsImages: boolean;
  supportsParallelToolCalls: boolean;
  /** Maximum registry budget for Anthropic-compatible budget variants. */
  reasoningBudgetMax?: number;
  /** The exposed high setting acts as the on switch for Anthropic adaptive thinking. */
  reasoningAdaptive?: boolean;
}

export interface OpenCodeGoRawModel {
  id: string;
  name?: string;
  description?: string | null;
  attachment?: boolean | null;
  reasoning?: boolean | null;
  tool_call?: boolean | null;
  limit?: {
    context?: number | null;
    output?: number | null;
  };
}

const NONE: ReasoningEffort[] = ["none"];
const LOW_MEDIUM_HIGH: ReasoningEffort[] = ["low", "medium", "high"];
const HIGH_MAX: ReasoningEffort[] = ["high", "max"];
const LOW_HIGH_MAX: ReasoningEffort[] = ["low", "high", "max"];
const LUNA_EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];

const UNKNOWN_PROFILE: OpenCodeGoProfile = {
  protocol: "chat",
  reasoningEfforts: NONE,
  defaultReasoningEffort: "none",
  supportsReasoning: false,
  contextWindow: 32_768,
  maxOutputTokens: null,
  supportsImages: false,
  supportsParallelToolCalls: false,
};

function chatProfile(
  contextWindow: number,
  maxOutputTokens: number,
  reasoningEfforts: ReasoningEffort[] = NONE,
  supportsReasoning = false,
  supportsImages = false,
): OpenCodeGoProfile {
  return {
    protocol: "chat",
    reasoningEfforts,
    defaultReasoningEffort: supportsReasoning
      ? reasoningEfforts.includes("medium") ? "medium"
        : reasoningEfforts.includes("high") ? "high"
          : reasoningEfforts.includes("max") ? "max"
            : reasoningEfforts[0] ?? "none"
      : "none",
    supportsReasoning,
    contextWindow,
    maxOutputTokens,
    supportsImages,
    supportsParallelToolCalls: false,
  };
}

function messagesProfile(
  contextWindow: number,
  maxOutputTokens: number,
  reasoningEfforts: ReasoningEffort[] = NONE,
  supportsImages = false,
  reasoningBudgetMax?: number,
): OpenCodeGoProfile {
  return {
    protocol: "messages",
    reasoningEfforts,
    defaultReasoningEffort: reasoningEfforts.includes("medium") ? "medium"
      : reasoningEfforts.includes("high") ? "high"
        : reasoningEfforts.includes("max") ? "max"
          : reasoningEfforts[0] ?? "none",
    supportsReasoning: true,
    contextWindow,
    maxOutputTokens,
    supportsImages,
    supportsParallelToolCalls: false,
    ...(reasoningBudgetMax === undefined ? {} : { reasoningBudgetMax }),
  };
}

const PROFILES: Record<string, OpenCodeGoProfile> = {
  // Current models documented at packages/web/src/content/docs/go.mdx.
  "grok-4.5": chatProfile(500_000, 500_000, LOW_MEDIUM_HIGH, true, true),
  "glm-5.2": chatProfile(1_000_000, 131_072, HIGH_MAX, true),
  "glm-5.1": chatProfile(202_752, 32_768, NONE, true),
  "gpt-5.6-luna": {
    protocol: "responses",
    reasoningEfforts: LUNA_EFFORTS,
    defaultReasoningEffort: "medium",
    supportsReasoning: true,
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsParallelToolCalls: false,
  },
  "kimi-k3": chatProfile(1_048_576, 131_072, ["max"], true, true),
  "kimi-k2.7-code": chatProfile(262_144, 262_144, NONE, true, true),
  "kimi-k2.6": chatProfile(262_144, 65_536, NONE, true, true),
  "mimo-v2.5": chatProfile(1_000_000, 128_000, NONE, true, true),
  "mimo-v2.5-pro": chatProfile(1_048_576, 128_000, NONE, true),
  "minimax-m3": {
    ...messagesProfile(1_000_000, 131_072, ["high"], true),
    reasoningAdaptive: true,
  },
  "minimax-m2.7": messagesProfile(204_800, 131_072),
  "qwen3.8-max": messagesProfile(1_000_000, 131_072, HIGH_MAX, true, 262_144),
  "qwen3.7-max": messagesProfile(1_000_000, 65_536, HIGH_MAX, false, 262_144),
  "qwen3.7-plus": messagesProfile(1_000_000, 65_536, HIGH_MAX, true, 262_144),
  "qwen3.6-plus": messagesProfile(1_000_000, 65_536, HIGH_MAX, true, 81_920),
  "deepseek-v4-pro": chatProfile(1_000_000, 384_000, HIGH_MAX, true),
  "deepseek-v4-flash": chatProfile(1_000_000, 384_000, LOW_HIGH_MAX, true),
  "hy3": chatProfile(256_000, 64_000, ["none", "low", "high"], true),

  // Deprecated IDs are still returned by the Go models catalog.
  "minimax-m2.5": messagesProfile(204_800, 65_536),
  "qwen3.5-plus": messagesProfile(262_144, 65_536, HIGH_MAX, true, 81_920),
  "kimi-k2.5": chatProfile(262_144, 65_536, NONE, true, true),
  "mimo-v2-omni": chatProfile(262_144, 128_000, NONE, true, true),
  "mimo-v2-pro": chatProfile(1_048_576, 128_000, NONE, true),
  "glm-5": chatProfile(202_752, 32_768, NONE, true),
};

function cloneProfile(profile: OpenCodeGoProfile): OpenCodeGoProfile {
  return { ...profile, reasoningEfforts: [...profile.reasoningEfforts] };
}

export function openCodeGoProfile(modelId: string): OpenCodeGoProfile {
  return cloneProfile(PROFILES[modelId] ?? UNKNOWN_PROFILE);
}

function validPositiveNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function openCodeGoModelInfo(raw: OpenCodeGoRawModel): ModelInfo {
  const profile = openCodeGoProfile(raw.id);
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    description: raw.description ?? "",
    contextWindow: validPositiveNumber(raw.limit?.context) ? raw.limit.context : profile.contextWindow,
    maxOutputTokens: validPositiveNumber(raw.limit?.output) ? raw.limit.output : profile.maxOutputTokens,
    reasoningEfforts: profile.reasoningEfforts,
    defaultReasoningEffort: profile.defaultReasoningEffort,
    defaultVerbosity: "low",
    supportsReasoning: profile.supportsReasoning,
    supportsImages: raw.attachment ?? profile.supportsImages,
    supportsParallelToolCalls: profile.supportsParallelToolCalls,
    supportsFast: false,
    priority: 1_000,
  };
}

export type OpenCodeGoReasoningParams = Record<string, unknown>;

const OUTPUT_TOKEN_MAX = 2 ** 31 - 1;

function budgetParams(profile: OpenCodeGoProfile, effort: ReasoningEffort): OpenCodeGoReasoningParams {
  if (profile.reasoningBudgetMax === undefined || profile.maxOutputTokens === null) return {};
  const outputMaximum = profile.maxOutputTokens - 1;
  const maximum = Math.min(profile.reasoningBudgetMax, outputMaximum, OUTPUT_TOKEN_MAX - 1);
  if (maximum <= 0) return {};
  const minimum = 0;
  const high = Math.min(Math.max(minimum, Math.ceil(maximum / 2)), maximum);
  const budget = effort === "high" ? high : effort === "max" ? maximum : null;
  return budget === null
    ? {}
    : { thinking: { type: "enabled", budget_tokens: budget } };
}

export function openCodeGoReasoningParams(modelId: string, selectedEffort: ReasoningEffort): OpenCodeGoReasoningParams {
  const profile = openCodeGoProfile(modelId);
  if (!profile.supportsReasoning || !profile.reasoningEfforts.includes(selectedEffort)) return {};
  if (profile.reasoningAdaptive) return { thinking: { type: "adaptive" } };
  if (profile.reasoningEfforts.length === 1 && profile.reasoningEfforts[0] === "none") return {};

  if (profile.reasoningBudgetMax !== undefined) return budgetParams(profile, selectedEffort);
  if (profile.protocol === "chat") return { reasoning_effort: selectedEffort };
  if (profile.protocol === "responses") {
    return { reasoning: { effort: selectedEffort, summary: "auto" } };
  }
  return {};
}
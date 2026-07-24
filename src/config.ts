import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { configDir, shouldEnforcePosixPermissions } from "./paths.js";
import {
  REASONING_EFFORTS,
  type ApprovalMode,
  type GlassConfig,
  type ReasoningEffort,
  type Verbosity,
} from "./types.js";

export const DEFAULT_CONFIG: GlassConfig = {
  gateway: {
    provider: "lm-studio",
    baseURL: "http://127.0.0.1:1234/v1",
    apiKeyEnv: "LM_STUDIO_API_KEY",
    timeoutMs: 10 * 60_000,
  },
  gateways: [],
  model: null,
  reasoningEffort: "medium",
  verbosity: "low",
  fast: false,
  instructions: [],
  tools: {
    approval: "code",
    shellTimeoutMs: 120_000,
    maxOutputBytes: 64 * 1024,
    maxReadLines: 2_000,
    maxToolRounds: 1_000,
  },
  scheduler: {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    pollIntervalMs: 1_000,
    leaseMs: 20_000,
    maxConcurrentCommands: 2,
    commandStartGraceMs: 60_000,
    commandTimeoutMs: 10 * 60_000,
    commandOutputBytes: 64 * 1024,
  },
};

type PartialConfig = {
  gateway?: Partial<GlassConfig["gateway"]>;
  gateways?: GatewayConfigInput[];
  model?: string | null;
  reasoningEffort?: ReasoningEffort;
  verbosity?: Verbosity;
  fast?: boolean;
  instructions?: string[];
  tools?: Partial<GlassConfig["tools"]>;
  scheduler?: Partial<GlassConfig["scheduler"]>;
};

type GatewayConfigInput = Partial<GlassConfig["gateway"]> & Pick<GlassConfig["gateway"], "provider" | "baseURL">;

function defaultApiKeyEnv(provider: GlassConfig["gateway"]["provider"]): string {
  if (provider === "lm-studio") return "LM_STUDIO_API_KEY";
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  return "CODEX_LB_API_KEY";
}

function parseConfigFile(path: string): PartialConfig {
  const errors: ParseError[] = [];
  const value = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0) {
    const details = errors.map((error) => `${printParseErrorCode(error.error)} at byte ${error.offset}`).join(", ");
    throw new Error(`Invalid config ${path}: ${details}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid config ${path}: expected an object`);
  }
  return value as PartialConfig;
}

function merge(base: GlassConfig, override: PartialConfig): GlassConfig {
  const gatewayOverride = override.gateway;
  const mergedGateway = gatewayOverride
    ? {
        ...base.gateway,
        ...gatewayOverride,
        ...(gatewayOverride.apiKeyEnv === undefined
          ? { apiKeyEnv: defaultApiKeyEnv(gatewayOverride.provider ?? base.gateway.provider) }
          : {}),
      }
    : base.gateway;
  return {
    ...base,
    ...override,
    gateway: mergedGateway,
    gateways: override.gateways
      ? override.gateways.map((gateway) => ({
          apiKeyEnv: defaultApiKeyEnv(gateway.provider),
          timeoutMs: base.gateway.timeoutMs,
          ...gateway,
        }))
      : base.gateways,
    tools: { ...base.tools, ...override.tools },
    scheduler: { ...base.scheduler, ...override.scheduler },
  };
}

function validate(config: GlassConfig): void {
  const gateways = [config.gateway, ...config.gateways];
  const providers = new Set<string>();
  for (const gateway of gateways) {
    if (!["codex-lb", "lm-studio", "openrouter"].includes(gateway.provider)) {
      throw new Error("gateway provider must be codex-lb, lm-studio, or openrouter");
    }
    if (!/^https?:\/\//.test(gateway.baseURL)) throw new Error("gateway baseURL must be HTTP or HTTPS");
    const url = new URL(gateway.baseURL);
    if (url.username || url.password) throw new Error("gateway baseURL must not contain credentials");
    if (providers.has(gateway.provider)) throw new Error(`Duplicate gateway provider: ${gateway.provider}`);
    providers.add(gateway.provider);
  }
  if (!REASONING_EFFORTS.includes(config.reasoningEffort)) throw new Error("Invalid reasoningEffort");
  if (!["low", "medium", "high"].includes(config.verbosity)) throw new Error("Invalid verbosity");
  if (!["review", "code", "unrestricted"].includes(config.tools.approval satisfies ApprovalMode)) {
    throw new Error("Invalid tools.approval");
  }
  if (config.tools.maxToolRounds < 1 || config.tools.maxToolRounds > 10_000) {
    throw new Error("tools.maxToolRounds must be between 1 and 10000");
  }
  new Intl.DateTimeFormat("en-US", { timeZone: config.scheduler.timezone }).format(0);
}

function loadEnvironmentFile(): void {
  const path = join(configDir(), "scheduler.env");
  if (!existsSync(path)) return;
  // Windows does not expose POSIX mode bits; do not reject a scheduler.env file
  // there based on the synthetic mode value returned by statSync.
  if (shouldEnforcePosixPermissions() && (statSync(path).mode & 0o077) !== 0) {
    throw new Error(`${path} must not be readable or writable by group or other users`);
  }
  for (const rawLine of readFileSync(path, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match?.[1]) throw new Error(`Invalid environment entry in ${path}`);
    let value = match[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

export function loadConfig(workspace: string): GlassConfig {
  loadEnvironmentFile();
  const globalPaths = [join(configDir(), "config.jsonc"), join(configDir(), "config.json")];
  const projectPaths = [join(workspace, ".looking-glass.jsonc"), join(workspace, ".looking-glass.json")];
  const explicit = process.env.LOOKING_GLASS_CONFIG ? resolve(process.env.LOOKING_GLASS_CONFIG) : null;

  let config = structuredClone(DEFAULT_CONFIG);
  for (const path of [...globalPaths, ...projectPaths, ...(explicit ? [explicit] : [])]) {
    if (existsSync(path)) config = merge(config, parseConfigFile(path));
  }
  config.gateway.baseURL = config.gateway.baseURL.replace(/\/$/, "");
  config.gateways = config.gateways.map((gateway) => ({
    ...gateway,
    baseURL: gateway.baseURL.replace(/\/$/, ""),
  }));
  validate(config);
  return config;
}

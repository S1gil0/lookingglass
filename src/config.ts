import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { configDir, shouldEnforcePosixPermissions } from "./paths.js";
import {
  REASONING_EFFORTS,
  type ApprovalMode,
  type GatewayProtocol,
  type GlassConfig,
  type ReasoningEffort,
  type Verbosity,
} from "./types.js";

export const DEFAULT_CONFIG: GlassConfig = {
  gateway: {
    provider: "codex-lb",
    protocol: "responses",
    baseURL: "http://127.0.0.1:2455/v1",
    apiKeyEnv: "CODEX_LB_API_KEY",
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

export function defaultApiKeyEnv(provider: GlassConfig["gateway"]["provider"]): string {
  if (provider === "lm-studio") return "LM_STUDIO_API_KEY";
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  if (provider === "custom") return "CUSTOM_API_KEY";
  return "CODEX_LB_API_KEY";
}

export function defaultProtocol(provider: GlassConfig["gateway"]["provider"]): GatewayProtocol {
  return provider === "openrouter" ? "chat" : "responses";
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
  const object = value as Record<string, unknown>;
  const isObject = (candidate: unknown): candidate is Record<string, unknown> => {
    return !!candidate && typeof candidate === "object" && !Array.isArray(candidate);
  };
  const pick = (candidate: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const key of keys) if (key in candidate) result[key] = candidate[key];
    return result;
  };
  const gatewayKeys = ["provider", "protocol", "baseURL", "apiKeyEnv", "timeoutMs"] as const;
  const nested = (key: string, keys: readonly string[]): Record<string, unknown> | undefined => {
    const candidate = object[key];
    if (candidate === undefined) return undefined;
    if (!isObject(candidate)) throw new Error(`Invalid config ${path}: ${key} expected an object`);
    return pick(candidate, keys);
  };
  if (object.gateways !== undefined) {
    if (!Array.isArray(object.gateways)) throw new Error(`Invalid config ${path}: gateways expected an array`);
    for (const gateway of object.gateways) {
      if (!isObject(gateway)) throw new Error(`Invalid config ${path}: gateways entries expected objects`);
    }
  }
  if (object.instructions !== undefined && !Array.isArray(object.instructions)) {
    throw new Error(`Invalid config ${path}: instructions expected an array`);
  }
  if (Array.isArray(object.instructions) && object.instructions.some((entry) => typeof entry !== "string")) {
    throw new Error(`Invalid config ${path}: instructions entries expected strings`);
  }
  const result: Record<string, unknown> = pick(object, [
    "model", "reasoningEffort", "verbosity", "fast", "instructions",
  ]);
  const gateway = nested("gateway", gatewayKeys);
  if (gateway) result.gateway = gateway;
  if (object.gateways !== undefined) {
    result.gateways = (object.gateways as unknown[]).map((entry) => pick(entry as Record<string, unknown>, gatewayKeys));
  }
  const tools = nested("tools", ["approval", "shellTimeoutMs", "maxOutputBytes", "maxReadLines", "maxToolRounds"]);
  if (tools) result.tools = tools;
  const scheduler = nested("scheduler", [
    "timezone", "pollIntervalMs", "leaseMs", "maxConcurrentCommands", "commandStartGraceMs",
    "commandTimeoutMs", "commandOutputBytes",
  ]);
  if (scheduler) result.scheduler = scheduler;
  return result as PartialConfig;
}

function merge(base: GlassConfig, override: PartialConfig): GlassConfig {
  const gatewayOverride = override.gateway;
  const gatewayProviderChanged = gatewayOverride?.provider !== undefined
    && gatewayOverride.provider !== base.gateway.provider;
  const mergedGateway = gatewayOverride
    ? {
        ...base.gateway,
        ...gatewayOverride,
        ...(gatewayOverride.protocol === undefined && gatewayProviderChanged
          ? { protocol: defaultProtocol(gatewayOverride.provider ?? base.gateway.provider) }
          : {}),
        ...(gatewayOverride.apiKeyEnv === undefined && gatewayProviderChanged
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
          protocol: defaultProtocol(gateway.provider),
          timeoutMs: base.gateway.timeoutMs,
          ...gateway,
        }))
      : base.gateways,
    tools: { ...base.tools, ...override.tools },
    scheduler: { ...base.scheduler, ...override.scheduler },
  };
}

function validate(config: GlassConfig): void {
  if (config.model !== null && typeof config.model !== "string") throw new Error("model must be a string or null");
  if (typeof config.fast !== "boolean") throw new Error("fast must be a boolean");
  if (config.instructions.some((instruction) => typeof instruction !== "string")) {
    throw new Error("instructions entries must be strings");
  }
  const gateways = [config.gateway, ...config.gateways];
  const providers = new Set<string>();
  for (const gateway of gateways) {
    if (!["codex-lb", "lm-studio", "openrouter", "custom"].includes(gateway.provider)) {
      throw new Error("gateway provider must be codex-lb, lm-studio, openrouter, or custom");
    }
    if (!["responses", "chat"].includes(gateway.protocol)) throw new Error("gateway protocol must be responses or chat");
    if (gateway.provider !== "custom" && gateway.protocol !== defaultProtocol(gateway.provider)) {
      throw new Error(`gateway protocol ${gateway.protocol} is not supported for ${gateway.provider}`);
    }
    if (typeof gateway.baseURL !== "string" || !/^https?:\/\//.test(gateway.baseURL)) {
      throw new Error("gateway baseURL must be HTTP or HTTPS");
    }
    const url = new URL(gateway.baseURL);
    if (url.username || url.password) throw new Error("gateway baseURL must not contain credentials");
    if (typeof gateway.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(gateway.apiKeyEnv)) {
      throw new Error("gateway apiKeyEnv must be a valid environment variable name");
    }
    if (typeof gateway.timeoutMs !== "number" || !Number.isFinite(gateway.timeoutMs) || gateway.timeoutMs < 0) {
      throw new Error("gateway timeoutMs must be a non-negative number");
    }
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
  for (const [name, value] of Object.entries(config.tools)) {
    if (name !== "approval" && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new Error(`tools.${name} must be a non-negative number`);
    }
  }
  for (const [name, value] of Object.entries(config.scheduler)) {
    if (name !== "timezone" && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new Error(`scheduler.${name} must be a non-negative number`);
    }
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
  try {
    loadEnvironmentFile();
  } catch {
    // A damaged environment file must not prevent the CLI from starting or
    // make the interactive /config recovery path unusable.
  }
  const globalPaths = [join(configDir(), "config.jsonc"), join(configDir(), "config.json")];
  const projectPaths = [join(workspace, ".looking-glass.jsonc"), join(workspace, ".looking-glass.json")];
  const explicit = process.env.LOOKING_GLASS_CONFIG ? resolve(process.env.LOOKING_GLASS_CONFIG) : null;

  let config = structuredClone(DEFAULT_CONFIG);
  for (const path of [...globalPaths, ...projectPaths, ...(explicit ? [explicit] : [])]) {
    if (!existsSync(path)) continue;
    try {
      const candidate = merge(config, parseConfigFile(path));
      validate(candidate);
      config = candidate;
    } catch {
      // Keep startup and onboarding available when one configuration layer is
      // damaged. A later valid layer, or the defaults, remains usable.
      continue;
    }
  }
  config.gateway.baseURL = config.gateway.baseURL.replace(/\/$/, "");
  config.gateways = config.gateways.map((gateway) => ({
    ...gateway,
    baseURL: gateway.baseURL.replace(/\/$/, ""),
  }));
  validate(config);
  return config;
}

export function globalConfigPath(): string {
  return join(configDir(), "config.json");
}

export function schedulerEnvPath(): string {
  return join(configDir(), "scheduler.env");
}

export const configPath = globalConfigPath;

export interface PersistedGatewayConfig {
  provider: GlassConfig["gateway"]["provider"];
  protocol?: GatewayProtocol;
  baseURL: string;
  apiKeyEnv?: string;
  model?: string | null;
  apiKey?: string;
}

function assertApiKeyEnv(apiKeyEnv: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new Error("gateway apiKeyEnv must be a valid environment variable name");
  }
}

/** Return only fields that are safe and declared in the effective config. */
export function serializeConfig(config: GlassConfig): GlassConfig {
  const gateway = (value: GlassConfig["gateway"]): GlassConfig["gateway"] => ({
    provider: value.provider,
    protocol: value.protocol,
    baseURL: value.baseURL,
    apiKeyEnv: value.apiKeyEnv,
    timeoutMs: value.timeoutMs,
  });
  return {
    gateway: gateway(config.gateway),
    gateways: config.gateways.map(gateway),
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    verbosity: config.verbosity,
    fast: config.fast,
    instructions: [...config.instructions],
    tools: {
      approval: config.tools.approval,
      shellTimeoutMs: config.tools.shellTimeoutMs,
      maxOutputBytes: config.tools.maxOutputBytes,
      maxReadLines: config.tools.maxReadLines,
      maxToolRounds: config.tools.maxToolRounds,
    },
    scheduler: {
      timezone: config.scheduler.timezone,
      pollIntervalMs: config.scheduler.pollIntervalMs,
      leaseMs: config.scheduler.leaseMs,
      maxConcurrentCommands: config.scheduler.maxConcurrentCommands,
      commandStartGraceMs: config.scheduler.commandStartGraceMs,
      commandTimeoutMs: config.scheduler.commandTimeoutMs,
      commandOutputBytes: config.scheduler.commandOutputBytes,
    },
  };
}

function atomicWrite(path: string, contents: string, mode = 0o600): void {
  mkdirSync(configDir(), shouldEnforcePosixPermissions() ? { recursive: true, mode: 0o700 } : { recursive: true });
  if (!shouldEnforcePosixPermissions()) {
    writeFileSync(path, contents, "utf8");
    return;
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, shouldEnforcePosixPermissions() ? { encoding: "utf8", mode } : "utf8");
    if (shouldEnforcePosixPermissions()) chmodSync(temporary, mode);
    renameSync(temporary, path);
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // Ignore cleanup failures.
    }
    throw error;
  }
}

export function writeGlobalConfig(input: PersistedGatewayConfig): string {
  const path = globalConfigPath();
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      existing = parseConfigFile(path) as Record<string, unknown>;
    } catch {
      // /config is the recovery path for a damaged global config. Start fresh
      // rather than preserving unknown or malformed values.
      existing = {};
    }
  }
  const previousGateway = existing.gateway && typeof existing.gateway === "object" && !Array.isArray(existing.gateway)
    ? existing.gateway as Record<string, unknown>
    : {};
  const provider = input.provider;
  if (input.apiKeyEnv !== undefined) assertApiKeyEnv(input.apiKeyEnv);
  const previousApiKeyEnv = previousGateway.provider === provider && typeof previousGateway.apiKeyEnv === "string"
    && /^[A-Za-z_][A-Za-z0-9_]*$/.test(previousGateway.apiKeyEnv)
    ? previousGateway.apiKeyEnv
    : undefined;
  const gateway = {
    provider,
    protocol: input.protocol ?? (previousGateway.provider === provider && typeof previousGateway.protocol === "string"
      ? previousGateway.protocol
      : defaultProtocol(provider)),
    baseURL: input.baseURL.replace(/\/$/, ""),
    apiKeyEnv: input.apiKeyEnv ?? previousApiKeyEnv ?? defaultApiKeyEnv(provider),
    ...(typeof previousGateway.timeoutMs === "number" ? { timeoutMs: previousGateway.timeoutMs } : {}),
  };
  const updated: Record<string, unknown> = { ...existing, gateway };
  if (input.model !== undefined) updated.model = input.model;
  atomicWrite(path, `${JSON.stringify(updated, null, 2)}\n`);
  return path;
}

export function persistGatewayConfig(input: PersistedGatewayConfig & { apiKey: string }): {
  configPath: string;
  schedulerEnvPath: string;
} {
  const apiKeyEnv = input.apiKeyEnv ?? defaultApiKeyEnv(input.provider);
  return {
    configPath: writeGlobalConfig({ ...input, apiKeyEnv }),
    schedulerEnvPath: writeSchedulerEnv(apiKeyEnv, input.apiKey),
  };
}

export function writeSchedulerEnv(apiKeyEnv: string, apiKey: string): string {
  assertApiKeyEnv(apiKeyEnv);
  const path = schedulerEnvPath();
  const lines = existsSync(path)
    ? readFileSync(path, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter((line) => {
      return !line || line.startsWith("#") || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(line);
    })
    : [];
  const assignment = apiKeyEnv + "=" + apiKey.replace(/[\r\n]/g, "");
  const escaped = apiKeyEnv.replace(/[.*+?^\\${}()|[\]\\]/g, "\\$&");
  const index = lines.findIndex((line) => new RegExp("^" + escaped + "=", process.platform === "win32" ? "i" : "").test(line));
  if (index >= 0) lines[index] = assignment;
  else {
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push(assignment);
  }
  atomicWrite(path, lines.join("\n") + "\n");
  return path;
}

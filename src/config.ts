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
  automation: {
    providerRetryMaxAttempts: 8,
    providerRetryMaxElapsedMs: 15 * 60_000,
    agentTurnTimeoutMs: 45 * 60_000,
    scheduledTurnTimeoutMs: 2 * 60 * 60_000,
  },
  maintenance: {
    runOnStartup: true,
    reconcileOrphanedTools: true,
    agentSessions: {
      maxAgeMs: 30 * 24 * 60 * 60_000,
      minAgeMs: 60 * 60_000,
      maxSessions: 500,
      maxLogicalBytes: 512 * 1024 * 1024,
      maxSessionsPerRun: 25,
      maxLogicalBytesPerRun: 64 * 1024 * 1024,
    },
    detachedArtifacts: {
      maxAgeMs: 30 * 24 * 60 * 60_000,
      minAgeMs: 60 * 60_000,
      maxArtifacts: 1_000,
      maxBytes: 1024 * 1024 * 1024,
      maxArtifactsPerRun: 100,
      maxBytesPerRun: 128 * 1024 * 1024,
    },
    schedulerHistory: {
      outputRetentionMs: 30 * 24 * 60 * 60_000,
      occurrenceRetentionMs: 90 * 24 * 60 * 60_000,
      acknowledgedInboxRetentionMs: 30 * 24 * 60 * 60_000,
      deletedJobRetentionMs: 30 * 24 * 60 * 60_000,
      minOccurrencesPerJob: 20,
      batchSize: 500,
    },
  },
};

type PartialMaintenanceConfig = {
  runOnStartup?: boolean;
  reconcileOrphanedTools?: boolean;
  agentSessions?: Partial<GlassConfig["maintenance"]["agentSessions"]>;
  detachedArtifacts?: Partial<GlassConfig["maintenance"]["detachedArtifacts"]>;
  schedulerHistory?: Partial<GlassConfig["maintenance"]["schedulerHistory"]>;
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
  automation?: Partial<GlassConfig["automation"]>;
  maintenance?: PartialMaintenanceConfig;
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

function assertGatewayBaseURL(baseURL: string): void {
  if (typeof baseURL !== "string" || !/^https?:\/\//.test(baseURL)) {
    throw new Error("gateway baseURL must be HTTP or HTTPS");
  }
  const url = new URL(baseURL);
  if (url.username || url.password) throw new Error("gateway baseURL must not contain credentials");
  if (url.search || url.hash) throw new Error("gateway baseURL must not contain a query or fragment");
}

const AGENT_SESSION_MAINTENANCE_KEYS = [
  "maxAgeMs", "minAgeMs", "maxSessions", "maxLogicalBytes", "maxSessionsPerRun", "maxLogicalBytesPerRun",
] as const;
const DETACHED_ARTIFACT_MAINTENANCE_KEYS = [
  "maxAgeMs", "minAgeMs", "maxArtifacts", "maxBytes", "maxArtifactsPerRun", "maxBytesPerRun",
] as const;
const SCHEDULER_HISTORY_MAINTENANCE_KEYS = [
  "outputRetentionMs", "occurrenceRetentionMs", "acknowledgedInboxRetentionMs",
  "deletedJobRetentionMs", "minOccurrencesPerJob", "batchSize",
] as const;

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
  const automation = nested("automation", [
    "providerRetryMaxAttempts", "providerRetryMaxElapsedMs", "agentTurnTimeoutMs", "scheduledTurnTimeoutMs",
  ]);
  if (automation) result.automation = automation;
  const maintenanceValue = object.maintenance;
  if (maintenanceValue !== undefined) {
    if (!isObject(maintenanceValue)) throw new Error(`Invalid config ${path}: maintenance expected an object`);
    const maintenance = pick(maintenanceValue, ["runOnStartup", "reconcileOrphanedTools"]);
    const maintenanceSections: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["agentSessions", AGENT_SESSION_MAINTENANCE_KEYS],
      ["detachedArtifacts", DETACHED_ARTIFACT_MAINTENANCE_KEYS],
      ["schedulerHistory", SCHEDULER_HISTORY_MAINTENANCE_KEYS],
    ];
    for (const [name, keys] of maintenanceSections) {
      const sectionValue = maintenanceValue[name];
      if (sectionValue === undefined) continue;
      if (!isObject(sectionValue)) throw new Error(`Invalid config ${path}: maintenance.${name} expected an object`);
      maintenance[name] = pick(sectionValue, keys);
    }
    result.maintenance = maintenance as PartialMaintenanceConfig;
  }
  return result as PartialConfig;
}

function mergeMaintenance(
  base: GlassConfig["maintenance"],
  override: PartialMaintenanceConfig | undefined,
): GlassConfig["maintenance"] {
  if (!override) return base;
  return {
    ...base,
    ...override,
    agentSessions: { ...base.agentSessions, ...override.agentSessions },
    detachedArtifacts: { ...base.detachedArtifacts, ...override.detachedArtifacts },
    schedulerHistory: { ...base.schedulerHistory, ...override.schedulerHistory },
  };
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
    automation: { ...base.automation, ...override.automation },
    maintenance: mergeMaintenance(base.maintenance, override.maintenance),
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
    assertGatewayBaseURL(gateway.baseURL);
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
  for (const [name, value] of Object.entries(config.automation)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_646) {
      throw new Error(`automation.${name} must be a positive safe integer no greater than 2147483646`);
    }
  }
  if (typeof config.maintenance.runOnStartup !== "boolean") {
    throw new Error("maintenance.runOnStartup must be a boolean");
  }
  if (typeof config.maintenance.reconcileOrphanedTools !== "boolean") {
    throw new Error("maintenance.reconcileOrphanedTools must be a boolean");
  }
  const maintenanceSections = [
    ["agentSessions", config.maintenance.agentSessions],
    ["detachedArtifacts", config.maintenance.detachedArtifacts],
    ["schedulerHistory", config.maintenance.schedulerHistory],
  ] as const;
  for (const [sectionName, section] of maintenanceSections) {
    for (const [name, value] of Object.entries(section)) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`maintenance.${sectionName}.${name} must be a non-negative safe integer`);
      }
    }
  }
  for (const [sectionName, keys] of [
    ["agentSessions", ["maxSessionsPerRun", "maxLogicalBytesPerRun"]],
    ["detachedArtifacts", ["maxArtifactsPerRun", "maxBytesPerRun"]],
    ["schedulerHistory", ["batchSize"]],
  ] as const) {
    const section = config.maintenance[sectionName];
    for (const name of keys) {
      const value = (section as unknown as Record<string, number>)[name];
      if (value === undefined || value < 1) {
        throw new Error(`maintenance.${sectionName}.${name} must be at least 1`);
      }
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
  const layers = [
    ...globalPaths.map((path) => ({ path, allowMaintenance: true })),
    ...projectPaths.map((path) => ({ path, allowMaintenance: false })),
    ...(explicit ? [{ path: explicit, allowMaintenance: true }] : []),
  ];
  for (const { path, allowMaintenance } of layers) {
    if (!existsSync(path)) continue;
    try {
      const override = parseConfigFile(path);
      // Retention operates on the shared state database, not one workspace.
      // Project files therefore cannot choose policy for other workspaces.
      if (!allowMaintenance) delete override.maintenance;
      const candidate = merge(config, override);
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
  automation?: Partial<GlassConfig["automation"]>;
  maintenance?: PartialMaintenanceConfig;
}

function assertApiKeyEnv(apiKeyEnv: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new Error("gateway apiKeyEnv must be a valid environment variable name");
  }
}

const AUTOMATION_CONFIG_KEYS = [
  "providerRetryMaxAttempts",
  "providerRetryMaxElapsedMs",
  "agentTurnTimeoutMs",
  "scheduledTurnTimeoutMs",
] as const;

function sanitizedAutomation(
  value: unknown,
  rejectInvalid: boolean,
): Partial<GlassConfig["automation"]> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (rejectInvalid) throw new Error("automation must be an object");
    return undefined;
  }
  const result: Partial<GlassConfig["automation"]> = {};
  for (const key of AUTOMATION_CONFIG_KEYS) {
    const candidate = (value as Record<string, unknown>)[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== "number"
      || !Number.isSafeInteger(candidate) || candidate < 1 || candidate > 2_147_483_646) {
      if (rejectInvalid) throw new Error(`automation.${key} must be a positive safe integer no greater than 2147483646`);
      continue;
    }
    result[key] = candidate;
  }
  return result;
}

function sanitizedMaintenance(value: unknown, rejectInvalid: boolean): PartialMaintenanceConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (rejectInvalid) throw new Error("maintenance must be an object");
    return undefined;
  }
  const object = value as Record<string, unknown>;
  const result: PartialMaintenanceConfig = {};
  for (const key of ["runOnStartup", "reconcileOrphanedTools"] as const) {
    const candidate = object[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== "boolean") {
      if (rejectInvalid) throw new Error(`maintenance.${key} must be a boolean`);
      continue;
    }
    result[key] = candidate;
  }
  const sections = [
    ["agentSessions", AGENT_SESSION_MAINTENANCE_KEYS],
    ["detachedArtifacts", DETACHED_ARTIFACT_MAINTENANCE_KEYS],
    ["schedulerHistory", SCHEDULER_HISTORY_MAINTENANCE_KEYS],
  ] as const;
  for (const [sectionName, keys] of sections) {
    const sectionValue = object[sectionName];
    if (sectionValue === undefined) continue;
    if (!sectionValue || typeof sectionValue !== "object" || Array.isArray(sectionValue)) {
      if (rejectInvalid) throw new Error(`maintenance.${sectionName} must be an object`);
      continue;
    }
    const section: Record<string, number> = {};
    for (const key of keys) {
      const candidate = (sectionValue as Record<string, unknown>)[key];
      if (candidate === undefined) continue;
      const minimum = key.endsWith("PerRun") || (sectionName === "schedulerHistory" && key === "batchSize") ? 1 : 0;
      if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < minimum) {
        if (rejectInvalid) {
          throw new Error(`maintenance.${sectionName}.${key} must be a ${minimum === 1 ? "positive" : "non-negative"} safe integer`);
        }
        continue;
      }
      section[key] = candidate;
    }
    result[sectionName] = section;
  }
  return result;
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
    automation: {
      providerRetryMaxAttempts: config.automation.providerRetryMaxAttempts,
      providerRetryMaxElapsedMs: config.automation.providerRetryMaxElapsedMs,
      agentTurnTimeoutMs: config.automation.agentTurnTimeoutMs,
      scheduledTurnTimeoutMs: config.automation.scheduledTurnTimeoutMs,
    },
    maintenance: {
      runOnStartup: config.maintenance.runOnStartup,
      reconcileOrphanedTools: config.maintenance.reconcileOrphanedTools,
      agentSessions: {
        maxAgeMs: config.maintenance.agentSessions.maxAgeMs,
        minAgeMs: config.maintenance.agentSessions.minAgeMs,
        maxSessions: config.maintenance.agentSessions.maxSessions,
        maxLogicalBytes: config.maintenance.agentSessions.maxLogicalBytes,
        maxSessionsPerRun: config.maintenance.agentSessions.maxSessionsPerRun,
        maxLogicalBytesPerRun: config.maintenance.agentSessions.maxLogicalBytesPerRun,
      },
      detachedArtifacts: {
        maxAgeMs: config.maintenance.detachedArtifacts.maxAgeMs,
        minAgeMs: config.maintenance.detachedArtifacts.minAgeMs,
        maxArtifacts: config.maintenance.detachedArtifacts.maxArtifacts,
        maxBytes: config.maintenance.detachedArtifacts.maxBytes,
        maxArtifactsPerRun: config.maintenance.detachedArtifacts.maxArtifactsPerRun,
        maxBytesPerRun: config.maintenance.detachedArtifacts.maxBytesPerRun,
      },
      schedulerHistory: {
        outputRetentionMs: config.maintenance.schedulerHistory.outputRetentionMs,
        occurrenceRetentionMs: config.maintenance.schedulerHistory.occurrenceRetentionMs,
        acknowledgedInboxRetentionMs: config.maintenance.schedulerHistory.acknowledgedInboxRetentionMs,
        deletedJobRetentionMs: config.maintenance.schedulerHistory.deletedJobRetentionMs,
        minOccurrencesPerJob: config.maintenance.schedulerHistory.minOccurrencesPerJob,
        batchSize: config.maintenance.schedulerHistory.batchSize,
      },
    },
  };
}

function atomicWrite(path: string, contents: string, mode = 0o600): void {
  mkdirSync(configDir(), shouldEnforcePosixPermissions() ? { recursive: true, mode: 0o700 } : { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const backup = `${path}.${process.pid}.${randomUUID()}.bak`;
  try {
    writeFileSync(temporary, contents, shouldEnforcePosixPermissions() ? { encoding: "utf8", mode } : "utf8");
    if (shouldEnforcePosixPermissions()) chmodSync(temporary, mode);
    try {
      renameSync(temporary, path);
    } catch (error) {
      if (process.platform !== "win32" || !existsSync(path)) throw error;
      renameSync(path, backup);
      try {
        renameSync(temporary, path);
        unlinkSync(backup);
      } catch (replacementError) {
        try {
          if (!existsSync(path) && existsSync(backup)) renameSync(backup, path);
        } catch {
          // Preserve the replacement failure.
        }
        throw replacementError;
      }
    }
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
      if (existsSync(backup) && !existsSync(path)) renameSync(backup, path);
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
  assertGatewayBaseURL(input.baseURL);
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
  const previousAutomation = sanitizedAutomation(existing.automation, false) ?? {};
  const incomingAutomation = input.automation === undefined
    ? undefined
    : sanitizedAutomation(input.automation, true);
  const automation = input.automation === undefined
    ? previousAutomation
    : sanitizedAutomation({ ...previousAutomation, ...incomingAutomation }, true);
  const previousMaintenance = sanitizedMaintenance(existing.maintenance, false) ?? {};
  const incomingMaintenance = input.maintenance === undefined
    ? undefined
    : sanitizedMaintenance(input.maintenance, true);
  const maintenance = mergeMaintenance(
    mergeMaintenance(DEFAULT_CONFIG.maintenance, previousMaintenance),
    incomingMaintenance,
  );
  const updated: Record<string, unknown> = {
    ...existing,
    gateway,
    maintenance,
    ...(automation && Object.keys(automation).length > 0 ? { automation } : {}),
  };
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
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(apiKey)) {
    throw new Error("API key must not contain control characters");
  }
  const path = schedulerEnvPath();
  const lines = existsSync(path)
    ? readFileSync(path, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter((line) => {
      return !line || line.startsWith("#") || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(line);
    })
    : [];
  const assignment = apiKeyEnv + "=" + apiKey.replace(/[\r\n]/g, "");
  const escaped = apiKeyEnv.replace(/[.*+?^\\${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp("^" + escaped + "=", process.platform === "win32" ? "i" : "");
  const retained = lines.filter((line) => !pattern.test(line));
  while (retained.length > 0 && retained[retained.length - 1] === "") retained.pop();
  retained.push(assignment);
  atomicWrite(path, retained.join("\n") + "\n");
  return path;
}

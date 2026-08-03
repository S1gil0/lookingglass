import type { GlassDatabase } from "./storage/database.js";
import { createConnection } from "node:net";
import { checkpointDatabase, openDatabase } from "./storage/database.js";
import { ArtifactStore } from "./storage/artifact-store.js";
import { SessionStore } from "./storage/session-store.js";
import { artifactsDir, ensureStateDirectories, findWorkspaceRoot, stateDbPath } from "./paths.js";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import { loadInstructions, type LoadedInstructions } from "./instructions.js";
import { CodexLbClient, chooseModel } from "./model/codex-lb.js";
import { createCoreToolRegistry, createWorkerToolRegistry, type ToolRegistry } from "./tools/index.js";
import { ConversationEngine } from "./engine/engine.js";
import { AgentCoordinator } from "./agents/coordinator.js";
import type { GatewayModel, GatewayProvider, GlassConfig, ModelInfo, SessionRecord } from "./types.js";
import { SchedulerStore } from "./scheduler/store.js";
import {
  abortableRetryDelay,
  runWithTransientRetries,
  type ProviderRetryBudgetOptions,
  type RetryDelay,
} from "./retry.js";
import { runMaintenance as executeMaintenance, type MaintenanceMode, type MaintenanceReport } from "./maintenance.js";

const MODEL_CATALOG_TIMEOUT_MS = 10_000;
const INITIAL_SESSION_CATALOG_TIMEOUT_MS = 1_500;
const MODEL_FAILURE_COOLDOWN_MS = 30_000;
const MODEL_CACHE_TTL_MS = 30_000;
const GATEWAY_PROBE_TIMEOUT_MS = 500;
const STARTUP_MAINTENANCE_DATABASES = new Set<string>();

async function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return promise;
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new Error("Aborted"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

export class LookingGlassApp {
  readonly workspace: string;
  config: GlassConfig;
  configurationError: Error | null = null;
  readonly db: GlassDatabase;
  readonly sessions: SessionStore;
  readonly artifacts: ArtifactStore;
  client!: CodexLbClient;
  clients!: Map<GatewayProvider, CodexLbClient>;
  readonly scheduler: SchedulerStore;
  maintenanceReport: MaintenanceReport | null = null;
  maintenanceError: Error | null = null;
  tools!: ToolRegistry;
  agents!: AgentCoordinator;
  instructions!: LoadedInstructions;
  engine!: ConversationEngine;
  private readonly modelCache = new Map<GatewayProvider, ModelInfo[]>();
  private readonly modelCacheTimes = new Map<GatewayProvider, number>();
  private readonly modelRequests = new Map<GatewayProvider, Promise<ModelInfo[]>>();
  private readonly modelFailures = new Map<GatewayProvider, number>();
  private readonly modelCatalogTimeoutMs = MODEL_CATALOG_TIMEOUT_MS;
  private readonly modelCacheTtlMs = MODEL_CACHE_TTL_MS;

  constructor(cwd = process.cwd(), options: { skipStartupMaintenance?: boolean } = {}) {
    ensureStateDirectories();
    this.workspace = findWorkspaceRoot(cwd);
    try {
      this.config = loadConfig(this.workspace);
    } catch (error) {
      this.config = structuredClone(DEFAULT_CONFIG);
      this.configurationError = error instanceof Error ? error : new Error(String(error));
    }
    const databasePath = stateDbPath();
    this.db = openDatabase(databasePath);
    this.sessions = new SessionStore(this.db);
    this.artifacts = new ArtifactStore(this.db, artifactsDir());
    this.scheduler = new SchedulerStore(this.db, this.config.automation.scheduledTurnTimeoutMs);
    if (!options.skipStartupMaintenance
      && this.config.maintenance.runOnStartup
      && !STARTUP_MAINTENANCE_DATABASES.has(databasePath)) {
      // Mark first so a partial failure is not retried implicitly in this
      // process. Operators can inspect or explicitly rerun maintenance.
      STARTUP_MAINTENANCE_DATABASES.add(databasePath);
      try {
        this.maintenanceReport = this.runMaintenance("apply");
      } catch (error) {
        this.maintenanceError = error instanceof Error ? error : new Error(String(error));
      }
    }
    this.rebuildRuntime();
  }

  runMaintenance(mode: MaintenanceMode = "dry-run", now = Date.now()): MaintenanceReport {
    const report = executeMaintenance(
      this.sessions,
      this.artifacts,
      this.scheduler,
      this.config,
      mode,
      now,
    );
    this.maintenanceReport = report;
    this.maintenanceError = null;
    return report;
  }

  private rebuildRuntime(): void {
    this.scheduler.setSessionPromptTimeout(this.config.automation.scheduledTurnTimeoutMs);
    this.clients?.forEach((client) => client.close());
    const clients = new Map([this.config.gateway, ...this.config.gateways].map((gateway) => {
      const providerConfig = { ...this.config, gateway };
      return [gateway.provider, new CodexLbClient(providerConfig)] as const;
    }));
    const client = clients.get(this.config.gateway.provider);
    if (!client) throw new Error(`Gateway provider is not configured: ${this.config.gateway.provider}`);
    const instructions = loadInstructions(this.workspace, this.config);
    const agents = new AgentCoordinator(
      this.config,
      this.workspace,
      this.sessions,
      this.artifacts,
      (provider) => this.clientForProvider(provider),
      createWorkerToolRegistry(),
      () => this.instructions.text,
      (id, provider, signal, retryBudget) => this.modelForTurn(
        id,
        provider,
        signal ?? new AbortController().signal,
        undefined,
        abortableRetryDelay,
        retryBudget,
      ),
    );
    const tools = createCoreToolRegistry(this.scheduler, agents);
    const engine = new ConversationEngine(
      this.config,
      this.workspace,
      this.sessions,
      this.artifacts,
      (provider) => this.clientForProvider(provider),
      tools,
      instructions.text,
    );
    this.clients = clients;
    this.client = client;
    this.instructions = instructions;
    this.agents = agents;
    this.tools = tools;
    this.engine = engine;
    this.modelCache.clear();
    this.modelCacheTimes.clear();
    this.modelRequests.clear();
    this.modelFailures.clear();
  }

  /** Reload onboarding/config files and replace all config-dependent services. */
  reloadConfig(): GlassConfig {
    let next: GlassConfig;
    try {
      next = loadConfig(this.workspace);
      this.configurationError = null;
    } catch (error) {
      next = structuredClone(DEFAULT_CONFIG);
      this.configurationError = error instanceof Error ? error : new Error(String(error));
    }
    this.config = next;
    this.rebuildRuntime();
    return this.config;
  }

  reconfigure(): GlassConfig {
    return this.reloadConfig();
  }

  configuredProviders(): GatewayProvider[] {
    return [...this.clients.keys()];
  }

  hasProvider(provider: GatewayProvider): boolean {
    return this.clients.has(provider);
  }

  clientForProvider(provider: GatewayProvider): CodexLbClient {
    const client = this.clients.get(provider);
    if (!client) throw new Error(`Gateway provider is not configured: ${provider}`);
    return client;
  }

  private async probeGateway(provider: GatewayProvider, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const gateway = [this.config.gateway, ...this.config.gateways]
      .find((candidate) => candidate.provider === provider);
    if (!gateway) throw new Error(`Gateway provider is not configured: ${provider}`);
    const url = new URL(gateway.baseURL);
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: url.hostname, port });
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        if (error) reject(error);
        else resolve();
      };
      const abort = (): void => finish(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
      const timer = setTimeout(() => {
        finish(new Error(`Gateway model catalog probe timed out: ${provider}`));
      }, GATEWAY_PROBE_TIMEOUT_MS);
      socket.once("connect", () => finish());
      socket.once("error", (error) => finish(error));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  async modelsForProvider(provider: GatewayProvider, refresh = false, signal?: AbortSignal): Promise<ModelInfo[]> {
    signal?.throwIfAborted();
    const cached = this.modelCache.get(provider);
    if (cached && !refresh) return cached;
    const pending = this.modelRequests.get(provider);
    if (pending) return waitWithSignal(pending, signal);
    const request = this.clientForProvider(provider).models(signal).then((models) => {
      this.modelCache.set(provider, models);
      this.modelCacheTimes.set(provider, Date.now());
      this.modelFailures.delete(provider);
      return models;
    }).finally(() => {
      if (this.modelRequests.get(provider) === request) this.modelRequests.delete(provider);
    });
    this.modelRequests.set(provider, request);
    return waitWithSignal(request, signal);
  }

  private async catalogModelsForProvider(
    provider: GatewayProvider,
    refresh = false,
    signal?: AbortSignal,
    timeoutMs = this.modelCatalogTimeoutMs,
  ): Promise<GatewayModel[]> {
    signal?.throwIfAborted();
    const cached = this.modelCache.get(provider);
    const cacheTime = this.modelCacheTimes.get(provider) ?? 0;
    const stale = !cached || Date.now() - cacheTime >= this.modelCacheTtlMs;
    const failedAt = this.modelFailures.get(provider);
    if (!refresh && stale && failedAt !== undefined
      && Date.now() - failedAt < MODEL_FAILURE_COOLDOWN_MS) {
      if (cached) return cached.map((model) => ({ ...model, provider }));
      throw new Error(`Gateway model catalog is temporarily unavailable: ${provider}`);
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      if (stale && !this.modelRequests.has(provider)) {
        await this.probeGateway(provider, requestSignal);
      }
      return (await this.modelsForProvider(provider, refresh || stale, requestSignal))
        .map((model) => ({ ...model, provider }));
    } catch (error) {
      if (timeout.aborted && !signal?.aborted) this.modelRequests.delete(provider);
      if (!refresh && cached && !signal?.aborted) {
        this.modelFailures.set(provider, Date.now());
        return cached.map((model) => ({ ...model, provider }));
      }
      if (!signal?.aborted) {
        this.modelCache.delete(provider);
        this.modelCacheTimes.delete(provider);
        this.modelFailures.set(provider, Date.now());
      }
      if (timeout.aborted && !signal?.aborted) {
        throw new Error(`Gateway model catalog timed out after ${timeoutMs}ms: ${provider}`, {
          cause: error,
        });
      }
      throw error;
    }
  }

  async models(refresh = false, signal?: AbortSignal): Promise<GatewayModel[]> {
    const results = await Promise.allSettled(this.configuredProviders().map((provider) => {
      return this.catalogModelsForProvider(provider, refresh, signal);
    }));
    signal?.throwIfAborted();
    const models = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (models.length === 0) {
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      throw failure?.reason ?? new Error("No configured gateway returned a model");
    }
    return models;
  }

  async catalogModel(id: string, provider: GatewayProvider, signal?: AbortSignal): Promise<GatewayModel> {
    const models = await this.catalogModelsForProvider(provider, false, signal);
    const match = models.find((model) => model.id === id);
    if (!match) throw new Error(`Model is not available: ${provider}:${id}`);
    return match;
  }

  async modelForTurn(
    id: string,
    provider: GatewayProvider,
    signal: AbortSignal,
    onStatus?: (status: string) => void,
    delay: RetryDelay = abortableRetryDelay,
    retryBudget?: ProviderRetryBudgetOptions,
  ): Promise<GatewayModel> {
    const budgetOptions = retryBudget
      ? {
          maxAttempts: retryBudget.maxAttempts,
          maxElapsedMs: retryBudget.maxElapsedMs,
        }
      : {};
    return runWithTransientRetries(
      async (requestSignal, attempt) => {
        // A failed catalog request is placed in a short cooldown for normal
        // UI lookups. An automated logical operation must be allowed to spend
        // its own independent retry budget, so clear that local cache marker
        // before each retry attempt.
        if (attempt > 1 && retryBudget) this.modelFailures?.delete(provider);
        return this.catalogModel(id, provider, requestSignal);
      },
      signal,
      { ...budgetOptions, ...(onStatus ? { onStatus } : {}), delay },
    );
  }

  async model(id: string, signal?: AbortSignal, provider?: GatewayProvider): Promise<GatewayModel> {
    const candidates = provider
      ? await this.catalogModelsForProvider(provider, false, signal)
      : await this.models(false, signal);
    const matches = candidates.filter((model) => model.id === id);
    if (matches.length > 1) throw new Error(`Model id is ambiguous across gateways: ${id}`);
    const match = matches[0];
    if (!match) throw new Error(`Model is not available: ${id}`);
    return match;
  }

  async createSession(signal?: AbortSignal): Promise<SessionRecord> {
    let model: ModelInfo;
    try {
      const models = await this.catalogModelsForProvider(
        this.config.gateway.provider,
        false,
        signal,
        signal ? MODEL_CATALOG_TIMEOUT_MS : INITIAL_SESSION_CATALOG_TIMEOUT_MS,
      );
      if (models.length === 0) throw new Error("Gateway returned no usable models");
      model = chooseModel(models, this.config.model);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof Error && error.message.startsWith("Configured model is not available:")) throw error;
      // A session is still useful for onboarding and /config when the gateway
      // is offline. Keep an explicitly selected model when one was supplied.
      if (this.config.model) {
        model = {
          id: this.config.model,
          name: this.config.model,
          description: "Configured model (catalog unavailable)",
          contextWindow: 0,
          maxOutputTokens: null,
          reasoningEfforts: [this.config.reasoningEffort],
          defaultReasoningEffort: this.config.reasoningEffort,
          defaultVerbosity: this.config.verbosity,
          supportsReasoning: true,
          supportsImages: false,
          supportsParallelToolCalls: false,
          supportsFast: false,
          priority: 0,
        };
      } else {
        model = {
          id: "unconfigured",
          name: "Unconfigured model",
          description: "Configure a gateway and model before sending prompts",
          contextWindow: 0,
          maxOutputTokens: null,
          reasoningEfforts: [this.config.reasoningEffort],
          defaultReasoningEffort: this.config.reasoningEffort,
          defaultVerbosity: this.config.verbosity,
          supportsReasoning: false,
          supportsImages: false,
          supportsParallelToolCalls: false,
          supportsFast: false,
          priority: 0,
        };
      }
    }
    const effort = model.reasoningEfforts.includes(this.config.reasoningEffort)
      ? this.config.reasoningEffort
      : model.defaultReasoningEffort;
    return this.sessions.create({
      workspace: this.workspace,
      provider: this.config.gateway.provider,
      model: model.id,
      reasoningEffort: effort,
      agentProvider: this.config.gateway.provider,
      agentModel: model.id,
      agentReasoningEffort: effort,
      verbosity: this.config.verbosity,
      fast: this.config.fast && model.supportsFast,
      approvalMode: this.config.tools.approval,
    });
  }

  async currentOrNewSession(id?: string, signal?: AbortSignal): Promise<SessionRecord> {
    if (id) {
      const session = this.sessions.get(id);
      if (!session) throw new Error(`Session not found: ${id}`);
      if (session.kind !== "interactive") throw new Error(`Session is not interactive: ${id}`);
      if (session.workspace !== this.workspace) {
        throw new Error(`Session belongs to ${session.workspace}; launch Looking Glass from that workspace`);
      }
      if (!this.hasProvider(session.provider)) throw new Error(`Session provider is not configured: ${session.provider}`);
      return session;
    }
    return this.sessions.listWithMessages(this.workspace, 100)
      .find((session) => this.hasProvider(session.provider)) ?? this.createSession(signal);
  }

  close(): void {
    this.clients?.forEach((client) => client.close());
    checkpointDatabase(this.db);
    this.db.close();
  }
}

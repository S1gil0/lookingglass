import type { GlassDatabase } from "./storage/database.js";
import { createConnection } from "node:net";
import { checkpointDatabase, openDatabase } from "./storage/database.js";
import { ArtifactStore } from "./storage/artifact-store.js";
import { SessionStore } from "./storage/session-store.js";
import { artifactsDir, ensureStateDirectories, findWorkspaceRoot, stateDbPath } from "./paths.js";
import { loadConfig } from "./config.js";
import { loadInstructions, type LoadedInstructions } from "./instructions.js";
import { CodexLbClient, chooseModel } from "./model/codex-lb.js";
import { createCoreToolRegistry, createWorkerToolRegistry, type ToolRegistry } from "./tools/index.js";
import { ConversationEngine } from "./engine/engine.js";
import { AgentCoordinator } from "./agents/coordinator.js";
import type { GatewayModel, GatewayProvider, GlassConfig, ModelInfo, SessionRecord } from "./types.js";
import { SchedulerStore } from "./scheduler/store.js";

const MODEL_CATALOG_TIMEOUT_MS = 2_000;
const MODEL_FAILURE_COOLDOWN_MS = 30_000;
const MODEL_CACHE_TTL_MS = 30_000;
const GATEWAY_PROBE_TIMEOUT_MS = 500;

export class LookingGlassApp {
  readonly workspace: string;
  readonly config: GlassConfig;
  readonly db: GlassDatabase;
  readonly sessions: SessionStore;
  readonly artifacts: ArtifactStore;
  readonly client: CodexLbClient;
  readonly clients: Map<GatewayProvider, CodexLbClient>;
  readonly scheduler: SchedulerStore;
  readonly tools: ToolRegistry;
  readonly agents: AgentCoordinator;
  readonly instructions: LoadedInstructions;
  readonly engine: ConversationEngine;
  private readonly modelCache = new Map<GatewayProvider, ModelInfo[]>();
  private readonly modelCacheTimes = new Map<GatewayProvider, number>();
  private readonly modelRequests = new Map<GatewayProvider, Promise<ModelInfo[]>>();
  private readonly modelFailures = new Map<GatewayProvider, number>();
  private readonly modelCatalogTimeoutMs = MODEL_CATALOG_TIMEOUT_MS;
  private readonly modelCacheTtlMs = MODEL_CACHE_TTL_MS;

  constructor(cwd = process.cwd()) {
    ensureStateDirectories();
    this.workspace = findWorkspaceRoot(cwd);
    this.config = loadConfig(this.workspace);
    this.db = openDatabase(stateDbPath());
    this.sessions = new SessionStore(this.db);
    this.artifacts = new ArtifactStore(this.db, artifactsDir());
    this.scheduler = new SchedulerStore(this.db);
    this.clients = new Map([this.config.gateway, ...this.config.gateways].map((gateway) => {
      const providerConfig = { ...this.config, gateway };
      return [gateway.provider, new CodexLbClient(providerConfig)] as const;
    }));
    this.client = this.clientForProvider(this.config.gateway.provider);
    this.instructions = loadInstructions(this.workspace, this.config);
    this.agents = new AgentCoordinator(
      this.config,
      this.workspace,
      this.sessions,
      this.artifacts,
      (provider) => this.clientForProvider(provider),
      createWorkerToolRegistry(),
      () => loadInstructions(this.workspace, this.config).text,
      (id, provider, signal) => this.catalogModel(id, provider, signal),
    );
    this.tools = createCoreToolRegistry(this.scheduler, this.agents);
    this.engine = new ConversationEngine(
      this.config,
      this.workspace,
      this.sessions,
      this.artifacts,
      (provider) => this.clientForProvider(provider),
      this.tools,
      this.instructions.text,
    );
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
    const cached = this.modelCache.get(provider);
    if (cached && !refresh) return cached;
    const pending = this.modelRequests.get(provider);
    if (pending) return pending;
    const request = this.clientForProvider(provider).models(signal).then((models) => {
      this.modelCache.set(provider, models);
      this.modelCacheTimes.set(provider, Date.now());
      this.modelFailures.delete(provider);
      return models;
    }).finally(() => {
      if (this.modelRequests.get(provider) === request) this.modelRequests.delete(provider);
    });
    this.modelRequests.set(provider, request);
    return request;
  }

  private async catalogModelsForProvider(
    provider: GatewayProvider,
    refresh = false,
    signal?: AbortSignal,
  ): Promise<GatewayModel[]> {
    const cacheTime = this.modelCacheTimes.get(provider) ?? 0;
    const stale = !this.modelCache.has(provider) || Date.now() - cacheTime >= this.modelCacheTtlMs;
    const failedAt = this.modelFailures.get(provider);
    if (!refresh && stale && failedAt !== undefined
      && Date.now() - failedAt < MODEL_FAILURE_COOLDOWN_MS) {
      throw new Error(`Gateway model catalog is temporarily unavailable: ${provider}`);
    }
    const timeout = AbortSignal.timeout(this.modelCatalogTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      if (stale && !this.modelRequests.has(provider)) {
        await this.probeGateway(provider, requestSignal);
      }
      return (await this.modelsForProvider(provider, refresh || stale, requestSignal))
        .map((model) => ({ ...model, provider }));
    } catch (error) {
      if (!signal?.aborted) {
        this.modelCache.delete(provider);
        this.modelCacheTimes.delete(provider);
        this.modelFailures.set(provider, Date.now());
      }
      throw error;
    }
  }

  async models(refresh = false, signal?: AbortSignal): Promise<GatewayModel[]> {
    const results = await Promise.allSettled(this.configuredProviders().map((provider) => {
      return this.catalogModelsForProvider(provider, refresh, signal);
    }));
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

  async model(id: string, signal?: AbortSignal, provider?: GatewayProvider): Promise<GatewayModel> {
    const candidates = provider
      ? (await this.modelsForProvider(provider, false, signal)).map((model) => ({ ...model, provider }))
      : await this.models(false, signal);
    const matches = candidates.filter((model) => model.id === id);
    if (matches.length > 1) throw new Error(`Model id is ambiguous across gateways: ${id}`);
    const match = matches[0];
    if (!match) throw new Error(`Model is not available: ${id}`);
    return match;
  }

  async createSession(signal?: AbortSignal): Promise<SessionRecord> {
    const model = chooseModel(
      await this.modelsForProvider(this.config.gateway.provider, false, signal),
      this.config.model,
    );
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
    checkpointDatabase(this.db);
    this.db.close();
  }
}

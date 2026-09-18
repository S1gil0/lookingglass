import type { CodexLbClient } from "../model/codex-lb.js";
import type { ArtifactStore } from "../storage/artifact-store.js";
import type { SessionStore } from "../storage/session-store.js";
import type { GatewayModel, GatewayProvider, GlassConfig } from "../types.js";
import { ToolPreflightError, type ToolRegistry } from "../tools/registry.js";
import type { AgentBatchRunner, AgentTaskInput, RunAgentsArgs } from "../tools/agents.js";
import type { ToolContext, ToolResult } from "../tools/types.js";
import { ConversationEngine } from "../engine/engine.js";
import { AutomatedTurnTimeoutError, type ProviderRetryBudgetOptions } from "../retry.js";
import { configuredCredentialValues, redactSensitiveText } from "../security.js";
import type { VisualizerEventBus } from "../visualizer/events.js";

interface AgentTaskResult {
  id: string;
  childSessionId: string;
  status: "succeeded" | "failed";
  model: string;
  reasoningEffort: string;
  text?: string;
  error?: string;
  code?: string;
}

const LEAF_MAX_TOOL_ROUNDS = 128;

const LEAF_INSTRUCTIONS = `You are a leaf coding agent delegated one narrow, self-contained task by a parent model.
You have fresh conversation context and do not have the parent transcript. Treat the delegated task envelope as the complete handoff. Complete only that task, then stop; do not broaden it into adjacent investigation, implementation, or review work. If the task proves broader than one bounded turn, finish the explicitly requested core where safe and report the remaining split points. Inspect the workspace and use available tools as needed. Do not create agents, schedules, or ask the operator questions. Return a concise technical result to the parent, including findings or changes, validation, blockers, and any assumptions. Other agents may share the workspace, so avoid unrelated files and coordinate only through the task boundaries.`;

function taskPrompt(task: AgentTaskInput): string {
  return [
    "Delegated leaf-agent task",
    `Task ID: ${task.id}`,
    "Context contract: You do not have the parent conversation. Everything relevant must be present below or discovered from the workspace.",
    "Scope contract: Deliver one narrow outcome in this bounded turn. Do not take on adjacent phases or unrelated cleanup.",
    "",
    task.prompt,
    "",
    "Return contract: report the result, files changed, validation performed, blockers, and assumptions. Do not address the end user directly.",
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u.test(value) ? value : undefined;
}

function progressDetail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact || undefined;
}

function reportAgentAction(
  context: ToolContext,
  identity: string,
  taskId: string,
  action: string,
  detail?: string,
): void {
  const suffix = progressDetail(detail);
  const message = `${identity} | agent ${JSON.stringify(taskId)} [${action}]${suffix ? `: ${suffix}` : ""}`;
  context.reportProgress?.(redactSensitiveText(message, configuredCredentialValues(context.config))
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " "));
}

function utf8Prefix(text: string, maxBytes: number): string {
  const data = Buffer.from(text);
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

export class AgentCoordinator implements AgentBatchRunner {
  constructor(
    private readonly config: GlassConfig,
    private readonly workspace: string,
    private readonly sessions: SessionStore,
    private readonly artifacts: ArtifactStore,
    private readonly clientFor: (provider: GatewayProvider) => CodexLbClient,
    private readonly workerTools: ToolRegistry,
    private readonly instructions: string | (() => string),
    private readonly modelFor: (
      id: string,
      provider: GatewayProvider,
      signal?: AbortSignal,
      retryBudget?: ProviderRetryBudgetOptions,
    ) => Promise<GatewayModel>,
    private readonly visualizerEvents?: VisualizerEventBus,
  ) {}

  private createEngine(): ConversationEngine {
    const sharedInstructions = typeof this.instructions === "function" ? this.instructions() : this.instructions;
    const leafConfig = structuredClone(this.config);
    leafConfig.tools.maxToolRounds = Math.min(leafConfig.tools.maxToolRounds, LEAF_MAX_TOOL_ROUNDS);
    return new ConversationEngine(
      leafConfig,
      this.workspace,
      this.sessions,
      this.artifacts,
      this.clientFor,
      this.workerTools,
      `${sharedInstructions}\n\n${LEAF_INSTRUCTIONS}`,
      undefined,
      this.visualizerEvents,
      undefined,
      undefined,
      (id, provider, signal) => this.modelFor(id, provider, signal, {
        maxAttempts: 1, maxElapsedMs: this.config.automation.providerRetryMaxElapsedMs,
      }),
    );
  }

  async run(args: RunAgentsArgs, context: ToolContext): Promise<ToolResult> {
    const ids = new Set<string>();
    for (const task of args.tasks) {
      if (ids.has(task.id)) throw new ToolPreflightError(`Duplicate agent task id: ${task.id}`);
      ids.add(task.id);
    }
    const parent = this.sessions.get(context.sessionId);
    if (!parent) throw new ToolPreflightError(`Parent session not found: ${context.sessionId}`);
    let model: GatewayModel;
    try {
      model = await this.modelFor(
        parent.agentModel,
        parent.agentProvider,
        context.signal,
        {
          maxAttempts: this.config.automation.providerRetryMaxAttempts,
          maxElapsedMs: this.config.automation.providerRetryMaxElapsedMs,
        },
      );
    } catch (error) {
      if (context.signal.aborted) throw error;
      throw new ToolPreflightError(
        `Agent model could not be resolved: ${redactSensitiveText(
          errorMessage(error),
          configuredCredentialValues(this.config),
        )}`,
        errorCode(error),
      );
    }
    const concurrency = Math.min(args.concurrency ?? 4, args.tasks.length);
    const results = new Array<AgentTaskResult>(args.tasks.length);
    let cursor = 0;
    let attempted = 0;
    const runTask = async (task: AgentTaskInput, index: number): Promise<void> => {
      context.signal.throwIfAborted();
      attempted += 1;
      const identity = `${model.provider}:${model.id} | reasoning ${parent.agentReasoningEffort}`;
      reportAgentAction(context, identity, task.id, "starting");
      const child = this.sessions.create({
        workspace: this.workspace,
        provider: model.provider,
        model: model.id,
        reasoningEffort: parent.agentReasoningEffort,
        agentProvider: model.provider,
        agentModel: model.id,
        agentReasoningEffort: parent.agentReasoningEffort,
        agentsEnabled: parent.agentsEnabled,
        verbosity: model.defaultVerbosity,
        fast: false,
        approvalMode: parent.approvalMode,
        kind: "agent",
        parentSessionId: parent.id,
      });
      this.sessions.rename(child.id, `Agent ${task.id}`);
      const agentEntityId = `agent:${child.id}`;
      const agentParentId = context.callId ? `tool:${context.callId}` : undefined;
      const agentStartedAt = Date.now();
      this.visualizerEvents?.emit({
        type: "agent.spawn",
        sessionId: parent.id,
        entityId: agentEntityId,
        agentId: task.id,
        ...(agentParentId ? { parentId: agentParentId } : {}),
        model: model.id,
        provider: model.provider,
        reasoningEffort: parent.agentReasoningEffort,
        status: "waiting",
        summary: `spawned child session ${child.id}`,
      });
      const timeoutMs = this.config.automation?.agentTurnTimeoutMs ?? 45 * 60_000;
      const timeout = new AbortController();
      let timedOut = false;
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        timeout.abort(new AutomatedTurnTimeoutError(timeoutMs));
      }, timeoutMs);
      const childSignal = AbortSignal.any([context.signal, timeout.signal]);
      try {
        this.visualizerEvents?.emit({
          type: "agent.start",
          sessionId: child.id,
          entityId: agentEntityId,
          agentId: task.id,
          ...(agentParentId ? { parentId: agentParentId } : {}),
          model: model.id,
          provider: model.provider,
          reasoningEffort: parent.agentReasoningEffort,
          status: "active",
        });
        const turn = await this.createEngine().turn(child.id, taskPrompt(task), {
          signal: childSignal,
          interaction: {
            approve: async () => "deny",
            ask: async () => "",
          },
          callbacks: {
            onStatus: (status) => reportAgentAction(context, identity, task.id, status),
            onWarning: (warning) => reportAgentAction(context, identity, task.id, "warning", warning),
            onToolStart: (notice) => reportAgentAction(
              context,
              identity,
              task.id,
              `tool ${notice.name} started`,
              notice.summary,
            ),
            onToolProgress: (notice) => reportAgentAction(
              context,
              identity,
              task.id,
              `tool ${notice.name} progress`,
              notice.output,
            ),
            onToolFinish: (notice) => reportAgentAction(
              context,
              identity,
              task.id,
              `tool ${notice.name} ${notice.failed ? "failed" : "finished"}`,
              notice.output,
            ),
          },
          modelInfo: model,
          automated: true,
          readOnly: context.readOnly || parent.approvalMode === "review",
          authorizationSessionId: context.authorizationSessionId ?? parent.id,
          visualizerParentId: agentEntityId,
          visualizerAgentId: task.id,
        });
        if (timedOut) throw timeout.signal.reason ?? new AutomatedTurnTimeoutError(timeoutMs);
        results[index] = {
          id: task.id,
          childSessionId: child.id,
          status: "succeeded",
          model: `${model.provider}:${model.id}`,
          reasoningEffort: parent.agentReasoningEffort,
          text: turn.text.trim() || "Agent completed without a text response.",
        };
        reportAgentAction(context, identity, task.id, "done");
        this.visualizerEvents?.emit({
          type: "agent.result",
          sessionId: child.id,
          entityId: agentEntityId,
          agentId: task.id,
          ...(agentParentId ? { parentId: agentParentId } : {}),
          model: model.id,
          provider: model.provider,
          reasoningEffort: parent.agentReasoningEffort,
          status: "complete",
          summary: "result returned to parent",
        });
        this.visualizerEvents?.emit({
          type: "agent.end",
          sessionId: child.id,
          entityId: agentEntityId,
          agentId: task.id,
          ...(agentParentId ? { parentId: agentParentId } : {}),
          model: model.id,
          provider: model.provider,
          reasoningEffort: parent.agentReasoningEffort,
          status: "complete",
          duration: Math.max(0, Date.now() - agentStartedAt),
        });
      } catch (error) {
        if (context.signal.aborted) {
          this.visualizerEvents?.emit({
            type: "agent.end",
            sessionId: child.id,
            entityId: agentEntityId,
            agentId: task.id,
            ...(agentParentId ? { parentId: agentParentId } : {}),
            model: model.id,
            provider: model.provider,
            reasoningEffort: parent.agentReasoningEffort,
            status: "cancelled",
            duration: Math.max(0, Date.now() - agentStartedAt),
            summary: "cancelled by parent",
          });
          throw error;
        }
        const timeoutError = timedOut || error instanceof AutomatedTurnTimeoutError;
        const code = timeoutError ? "automated_turn_timeout" : errorCode(error);
        const message = timeoutError
          ? "Automated leaf task timed out."
          : redactSensitiveText(errorMessage(error), configuredCredentialValues(this.config))
            .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").trim().slice(0, 512)
            || "Automated leaf task failed.";
        results[index] = {
          id: task.id,
          childSessionId: child.id,
          status: "failed",
          model: `${model.provider}:${model.id}`,
          reasoningEffort: parent.agentReasoningEffort,
          error: message,
          ...(code ? { code } : {}),
        };
        reportAgentAction(context, identity, task.id, timeoutError ? "timed out" : "failed", message);
        this.visualizerEvents?.emit({
          type: "agent.end",
          sessionId: child.id,
          entityId: agentEntityId,
          agentId: task.id,
          ...(agentParentId ? { parentId: agentParentId } : {}),
          model: model.id,
          provider: model.provider,
          reasoningEffort: parent.agentReasoningEffort,
          status: timeoutError ? "cancelled" : "failed",
          duration: Math.max(0, Date.now() - agentStartedAt),
          summary: message,
        });
      } finally {
        clearTimeout(timeoutTimer);
      }
    };
    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        const task = args.tasks[index];
        if (!task) return;
        await runTask(task, index);
      }
    });
    const settled = await Promise.allSettled(workers);
    context.signal.throwIfAborted();
    const failedWorker = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failedWorker) throw failedWorker.reason;
    const fullOutput = redactSensitiveText([
      `Agent batch completed with ${model.provider}:${model.id} | reasoning ${parent.agentReasoningEffort}`,
      ...results.map((result) => [
        `\n## ${result.id} [${result.status}]`,
        `child_session_id: ${result.childSessionId}`,
        `model: ${result.model}`,
        `reasoning: ${result.reasoningEffort}`,
        result.status === "succeeded" ? result.text : `error${result.code ? ` [${result.code}]` : ""}: ${result.error}`,
      ].join("\n")),
    ].join("\n"), configuredCredentialValues(this.config));
    const limit = this.config.tools.maxOutputBytes;
    if (Buffer.byteLength(fullOutput) <= limit) {
      return { output: fullOutput, metadata: { agentTasksAttempted: attempted } };
    }
    const artifact = this.artifacts.save(parent.id, "agent-results", fullOutput, {
      model: `${model.provider}:${model.id}`,
      reasoningEffort: parent.agentReasoningEffort,
      taskCount: args.tasks.length,
    });
    const suffix = `\n\nFull agent results: ${artifact.uri}`;
    const bounded = utf8Prefix(fullOutput, Math.max(0, limit - Buffer.byteLength(suffix)));
    return {
      output: `${bounded}${suffix}`,
      display: `Agent batch completed; full results saved to ${artifact.uri}`,
      artifactUri: artifact.uri,
      truncated: true,
      metadata: { agentTasksAttempted: attempted },
    };
  }
}

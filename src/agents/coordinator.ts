import type { CodexLbClient } from "../model/codex-lb.js";
import type { ArtifactStore } from "../storage/artifact-store.js";
import type { SessionStore } from "../storage/session-store.js";
import type { GatewayModel, GatewayProvider, GlassConfig } from "../types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { AgentBatchRunner, AgentTaskInput, RunAgentsArgs } from "../tools/agents.js";
import type { ToolContext, ToolResult } from "../tools/types.js";
import { ConversationEngine } from "../engine/engine.js";

interface AgentTaskResult {
  id: string;
  childSessionId: string;
  status: "succeeded" | "failed";
  model: string;
  reasoningEffort: string;
  text?: string;
  error?: string;
}

const LEAF_INSTRUCTIONS = `You are a leaf coding agent delegated one self-contained task by a parent model.
You have fresh conversation context and do not have the parent transcript. Treat the delegated task envelope as the complete handoff. Complete only that task. Inspect the workspace and use available tools as needed. Do not create agents, schedules, or ask the operator questions. Return a concise technical result to the parent, including findings or changes, validation, blockers, and any assumptions. Other agents may share the workspace, so avoid unrelated files and coordinate only through the task boundaries.`;

function taskPrompt(task: AgentTaskInput): string {
  return [
    "Delegated leaf-agent task",
    `Task ID: ${task.id}`,
    "Context contract: You do not have the parent conversation. Everything relevant must be present below or discovered from the workspace.",
    "",
    task.prompt,
    "",
    "Return contract: report the result, files changed, validation performed, blockers, and assumptions. Do not address the end user directly.",
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    private readonly modelFor: (id: string, provider: GatewayProvider, signal?: AbortSignal) => Promise<GatewayModel>,
  ) {}

  private createEngine(): ConversationEngine {
    const sharedInstructions = typeof this.instructions === "function" ? this.instructions() : this.instructions;
    return new ConversationEngine(
      this.config,
      this.workspace,
      this.sessions,
      this.artifacts,
      this.clientFor,
      this.workerTools,
      `${sharedInstructions}\n\n${LEAF_INSTRUCTIONS}`,
    );
  }

  async run(args: RunAgentsArgs, context: ToolContext): Promise<ToolResult> {
    const ids = new Set<string>();
    for (const task of args.tasks) {
      if (ids.has(task.id)) throw new Error(`Duplicate agent task id: ${task.id}`);
      ids.add(task.id);
    }
    const parent = this.sessions.get(context.sessionId);
    if (!parent) throw new Error(`Parent session not found: ${context.sessionId}`);
    const model = await this.modelFor(parent.agentModel, parent.agentProvider, context.signal);
    const concurrency = Math.min(args.concurrency ?? 4, args.tasks.length);
    const results = new Array<AgentTaskResult>(args.tasks.length);
    let cursor = 0;
    const runTask = async (task: AgentTaskInput, index: number): Promise<void> => {
      context.signal.throwIfAborted();
      const identity = `${model.provider}:${model.id} | reasoning ${parent.agentReasoningEffort}`;
      context.reportProgress?.(`${identity} | agent ${task.id} [starting]`);
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
      try {
        const turn = await this.createEngine().turn(child.id, taskPrompt(task), {
          signal: context.signal,
          interaction: {
            approve: async () => "deny",
            ask: async () => "",
          },
          callbacks: {
            onStatus: (status) => context.reportProgress?.(`${identity} | agent ${task.id} [${status}]`),
          },
          modelInfo: model,
          automated: true,
          readOnly: context.readOnly || parent.approvalMode === "review",
          authorizationSessionId: context.authorizationSessionId ?? parent.id,
        });
        results[index] = {
          id: task.id,
          childSessionId: child.id,
          status: "succeeded",
          model: `${model.provider}:${model.id}`,
          reasoningEffort: parent.agentReasoningEffort,
          text: turn.text.trim() || "Agent completed without a text response.",
        };
        context.reportProgress?.(`${identity} | agent ${task.id} [done]`);
      } catch (error) {
        if (context.signal.aborted) throw error;
        results[index] = {
          id: task.id,
          childSessionId: child.id,
          status: "failed",
          model: `${model.provider}:${model.id}`,
          reasoningEffort: parent.agentReasoningEffort,
          error: errorMessage(error),
        };
        context.reportProgress?.(`${identity} | agent ${task.id} [failed]: ${errorMessage(error)}`);
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
    const fullOutput = [
      `Agent batch completed with ${model.provider}:${model.id} | reasoning ${parent.agentReasoningEffort}`,
      ...results.map((result) => [
        `\n## ${result.id} [${result.status}]`,
        `child_session_id: ${result.childSessionId}`,
        `model: ${result.model}`,
        `reasoning: ${result.reasoningEffort}`,
        result.status === "succeeded" ? result.text : `error: ${result.error}`,
      ].join("\n")),
    ].join("\n");
    const limit = this.config.tools.maxOutputBytes;
    if (Buffer.byteLength(fullOutput) <= limit) return { output: fullOutput };
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
    };
  }
}

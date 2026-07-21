import { applyPatchTool } from "./apply-patch.js";
import { askUserTool } from "./ask.js";
import { bashTool } from "./bash.js";
import { readTool } from "./read.js";
import { ToolRegistry } from "./registry.js";
import { globTool, grepTool } from "./search.js";
import { createScheduleTools } from "./schedule.js";
import { createRunAgentsTool, type AgentBatchRunner } from "./agents.js";
import type { SchedulerStore } from "../scheduler/store.js";

export function createWorkerToolRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(readTool)
    .register(globTool)
    .register(grepTool)
    .register(applyPatchTool)
    .register(bashTool);
}

export function createCoreToolRegistry(scheduler?: SchedulerStore, agents?: AgentBatchRunner): ToolRegistry {
  const registry = new ToolRegistry()
    .register(readTool)
    .register(globTool)
    .register(grepTool)
    .register(applyPatchTool)
    .register(bashTool)
    .register(askUserTool);
  if (agents) registry.register(createRunAgentsTool(agents));
  if (scheduler) {
    for (const tool of createScheduleTools(scheduler)) registry.register(tool);
  }
  return registry;
}

export { ToolRegistry, ToolDeniedError } from "./registry.js";
export type { ApprovalDecision, ApprovalRequest, QuestionRequest, ToolContext, ToolResult } from "./types.js";
export type { AgentBatchRunner, AgentTaskInput, RunAgentsArgs } from "./agents.js";

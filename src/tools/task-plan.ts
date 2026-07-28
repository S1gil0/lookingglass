import { configuredCredentialValues, redactSensitiveText } from "../security.js";
import {
  formatTaskPlanForModel,
  normalizeTaskPlan,
  type TaskPlanItem,
} from "../task-plan.js";
import type { GlassTool, ToolContext } from "./types.js";

export interface TaskPlanArgs {
  action: "read" | "set" | "update" | "patch";
  items: TaskPlanItem[] | null;
}

const taskPlanItemSchema = {
  type: "object",
  description: "One durable work item. Update its status at the exact boundary where work starts or finishes.",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 64, description: "Stable item id used by partial updates." },
    content: { type: "string", minLength: 1, maxLength: 240, description: "Concise description of the concrete work." },
    priority: { type: "string", enum: ["high", "medium", "low"] },
    status: {
      type: "string",
      enum: ["pending", "in_progress", "completed", "cancelled"],
      description: "Set in_progress immediately before work and completed immediately after validation.",
    },
  },
  required: ["id", "content", "priority", "status"],
  additionalProperties: false,
} as const;

function requireMainSession(context: ToolContext): ToolContext["sessions"] {
  const session = context.sessions.get(context.sessionId);
  if (!session) throw new Error(`Main session not found: ${context.sessionId}`);
  if (session.kind === "agent") throw new Error("task_plan is available only in the main session");
  return context.sessions;
}

function requireExecutionToken(context: ToolContext): string {
  const token = context.executionToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Task plan write requires an active session execution lease");
  }
  return token;
}

function redactItems(items: TaskPlanItem[], context: ToolContext): TaskPlanItem[] {
  const secrets = configuredCredentialValues(context.config);
  return items.map((item) => ({
    ...item,
    id: redactSensitiveText(item.id, secrets),
    content: redactSensitiveText(item.content, secrets),
  }));
}

function terminalTransitionCount(previous: TaskPlanItem[], next: TaskPlanItem[]): number {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  return next.filter((item) => {
    const before = previousById.get(item.id);
    return before && before.status !== item.status && (item.status === "completed" || item.status === "cancelled");
  }).length;
}

function assertUnbatchedTransitions(previous: TaskPlanItem[], next: TaskPlanItem[]): void {
  if (terminalTransitionCount(previous, next) > 1) {
    throw new Error("Task plan change cannot batch multiple completed or cancelled items; patch immediately at each item boundary");
  }
}

export const taskPlanTool: GlassTool<TaskPlanArgs> = {
  name: "task_plan",
  description: "Read or maintain the internal task plan for substantial multipart work. Use set for the initial full plan or a replan. Use patch at every item boundary; it merges supplied items by id, so mark each finished item immediately instead of batching completions. Update remains a full-plan replacement for compatibility.",
  // Task plans are internal session state and do not touch the filesystem or shell.
  // Keep this readable by read-only scheduled turns so they can record progress.
  risk: "read",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["read", "set", "update", "patch"],
        description: "read uses items:null; set and update replace the full plan; patch merges supplied existing items by id.",
      },
      items: {
        type: ["array", "null"],
        maxItems: 32,
        items: taskPlanItemSchema,
        description: "For set or update, provide the complete plan. For patch, provide only the finished item and optionally the next item becoming in_progress. Never batch multiple completions.",
      },
    },
    required: ["action", "items"],
    additionalProperties: false,
  },
  summarize: (args) => args.action === "read"
    ? "Read the current internal task plan"
    : `${args.action === "set" ? "Set" : args.action === "patch" ? "Patch" : "Update"} the internal task plan with ${args.items?.length ?? 0} item${args.items?.length === 1 ? "" : "s"}`,
  async execute(args, context) {
    const sessions = requireMainSession(context);
    if (args.action === "read") {
      if (args.items !== null) throw new Error("Reading a task plan requires items: null");
      return { output: formatTaskPlanForModel(sessions.latestTaskPlan(context.sessionId)) };
    }
    if (args.items === null) throw new Error(`${args.action} requires an array of task plan items`);

    const executionToken = requireExecutionToken(context);
    if (!sessions.assertOperationToken(context.sessionId, executionToken)) {
      throw new Error("Task plan write blocked: the session operation lease is missing or stale");
    }
    const submitted = normalizeTaskPlan({ items: redactItems(args.items, context) });
    let plan = submitted;
    const current = sessions.latestTaskPlan(context.sessionId);
    if (args.action === "patch") {
      if (submitted.items.length === 0) throw new Error("Task plan patch requires at least one item");
      if (!current) throw new Error("Task plan patch requires an existing plan; use set first");
      const indices = new Map(current.plan.items.map((item, index) => [item.id, index]));
      const merged = current.plan.items.map((item) => ({ ...item }));
      for (const item of submitted.items) {
        const index = indices.get(item.id);
        if (index === undefined) throw new Error(`Task plan patch references unknown item id: ${item.id}`);
        merged[index] = item;
      }
      plan = normalizeTaskPlan({ items: merged });
      assertUnbatchedTransitions(current.plan.items, plan.items);
    } else if (args.action === "update" && current) {
      assertUnbatchedTransitions(current.plan.items, submitted.items);
    }
    const saved = sessions.saveTaskPlan(context.sessionId, executionToken, plan);
    if (!saved) throw new Error("Task plan write blocked: the session operation lease is missing or stale");
    return {
      output: `Task plan ${args.action} persisted at snapshot ${saved.sequence}.\n${formatTaskPlanForModel(saved)}`,
    };
  },
};
import { configuredCredentialValues, redactSensitiveText } from "../security.js";
import {
  formatTaskPlanForModel,
  normalizeTaskPlan,
  type TaskPlanItem,
} from "../task-plan.js";
import type { GlassTool, ToolContext } from "./types.js";

export interface TaskPlanArgs {
  action: "read" | "set" | "update";
  items: TaskPlanItem[] | null;
}

const taskPlanItemSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 64 },
    content: { type: "string", minLength: 1, maxLength: 240 },
    priority: { type: "string", enum: ["high", "medium", "low"] },
    status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
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

export const taskPlanTool: GlassTool<TaskPlanArgs> = {
  name: "task_plan",
  description: "Read or update the internal task plan for substantial multipart work in the main session.",
  // Task plans are internal session state and do not touch the filesystem or shell.
  // Keep this readable by read-only scheduled turns so they can record progress.
  risk: "read",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["read", "set", "update"] },
      items: {
        type: ["array", "null"],
        maxItems: 32,
        items: taskPlanItemSchema,
      },
    },
    required: ["action", "items"],
    additionalProperties: false,
  },
  summarize: (args) => args.action === "read"
    ? "Read the current internal task plan"
    : `${args.action === "set" ? "Set" : "Update"} the internal task plan with ${args.items?.length ?? 0} item${args.items?.length === 1 ? "" : "s"}`,
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
    const plan = normalizeTaskPlan({ items: redactItems(args.items, context) });
    const saved = sessions.saveTaskPlan(context.sessionId, executionToken, plan);
    if (!saved) throw new Error("Task plan write blocked: the session operation lease is missing or stale");
    return { output: formatTaskPlanForModel(saved) };
  },
};
import type { GlassTool, ToolContext, ToolResult } from "./types.js";

export interface AgentTaskInput {
  id: string;
  prompt: string;
}

export interface RunAgentsArgs {
  tasks: AgentTaskInput[];
  concurrency: number | null;
}

export interface AgentBatchRunner {
  run(args: RunAgentsArgs, context: ToolContext): Promise<ToolResult>;
}

export function createRunAgentsTool(runner: AgentBatchRunner): GlassTool<RunAgentsArgs> {
  return {
    name: "run_agents",
    description: "Run one or more independent leaf agents concurrently using the session's configured agent model and reasoning effort. This tool is available at any point in a main turn: use it just in time for independent discovery, disjoint implementation, newly discovered branches, or focused post-change review rather than automatically at the start. Keep dependent work and overlapping file edits sequential. Every agent starts with fresh conversation context and does not receive the parent transcript. Each prompt must include all relevant background, objective, file scope, constraints, validation, and expected return details. Agents share project instructions and the workspace but cannot spawn more agents.",
    risk: "write",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1, maxLength: 64 },
              prompt: { type: "string", minLength: 1, maxLength: 32_000 },
            },
            required: ["id", "prompt"],
            additionalProperties: false,
          },
        },
        concurrency: { type: ["integer", "null"], minimum: 1, maximum: 8 },
      },
      required: ["tasks", "concurrency"],
      additionalProperties: false,
    },
    summarize: ({ tasks, concurrency }) => {
      const parallel = concurrency ?? Math.min(4, tasks.length);
      return `Run ${tasks.length} agent${tasks.length === 1 ? "" : "s"} with concurrency ${parallel}`;
    },
    execute: (args, context) => runner.run(args, context),
  };
}

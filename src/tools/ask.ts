import type { GlassTool } from "./types.js";

interface AskArgs {
  question: string;
  options: string[] | null;
}

export const askUserTool: GlassTool<AskArgs> = {
  name: "ask_user",
  description: "Ask the user for information that is required to continue. Use only when the answer cannot be inferred safely.",
  risk: "read",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", minLength: 1 },
      options: {
        type: ["array", "null"],
        items: { type: "string", minLength: 1 },
        maxItems: 8,
      },
    },
    required: ["question", "options"],
    additionalProperties: false,
  },
  summarize: (args) => args.question,
  async execute(args, context) {
    const answer = await context.ask({
      question: args.question,
      ...(args.options ? { options: args.options } : {}),
    });
    return { output: answer };
  },
};

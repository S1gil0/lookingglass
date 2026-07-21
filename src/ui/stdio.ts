import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { EngineCallbacks, EngineInteraction } from "../engine/engine.js";
import type { ApprovalDecision, ApprovalRequest, QuestionRequest } from "../tools/index.js";

export function terminalSafe(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

async function promptLine(prompt: string): Promise<string> {
  if (!stdin.isTTY) throw new Error("Interactive input is required but stdin is not a TTY");
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return await readline.question(prompt);
  } finally {
    readline.close();
  }
}

export function stdioInteraction(assumeYes: boolean): EngineInteraction {
  return {
    async approve(request: ApprovalRequest): Promise<ApprovalDecision> {
      if (assumeYes && request.risk !== "persistent" && request.risk !== "critical") return "once";
      process.stderr.write(`\nApproval required: ${terminalSafe(request.summary)}\n${terminalSafe(request.details)}\n`);
      if (!stdin.isTTY) return "deny";
      const answer = await promptLine(request.canAlwaysApprove ? "Approve? [y/N/a=always] " : "Approve? [y/N] ");
      if (/^(y|yes)$/i.test(answer.trim())) return "once";
      if (request.canAlwaysApprove && /^(a|always)$/i.test(answer.trim())) return "always";
      return "deny";
    },
    async ask(request: QuestionRequest): Promise<string> {
      process.stderr.write(`\n${terminalSafe(request.question)}\n`);
      if (request.options) process.stderr.write(`${request.options.map((value, index) => `${index + 1}. ${terminalSafe(value)}`).join("\n")}\n`);
      return promptLine("> ");
    },
  };
}

export function stdioCallbacks(): EngineCallbacks {
  return {
    onTextDelta(delta) {
      process.stdout.write(terminalSafe(delta));
    },
    onReasoningDelta(delta) {
      if (process.env.LOOKING_GLASS_SHOW_REASONING === "1") process.stderr.write(`\x1b[2m${terminalSafe(delta)}\x1b[0m`);
    },
    onStatus(status) {
      if (process.stderr.isTTY) process.stderr.write(`\r\x1b[2m${terminalSafe(status).padEnd(32)}\x1b[0m`);
    },
    onWarning(message) {
      process.stderr.write(`\nWarning: ${terminalSafe(message)}\n`);
    },
    onToolStart(notice) {
      process.stderr.write(`\n\x1b[36m[${terminalSafe(notice.name)}]\x1b[0m ${terminalSafe(notice.summary)}\n`);
    },
    onToolFinish(notice) {
      const marker = notice.failed ? "failed" : "done";
      process.stderr.write(`\x1b[2m[${terminalSafe(notice.name)}: ${marker}]\x1b[0m\n`);
    },
  };
}

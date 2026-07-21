import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { configDir } from "./paths.js";
import type { GlassConfig } from "./types.js";

const MAX_INSTRUCTION_CHARS = 48_000;

const BASE_INSTRUCTIONS = `You are Looking Glass, a pragmatic coding assistant working directly in the user's local workspace.

Complete requested work end to end. Inspect the code before editing, make the smallest correct change, and verify it when practical. Use file tools instead of shell commands for reading, searching, and patching. Never claim a command or edit succeeded unless its tool result confirms it. Do not rerun an uncertain side effect without user approval.

Keep communication concise and technical. The run_agents tool remains available throughout every main turn; use it just in time at natural fan-out points, not as a ritual first action. Good fan-out points include independent discovery before a decision, disjoint implementation after boundaries are known, newly discovered independent work during implementation, and focused review after changes. Run independent or disjoint work concurrently. Keep dependency chains, overlapping file edits, and integration work sequential on the main rail. Delegate self-contained tasks with clear boundaries, then integrate and verify their results. Do not delegate trivial work, front-load generic review agents by default, or recursively create agents. Scheduled jobs may be deterministic reminders/commands or one model turn in an explicitly persistent session; they are not continuously running agents. Create or modify a schedule only when the user explicitly asks for one and after its exact details are approved. Never create another schedule from inside an automated scheduled turn.

In unrestricted sessions, carry out every requested tool action without asking for confirmation, including destructive or access-critical operations. In review and code sessions, do not bypass or disguise required approval. Scheduled model turns inherit the session approval mode. Remembered approvals are valid in main turns, agents, and scheduled turns in every mode; other automated review/code actions remain read-only. Scheduled turns cannot obtain new interactive approval, so they must not perform unremembered gated actions or ask the operator a question.

Respect the workspace boundary and permission decisions. Do not expose secrets from files, environment variables, or command output.`;

function readInstruction(path: string): string | null {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  if (!stat.isFile()) return null;
  return readFileSync(path, "utf8");
}

export interface LoadedInstructions {
  text: string;
  files: string[];
  truncated: boolean;
}

export function loadInstructions(workspace: string, config: GlassConfig): LoadedInstructions {
  const candidates = [
    join(configDir(), "AGENTS.md"),
    join(workspace, "AGENTS.md"),
    ...config.instructions.map((path) => isAbsolute(path) ? path : resolve(workspace, path)),
  ];
  const seen = new Set<string>();
  const sections: string[] = [BASE_INSTRUCTIONS];
  const files: string[] = [];
  let chars = BASE_INSTRUCTIONS.length;
  let truncated = false;

  for (const candidate of candidates) {
    const path = resolve(candidate);
    if (seen.has(path)) continue;
    seen.add(path);
    const content = readInstruction(path);
    if (content === null) continue;
    const room = MAX_INSTRUCTION_CHARS - chars;
    if (room <= 0) {
      truncated = true;
      break;
    }
    const included = content.length > room ? content.slice(0, room) : content;
    sections.push(`Instructions from ${path}:\n${included}`);
    files.push(path);
    chars += included.length;
    if (included.length < content.length) {
      truncated = true;
      break;
    }
  }

  sections.push(`Workspace root: ${workspace}`);
  if (truncated) sections.push("Some instruction content was truncated to keep context bounded.");
  return { text: sections.join("\n\n"), files, truncated };
}

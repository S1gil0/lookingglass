import type { GlassTool } from "./types.js";
import { runProcess } from "./process.js";
import { resolveWorkspacePath } from "./paths.js";
import { resolveExecutableFromPath } from "./executable.js";
import { shellEnvironment } from "./safety.js";
import { credentialEnvironmentNames } from "../security.js";

interface GlobArgs {
  pattern: string;
  path: string | null;
  limit: number | null;
}

interface GrepArgs {
  pattern: string;
  path: string | null;
  include: string | null;
  limit: number | null;
}

function outputFromRg(stdout: Buffer, stderr: Buffer, exitCode: number | null, limit: number): string {
  const error = stderr.toString("utf8").trim();
  if (exitCode !== 0 && exitCode !== 1) throw new Error(error || `ripgrep exited with code ${String(exitCode)}`);
  const lines = stdout.toString("utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return "No matches found.";
  const selected = lines.slice(0, limit);
  return `${selected.join("\n")}${lines.length > limit ? `\n\n[Truncated after ${limit} matches. Narrow the search.]` : ""}`;
}

export const globTool: GlassTool<GlobArgs> = {
  name: "glob",
  description: "List workspace files matching a glob pattern. Results respect ignore files and are bounded.",
  risk: "read",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", minLength: 1 },
      path: { type: ["string", "null"], description: "Optional workspace-relative directory" },
      limit: { type: ["integer", "null"], minimum: 1, maximum: 5000 },
    },
    required: ["pattern", "path", "limit"],
    additionalProperties: false,
  },
  summarize: (args) => `Find files matching ${args.pattern}`,
  async execute(args, context) {
    const limit = Math.min(args.limit ?? 1_000, 5_000);
    const commandArgs = ["--no-config", "--path-separator", "/", "--files", "--hidden", "--glob", "!.git", "--glob", args.pattern];
    if (args.path) commandArgs.push(resolveWorkspacePath(context.workspace, args.path));
    const result = await runProcess(resolveExecutableFromPath("rg", { cwd: context.workspace }), commandArgs, {
      cwd: context.workspace,
      env: shellEnvironment(process.env, credentialEnvironmentNames(context.config)),
      timeoutMs: 30_000,
      captureBytes: context.config.tools.maxOutputBytes * 4,
      signal: context.signal,
      detached: false,
    });
    return { output: outputFromRg(result.stdout, result.stderr, result.exitCode, limit) };
  },
};

export const grepTool: GlassTool<GrepArgs> = {
  name: "grep",
  description: "Search workspace text using a regular expression. Returns file paths, line numbers, and matching lines.",
  risk: "read",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", minLength: 1, description: "Rust regular expression" },
      path: { type: ["string", "null"], description: "Optional workspace-relative path" },
      include: { type: ["string", "null"], description: "Optional file glob such as *.{ts,tsx}" },
      limit: { type: ["integer", "null"], minimum: 1, maximum: 5000 },
    },
    required: ["pattern", "path", "include", "limit"],
    additionalProperties: false,
  },
  summarize: (args) => `Search for ${args.pattern}`,
  async execute(args, context) {
    const limit = Math.min(args.limit ?? 500, 5_000);
    const commandArgs = ["--no-config", "--path-separator", "/", "--line-number", "--column", "--no-heading", "--color", "never", "--hidden", "--glob", "!.git"];
    if (args.include) commandArgs.push("--glob", args.include);
    commandArgs.push("--", args.pattern, args.path ? resolveWorkspacePath(context.workspace, args.path) : ".");
    const result = await runProcess(resolveExecutableFromPath("rg", { cwd: context.workspace }), commandArgs, {
      cwd: context.workspace,
      env: shellEnvironment(process.env, credentialEnvironmentNames(context.config)),
      timeoutMs: 30_000,
      captureBytes: context.config.tools.maxOutputBytes * 4,
      signal: context.signal,
      detached: false,
    });
    return { output: outputFromRg(result.stdout, result.stderr, result.exitCode, limit) };
  },
};

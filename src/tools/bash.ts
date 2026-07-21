import type { GlassTool } from "./types.js";
import { resolveWorkspacePath } from "./paths.js";
import { runProcess } from "./process.js";
import { bashApprovalExecutable, bashExecutionRisk, shellCommandRisk, shellEnvironment } from "./safety.js";
import { shellDefinition, shellKind } from "./shell.js";
import { configuredCredentialValues, credentialEnvironmentNames, redactSensitiveText } from "../security.js";

interface BashArgs {
  command: string;
  workdir: string | null;
  timeout_ms: number | null;
}

function exactApprovalSignature(args: BashArgs, context: Parameters<NonNullable<GlassTool<BashArgs>["execute"]>>[1]): string {
  const { cwd, timeoutMs } = prepareExecution(args, context);
  return JSON.stringify(["shell-exec", 1, shellKind(), args.command, cwd, timeoutMs]);
}

/** PowerShell approvals are intentionally never reduced to a leading token. */
export function powershellApprovalExecutable(_command: string): string | null {
  return null;
}

function shellApprovalExecutable(command: string): string | null {
  // PowerShell commands are never scoped by their leading token: wrappers,
  // aliases, and suffixes can change what actually executes. Bash retains its
  // established executable-scoped approval behavior.
  return shellKind() === "powershell" ? null : bashApprovalExecutable(command);
}

function legacyBashSignatures(
  args: BashArgs,
  context: Parameters<NonNullable<GlassTool<BashArgs>["execute"]>>[1],
): string[] {
  const { cwd, timeoutMs } = prepareExecution(args, context);
  const executable = bashApprovalExecutable(args.command);
  return [
    JSON.stringify(["bash-exec", 3, args.command, cwd, timeoutMs]),
    ...(executable ? [
      JSON.stringify(["bash-executable", 2, executable]),
      JSON.stringify([
        "bash-executable",
        1,
        bashExecutionRisk(args.command),
        executable,
        ...(!executable.startsWith("/") && executable.includes("/") ? [cwd] : []),
      ]),
    ] : []),
  ];
}

function prepareExecution(args: BashArgs, context: Parameters<NonNullable<GlassTool<BashArgs>["execute"]>>[1]): {
  cwd: string;
  timeoutMs: number;
} {
  if (args.command.includes("\0")) throw new Error("Command contains a NUL byte");
  const cwd = resolveWorkspacePath(context.workspace, args.workdir ?? ".");
  const timeoutMs = Math.min(args.timeout_ms ?? context.config.tools.shellTimeoutMs, 3_600_000);
  return { cwd, timeoutMs };
}

export const bashTool: GlassTool<BashArgs> = {
  name: "bash",
  description: shellDefinition().description,
  risk: "shell",
  classifyRisk: (args) => shellCommandRisk(args.command, shellKind()),
  approvalSignature: (args, context) => {
    prepareExecution(args, context);
    const executable = shellApprovalExecutable(args.command);
    return executable
      ? JSON.stringify(["shell-executable", 1, shellKind(), executable])
      : exactApprovalSignature(args, context);
  },
  legacyApprovalSignatures: (args, context) => {
    // Old signatures predate the shell kind and are only safe on POSIX, where
    // this tool still launches Bash. Never let them authorize PowerShell.
    return shellKind() === "bash" ? legacyBashSignatures(args, context) : [];
  },
  approvalDescription: (args) => {
    const shell = shellDefinition();
    const executable = shellApprovalExecutable(args.command);
    return executable
      ? `All ${shell.kind === "bash" ? "Bash" : "PowerShell"} commands starting with '${executable}' in this session, regardless of arguments, risk, working directory, timeout, redirects, or compound suffix. This includes main turns, agents, and scheduled turns.`
      : `Only this exact ${shell.kind === "bash" ? "Bash" : "PowerShell"} command, working directory, and timeout in this session.`;
  },
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", minLength: 1 },
      workdir: { type: ["string", "null"], description: "Optional workspace-relative working directory" },
      timeout_ms: { type: ["integer", "null"], minimum: 100, maximum: 3600000 },
    },
    required: ["command", "workdir", "timeout_ms"],
    additionalProperties: false,
  },
  summarize: (args) => `Run: ${args.command.slice(0, 160)}`,
  async execute(args, context) {
    const { cwd, timeoutMs } = prepareExecution(args, context);
    const shell = shellDefinition();
    const captureBytes = Math.max(context.config.tools.maxOutputBytes * 8, 512 * 1024);
    const secrets = configuredCredentialValues(context.config);
    const result = await runProcess(shell.executable, shell.args(args.command), {
      cwd,
      env: shellEnvironment(process.env, credentialEnvironmentNames(context.config)),
      timeoutMs,
      captureBytes,
      signal: context.signal,
    });
    const stdout = result.stdout.toString("utf8");
    const stderr = result.stderr.toString("utf8");
    const full = redactSensitiveText([
      stdout ? `stdout:\n${stdout}` : "",
      stderr ? `stderr:\n${stderr}` : "",
      `exit: ${result.exitCode === null ? result.signal ?? "unknown" : result.exitCode}${result.timedOut ? " (timed out)" : ""}`,
    ].filter(Boolean).join("\n\n"), secrets);
    const modelLimit = context.config.tools.maxOutputBytes;
    const encoded = Buffer.from(full);
    if (encoded.byteLength <= modelLimit && !result.stdoutTruncated && !result.stderrTruncated) {
      return { output: full };
    }
    const artifact = context.artifacts.save(context.sessionId, "shell-output", encoded, {
      command: redactSensitiveText(args.command, secrets),
      exitCode: result.exitCode,
      signal: result.signal,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      captureTruncated: result.stdoutTruncated || result.stderrTruncated,
    });
    const visible = encoded.subarray(0, modelLimit).toString("utf8");
    return {
      output: `${visible}\n\n[Output truncated. Full captured output: ${artifact.uri}]`,
      artifactUri: artifact.uri,
      truncated: true,
    };
  },
};

import { win32 } from "node:path";

export type ShellKind = "bash" | "powershell";

export interface ShellDefinition {
  kind: ShellKind;
  executable: string;
  args(command: string): string[];
  description: string;
}

export interface ShellOptions {
  /** Override SystemRoot in tests; production uses the host's SystemRoot. */
  systemRoot?: string;
}

const BASH_SHELL: ShellDefinition = {
  kind: "bash",
  executable: "/bin/bash",
  args: (command) => ["--noprofile", "--norc", "-c", command],
  description: "Run one noninteractive Bash command in the workspace. Do not start background jobs or commands requiring a TTY.",
};

const WINDOWS_FALLBACK_SYSTEM_ROOT = "C:\\Windows";
const POWERSHELL_UTF8_SETUP = "$OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = $OutputEncoding; ";

/**
 * Return an absolute, deterministic Windows system root. A relative
 * SystemRoot would make executable resolution depend on the working
 * directory, so it is rejected rather than used for security-sensitive
 * helpers such as PowerShell and taskkill.
 */
export function windowsSystemRoot(systemRoot: string | undefined = process.env.SystemRoot): string {
  if (systemRoot && !systemRoot.includes("\0") && /^[A-Za-z]:[\\/]/.test(systemRoot)) return win32.normalize(systemRoot);
  return WINDOWS_FALLBACK_SYSTEM_ROOT;
}

export function windowsSystemExecutable(name: string, systemRoot?: string): string {
  return win32.join(windowsSystemRoot(systemRoot), "System32", name);
}

export function powershellExecutable(systemRoot?: string): string {
  return win32.join(windowsSystemRoot(systemRoot), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function taskkillExecutable(systemRoot?: string): string {
  return windowsSystemExecutable("taskkill.exe", systemRoot);
}

/** Select arguments for a noninteractive UTF-8 Windows PowerShell process. */
export function powershellArguments(command: string): string[] {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `${POWERSHELL_UTF8_SETUP}${command}`];
}

export function shellKind(platform: NodeJS.Platform = process.platform): ShellKind {
  return platform === "win32" ? "powershell" : "bash";
}

export function shellDefinition(platform: NodeJS.Platform = process.platform, options: ShellOptions = {}): ShellDefinition {
  if (shellKind(platform) === "bash") return BASH_SHELL;
  return {
    kind: "powershell",
    executable: powershellExecutable(options.systemRoot),
    args: powershellArguments,
    description: "Run one noninteractive Windows PowerShell command in the workspace. Do not start background jobs or commands requiring a TTY.",
  };
}

export function shellCommand(platform: NodeJS.Platform = process.platform, command: string, options: ShellOptions = {}): {
  executable: string;
  args: string[];
} {
  const shell = shellDefinition(platform, options);
  return { executable: shell.executable, args: shell.args(command) };
}
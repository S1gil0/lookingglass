import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { powershellArguments, powershellExecutable } from "../tools/shell.js";

const HELPER_TIMEOUT_MS = 2_000;
const HELPER_MAX_BUFFER = 16 * 1024;

/** The small result surface needed by the helper's injectable runner. */
export interface WindowsConsoleRunnerResult {
  status: number | null;
  error?: Error | undefined;
}

export type WindowsConsoleRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptions,
) => WindowsConsoleRunnerResult;

export interface WindowsConsoleOptions {
  /** Override the host platform in tests without changing process.platform. */
  platform?: NodeJS.Platform;
  /** Override SystemRoot in tests without changing the host environment. */
  systemRoot?: string;
  /** Inject a synchronous process runner for tests. */
  runner?: WindowsConsoleRunner;
}

const ENABLE_INPUT_SCRIPT = `
$source = @'
using System;
using System.Runtime.InteropServices;

public static class LookingGlassConsoleInput
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);
}
'@
Add-Type -TypeDefinition $source
$handle = [LookingGlassConsoleInput]::GetStdHandle(-10)
[uint32]$mode = 0
if (-not [LookingGlassConsoleInput]::GetConsoleMode($handle, [ref]$mode)) { exit 1 }
if (-not [LookingGlassConsoleInput]::SetConsoleMode($handle, ($mode -bor 0x0200))) { exit 1 }
exit 0
`.trim();

function defaultRunner(command: string, args: string[], options: SpawnSyncOptions): WindowsConsoleRunnerResult {
  const result = spawnSync(command, args, options);
  return { status: result.status, error: result.error };
}

/**
 * Best-effort enablement of VT input on the inherited Windows console stdin.
 * This deliberately has no effect on other platforms and never propagates a
 * process-start or PowerShell failure into TUI startup.
 */
export function enableWindowsVirtualTerminalInput(options: WindowsConsoleOptions = {}): boolean {
  try {
    if ((options.platform ?? process.platform) !== "win32") return false;
    const runner = options.runner ?? defaultRunner;
    const result = runner(
      powershellExecutable(options.systemRoot),
      powershellArguments(ENABLE_INPUT_SCRIPT),
      {
        encoding: "utf8",
        shell: false,
        stdio: ["inherit", "pipe", "pipe"],
        windowsHide: true,
        timeout: HELPER_TIMEOUT_MS,
        maxBuffer: HELPER_MAX_BUFFER,
      },
    );
    return result.status === 0 && result.error === undefined;
  } catch {
    return false;
  }
}
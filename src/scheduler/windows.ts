import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { spawnSync } from "node:child_process";
import { configDir } from "../paths.js";
import { powershellExecutable, windowsSystemExecutable } from "../tools/shell.js";

/** The per-user task used by the scheduler on Windows. */
export const TASK_NAME = "Looking Glass Scheduler";
/** Compatibility name shared with the systemd backend's public vocabulary. */
export const SERVICE_NAME = TASK_NAME;

export const LAUNCHER_FILE_NAME = "scheduler-launcher.ps1";
export const TASK_XML_FILE_NAME = "scheduler-task.xml";

export interface WindowsCommandResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  /** Optional process details make injected command failures distinguishable in tests. */
  errorCode?: string | number;
  errorMessage?: string;
  code?: string | number;
  message?: string;
}

/**
 * This deliberately has no shell-shaped arguments.  Tests can provide this
 * function and therefore never need to invoke schtasks on the test host.
 */
export type WindowsCommandRunner = (command: string, args: string[]) => WindowsCommandResult;

export interface WindowsServiceOptions {
  command?: WindowsCommandRunner;
  /** Additional names accepted for dependency injection by embedders. */
  run?: WindowsCommandRunner;
  spawn?: WindowsCommandRunner;
  /** Alias for command, useful to callers that call this an executor. */
  exec?: WindowsCommandRunner;
  configDirectory?: string;
  taskName?: string;
  launcherPath?: string;
  taskXmlPath?: string;
  nodePath?: string;
  user?: string;
  /** Override SystemRoot in tests without changing the host environment. */
  systemRoot?: string;
  powershellPath?: string;
}

interface ResolvedWindowsServiceOptions {
  command: WindowsCommandRunner;
  configDirectory: string;
  taskName: string;
  launcherPath: string;
  taskXmlPath: string;
  nodePath: string;
  user: string;
  powershellPath: string;
  schtasksPath: string;
}

export interface TaskXmlOptions {
  taskName?: string;
  user?: string;
  /** Override SystemRoot in tests without changing the host environment. */
  systemRoot?: string;
  powershellPath?: string;
  workingDirectory?: string;
}

function defaultCommand(command: string, args: string[]): WindowsCommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  const commandResult: WindowsCommandResult = {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  if (result.error) {
    const errorCode = (result.error as NodeJS.ErrnoException).code;
    if (errorCode !== undefined) commandResult.errorCode = errorCode;
    commandResult.errorMessage = result.error.message;
  }
  return commandResult;
}

function currentTaskUser(): string {
  const domain = process.env.USERDOMAIN;
  const user = process.env.USERNAME ?? process.env.USER;
  if (domain && user) return `${domain}\\${user}`;
  return user ?? "";
}

function resolveOptions(options: WindowsServiceOptions = {}): ResolvedWindowsServiceOptions {
  const directory = options.configDirectory ?? configDir();
  const resolved = {
    command: options.command ?? options.run ?? options.spawn ?? options.exec ?? defaultCommand,
    configDirectory: directory,
    taskName: options.taskName ?? TASK_NAME,
    launcherPath: options.launcherPath ?? join(directory, LAUNCHER_FILE_NAME),
    taskXmlPath: options.taskXmlPath ?? join(directory, TASK_XML_FILE_NAME),
    nodePath: options.nodePath ?? process.execPath,
    user: options.user ?? currentTaskUser(),
    powershellPath: options.powershellPath ?? powershellExecutable(options.systemRoot),
    schtasksPath: windowsSystemExecutable("schtasks.exe", options.systemRoot),
  };
  requiredText(resolved.configDirectory, "config directory");
  requiredText(resolved.taskName, "task name");
  requiredText(resolved.launcherPath, "launcher path");
  requiredText(resolved.taskXmlPath, "task XML path");
  requiredText(resolved.nodePath, "node path");
  requiredText(resolved.user, "task user");
  requiredText(resolved.powershellPath, "PowerShell path");
  return resolved;
}

function validateXmlCharacters(value: string, label: string): void {
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const valid = codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d
      || (codePoint >= 0x20 && codePoint <= 0xd7ff)
      || (codePoint >= 0xe000 && codePoint <= 0xfffd)
      || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (!valid) throw new TypeError(`${label} contains an invalid XML control character`);
    index += codePoint > 0xffff ? 2 : 1;
  }
}

function requiredText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
  validateXmlCharacters(value, label);
  return value;
}

/** Escape a value used as a single-quoted PowerShell string literal. */
export function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Escape XML text, rejecting characters that XML 1.0 cannot represent. */
export function xmlText(value: string): string {
  if (typeof value !== "string") throw new TypeError("XML text must be a string");
  validateXmlCharacters(value, "XML text");
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Quote one argument for the command line passed to an Exec action.  The
 * launcher path is a Windows path (and thus cannot contain a double quote),
 * but handling backslashes here also makes this safe for synthetic test
 * paths and future callers.
 */
export function windowsArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/.test(value)) return value;
  let result = '"';
  let slashes = 0;
  for (const character of value) {
    if (character === "\\") {
      slashes += 1;
      continue;
    }
    if (character === '"') {
      result += "\\".repeat(slashes * 2 + 1) + '"';
      slashes = 0;
      continue;
    }
    result += "\\".repeat(slashes) + character;
    slashes = 0;
  }
  result += "\\".repeat(slashes * 2) + '"';
  return result;
}

/** Render the PowerShell process launcher used by the scheduled task. */
export function renderLauncher(nodePath: string, cliPath: string, dbPath: string): string {
  requiredText(nodePath, "node path");
  requiredText(cliPath, "CLI path");
  requiredText(dbPath, "database path");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$node = ${powerShellLiteral(nodePath)}`,
    `$cli = ${powerShellLiteral(cliPath)}`,
    `$env:LOOKING_GLASS_DB = ${powerShellLiteral(dbPath)}`,
    "& $node $cli 'cron' 'daemon'",
    "exit $LASTEXITCODE",
    "",
  ].join("\r\n");
}

/** Descriptive alias for callers that want to make the generated format explicit. */
export const renderPowerShellLauncher = renderLauncher;

function taskXmlOptions(
  userOrOptions: string | TaskXmlOptions | undefined,
  powershellPath: string | undefined,
  workingDirectory: string | undefined,
): Required<Omit<TaskXmlOptions, "systemRoot">> {
  if (typeof userOrOptions === "object" && userOrOptions !== null) {
    const options = {
      taskName: userOrOptions.taskName ?? TASK_NAME,
      user: userOrOptions.user ?? currentTaskUser(),
      powershellPath: userOrOptions.powershellPath ?? powershellExecutable(userOrOptions.systemRoot),
      workingDirectory: userOrOptions.workingDirectory ?? homedir(),
    };
    requiredText(options.taskName, "task name");
    requiredText(options.user, "task user");
    requiredText(options.powershellPath, "PowerShell path");
    requiredText(options.workingDirectory, "working directory");
    return options;
  }
  const options = {
    taskName: TASK_NAME,
    user: userOrOptions ?? currentTaskUser(),
    powershellPath: powershellPath ?? powershellExecutable(),
    workingDirectory: workingDirectory ?? homedir(),
  };
  requiredText(options.taskName, "task name");
  requiredText(options.user, "task user");
  requiredText(options.powershellPath, "PowerShell path");
  requiredText(options.workingDirectory, "working directory");
  return options;
}

/**
 * Render a Task Scheduler XML definition.  The overload accepting positional
 * values keeps this helper convenient for small, pure rendering tests.
 */
export function renderTaskXml(launcherPath: string, options?: TaskXmlOptions): string;
export function renderTaskXml(launcherPath: string, user?: string, powershellPath?: string, workingDirectory?: string): string;
export function renderTaskXml(
  launcherPath: string,
  userOrOptions: string | TaskXmlOptions | undefined = undefined,
  powershellPath?: string,
  workingDirectory?: string,
): string {
  requiredText(launcherPath, "launcher path");
  const options = taskXmlOptions(userOrOptions, powershellPath, workingDirectory);
  const commandArguments = `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ${windowsArgument(launcherPath)}`;
  // The trigger and principal deliberately share UserId: InteractiveToken
  // keeps execution tied to this user's interactive logon, while
  // LeastPrivilege avoids elevating the scheduler daemon.
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlText(options.taskName)} persistent scheduler</Description>
    <URI>\\${xmlText(options.taskName)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <UserId>${xmlText(options.user)}</UserId>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlText(options.user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlText(options.powershellPath)}</Command>
      <Arguments>${xmlText(commandArguments)}</Arguments>
      <WorkingDirectory>${xmlText(options.workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** Alias with a shorter name for callers that only need a pure renderer. */
export const renderTask = renderTaskXml;

function commandOutput(result: WindowsCommandResult): string {
  return [
    result.stdout ?? "",
    result.stderr ?? "",
    result.errorMessage ?? result.message ?? "",
  ].filter(Boolean).join("\n").trim();
}

function commandFailure(command: string, args: string[], result: WindowsCommandResult): Error {
  const code = result.errorCode ?? result.code;
  const suffix = code === undefined ? "" : ` (code ${String(code)})`;
  return new Error(commandOutput(result) || `${command} ${args.join(" ")} exited with ${String(result.status)}${suffix}`);
}

function runSchtasks(options: ResolvedWindowsServiceOptions, args: string[], tolerateFailure = false): WindowsCommandResult {
  const result = options.command(options.schtasksPath, args);
  if (result.status !== 0 && !tolerateFailure) {
    throw commandFailure(options.schtasksPath, args, result);
  }
  return result;
}

function resultCode(result: WindowsCommandResult): string {
  return String(result.errorCode ?? result.code ?? "").toLowerCase().replaceAll("_", "");
}

const TASK_NOT_FOUND_SENTINEL = "LOOKING_GLASS_TASK_NOT_FOUND";

// These are the documented Win32 / Task Scheduler values returned by the
// schtasks operation itself.  Do not add message text (or a generic
// "*not-found" code) here: a localized or otherwise unrelated failure must
// never authorize removal of the generated scheduler files.
const DOCUMENTED_MISSING_TASK_CODES = new Set([
  "2", // ERROR_FILE_NOT_FOUND
  "2147942402", // HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)
  "0x80070002", // HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)
  "2147750671", // SCHED_E_TASK_NOT_FOUND
  "0x8004130f", // SCHED_E_TASK_NOT_FOUND
  "errorfilenotfound",
  "schedetasknotfound",
]);

/** Only the internal sentinel or documented invariant codes count as missing. */
function isMissingTaskFailure(result: WindowsCommandResult): boolean {
  if (commandOutput(result).trim() === TASK_NOT_FOUND_SENTINEL) return true;
  return DOCUMENTED_MISSING_TASK_CODES.has(resultCode(result));
}

function isNotRunningFailure(result: WindowsCommandResult): boolean {
  const code = resultCode(result);
  return code === "0x8004131f" || code === "2147750687"
    || /(?:not currently running|is not running|no running instance|cannot be stopped because)/i.test(commandOutput(result));
}

function taskStateScript(taskName: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    // Enumerate tasks and filter exact root-path/name properties instead of
    // querying an absent path or name. Filtered cmdlet queries throw errors whose
    // FullyQualifiedErrorId has varied between Windows releases, while this
    // successful enumeration is independent of localization and error text.
    `  $tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskPath -eq '\\' -and $_.TaskName -eq ${powerShellLiteral(taskName)} })`,
    `  if ($tasks.Count -eq 0) { [Console]::Error.Write('${TASK_NOT_FOUND_SENTINEL}'); exit 3 }`,
    "  [Console]::Out.Write($tasks[0].State.ToString())",
    "} catch {",
    "  [Console]::Error.Write('LOOKING_GLASS_TASK_ERROR')",
    "  exit 4",
    "}",
  ].join("\r\n");
}

interface TaskLookup {
  kind: "present" | "missing";
  state?: string;
}

/** Query the enum-valued State property; never parse localized schtasks output. */
function lookupTask(options: ResolvedWindowsServiceOptions): TaskLookup {
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", taskStateScript(options.taskName)];
  const result = options.command(options.powershellPath, args);
  if (result.status === 0) {
    const state = (result.stdout ?? "").trim();
    if (state.length === 0) throw commandFailure(options.powershellPath, args, result);
    return { kind: "present", state };
  }
  if (isMissingTaskFailure(result)) return { kind: "missing" };
  throw commandFailure(options.powershellPath, args, result);
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function restoreFile(path: string, previous: Buffer | null): void {
  if (previous === null) removeFile(path);
  else writeFileSync(path, previous, { mode: 0o600 });
}

function isRenameCollision(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "EPERM" || code === "ENOTEMPTY";
}

/** Replace a completed file atomically where the host permits it. */
function replaceCompletedFile(temporaryPath: string, targetPath: string): void {
  try {
    renameSync(temporaryPath, targetPath);
    return;
  } catch (error) {
    if (!isRenameCollision(error)) throw error;
  }

  // Windows rename does not replace an existing file. Move it aside first,
  // then rename the complete temporary file into place; both operations are
  // metadata changes and never expose a partially written generated file.
  const backupPath = `${targetPath}.${randomUUID()}.bak`;
  let backedUp = false;
  try {
    try {
      renameSync(targetPath, backupPath);
      backedUp = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    renameSync(temporaryPath, targetPath);
  } catch (error) {
    if (backedUp) {
      try {
        renameSync(backupPath, targetPath);
      } catch {
        // Preserve the original failure; the caller still rolls back both files.
      }
    }
    throw error;
  }
  if (backedUp) removeFile(backupPath);
}

/** End a task before replacement/deletion; stopped tasks report a benign error. */
function endTask(options: ResolvedWindowsServiceOptions): void {
  const args = ["/End", "/TN", options.taskName];
  const result = runSchtasks(options, args, true);
  if (result.status !== 0 && !isMissingTaskFailure(result) && !isNotRunningFailure(result)) {
    throw commandFailure(options.schtasksPath, args, result);
  }
}

/** Best-effort recovery for a task stopped before a replacement/deletion failed. */
function restartTask(options: ResolvedWindowsServiceOptions): void {
  try {
    runSchtasks(options, ["/Run", "/TN", options.taskName], true);
  } catch {
    // Recovery must never replace the failure that triggered the rollback.
  }
}

/** Install or replace the current user's logon task and start it once. */
export function installService(cliPath: string, dbPath: string, serviceOptions: WindowsServiceOptions = {}): string {
  requiredText(cliPath, "CLI path");
  requiredText(dbPath, "database path");
  const options = resolveOptions(serviceOptions);
  mkdirSync(options.configDirectory, { recursive: true, mode: 0o700 });
  const previousLauncher = existsSync(options.launcherPath) ? readFileSync(options.launcherPath) : null;
  const previousXml = existsSync(options.taskXmlPath) ? readFileSync(options.taskXmlPath) : null;
  const existingTask = lookupTask(options);
  const previousTaskWasRunning = existingTask.kind === "present" && /^running$/i.test(existingTask.state ?? "");
  if (previousTaskWasRunning) endTask(options);
  // `process.argv[1]` is commonly relative when glass is launched as
  // `node dist/cli.js`; Task Scheduler will not resolve it relative to the
  // terminal that performed the install.
  const resolvedCliPath = isAbsolute(cliPath) || win32.isAbsolute(cliPath) ? cliPath : resolve(cliPath);
  const resolvedDbPath = isAbsolute(dbPath) || win32.isAbsolute(dbPath) ? dbPath : resolve(dbPath);
  const launcher = renderLauncher(options.nodePath, resolvedCliPath, resolvedDbPath);
  const xml = renderTaskXml(options.launcherPath, {
    taskName: options.taskName,
    user: options.user,
    powershellPath: options.powershellPath,
    workingDirectory: homedir(),
  });
  const tempSuffix = randomUUID();
  const temporaryLauncher = `${options.launcherPath}.${tempSuffix}.tmp`;
  const temporaryXml = `${options.taskXmlPath}.${tempSuffix}.tmp`;
  let taskCreated = false;
  try {
    // Windows PowerShell 5.1 reads UTF-8 scripts reliably only when they have
    // a BOM (important for non-ASCII usernames and installation paths).
    writeFileSync(temporaryLauncher, Buffer.from(`\uFEFF${launcher}`, "utf8"), { mode: 0o600, flag: "wx" });
    // Task Scheduler expects UTF-16 XML.  Include the BOM as required by its
    // XML importer rather than relying on the host's default encoding.
    writeFileSync(temporaryXml, `\uFEFF${xml}`, { encoding: "utf16le", mode: 0o600, flag: "wx" });
    // Both temporary files are complete before either target is replaced.
    replaceCompletedFile(temporaryLauncher, options.launcherPath);
    replaceCompletedFile(temporaryXml, options.taskXmlPath);
    runSchtasks(options, ["/Create", "/TN", options.taskName, "/XML", options.taskXmlPath, "/F"]);
    taskCreated = true;
    runSchtasks(options, ["/Run", "/TN", options.taskName]);
  } catch (error) {
    try {
      removeFile(temporaryLauncher);
    } catch {
      // Preserve the replacement failure below.
    }
    try {
      removeFile(temporaryXml);
    } catch {
      // Preserve the replacement failure below.
    }
    // Once Create succeeded, retain the matching generated files even if an
    // immediate Run is unavailable.  The logon trigger still has a valid
    // task and will start it at the next interactive logon.
    if (!taskCreated) {
      try {
        restoreFile(options.launcherPath, previousLauncher);
        restoreFile(options.taskXmlPath, previousXml);
      } catch {
        // Preserve the replacement failure below.
      }
      if (previousTaskWasRunning) restartTask(options);
    }
    throw error;
  }
  return options.taskName;
}

/**
 * Return a stable ActiveState line in addition to useful Task Scheduler
 * details. A confirmed missing task is inactive; access/operational failures
 * are surfaced instead of being misreported as an absent task.
 */
export function serviceStatus(serviceOptions: WindowsServiceOptions = {}): string {
  const options = resolveOptions(serviceOptions);
  const task = lookupTask(options);
  if (task.kind === "missing") {
    return `ActiveState=inactive\nTask=${options.taskName} is not installed`;
  }
  const status = task.state ?? "unknown";
  const active = /^running$/i.test(status);
  return [
    `TaskName=${options.taskName}`,
    `TaskStatus=${status.trim() || "unknown"}`,
    `ActiveState=${active ? "active" : "inactive"}`,
  ].join("\n");
}

/** Remove the task and only the generated scheduler definition files. */
export function uninstallService(serviceOptions: WindowsServiceOptions = {}): boolean {
  const options = resolveOptions(serviceOptions);
  const task = lookupTask(options);
  if (task.kind === "missing") {
    // A confirmed not-found result is sufficient to clean up stale generated
    // definitions; operational failures above intentionally leave them alone.
    removeFile(options.launcherPath);
    removeFile(options.taskXmlPath);
    return false;
  }
  const deleteArgs = ["/Delete", "/TN", options.taskName, "/F"];
  const previousTaskWasRunning = /^running$/i.test(task.state ?? "");
  if (previousTaskWasRunning) endTask(options);
  try {
    const deleted = runSchtasks(options, deleteArgs, true);
    if (deleted.status !== 0 && !isMissingTaskFailure(deleted)) {
      throw commandFailure(options.schtasksPath, deleteArgs, deleted);
    }
  } catch (error) {
    if (previousTaskWasRunning) restartTask(options);
    throw error;
  }
  // Only a successful delete or a confirmed race-to-not-found permits file cleanup.
  removeFile(options.launcherPath);
  removeFile(options.taskXmlPath);
  return true;
}

export interface WindowsScheduler {
  installService(cliPath: string, dbPath: string): string;
  serviceStatus(): string;
  uninstallService(): boolean;
}

/** Bind injectable options once for the platform dispatcher and tests. */
export function createWindowsScheduler(options: WindowsServiceOptions = {}): WindowsScheduler {
  return {
    installService: (cliPath, dbPath) => installService(cliPath, dbPath, options),
    serviceStatus: () => serviceStatus(options),
    uninstallService: () => uninstallService(options),
  };
}

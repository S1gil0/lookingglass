import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

/** The per-user launchd job used by the scheduler on macOS. */
export const LAUNCHD_LABEL = "com.sigil0.looking-glass.scheduler";
export const PLIST_FILE_NAME = `${LAUNCHD_LABEL}.plist`;

export interface LaunchdCommandResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * This runner is intentionally argument based.  In particular, launchctl is
 * never run through a shell, which also makes all scheduler operations easy to
 * exercise on non-macOS hosts.
 */
export type LaunchdCommandRunner = (command: string, args: string[]) => LaunchdCommandResult;
export type LaunchdRealpath = (path: string) => string;

export interface LaunchdServiceOptions {
  command?: LaunchdCommandRunner;
  /** The launchctl executable, mainly useful for tests. */
  launchctlPath?: string;
  uid?: string | number;
  /** Override the home used for the LaunchAgents directory and plist. */
  homeDirectory?: string;
  /** Override the generated plist location. */
  plistPath?: string;
  environment?: NodeJS.ProcessEnv;
  nodePath?: string;
  /** Avoid requiring synthetic test executables to exist on disk. */
  realpath?: LaunchdRealpath;
}

interface ResolvedLaunchdServiceOptions {
  command: LaunchdCommandRunner;
  launchctlPath: string;
  uid: string;
  home: string;
  plistPath: string;
  environment: NodeJS.ProcessEnv;
  nodePath: string;
  realpath: LaunchdRealpath;
}

interface ServiceLookup {
  loaded: boolean;
  output?: string;
}

const ENVIRONMENT_ALLOWLIST = [
  "LOOKING_GLASS_CONFIG",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "PATH",
] as const;

function defaultCommand(command: string, args: string[]): LaunchdCommandResult {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false });
  const commandResult: LaunchdCommandResult = {
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

function currentUid(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return String(uid ?? process.env.UID ?? "");
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

/** Escape a value used as plist XML text, rejecting invalid XML 1.0 chars. */
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

function resolveOptions(options: LaunchdServiceOptions = {}): ResolvedLaunchdServiceOptions {
  const home = options.homeDirectory ?? homedir();
  const plistPath = options.plistPath ?? join(home, "Library", "LaunchAgents", PLIST_FILE_NAME);
  const uid = String(options.uid ?? currentUid());
  const nodePath = options.nodePath ?? process.execPath;
  const result: ResolvedLaunchdServiceOptions = {
    command: options.command ?? defaultCommand,
    launchctlPath: options.launchctlPath ?? "/bin/launchctl",
    uid,
    home,
    plistPath,
    environment: options.environment ?? process.env,
    nodePath,
    realpath: options.realpath ?? realpathSync,
  };
  requiredText(result.launchctlPath, "launchctl path");
  requiredText(result.uid, "user ID");
  requiredText(result.home, "home directory");
  requiredText(result.plistPath, "plist path");
  requiredText(result.nodePath, "node path");
  return result;
}

function domain(options: ResolvedLaunchdServiceOptions): string {
  return `gui/${options.uid}`;
}

function target(options: ResolvedLaunchdServiceOptions): string {
  return `${domain(options)}/${LAUNCHD_LABEL}`;
}

function commandOutput(result: LaunchdCommandResult): string {
  return [
    result.stderr ?? "",
    result.stdout ?? "",
    result.errorMessage ?? "",
  ].filter(Boolean).join("\n").trim();
}

function commandFailure(command: string, args: string[], result: LaunchdCommandResult): Error {
  const code = result.errorCode;
  const suffix = code === undefined ? "" : ` (code ${String(code)})`;
  return new Error(commandOutput(result) || `${command} ${args.join(" ")} exited with ${String(result.status)}${suffix}`);
}

function runLaunchctl(options: ResolvedLaunchdServiceOptions, args: string[], tolerateMissing = false): LaunchdCommandResult {
  const result = options.command(options.launchctlPath, args);
  if (result.status !== 0 && !(tolerateMissing && result.status === 113)) {
    throw commandFailure(options.launchctlPath, args, result);
  }
  return result;
}

function lookup(options: ResolvedLaunchdServiceOptions): ServiceLookup {
  const args = ["print", target(options)];
  const result = options.command(options.launchctlPath, args);
  if (result.status === 0) return { loaded: true, output: result.stdout ?? "" };
  if (result.status === 113) return { loaded: false };
  throw commandFailure(options.launchctlPath, args, result);
}

function absoluteRealpath(path: string, realpath: LaunchdRealpath, label: string): string {
  requiredText(path, label);
  const resolved = realpath(path);
  requiredText(resolved, label);
  return isAbsolute(resolved) ? resolved : resolve(resolved);
}

export interface LaunchdPlistOptions {
  nodePath: string;
  cliPath: string;
  dbPath: string;
  home?: string;
  environment?: NodeJS.ProcessEnv;
}

/** Render the launchd plist without a shell wrapper or EnvironmentFile. */
export function renderPlist(options: LaunchdPlistOptions): string {
  const nodePath = requiredText(options.nodePath, "node path");
  const cliPath = requiredText(options.cliPath, "CLI path");
  const dbPath = requiredText(options.dbPath, "database path");
  const home = requiredText(options.home ?? homedir(), "home directory");
  const environment = options.environment ?? process.env;
  const variables: Array<[string, string]> = [["LOOKING_GLASS_DB", dbPath]];
  for (const name of ENVIRONMENT_ALLOWLIST) {
    const value = environment[name];
    if (!value) continue;
    const normalized = name === "PATH" || isAbsolute(value) ? value : resolve(value);
    variables.push([name, normalized]);
  }
  const environmentXml = variables.flatMap(([name, value]) => [
    `    <key>${xmlText(name)}</key>`,
    `    <string>${xmlText(value)}</string>`,
  ]).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlText(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlText(nodePath)}</string>
    <string>${xmlText(cliPath)}</string>
    <string>cron</string>
    <string>daemon</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlText(home)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>25</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
</dict>
</plist>
`;
}

export function userPlistPath(home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", PLIST_FILE_NAME);
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function atomicWrite(path: string, contents: string | Buffer): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    try {
      removeFile(temporary);
    } catch {
      // Preserve the operation's original failure.
    }
    throw error;
  }
}

function restoreFile(path: string, previous: Buffer | null): void {
  if (previous === null) removeFile(path);
  else atomicWrite(path, previous);
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function unload(options: ResolvedLaunchdServiceOptions): void {
  runLaunchctl(options, ["bootout", target(options)], true);
}

function load(options: ResolvedLaunchdServiceOptions): void {
  runLaunchctl(options, ["bootstrap", domain(options), options.plistPath]);
}

function kickstart(options: ResolvedLaunchdServiceOptions): void {
  runLaunchctl(options, ["kickstart", "-k", target(options)]);
}

function recover(options: ResolvedLaunchdServiceOptions, wasLoaded: boolean, previous: Buffer | null): unknown[] {
  const failures: unknown[] = [];
  try {
    // A successful bootstrap followed by a failed kickstart leaves a new job
    // loaded. Always attempt cleanup before restoring the managed file.
    unload(options);
  } catch (error) {
    failures.push(error);
  }
  let restored = false;
  try {
    restoreFile(options.plistPath, previous);
    restored = true;
  } catch (error) {
    failures.push(error);
  }
  if (restored && wasLoaded && previous !== null) {
    let loaded = false;
    try {
      load(options);
      loaded = true;
    } catch (error) {
      failures.push(error);
    }
    if (loaded) {
      try {
        kickstart(options);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  return failures;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Install or replace this user's launchd scheduler job and start it once. */
export function installService(cliPath: string, dbPath: string, serviceOptions: LaunchdServiceOptions = {}): string {
  const options = resolveOptions(serviceOptions);
  requiredText(cliPath, "CLI path");
  requiredText(dbPath, "database path");
  const previous = existsSync(options.plistPath) ? readFileSync(options.plistPath) : null;
  const oldJob = lookup(options);
  if (oldJob.loaded && previous === null) {
    throw new Error(`refusing to replace unmanaged loaded launchd job ${LAUNCHD_LABEL}`);
  }

  const nodePath = absoluteRealpath(options.nodePath, options.realpath, "node path");
  const resolvedCliPath = absoluteRealpath(cliPath, options.realpath, "CLI path");
  const plist = renderPlist({
    nodePath,
    cliPath: resolvedCliPath,
    dbPath: isAbsolute(dbPath) ? dbPath : resolve(dbPath),
    home: options.home,
    environment: options.environment,
  });
  ensureDirectory(dirname(options.plistPath));
  if (oldJob.loaded) unload(options);

  try {
    atomicWrite(options.plistPath, plist);
    load(options);
    kickstart(options);
  } catch (error) {
    const rollbackFailures = recover(options, oldJob.loaded, previous);
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        `launchd activation failed: ${errorDetail(error)}; rollback was incomplete: ${rollbackFailures.map(errorDetail).join("; ")}`,
      );
    }
    throw error;
  }
  return options.plistPath;
}

function stateFromPrint(output: string): { active: string; sub: string } {
  const match = output.match(/^\s*state\s*=\s*(.+?)\s*$/im);
  const raw = match?.[1]?.trim().toLowerCase() ?? "";
  if (raw === "running") return { active: "active", sub: "running" };
  if (raw === "waiting" || raw.includes("spawn scheduled")) return { active: "inactive", sub: "waiting" };
  if (raw === "exited") return { active: "inactive", sub: "exited" };
  if (raw === "throttled") return { active: "inactive", sub: "throttled" };
  if (raw === "not running") return { active: "inactive", sub: "dead" };
  return { active: "inactive", sub: "unknown" };
}

/** Return stable state keys rather than locale/version-dependent launchctl output. */
export function serviceStatus(serviceOptions: LaunchdServiceOptions = {}): string {
  const options = resolveOptions(serviceOptions);
  const job = lookup(options);
  if (!job.loaded) {
    const loadState = existsSync(options.plistPath) ? "unloaded" : "not-found";
    return `LoadState=${loadState}\nActiveState=inactive\nSubState=dead`;
  }
  const state = stateFromPrint(job.output ?? "");
  return `LoadState=loaded\nActiveState=${state.active}\nSubState=${state.sub}`;
}

/** Unload the job before deleting its generated plist. */
export function uninstallService(serviceOptions: LaunchdServiceOptions = {}): boolean {
  const options = resolveOptions(serviceOptions);
  const managed = existsSync(options.plistPath);
  const job = lookup(options);
  if (job.loaded && !managed) {
    throw new Error(`refusing to unload unmanaged loaded launchd job ${LAUNCHD_LABEL}`);
  }
  if (!job.loaded && !managed) return false;
  if (job.loaded) unload(options);
  removeFile(options.plistPath);
  return true;
}

export interface LaunchdScheduler {
  installService(cliPath: string, dbPath: string): string;
  serviceStatus(): string;
  uninstallService(): boolean;
}

/** Bind injectable options once for platform dispatchers and tests. */
export function createLaunchdScheduler(options: LaunchdServiceOptions = {}): LaunchdScheduler {
  return {
    installService: (cliPath, dbPath) => installService(cliPath, dbPath, options),
    serviceStatus: () => serviceStatus(options),
    uninstallService: () => uninstallService(options),
  };
}

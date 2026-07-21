import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";

type Environment = Readonly<Record<string, string | undefined>>;

function envPath(environment: Environment, name: string, fallback: string): string {
  const value = environment[name];
  return value ? resolve(value) : fallback;
}

/** Return whether POSIX mode bits and umask should be enforced on a platform. */
export function shouldEnforcePosixPermissions(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

function configRoot(platform: NodeJS.Platform, environment: Environment, home: string): string {
  const fallback = platform === "win32" ? join(home, "AppData", "Roaming") : join(home, ".config");
  const appData = platform === "win32" ? environment.APPDATA : undefined;
  return envPath(environment, "XDG_CONFIG_HOME", appData ? resolve(appData) : fallback);
}

function dataRoot(platform: NodeJS.Platform, environment: Environment, home: string): string {
  const fallback = platform === "win32" ? join(home, "AppData", "Local") : join(home, ".local", "share");
  const localAppData = platform === "win32" ? environment.LOCALAPPDATA : undefined;
  return envPath(environment, "XDG_DATA_HOME", localAppData ? resolve(localAppData) : fallback);
}

export function configDir(
  platform: NodeJS.Platform = process.platform,
  environment: Environment = process.env,
  home: string = homedir(),
): string {
  return join(configRoot(platform, environment, home), "looking-glass");
}

export function dataDir(
  platform: NodeJS.Platform = process.platform,
  environment: Environment = process.env,
  home: string = homedir(),
): string {
  return join(dataRoot(platform, environment, home), "looking-glass");
}

export function stateDbPath(
  platform: NodeJS.Platform = process.platform,
  environment: Environment = process.env,
  home: string = homedir(),
): string {
  const configured = environment.LOOKING_GLASS_DB;
  if (configured) return platform === "win32" ? win32.resolve(configured) : resolve(configured);
  return join(dataDir(platform, environment, home), "state.db");
}

export function artifactsDir(
  platform: NodeJS.Platform = process.platform,
  environment: Environment = process.env,
  home: string = homedir(),
): string {
  return join(dataDir(platform, environment, home), "artifacts");
}

export function ensureStateDirectories(): void {
  const mode = shouldEnforcePosixPermissions() ? { mode: 0o700 } : {};
  mkdirSync(configDir(), { recursive: true, ...mode });
  mkdirSync(dataDir(), { recursive: true, ...mode });
  mkdirSync(artifactsDir(), { recursive: true, ...mode });
}

export function findWorkspaceRoot(start = process.cwd()): string {
  let current = resolve(start);
  while (true) {
    try {
      statSync(join(current, ".git"));
      return current;
    } catch {
      // Continue to the filesystem root.
    }
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

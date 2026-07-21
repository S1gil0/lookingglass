import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";

type Environment = Readonly<Record<string, string | undefined>>;

type PathApi = Pick<typeof posix, "join" | "resolve">;

function pathApi(platform: NodeJS.Platform): PathApi {
  return platform === "win32" ? win32 : posix;
}

function envPath(environment: Environment, name: string, fallback: string, paths: PathApi): string {
  const value = environment[name];
  return value ? paths.resolve(value) : fallback;
}

/** Return whether POSIX mode bits and umask should be enforced on a platform. */
export function shouldEnforcePosixPermissions(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

function configRoot(platform: NodeJS.Platform, environment: Environment, home: string): string {
  const paths = pathApi(platform);
  const fallback = platform === "win32" ? paths.join(home, "AppData", "Roaming") : paths.join(home, ".config");
  const appData = platform === "win32" ? environment.APPDATA : undefined;
  return envPath(environment, "XDG_CONFIG_HOME", appData ? paths.resolve(appData) : fallback, paths);
}

function dataRoot(platform: NodeJS.Platform, environment: Environment, home: string): string {
  const paths = pathApi(platform);
  const fallback = platform === "win32" ? paths.join(home, "AppData", "Local") : paths.join(home, ".local", "share");
  const localAppData = platform === "win32" ? environment.LOCALAPPDATA : undefined;
  return envPath(environment, "XDG_DATA_HOME", localAppData ? paths.resolve(localAppData) : fallback, paths);
}

export function configDir(
  platform: NodeJS.Platform = process.platform,
  environment: Environment = process.env,
  home: string = homedir(),
): string {
  return pathApi(platform).join(configRoot(platform, environment, home), "looking-glass");
}

export function dataDir(
  platform: NodeJS.Platform = process.platform,
  environment: Environment = process.env,
  home: string = homedir(),
): string {
  return pathApi(platform).join(dataRoot(platform, environment, home), "looking-glass");
}

export function stateDbPath(
  platform: NodeJS.Platform = process.platform,
  environment: Environment = process.env,
  home: string = homedir(),
): string {
  const configured = environment.LOOKING_GLASS_DB;
  const paths = pathApi(platform);
  if (configured) return paths.resolve(configured);
  return paths.join(dataDir(platform, environment, home), "state.db");
}

export function artifactsDir(
  platform: NodeJS.Platform = process.platform,
  environment: Environment = process.env,
  home: string = homedir(),
): string {
  return pathApi(platform).join(dataDir(platform, environment, home), "artifacts");
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

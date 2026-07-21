import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

function envPath(name: string, fallback: string): string {
  const value = process.env[name];
  return value ? resolve(value) : fallback;
}

export function configDir(): string {
  return envPath("XDG_CONFIG_HOME", join(homedir(), ".config")) + "/looking-glass";
}

export function dataDir(): string {
  return envPath("XDG_DATA_HOME", join(homedir(), ".local", "share")) + "/looking-glass";
}

export function stateDbPath(): string {
  return process.env.LOOKING_GLASS_DB ?? join(dataDir(), "state.db");
}

export function artifactsDir(): string {
  return join(dataDir(), "artifacts");
}

export function ensureStateDirectories(): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  mkdirSync(artifactsDir(), { recursive: true, mode: 0o700 });
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

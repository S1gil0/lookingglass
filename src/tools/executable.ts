import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

type Environment = Readonly<Record<string, string | undefined>>;

// Node is asked to spawn these commands with shell:false. BAT/CMD files need
// cmd.exe and must therefore never be selected by this resolver.
const WINDOWS_SHELL_FALSE_EXTENSIONS = new Set([".COM", ".EXE"]);
const WINDOWS_PATHEXT = [".COM", ".EXE"];

function environmentValue(environment: Environment, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return environment[name];
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : environment[key];
}

function pathEquals(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isAbsolutePathEntry(entry: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return posix.isAbsolute(entry);
  // A drive-qualified path is the only local Windows path form accepted here.
  // This deliberately excludes UNC and device paths, as well as rooted paths
  // without a drive and drive-relative paths.
  return /^[A-Za-z]:[\\/]/.test(entry);
}

function windowsExtensions(name: string, environment: Environment): string[] {
  const suppliedExtension = win32.extname(name).toUpperCase();
  if (suppliedExtension) {
    return WINDOWS_SHELL_FALSE_EXTENSIONS.has(suppliedExtension) ? [""] : [];
  }

  const configured = environmentValue(environment, "PATHEXT", "win32")
    ?.split(";")
    .map((extension) => {
      const normalized = extension.trim().toUpperCase();
      return normalized.startsWith(".") ? normalized : `.${normalized}`;
    })
    .filter((extension) => WINDOWS_SHELL_FALSE_EXTENSIONS.has(extension));
  return configured?.length ? [...new Set(configured)] : [...WINDOWS_PATHEXT];
}

/**
 * Resolve a command without invoking a shell or a platform lookup command.
 * Empty PATH entries are deliberately ignored: on both supported platforms
 * they mean the current directory, which must never be an implicit fallback.
 */
export function resolveExecutableFromPath(
  name: string,
  options: {
    platform?: NodeJS.Platform;
    environment?: Environment;
    cwd?: string;
  } = {},
): string {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const pathApi = platform === "win32" ? win32 : posix;
  const cwd = pathApi.resolve(options.cwd ?? process.cwd());
  const pathValue = environmentValue(environment, "PATH", platform);
  const entries = pathValue?.split(platform === "win32" ? ";" : ":") ?? [];
  const extensions = platform === "win32" ? windowsExtensions(name, environment) : [""];

  for (const entry of entries) {
    if (!entry || !isAbsolutePathEntry(entry, platform)) continue;
    try {
      const directory = pathApi.normalize(entry);
      if (pathEquals(directory, cwd, platform)) continue;
      for (const extension of extensions) {
        const candidate = pathApi.resolve(directory, `${name}${extension}`);
        if (isExecutable(candidate, platform)) return candidate;
      }
    } catch {
      // Ignore malformed or inaccessible PATH entries without echoing them.
    }
  }

  throw new Error(`Executable "${name}" was not found on PATH`);
}
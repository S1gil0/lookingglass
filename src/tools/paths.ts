import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function resolveWorkspacePath(workspace: string, requested: string, allowMissing = false): string {
  if (requested.includes("\0")) throw new Error("Path contains a NUL byte");
  const root = realpathSync(workspace);
  const lexical = resolve(root, requested);
  if (!isWithin(root, lexical)) throw new Error(`Path is outside the workspace: ${requested}`);

  if (existsSync(lexical)) {
    const actual = realpathSync(lexical);
    if (!isWithin(root, actual)) throw new Error(`Path resolves outside the workspace: ${requested}`);
    return actual;
  }
  if (!allowMissing) throw new Error(`Path does not exist: ${requested}`);

  let existingParent = dirname(lexical);
  while (!existsSync(existingParent)) {
    const parent = dirname(existingParent);
    if (parent === existingParent) throw new Error(`No existing parent for path: ${requested}`);
    existingParent = parent;
  }
  const actualParent = realpathSync(existingParent);
  if (!isWithin(root, actualParent)) throw new Error(`Path parent resolves outside the workspace: ${requested}`);
  return lexical;
}

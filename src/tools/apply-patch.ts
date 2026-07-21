import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isWithin, resolveWorkspacePath } from "./paths.js";
import type { GlassTool } from "./types.js";
import { isSensitiveMutationPath, patchRisk } from "./safety.js";

interface ApplyPatchArgs {
  patch: string;
}

interface HunkLine {
  kind: "context" | "add" | "remove";
  text: string;
}

interface Hunk {
  anchor: string | null;
  lines: HunkLine[];
}

interface AddOperation {
  kind: "add";
  path: string;
  lines: string[];
}

interface UpdateOperation {
  kind: "update";
  path: string;
  moveTo: string | null;
  hunks: Hunk[];
}

interface DeleteOperation {
  kind: "delete";
  path: string;
}

type Operation = AddOperation | UpdateOperation | DeleteOperation;

interface PreparedAdd {
  kind: "add";
  requestedPath: string;
  targetPath: string;
  content: string;
}

interface PreparedUpdate {
  kind: "update";
  sourceRequestedPath: string;
  targetRequestedPath: string;
  sourcePath: string;
  targetPath: string;
  content: string;
  mode: number;
  moved: boolean;
}

interface PreparedDelete {
  kind: "delete";
  requestedPath: string;
  sourcePath: string;
}

type PreparedOperation = PreparedAdd | PreparedUpdate | PreparedDelete;

interface ChangedPath {
  identity: string;
  requestedPath: string;
}

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const UPDATE_FILE = "*** Update File: ";
const DELETE_FILE = "*** Delete File: ";
const MOVE_TO = "*** Move to: ";

function parsePath(line: string, prefix: string): string {
  const path = line.slice(prefix.length);
  if (path.length === 0) throw new Error(`Missing path after ${prefix.trimEnd()}`);
  return path;
}

function parseHunkHeader(line: string): string | null {
  if (line === "@@") return null;
  if (!line.startsWith("@@ ")) throw new Error(`Malformed hunk header: ${line}`);

  const header = line.slice(3);
  if (header.length === 0) throw new Error("Hunk anchor cannot be empty");
  if (/^-\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?: .*)?$/.test(header)) return null;
  return header;
}

function parsePatch(patch: string): Operation[] {
  if (patch.includes("\0")) throw new Error("Patch contains a NUL byte");

  const lines = patch.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] !== BEGIN_PATCH) throw new Error(`Patch must start with ${BEGIN_PATCH}`);

  const operations: Operation[] = [];
  let index = 1;
  while (index < lines.length && lines[index] !== END_PATCH) {
    const line = lines[index];
    if (line === undefined) throw new Error(`Patch must end with ${END_PATCH}`);

    if (line.startsWith(ADD_FILE)) {
      const path = parsePath(line, ADD_FILE);
      const contentLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]?.startsWith("***")) {
        const contentLine = lines[index];
        if (contentLine === undefined || !contentLine.startsWith("+")) {
          throw new Error(`Add File lines must start with +: ${path}`);
        }
        contentLines.push(contentLine.slice(1));
        index += 1;
      }
      operations.push({ kind: "add", path, lines: contentLines });
      continue;
    }

    if (line.startsWith(UPDATE_FILE)) {
      const path = parsePath(line, UPDATE_FILE);
      let moveTo: string | null = null;
      const hunks: Hunk[] = [];
      index += 1;

      const nextLine = lines[index];
      if (nextLine?.startsWith(MOVE_TO)) {
        moveTo = parsePath(nextLine, MOVE_TO);
        index += 1;
      }

      while (index < lines.length && lines[index]?.startsWith("@@")) {
        const header = lines[index];
        if (header === undefined) throw new Error(`Missing hunk header for ${path}`);
        const anchor = parseHunkHeader(header);
        const hunkLines: HunkLine[] = [];
        let hasChange = false;
        index += 1;

        while (index < lines.length && !lines[index]?.startsWith("@@") && !lines[index]?.startsWith("***")) {
          const hunkLine = lines[index];
          if (hunkLine === undefined || hunkLine.length === 0) {
            throw new Error(`Hunk lines must start with space, +, or -: ${path}`);
          }
          const marker = hunkLine[0];
          if (marker === " ") {
            hunkLines.push({ kind: "context", text: hunkLine.slice(1) });
          } else if (marker === "+") {
            hunkLines.push({ kind: "add", text: hunkLine.slice(1) });
            hasChange = true;
          } else if (marker === "-") {
            hunkLines.push({ kind: "remove", text: hunkLine.slice(1) });
            hasChange = true;
          } else {
            throw new Error(`Hunk lines must start with space, +, or -: ${path}`);
          }
          index += 1;
        }

        if (hunkLines.length === 0) throw new Error(`Empty hunk for ${path}`);
        if (!hasChange) throw new Error(`Hunk contains no changes: ${path}`);
        hunks.push({ anchor, lines: hunkLines });
      }

      if (hunks.length === 0) throw new Error(`Update File requires at least one hunk: ${path}`);
      operations.push({ kind: "update", path, moveTo, hunks });
      continue;
    }

    if (line.startsWith(DELETE_FILE)) {
      operations.push({ kind: "delete", path: parsePath(line, DELETE_FILE) });
      index += 1;
      continue;
    }

    throw new Error(`Unexpected patch line: ${line}`);
  }

  if (lines[index] !== END_PATCH) throw new Error(`Patch must end with ${END_PATCH}`);
  if (index !== lines.length - 1) throw new Error(`No content is allowed after ${END_PATCH}`);
  if (operations.length === 0) throw new Error("Patch contains no operations");
  return operations;
}

function isMissingPathError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function validateTargetParent(workspace: string, targetPath: string, requestedPath: string): void {
  let parent = dirname(targetPath);
  while (!existsSync(parent)) {
    if (pathEntryExists(parent)) throw new Error(`Broken symlink in parent path: ${requestedPath}`);
    const next = dirname(parent);
    if (next === parent) throw new Error(`No existing parent for path: ${requestedPath}`);
    parent = next;
  }

  const safeParent = resolveWorkspacePath(workspace, parent);
  if (!statSync(safeParent).isDirectory()) throw new Error(`Parent is not a directory: ${requestedPath}`);
}

function canonicalPath(path: string): string {
  const missingParts: string[] = [];
  let existingPath = path;
  while (!existsSync(existingPath)) {
    missingParts.unshift(basename(existingPath));
    const parent = dirname(existingPath);
    if (parent === existingPath) break;
    existingPath = parent;
  }
  return resolve(realpathSync(existingPath), ...missingParts);
}

function assertRegularFile(path: string, requestedPath: string): number {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${requestedPath}`);
  return stat.mode & 0o7777;
}

function findMatches(lines: string[], expected: string[]): number[] {
  if (expected.length === 0 || expected.length > lines.length) return [];
  const matches: number[] = [];
  for (let index = 0; index <= lines.length - expected.length; index += 1) {
    let matchesAtIndex = true;
    for (let offset = 0; offset < expected.length; offset += 1) {
      if (lines[index + offset] !== expected[offset]) {
        matchesAtIndex = false;
        break;
      }
    }
    if (matchesAtIndex) matches.push(index);
  }
  return matches;
}

function applyHunks(content: string, hunks: Hunk[], requestedPath: string): string {
  const firstNewline = content.indexOf("\n");
  const lineEnding = firstNewline > 0 && content[firstNewline - 1] === "\r" ? "\r\n" : "\n";
  const normalized = lineEnding === "\r\n" ? content.replaceAll("\r\n", "\n") : content;
  const lines = normalized.split("\n");

  for (const [hunkIndex, hunk] of hunks.entries()) {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    if (hunk.anchor !== null) {
      oldLines.push(hunk.anchor);
      newLines.push(hunk.anchor);
    }
    for (const line of hunk.lines) {
      if (line.kind !== "add") oldLines.push(line.text);
      if (line.kind !== "remove") newLines.push(line.text);
    }

    if (oldLines.length === 0) {
      throw new Error(`Hunk ${hunkIndex + 1} has no context or removed lines: ${requestedPath}`);
    }
    const matches = findMatches(lines, oldLines);
    if (matches.length === 0) {
      throw new Error(`Hunk ${hunkIndex + 1} did not match exactly: ${requestedPath}`);
    }
    if (matches.length > 1) {
      throw new Error(`Hunk ${hunkIndex + 1} matched ${matches.length} locations: ${requestedPath}`);
    }
    lines.splice(matches[0] as number, oldLines.length, ...newLines);
  }

  return lines.join(lineEnding);
}

function preflight(operations: Operation[], workspace: string): PreparedOperation[] {
  const prepared: PreparedOperation[] = [];
  const changedPaths: ChangedPath[] = [];

  const registerPath = (path: string, requestedPath: string): void => {
    const identity = canonicalPath(path);
    const duplicate = changedPaths.find((entry) => entry.identity === identity);
    if (duplicate) {
      throw new Error(`Conflicting paths in patch: ${duplicate.requestedPath} and ${requestedPath}`);
    }
    changedPaths.push({ identity, requestedPath });
  };

  for (const operation of operations) {
    if (operation.kind === "add") {
      const targetPath = resolveWorkspacePath(workspace, operation.path, true);
      if (pathEntryExists(targetPath)) throw new Error(`Add File target already exists: ${operation.path}`);
      validateTargetParent(workspace, targetPath, operation.path);
      registerPath(targetPath, operation.path);
      prepared.push({
        kind: "add",
        requestedPath: operation.path,
        targetPath,
        content: operation.lines.join("\n"),
      });
      continue;
    }

    if (operation.kind === "update") {
      const sourcePath = resolveWorkspacePath(workspace, operation.path);
      const mode = assertRegularFile(sourcePath, operation.path);
      const content = applyHunks(readFileSync(sourcePath, "utf8"), operation.hunks, operation.path);
      registerPath(sourcePath, operation.path);

      let targetPath = sourcePath;
      let targetRequestedPath = operation.path;
      const moved = operation.moveTo !== null;
      if (operation.moveTo !== null) {
        targetRequestedPath = operation.moveTo;
        targetPath = resolveWorkspacePath(workspace, operation.moveTo, true);
        if (pathEntryExists(targetPath)) throw new Error(`Move target already exists: ${operation.moveTo}`);
        validateTargetParent(workspace, targetPath, operation.moveTo);
        registerPath(targetPath, operation.moveTo);
      }

      prepared.push({
        kind: "update",
        sourceRequestedPath: operation.path,
        targetRequestedPath,
        sourcePath,
        targetPath,
        content,
        mode,
        moved,
      });
      continue;
    }

    const sourcePath = resolveWorkspacePath(workspace, operation.path);
    assertRegularFile(sourcePath, operation.path);
    registerPath(sourcePath, operation.path);
    prepared.push({ kind: "delete", requestedPath: operation.path, sourcePath });
  }

  for (let leftIndex = 0; leftIndex < changedPaths.length; leftIndex += 1) {
    const left = changedPaths[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < changedPaths.length; rightIndex += 1) {
      const right = changedPaths[rightIndex];
      if (!right) continue;
      if (isWithin(left.identity, right.identity) || isWithin(right.identity, left.identity)) {
        throw new Error(`Conflicting paths in patch: ${left.requestedPath} and ${right.requestedPath}`);
      }
    }
  }

  return prepared;
}

function ensureParentDirectories(workspace: string, targetPath: string): void {
  const missing: string[] = [];
  let parent = dirname(targetPath);
  while (!existsSync(parent)) {
    missing.push(parent);
    parent = dirname(parent);
  }

  for (const directory of missing.reverse()) {
    resolveWorkspacePath(workspace, directory, true);
    mkdirSync(directory);
    const safeDirectory = resolveWorkspacePath(workspace, directory);
    if (!statSync(safeDirectory).isDirectory()) throw new Error(`Created path is not a directory: ${directory}`);
  }
}

function atomicWrite(path: string, content: string, mode: number | null): void {
  const tempPath = join(dirname(path), `.glass-patch-${process.pid}-${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(tempPath, "wx", mode ?? 0o666);
    writeFileSync(descriptor, content, "utf8");
    if (mode !== null) chmodSync(tempPath, mode);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(tempPath, path);
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original write failure.
      }
    }
    try {
      unlinkSync(tempPath);
    } catch (cleanupError) {
      if (!isMissingPathError(cleanupError)) {
        // Preserve the original write failure.
      }
    }
    throw error;
  }
}

function commit(prepared: PreparedOperation[], workspace: string): void {
  for (const operation of prepared) {
    if (operation.kind === "add") {
      ensureParentDirectories(workspace, operation.targetPath);
      resolveWorkspacePath(workspace, operation.targetPath, true);
      if (pathEntryExists(operation.targetPath)) {
        throw new Error(`Add File target already exists: ${operation.requestedPath}`);
      }
      atomicWrite(operation.targetPath, operation.content, null);
      continue;
    }

    if (operation.kind === "update") {
      const currentSource = resolveWorkspacePath(workspace, operation.sourceRequestedPath);
      if (currentSource !== operation.sourcePath) {
        throw new Error(`Update source changed during patch application: ${operation.sourceRequestedPath}`);
      }
      if (operation.moved) {
        ensureParentDirectories(workspace, operation.targetPath);
        resolveWorkspacePath(workspace, operation.targetRequestedPath, true);
        if (pathEntryExists(operation.targetPath)) {
          throw new Error(`Move target already exists: ${operation.targetRequestedPath}`);
        }
      }
      atomicWrite(operation.targetPath, operation.content, operation.mode);
      if (operation.moved) unlinkSync(operation.sourcePath);
      continue;
    }

    const currentSource = resolveWorkspacePath(workspace, operation.requestedPath);
    if (currentSource !== operation.sourcePath) {
      throw new Error(`Delete source changed during patch application: ${operation.requestedPath}`);
    }
    unlinkSync(currentSource);
  }
}

function changedFileSummary(prepared: PreparedOperation[]): string {
  return prepared.map((operation) => {
    if (operation.kind === "add") return `Added ${operation.requestedPath}`;
    if (operation.kind === "delete") return `Deleted ${operation.requestedPath}`;
    if (operation.moved) return `Updated and moved ${operation.sourceRequestedPath} -> ${operation.targetRequestedPath}`;
    return `Updated ${operation.sourceRequestedPath}`;
  }).join("\n");
}

function classifyPatchRisk(args: ApplyPatchArgs, workspace: string): "write" | "critical" {
  const declared = patchRisk(args.patch);
  const prepared = preflight(parsePatch(args.patch), workspace);
  if (declared === "critical") return declared;
  for (const operation of prepared) {
    if (operation.kind === "delete") return "critical";
    if (operation.kind === "add") {
      if (isSensitiveMutationPath(operation.targetPath)) return "critical";
      continue;
    }
    if (isSensitiveMutationPath(operation.sourcePath) || isSensitiveMutationPath(operation.targetPath)) return "critical";
  }
  return "write";
}

export const applyPatchTool: GlassTool<ApplyPatchArgs> = {
  name: "apply_patch",
  description: "Apply an atomic, workspace-bound patch that adds, updates, moves, or deletes files.",
  risk: "write",
  classifyRisk: (args, context) => classifyPatchRisk(args, context.workspace),
  parameters: {
    type: "object",
    properties: {
      patch: { type: "string", minLength: 1 },
    },
    required: ["patch"],
    additionalProperties: false,
  },
  summarize: (args) => `Apply patch (${args.patch.length} characters)`,
  async execute(args, context) {
    const prepared = preflight(parsePatch(args.patch), context.workspace);
    commit(prepared, context.workspace);
    return { output: changedFileSummary(prepared) };
  },
};

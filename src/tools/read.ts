import { closeSync, createReadStream, openSync, readSync, readdirSync, statSync } from "node:fs";
import { relative } from "node:path";
import { createInterface } from "node:readline";
import type { GlassTool, ToolContext, ToolResult } from "./types.js";
import { resolveWorkspacePath } from "./paths.js";

interface ReadArgs {
  path: string;
  offset: number | null;
  limit: number | null;
}

async function numberedFileLines(path: string, offset: number, limit: number): Promise<{ output: string; truncated: boolean }> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const selected: string[] = [];
  let lineNumber = 0;
  let truncated = false;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (lineNumber < offset) continue;
      if (selected.length >= limit) {
        truncated = true;
        break;
      }
      selected.push(`${lineNumber}: ${line}`);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return { output: selected.join("\n"), truncated };
}

function binarySample(path: string, byteCount: number): boolean {
  const fd = openSync(path, "r");
  try {
    const sample = Buffer.allocUnsafe(Math.min(byteCount, 8_192));
    const bytesRead = readSync(fd, sample, 0, sample.byteLength, 0);
    return sample.subarray(0, bytesRead).includes(0);
  } finally {
    closeSync(fd);
  }
}

async function readArtifact(args: ReadArgs, context: ToolContext): Promise<ToolResult> {
  const offset = Math.max(0, args.offset ?? 0);
  const limit = Math.min(args.limit ?? context.config.tools.maxOutputBytes, context.config.tools.maxOutputBytes);
  const artifact = context.artifacts.get(args.path);
  if (!artifact) throw new Error(`Artifact not found: ${args.path}`);
  const data = context.artifacts.read(args.path, offset, limit);
  const truncated = offset + data.byteLength < artifact.byteCount;
  return {
    output: `${data.toString("utf8")}${truncated ? `\n\n[Truncated. Continue at byte offset ${offset + data.byteLength}.]` : ""}`,
    truncated,
    artifactUri: artifact.uri,
  };
}

export const readTool: GlassTool<ReadArgs> = {
  name: "read",
  description: "Read a text file with line numbers, list a directory, or read a bounded range from an artifact:// URI.",
  risk: "read",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, description: "Workspace-relative path or artifact:// URI" },
      offset: { type: ["integer", "null"], minimum: 0, description: "1-based line for files; byte offset for artifacts" },
      limit: { type: ["integer", "null"], minimum: 1, description: "Maximum lines or artifact bytes" },
    },
    required: ["path", "offset", "limit"],
    additionalProperties: false,
  },
  summarize: (args) => `Read ${args.path}`,
  async execute(args, context) {
    if (args.path.startsWith("artifact://")) return readArtifact(args, context);
    const path = resolveWorkspacePath(context.workspace, args.path);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      const entries = readdirSync(path, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, context.config.tools.maxReadLines)
        .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
      return { output: entries.join("\n") || "[Empty directory]" };
    }
    if (!stat.isFile()) throw new Error(`Not a regular file: ${args.path}`);
    if (binarySample(path, stat.size)) {
      return { output: `[Binary file: ${relative(context.workspace, path)}, ${stat.size} bytes]` };
    }
    const offset = Math.max(1, args.offset ?? 1);
    const limit = Math.min(args.limit ?? context.config.tools.maxReadLines, context.config.tools.maxReadLines);
    const result = await numberedFileLines(path, offset, limit);
    return {
      output: `${result.output}${result.truncated ? `\n\n[Truncated. Continue at line ${offset + limit}.]` : ""}`,
      truncated: result.truncated,
    };
  },
};

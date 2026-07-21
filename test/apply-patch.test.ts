import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { applyPatchForPlatform, applyPatchTool, replaceStagedFile, validatePatchPath } from "../src/tools/apply-patch.js";
import type { ToolContext } from "../src/tools/types.js";

function workspace(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "looking-glass-apply-patch-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

async function apply(root: string, lines: string[]): Promise<string> {
  const result = await applyPatchTool.execute({ patch: lines.join("\n") }, { workspace: root } as ToolContext);
  return result.output;
}

function applyOnPlatform(root: string, lines: string[], platform: NodeJS.Platform): string {
  return applyPatchForPlatform(lines.join("\n"), root, platform);
}

test("adds a file and creates missing parent directories", async (t) => {
  const root = workspace(t);
  const output = await apply(root, [
    "*** Begin Patch",
    "*** Add File: nested/new.txt",
    "+first",
    "+second",
    "+",
    "*** End Patch",
  ]);

  assert.equal(readFileSync(join(root, "nested/new.txt"), "utf8"), "first\nsecond\n");
  assert.equal(output, "Added nested/new.txt");
});

test("updates a file with multiple exact hunks and preserves mode and final newline", async (t) => {
  const root = workspace(t);
  const path = join(root, "update.txt");
  writeFileSync(path, "alpha\nbeta\ngamma\ndelta\n");
  chmodSync(path, 0o751);

  const output = await apply(root, [
    "*** Begin Patch",
    "*** Update File: update.txt",
    "@@",
    " alpha",
    "-beta",
    "+BETA",
    "@@ gamma",
    "-delta",
    "+DELTA",
    "*** End Patch",
  ]);

  assert.equal(readFileSync(path, "utf8"), "alpha\nBETA\ngamma\nDELTA\n");
  if (process.platform === "win32") assert.equal(existsSync(path), true);
  else assert.equal(statSync(path).mode & 0o7777, 0o751);
  assert.equal(output, "Updated update.txt");
});

test("deletes an existing file", async (t) => {
  const root = workspace(t);
  const path = join(root, "obsolete.txt");
  writeFileSync(path, "old\n");

  const output = await apply(root, [
    "*** Begin Patch",
    "*** Delete File: obsolete.txt",
    "*** End Patch",
  ]);

  assert.equal(existsSync(path), false);
  assert.equal(output, "Deleted obsolete.txt");
});

test("updates and moves a file while preserving its mode", async (t) => {
  const root = workspace(t);
  const source = join(root, "old.txt");
  const target = join(root, "moved/new.txt");
  writeFileSync(source, "before\nkeep\n");
  chmodSync(source, 0o640);

  const output = await apply(root, [
    "*** Begin Patch",
    "*** Update File: old.txt",
    "*** Move to: moved/new.txt",
    "@@",
    "-before",
    "+after",
    " keep",
    "*** End Patch",
  ]);

  assert.equal(existsSync(source), false);
  assert.equal(readFileSync(target, "utf8"), "after\nkeep\n");
  if (process.platform === "win32") assert.equal(existsSync(target), true);
  else assert.equal(statSync(target).mode & 0o7777, 0o640);
  assert.equal(output, "Updated and moved old.txt -> moved/new.txt");
});

test("rolls back a Windows-style replacement when installing the staged file fails", (t) => {
  const root = workspace(t);
  const target = join(root, "target.txt");
  const temp = join(root, "staged.tmp");
  writeFileSync(target, "before\n");
  writeFileSync(temp, "after\n");

  const fileSystem = {
    renameSync(source: Parameters<typeof renameSync>[0], destination: Parameters<typeof renameSync>[1]): void {
      if (source.toString() === temp && destination.toString() === target) {
        const error = new Error("simulated Windows rename collision") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      renameSync(source, destination);
    },
    unlinkSync,
  };

  assert.throws(() => replaceStagedFile(temp, target, "win32", fileSystem), /simulated Windows rename collision/);
  assert.equal(readFileSync(target, "utf8"), "before\n");
  assert.equal(existsSync(temp), true);
  rmSync(temp, { force: true });
});

test("replaces an existing target with a Windows-style collision-safe rename", (t) => {
  const root = workspace(t);
  const target = join(root, "target.txt");
  const temp = join(root, "staged.tmp");
  writeFileSync(target, "before\n");
  writeFileSync(temp, "after\n");

  const fileSystem = {
    renameSync(source: Parameters<typeof renameSync>[0], destination: Parameters<typeof renameSync>[1]): void {
      if (existsSync(destination.toString())) {
        const error = new Error("simulated Windows rename collision") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      renameSync(source, destination);
    },
    unlinkSync,
  };

  replaceStagedFile(temp, target, "win32", fileSystem);
  assert.equal(readFileSync(target, "utf8"), "after\n");
  assert.equal(existsSync(temp), false);
  assert.deepEqual(readdirSync(root).filter((entry) => entry.endsWith(".bak")), []);
});

test("rejects malformed patches and non-matching hunks", async (t) => {
  const root = workspace(t);
  const path = join(root, "source.txt");
  writeFileSync(path, "unchanged\n");

  await assert.rejects(
    apply(root, ["*** Begin Patch", "*** Add File: bad.txt", "missing-prefix", "*** End Patch"]),
    /must start with \+/,
  );
  await assert.rejects(
    apply(root, [
      "*** Begin Patch",
      "*** Update File: source.txt",
      "@@",
      "-missing",
      "+replacement",
      "*** End Patch",
    ]),
    /did not match exactly/,
  );
  assert.equal(readFileSync(path, "utf8"), "unchanged\n");
  assert.equal(existsSync(join(root, "bad.txt")), false);
});

test("rejects ambiguous update matches", async (t) => {
  const root = workspace(t);
  const path = join(root, "duplicate.txt");
  writeFileSync(path, "same\nother\nsame\n");

  await assert.rejects(
    apply(root, [
      "*** Begin Patch",
      "*** Update File: duplicate.txt",
      "@@",
      "-same",
      "+changed",
      "*** End Patch",
    ]),
    /matched 2 locations/,
  );
  assert.equal(readFileSync(path, "utf8"), "same\nother\nsame\n");
});

test("rejects paths outside the workspace", async (t) => {
  const root = workspace(t);
  const escaped = join(dirname(root), `escaped-${basename(root)}.txt`);
  rmSync(escaped, { force: true });
  t.after(() => rmSync(escaped, { force: true }));

  await assert.rejects(
    apply(root, [
      "*** Begin Patch",
      `*** Add File: ../${basename(escaped)}`,
      "+escape",
      "*** End Patch",
    ]),
    /outside the workspace/,
  );
  assert.equal(existsSync(escaped), false);
});

test("preflights all operations before changing any file", async (t) => {
  const root = workspace(t);
  const path = join(root, "early.txt");
  writeFileSync(path, "before\n");
  mkdirSync(join(root, "existing"));

  await assert.rejects(
    apply(root, [
      "*** Begin Patch",
      "*** Update File: early.txt",
      "@@",
      "-before",
      "+after",
      "*** Add File: created/also.txt",
      "+new",
      "*** Delete File: existing/missing.txt",
      "*** End Patch",
    ]),
    /does not exist/,
  );

  assert.equal(readFileSync(path, "utf8"), "before\n");
  assert.equal(existsSync(join(root, "created")), false);
});

test("preflights case-insensitive path conflicts on simulated Windows", (t) => {
  const root = workspace(t);

  assert.throws(
    () => applyOnPlatform(root, [
      "*** Begin Patch",
      "*** Add File: Foo.txt",
      "+first",
      "*** Add File: foo.txt",
      "+second",
      "*** End Patch",
    ], "win32"),
    /Conflicting paths in patch/,
  );
  assert.equal(existsSync(join(root, "Foo.txt")), false);
  assert.equal(existsSync(join(root, "foo.txt")), false);
});

test("rejects Windows stream, device, and reserved path forms when simulated on Linux", (t) => {
  const root = workspace(t);
  const paths = [
    "notes.txt:secret",
    "NUL.txt",
    "nested/CON.log",
    "\\\\?\\C:\\unexpected",
    "trailing.",
  ];

  for (const path of paths) {
    assert.throws(
      () => applyOnPlatform(root, [
        "*** Begin Patch",
        `*** Add File: ${path}`,
        "+blocked",
        "*** End Patch",
      ], "win32"),
      /Windows path/,
    );
  }
  assert.deepEqual(readdirSync(root), []);
});

test("leaves Linux path validation unchanged", () => {
  assert.doesNotThrow(() => validatePatchPath("notes.txt:metadata", "linux"));
});

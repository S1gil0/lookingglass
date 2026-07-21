import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { applyPatchTool } from "../src/tools/apply-patch.js";
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
  assert.equal(statSync(path).mode & 0o7777, 0o751);
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
  assert.equal(statSync(target).mode & 0o7777, 0o640);
  assert.equal(output, "Updated and moved old.txt -> moved/new.txt");
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

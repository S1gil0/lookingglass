import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { resolveExecutableFromPath } from "../src/tools/executable.js";

test("Windows executable resolution ignores relative, UNC, device, and shell-script PATH entries", () => {
  const environment = {
    pAtH: ["bin", "\\\\server\\share\\bin", "\\\\?\\C:\\Tools", "\\\\.\\C:\\Tools"].join(";"),
    pAtHeXt: ".BAT;.CMD",
  };
  assert.throws(
    () => resolveExecutableFromPath("rg", { platform: "win32", environment, cwd: "C:\\workspace" }),
    /not found on PATH/,
  );
  assert.throws(
    () => resolveExecutableFromPath("rg.cmd", { platform: "win32", environment, cwd: "C:\\workspace" }),
    /not found on PATH/,
  );
});

test("resolves ripgrep from PATH and skips the current directory", () => {
  const base = mkdtempSync(join(tmpdir(), "looking-glass-executable-"));
  const workspace = join(base, "workspace");
  const bin = join(base, "bin");
  mkdirSync(workspace);
  mkdirSync(bin);
  const extension = process.platform === "win32" ? ".EXE" : "";
  const currentDirectoryExecutable = join(workspace, `rg${extension}`);
  const pathExecutable = join(bin, `rg${extension}`);
  writeFileSync(currentDirectoryExecutable, "current directory executable");
  writeFileSync(pathExecutable, "PATH executable");
  if (process.platform !== "win32") chmodSync(pathExecutable, 0o755);

  try {
    const environment = process.platform === "win32"
      ? { Path: `${workspace};${bin}`, PATHEXT: ".EXE;.CMD" }
      : { PATH: `${workspace}${delimiter}${bin}` };
    assert.equal(resolveExecutableFromPath("rg", { environment, cwd: workspace }), pathExecutable);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("does not fall back to the current directory or expose PATH entries", () => {
  const base = mkdtempSync(join(tmpdir(), "looking-glass-executable-"));
  const workspace = join(base, "workspace");
  const secretPath = join(base, "private-tool-directory");
  mkdirSync(workspace);
  mkdirSync(secretPath);
  const extension = process.platform === "win32" ? ".EXE" : "";
  writeFileSync(join(workspace, `rg${extension}`), "untrusted executable");

  try {
    const environment = process.platform === "win32"
      ? { Path: `${workspace};${secretPath}`, PATHEXT: ".EXE" }
      : { PATH: `${workspace}${delimiter}${secretPath}` };
    assert.throws(
      () => resolveExecutableFromPath("rg", { environment, cwd: workspace }),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        assert.match((error as Error).message, /not found on PATH/);
        assert.equal((error as Error).message.includes(secretPath), false);
        return true;
      },
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
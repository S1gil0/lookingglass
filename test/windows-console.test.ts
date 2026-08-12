import assert from "node:assert/strict";
import type { SpawnSyncOptions } from "node:child_process";
import test from "node:test";
import { enableWindowsVirtualTerminalInput } from "../src/ui/windows-console.js";

test("Windows VT input helper is a no-op off Windows", () => {
  let calls = 0;
  const enabled = enableWindowsVirtualTerminalInput({
    platform: "linux",
    runner: () => {
      calls += 1;
      return { status: 0 };
    },
  });

  assert.equal(enabled, false);
  assert.equal(calls, 0);
});

test("Windows VT input helper transports a fixed script to absolute PowerShell without a shell", () => {
  let invocation: {
    command: string;
    args: readonly string[];
    options: SpawnSyncOptions;
  } | undefined;
  const enabled = enableWindowsVirtualTerminalInput({
    platform: "win32",
    systemRoot: "D:\\Windows",
    runner: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0 };
    },
  });

  assert.equal(enabled, true);
  assert.equal(invocation?.command, "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(invocation?.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
  const script = invocation?.args[4] ?? "";
  assert.match(script, /GetStdHandle\(-10\)/);
  assert.match(script, /GetConsoleMode/);
  assert.match(script, /SetConsoleMode/);
  assert.match(script, /-bor 0x0200/);
  assert.equal(invocation?.options.shell, false);
  assert.equal(invocation?.options.timeout !== undefined && invocation.options.timeout > 0, true);
  assert.equal(invocation?.options.maxBuffer !== undefined && invocation.options.maxBuffer > 0, true);
});

test("Windows VT input helper inherits stdin and ignores captured output", () => {
  let stdio: unknown;
  const enabled = enableWindowsVirtualTerminalInput({
    platform: "win32",
    runner: (_command, _args, options) => {
      stdio = options.stdio;
      return { status: 0 };
    },
  });

  assert.equal(enabled, true);
  assert.deepEqual(stdio, ["inherit", "pipe", "pipe"]);
});

test("Windows VT input helper reports PowerShell failures and spawn errors", () => {
  assert.equal(
    enableWindowsVirtualTerminalInput({ platform: "win32", runner: () => ({ status: 1 }) }),
    false,
  );
  assert.equal(
    enableWindowsVirtualTerminalInput({ platform: "win32", runner: () => ({ status: null, error: new Error("spawn failed") }) }),
    false,
  );
  assert.equal(
    enableWindowsVirtualTerminalInput({ platform: "win32", runner: () => { throw new Error("spawn failed"); } }),
    false,
  );
});
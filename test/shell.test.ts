import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";
import { runProcess } from "../src/tools/process.js";
import { powershellArguments } from "../src/tools/shell.js";

test("PowerShell commands use attached -Command transport for Unicode, quotes, and newlines", () => {
  const command = `Write-Output "café 'quoted'";\nWrite-Output 'line 2 — 日本語'`;
  const args = powershellArguments(command);
  assert.deepEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(args.length, 5);
  assert.equal(args[4],
    "$OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = $OutputEncoding; " + command);
});

test("Windows process cancellation uses direct taskkill tree termination", async () => {
  const calls: { command: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
  let main: FakeChild | undefined;
  const spawnProcess = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    if (command.toLowerCase().endsWith("\\system32\\taskkill.exe")) return new FakeChild(0) as unknown as ChildProcess;
    main = new FakeChild(4242);
    return main as unknown as ChildProcess;
  }) as unknown as typeof spawn;

  const controller = new AbortController();
  const running = runProcess("powershell.exe", ["-Command", "Start-Sleep 10"], {
    cwd: process.cwd(),
    env: {},
    timeoutMs: 10_000,
    captureBytes: 1_024,
    signal: controller.signal,
    platform: "win32",
    spawnProcess,
  });
  controller.abort();
  main!.emit("close", 1, null);
  const result = await running;

  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.deepEqual(calls.map(({ command, args }) => [command, ...args]), [
    ["powershell.exe", "-Command", "Start-Sleep 10"],
    ["C:\\Windows\\System32\\taskkill.exe", "/PID", "4242", "/T", "/F"],
  ]);
  assert.equal(calls[0]?.options.shell, false);
  assert.equal(calls[0]?.options.detached, false);
  assert.equal(calls[0]?.options.windowsHide, true);
  assert.equal(calls[1]?.options.shell, false);
  assert.equal(calls[1]?.options.windowsHide, true);
});

test("POSIX process defaults remain detached for process-group cancellation", async () => {
  const calls: { options: Record<string, unknown> }[] = [];
  let main: FakeChild | undefined;
  const spawnProcess = ((_command: string, _args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ options });
    main = new FakeChild(0);
    return main as unknown as ChildProcess;
  }) as unknown as typeof spawn;

  const running = runProcess("bash", ["-c", "true"], {
    cwd: process.cwd(),
    env: {},
    timeoutMs: 10_000,
    captureBytes: 1_024,
    platform: "linux",
    spawnProcess,
  });
  assert.equal(calls[0]?.options.detached, true);
  main!.emit("close", 0, null);
  const result = await running;
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
});

test("Windows taskkill errors and nonzero exits fall back to the child handle", async () => {
  for (const failure of ["error", "close"]) {
    let main: FakeChild | undefined;
    let killer: FakeChild | undefined;
    const spawnProcess = ((command: string) => {
      if (command.toLowerCase().endsWith("\\system32\\taskkill.exe")) {
        killer = new FakeChild(0);
        return killer as unknown as ChildProcess;
      }
      main = new FakeChild(5151);
      return main as unknown as ChildProcess;
    }) as unknown as typeof spawn;
    const controller = new AbortController();
    const running = runProcess("powershell.exe", ["-Command", "Write-Output x"], {
      cwd: process.cwd(),
      env: {},
      timeoutMs: 10_000,
      captureBytes: 1_024,
      signal: controller.signal,
      platform: "win32",
      spawnProcess,
    });
    controller.abort();
    if (failure === "error") killer!.emit("error", new Error("taskkill unavailable"));
    else killer!.emit("close", 1, null);
    assert.equal(main!.killed, true);
    main!.emit("close", null, null);
    const result = await running;
    assert.equal(result.signal, null);
  }
});

test("Windows cancellation settles after direct kill even if close is lost", async () => {
  let killer: FakeChild | undefined;
  const spawnProcess = ((command: string) => {
    if (command.toLowerCase().endsWith("\\system32\\taskkill.exe")) {
      killer = new FakeChild(0);
      return killer as unknown as ChildProcess;
    }
    return new FakeChild(6161) as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  const controller = new AbortController();
  const running = runProcess("powershell.exe", ["-Command", "Write-Output x"], {
    cwd: process.cwd(),
    env: {},
    timeoutMs: 10_000,
    captureBytes: 1_024,
    signal: controller.signal,
    platform: "win32",
    spawnProcess,
  });
  controller.abort();
  killer!.emit("close", 1, null);
  const result = await running;
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, null);
});

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  constructor(readonly pid: number) {
    super();
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createWindowsScheduler,
  installService,
  powerShellLiteral,
  renderLauncher,
  renderTaskXml,
  serviceStatus,
  uninstallService,
} from "../src/scheduler/windows.js";
import { schedulerForPlatform } from "../src/scheduler/service.js";

test("renders Windows paths as safe PowerShell and XML literals", () => {
  const nodePath = `C:\\Program Files\\Node's & 100%.exe`;
  const cliPath = `C:\\Looking Glass\\it's & ready\\cli.js`;
  const dbPath = `C:\\Users\\A&B\\state's 100%.db`;
  const launcher = renderLauncher(nodePath, cliPath, dbPath);
  assert.match(launcher, /Node''s & 100%\.exe/);
  assert.match(launcher, /LOOKING_GLASS_DB/);
  assert.match(launcher, /& \$node \$cli 'cron' 'daemon'/);
  const xml = renderTaskXml(`C:\\Looking Glass\\scheduler's & 100%.ps1`, {
    user: "DOMAIN\\user's",
    workingDirectory: "C:\\Users\\A&B",
  });
  assert.match(xml, /scheduler&apos;s &amp; 100%\.ps1/);
  assert.match(xml, /DOMAIN\\user&apos;s/);
  assert.match(xml, /<LogonTrigger>[\s\S]*<UserId>DOMAIN\\user&apos;s<\/UserId>/);
  assert.doesNotMatch(xml, /<Hidden>true<\/Hidden>/);
  assert.match(xml, /-WindowStyle Hidden/);
  assert.match(xml, /<Command>C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe<\/Command>/);
  assert.match(xml, /IgnoreNew/);
  assert.match(xml, /InteractiveToken/);
  assert.match(xml, /LeastPrivilege/);
  assert.match(xml, /ExecutionTimeLimit>PT0S/);
  assert.match(xml, /RestartOnFailure/);
});

test("Windows scheduler dispatches without invoking a host scheduler", () => {
  const commands: Array<{ command: string; args: string[] }> = [];
  const runner = (command: string, args: string[]) => {
    commands.push({ command, args });
    // Status comes from the PowerShell enum value, which is stable across
    // Windows locales; no localized command output is parsed.
    if (command.endsWith("\\System32\\schtasks.exe")) return { status: 0, stdout: "Status: Wird ausgeführt\n" };
    return { status: 0, stdout: "Running\n" };
  };
  const backend = schedulerForPlatform("win32", {
    command: runner,
    configDirectory: mkdtempSync(join(tmpdir(), "looking-glass-windows-")),
    user: "DOMAIN\\user",
  });
  assert.equal(backend.serviceStatus().includes("ActiveState=active"), true);
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  const script = commands[0]?.args.at(-1) ?? "";
  assert.match(script, /Get-ScheduledTask/);
  assert.equal(script.includes("Get-ScheduledTask -ErrorAction Stop"), true);
  assert.match(script, /Where-Object \{ \$_.TaskPath -eq '\\' -and \$_.TaskName -eq/);
  assert.equal(script.includes("FullyQualifiedErrorId"), false);
});

test("Windows runtime reports a truly absent root task as inactive", { skip: process.platform !== "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "looking-glass-windows-"));
  try {
    const taskName = `Looking Glass Missing ${randomUUID()}`;
    assert.match(serviceStatus({ configDirectory: directory, taskName }), /ActiveState=inactive/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("install and uninstall preserve state while cleaning generated files", () => {
  const directory = mkdtempSync(join(tmpdir(), "looking-glass-windows-"));
  const commands: string[][] = [];
  const runner = (command: string, args: string[]) => {
    commands.push([command, ...args]);
    if (command.endsWith("\\WindowsPowerShell\\v1.0\\powershell.exe")) return { status: 0, stdout: "Running" };
    return { status: 0, stdout: "" };
  };
  const options = { command: runner, configDirectory: directory, user: "user" };
  assert.equal(installService("C:\\Program Files\\node.exe", "C:\\state.db", options), "Looking Glass Scheduler");
  const launcherPath = join(directory, "scheduler-launcher.ps1");
  const xmlPath = join(directory, "scheduler-task.xml");
  assert.equal(existsSync(launcherPath), true);
  assert.equal(existsSync(xmlPath), true);
  const launcherBytes = readFileSync(launcherPath);
  assert.deepEqual([...launcherBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(launcherBytes.toString("utf8"), /LOOKING_GLASS_DB/);
  assert.deepEqual([...readFileSync(xmlPath).subarray(0, 2)], [0xff, 0xfe]);
  assert.deepEqual(commands.map((entry) => entry[1]), ["-NoLogo", "/End", "/Create", "/Run"]);
  assert.equal(uninstallService(options), true);
  assert.equal(existsSync(launcherPath), false);
  assert.equal(existsSync(xmlPath), false);
  assert.deepEqual(commands.map((entry) => entry[1]), ["-NoLogo", "/End", "/Create", "/Run", "-NoLogo", "/End", "/Delete"]);
});

test("missing Windows task is nonfatal for status and uninstall", () => {
  const directory = mkdtempSync(join(tmpdir(), "looking-glass-windows-"));
  const commands: string[][] = [];
  const options = {
    configDirectory: directory,
    command: (_command: string, args: string[]) => {
      commands.push(args);
      return { status: 1, stderr: "LOOKING_GLASS_TASK_NOT_FOUND" };
    },
  };
  assert.match(serviceStatus(options), /ActiveState=inactive/);
  assert.equal(uninstallService(options), false);
  assert.deepEqual(commands.map((args) => args[0]), ["-NoLogo", "-NoLogo"]);
  // Keep this pure test from accidentally depending on a user's real task.
  assert.equal(powerShellLiteral("a'b"), "'a''b'");
});

test("localized missing-task text without the sentinel is an operational failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "looking-glass-windows-"));
  const launcherPath = join(directory, "scheduler-launcher.ps1");
  const xmlPath = join(directory, "scheduler-task.xml");
  writeFileSync(launcherPath, "keep");
  writeFileSync(xmlPath, "keep");
  const options = {
    configDirectory: directory,
    user: "user",
    command: () => ({ status: 1, stderr: "La tarea programada no existe" }),
  };

  assert.throws(() => serviceStatus(options), /La tarea programada no existe/);
  assert.throws(() => uninstallService(options), /La tarea programada no existe/);
  assert.equal(existsSync(launcherPath), true);
  assert.equal(existsSync(xmlPath), true);
});

test("documented Task Scheduler missing-task codes permit cleanup", () => {
  const directory = mkdtempSync(join(tmpdir(), "looking-glass-windows-"));
  const launcherPath = join(directory, "scheduler-launcher.ps1");
  const xmlPath = join(directory, "scheduler-task.xml");
  writeFileSync(launcherPath, "remove");
  writeFileSync(xmlPath, "remove");
  const options = {
    configDirectory: directory,
    user: "user",
    command: () => ({ status: 1, errorCode: "SCHED_E_TASK_NOT_FOUND" }),
  };

  assert.match(serviceStatus(options), /ActiveState=inactive/);
  assert.equal(uninstallService(options), false);
  assert.equal(existsSync(launcherPath), false);
  assert.equal(existsSync(xmlPath), false);
});

test("relative database paths are resolved before writing the launcher", () => {
  const directory = mkdtempSync(join(tmpdir(), "looking-glass-windows-"));
  const runner = (command: string) => {
    if (command.endsWith("\\WindowsPowerShell\\v1.0\\powershell.exe")) return { status: 1, stderr: "LOOKING_GLASS_TASK_NOT_FOUND" };
    return { status: 0, stdout: "" };
  };
  installService("relative/cli.js", "relative/state.db", {
    command: runner,
    configDirectory: directory,
    user: "user",
  });
  const launcher = readFileSync(join(directory, "scheduler-launcher.ps1"), "utf8");
  assert.equal(launcher.includes(`LOOKING_GLASS_DB = '${resolve("relative/state.db")}'`), true);
});

test("access failures are not mistaken for missing tasks or allowed to clean files", () => {
  const directory = mkdtempSync(join(tmpdir(), "looking-glass-windows-"));
  const launcherPath = join(directory, "scheduler-launcher.ps1");
  const xmlPath = join(directory, "scheduler-task.xml");
  const runner = () => ({ status: 5, stderr: "Access is denied", errorCode: "E_ACCESSDENIED", errorMessage: "access denied" });
  const options = { command: runner, configDirectory: directory, user: "user" };
  assert.throws(() => serviceStatus(options), /access denied/i);
  writeFileSync(launcherPath, "keep");
  writeFileSync(xmlPath, "keep");
  assert.throws(() => uninstallService(options), /access denied/i);
  assert.equal(existsSync(launcherPath), true);
  assert.equal(existsSync(xmlPath), true);
});

test("uninstall leaves an already stopped task running state untouched when delete fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "looking-glass-windows-"));
  const launcherPath = join(directory, "scheduler-launcher.ps1");
  const xmlPath = join(directory, "scheduler-task.xml");
  writeFileSync(launcherPath, "keep");
  writeFileSync(xmlPath, "keep");
  const runner = (command: string, args: string[]) => {
    if (command.endsWith("\\WindowsPowerShell\\v1.0\\powershell.exe")) return { status: 0, stdout: "Ready" };
    if (args[0] === "/End") return { status: 1, stderr: "The task is not running" };
    return { status: 1, stderr: "Access is denied", errorCode: "E_ACCESSDENIED" };
  };
  assert.throws(() => uninstallService({ command: runner, configDirectory: directory, user: "user" }), /Access is denied/);
  assert.equal(existsSync(launcherPath), true);
  assert.equal(existsSync(xmlPath), true);
});

test("install does not end a Ready task before replacing it", () => {
  const directory = mkdtempSync(join(tmpdir(), "looking-glass-windows-"));
  const calls: string[][] = [];
  const runner = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command.endsWith("\\WindowsPowerShell\\v1.0\\powershell.exe")) return { status: 0, stdout: "Ready" };
    return { status: 0, stdout: "" };
  };

  installService("C:\\node.exe", "C:\\state.db", { command: runner, configDirectory: directory, user: "user" });
  assert.deepEqual(calls.map((entry) => entry[1]), ["-NoLogo", "/Create", "/Run"]);
});

test("uninstall does not end a Disabled task before deleting it", () => {
  const directory = mkdtempSync(join(tmpdir(), "looking-glass-windows-"));
  const launcherPath = join(directory, "scheduler-launcher.ps1");
  const xmlPath = join(directory, "scheduler-task.xml");
  writeFileSync(launcherPath, "keep");
  writeFileSync(xmlPath, "keep");
  const calls: string[][] = [];
  const runner = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command.endsWith("\\WindowsPowerShell\\v1.0\\powershell.exe")) return { status: 0, stdout: "Disabled" };
    return { status: 0, stdout: "" };
  };

  assert.equal(uninstallService({ command: runner, configDirectory: directory, user: "user" }), true);
  assert.deepEqual(calls.map((entry) => entry[1]), ["-NoLogo", "/Delete"]);
});

test("failed replacement attempts to restart a running task without masking the failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "looking-glass-windows-"));
  const launcherPath = join(directory, "scheduler-launcher.ps1");
  const xmlPath = join(directory, "scheduler-task.xml");
  writeFileSync(launcherPath, "previous launcher");
  writeFileSync(xmlPath, "previous XML");
  const calls: string[][] = [];
  const runner = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command.endsWith("\\WindowsPowerShell\\v1.0\\powershell.exe")) return { status: 0, stdout: "Running" };
    if (args[0] === "/Create") return { status: 1, stderr: "replacement failed" };
    if (args[0] === "/Run") return { status: 1, stderr: "recovery unavailable" };
    return { status: 0, stdout: "" };
  };

  assert.throws(
    () => installService("C:\\node.exe", "C:\\state.db", { command: runner, configDirectory: directory, user: "user" }),
    /replacement failed/,
  );
  assert.equal(readFileSync(launcherPath, "utf8"), "previous launcher");
  assert.equal(readFileSync(xmlPath, "utf8"), "previous XML");
  assert.deepEqual(calls.map((entry) => entry[1]), ["-NoLogo", "/End", "/Create", "/Run"]);
  assert.equal(calls.at(-1)?.[0], "C:\\Windows\\System32\\schtasks.exe");
});

test("failed deletion attempts to restart a running task without masking the failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "looking-glass-windows-"));
  const launcherPath = join(directory, "scheduler-launcher.ps1");
  const xmlPath = join(directory, "scheduler-task.xml");
  writeFileSync(launcherPath, "keep");
  writeFileSync(xmlPath, "keep");
  const calls: string[][] = [];
  const runner = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command.endsWith("\\WindowsPowerShell\\v1.0\\powershell.exe")) return { status: 0, stdout: "Running" };
    if (args[0] === "/Delete") return { status: 1, stderr: "deletion failed" };
    if (args[0] === "/Run") return { status: 1, stderr: "recovery unavailable" };
    return { status: 0, stdout: "" };
  };

  assert.throws(
    () => uninstallService({ command: runner, configDirectory: directory, user: "user" }),
    /deletion failed/,
  );
  assert.equal(existsSync(launcherPath), true);
  assert.equal(existsSync(xmlPath), true);
  assert.deepEqual(calls.map((entry) => entry[1]), ["-NoLogo", "/End", "/Delete", "/Run"]);
});

test("XML text rejects controls and empty scheduler values", () => {
  assert.throws(() => renderTaskXml(""), /launcher path must not be empty/);
  assert.throws(() => renderTaskXml("launcher.ps1", { user: "" }), /task user must not be empty/);
  assert.throws(() => renderTaskXml("launcher.ps1", { taskName: "Task\u0001" }), /invalid XML control/);
});

test("dispatcher keeps Linux on the existing systemd backend", () => {
  const backend = createWindowsScheduler({ command: () => ({ status: 0 }) });
  assert.equal(typeof backend.installService, "function");
  assert.equal(typeof schedulerForPlatform("linux").serviceStatus, "function");
});

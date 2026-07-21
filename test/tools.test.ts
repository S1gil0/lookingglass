import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { openDatabase } from "../src/storage/database.js";
import { SessionStore } from "../src/storage/session-store.js";
import { SchedulerStore } from "../src/scheduler/store.js";
import { applyPatchTool } from "../src/tools/apply-patch.js";
import { bashTool, powershellApprovalExecutable } from "../src/tools/bash.js";
import { readTool } from "../src/tools/read.js";
import { ToolRegistry, toolApprovalSignature } from "../src/tools/registry.js";
import { createScheduleTools } from "../src/tools/schedule.js";
import { bashApprovalExecutable, bashCommandRisk, isSensitiveMutationPath, patchRisk, powershellCommandRisk, shellEnvironment, workspacePatchRisk } from "../src/tools/safety.js";
import { powershellArguments, powershellExecutable, shellCommand, shellDefinition, shellKind, taskkillExecutable, windowsSystemRoot } from "../src/tools/shell.js";
import { globTool, grepTool } from "../src/tools/search.js";
import type { GlassTool, ToolContext } from "../src/tools/types.js";
import {
  compoundWriteCommand,
  largeOutputCommand,
  outputCommand,
  removeDirectoryCommand,
  sleepCommand,
  transformInputCommand,
} from "./helpers.js";

function fixture(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), "looking-glass-tools-"));
  const workspace = join(base, "workspace");
  const artifactDir = join(base, "artifacts");
  mkdirSync(workspace);
  mkdirSync(artifactDir);
  const db = openDatabase(join(base, "state.db"));
  const sessions = new SessionStore(db);
  const session = sessions.create({
    workspace,
    model: "test",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
  });
  const config = structuredClone(DEFAULT_CONFIG);
  config.tools.maxOutputBytes = 128;
  config.tools.maxReadLines = 20;
  t.after(() => {
    db.close();
    rmSync(base, { recursive: true, force: true });
  });
  const context: ToolContext = {
    workspace,
    sessionId: session.id,
    config,
    artifacts: new ArtifactStore(db, artifactDir),
    sessions,
    signal: new AbortController().signal,
    approve: async () => "once",
    ask: async () => "answer",
  };
  return { base, workspace, context, db };
}

function parseApprovalSignature(signature: string | undefined): unknown[] {
  assert.ok(signature, "approval signature should be present");
  const parsed: unknown = JSON.parse(signature);
  assert.ok(Array.isArray(parsed), "approval signature should be an array");
  return parsed;
}

function decodePowerShellCommand(args: readonly string[]): string {
  assert.deepEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  assert.equal(args.length, 5);
  return Buffer.from(args[4]!, "base64").toString("utf16le");
}

test("read handles files, directories, and artifacts", async (t) => {
  const { base, workspace, context } = fixture(t);
  if (process.platform === "win32") assert.equal(existsSync(join(base, "state.db")), true);
  else assert.equal(statSync(join(base, "state.db")).mode & 0o077, 0);
  mkdirSync(join(workspace, "src"));
  writeFileSync(join(workspace, "src", "file.txt"), "alpha\nbeta\ngamma\n");
  const file = await readTool.execute({ path: "src/file.txt", offset: 2, limit: 1 }, context);
  assert.equal(file.output, "2: beta\n\n[Truncated. Continue at line 3.]");
  const directory = await readTool.execute({ path: "src", offset: null, limit: null }, context);
  assert.equal(directory.output, "file.txt");

  const artifact = context.artifacts.save(context.sessionId, "test", "0123456789");
  const range = await readTool.execute({ path: artifact.uri, offset: 3, limit: 4 }, context);
  assert.match(range.output, /^3456/);

});

test("read rejects symlink escapes when the host permits symlink creation", async (t) => {
  const { base, workspace, context } = fixture(t);
  const outside = join(base, "outside.txt");
  writeFileSync(outside, "secret");
  try {
    symlinkSync(outside, join(workspace, "escape.txt"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
      t.skip("symlink creation requires elevated Windows privileges");
      return;
    }
    throw error;
  }
  await assert.rejects(
    readTool.execute({ path: "escape.txt", offset: null, limit: null }, context),
    /outside the workspace/,
  );
});

test("registry centrally bounds UTF-8 tool output and preserves the full artifact", async (t) => {
  const { context } = fixture(t);
  context.modelOutputBytes = 1_024;
  const large: GlassTool<Record<string, never>> = {
    name: "large_read",
    description: "large read result",
    risk: "read",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    summarize: () => "large read",
    async execute() {
      return { output: "é".repeat(10_000) };
    },
  };
  const result = await new ToolRegistry().register(large).execute("large_read", {}, context);
  assert.ok(Buffer.byteLength(result.output) <= 1_024);
  assert.equal(result.output.includes("�"), false);
  assert.equal(result.truncated, true);
  assert.ok(result.artifactUri);
  assert.equal(context.artifacts.read(result.artifactUri!, 0, 30_000).toString("utf8"), "é".repeat(10_000));

  context.modelOutputBytes = 17;
  const staleArtifact = await new ToolRegistry().register({
    ...large,
    async execute() {
      return { output: "full output must survive", artifactUri: "artifact://missing" };
    },
  }).execute("large_read", {}, context);
  assert.ok(Buffer.byteLength(staleArtifact.output) <= 17);
  assert.notEqual(staleArtifact.artifactUri, "artifact://missing");
  assert.equal(context.artifacts.read(staleArtifact.artifactUri!, 0, 100).toString("utf8"), "full output must survive");
});

test("registry redacts configured credentials before output persistence", async (t) => {
  const { context } = fixture(t);
  const secret = "test-secret-value-12345";
  const previous = process.env.TEST_LOOKING_GLASS_API_KEY;
  process.env.TEST_LOOKING_GLASS_API_KEY = secret;
  context.config.gateway.apiKeyEnv = "TEST_LOOKING_GLASS_API_KEY";
  const bearer = ["unrelated", "secret", "token"].join("-");
  t.after(() => {
    if (previous === undefined) delete process.env.TEST_LOOKING_GLASS_API_KEY;
    else process.env.TEST_LOOKING_GLASS_API_KEY = previous;
  });
  const result = await new ToolRegistry().register({
    name: "credential_read",
    description: "credential-shaped output",
    risk: "read",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    summarize: () => "credential output",
    async execute() {
      return { output: `configured=${secret}\nAuthorization: Bearer ${bearer}` };
    },
  }).execute("credential_read", {}, context);
  assert.equal(result.output.includes(secret), false);
  assert.equal(result.output.includes(bearer), false);
  assert.match(result.output, /\[REDACTED\]/);
});

test("glob and grep use bounded ripgrep searches", async (t) => {
  const { workspace, context } = fixture(t);
  mkdirSync(join(workspace, "src"));
  writeFileSync(join(workspace, "src", "one.ts"), "const prism = 1;\n");
  writeFileSync(join(workspace, "src", "two.js"), "const other = 2;\n");

  const glob = await globTool.execute({ pattern: "**/*.ts", path: null, limit: 10 }, context);
  assert.equal(glob.output, "src/one.ts");
  const grep = await grepTool.execute({ pattern: "prism", path: "src", include: "*.ts", limit: 10 }, context);
  assert.match(grep.output, /src\/one\.ts:1:\d+:const prism/);
  const missing = await grepTool.execute({ pattern: "absent", path: null, include: null, limit: 10 }, context);
  assert.equal(missing.output, "No matches found.");
  await assert.rejects(
    grepTool.execute({ pattern: ".", path: "../", include: null, limit: 10 }, context),
    /outside the workspace/,
  );
});

test("glob and grep sanitize ripgrep credentials", async (t) => {
  if (process.platform === "win32") {
    t.skip("test helper uses a POSIX executable");
    return;
  }
  const { base, context } = fixture(t);
  const bin = join(base, "bin");
  const executable = join(bin, "rg");
  const credentialName = "LOOKING_GLASS_SEARCH_SECRET";
  const previousPath = process.env.PATH;
  const previousCredential = process.env[credentialName];
  mkdirSync(bin);
  writeFileSync(executable, `#!/bin/sh\nprintf '%s' "\${${credentialName}:-unset}"\n`);
  chmodSync(executable, 0o755);
  process.env.PATH = bin;
  process.env[credentialName] = "search-secret-value";
  context.config.gateway.apiKeyEnv = credentialName;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCredential === undefined) delete process.env[credentialName];
    else process.env[credentialName] = previousCredential;
  });

  assert.equal((await globTool.execute({ pattern: "*", path: null, limit: 10 }, context)).output, "unset");
  assert.equal((await grepTool.execute({ pattern: "*", path: null, include: null, limit: 10 }, context)).output, "unset");
});

test("bash bounds model output, stores an artifact, and cancels process groups", async (t) => {
  const { context } = fixture(t);
  const large = await bashTool.execute({
    command: largeOutputCommand("x", 3_000),
    workdir: null,
    timeout_ms: 10_000,
  }, context);
  assert.equal(large.truncated, true);
  assert.match(large.artifactUri ?? "", /^artifact:\/\//);
  assert.ok(context.artifacts.get(large.artifactUri ?? "")?.byteCount);

  const controller = new AbortController();
  const cancelledContext = { ...context, signal: controller.signal };
  const started = Date.now();
  const running = bashTool.execute({ command: sleepCommand(5), workdir: null, timeout_ms: 10_000 }, cancelledContext);
  setTimeout(() => controller.abort(), 30);
  const cancelled = await running;
  assert.ok(Date.now() - started < 2_000);
  if (process.platform === "win32") assert.match(cancelled.output, /exit: (?:\d+|unknown)/);
  else assert.match(cancelled.output, /exit: SIGTERM|exit: SIGKILL/);
});

test("registry lets unrestricted persistent actions run without approval", async (t) => {
  const { context } = fixture(t);
  let approvals = 0;
  context.config.tools.approval = "code";
  context.approvalMode = "unrestricted";
  context.approve = async () => {
    approvals += 1;
    return "once";
  };
  const persistent: GlassTool<{ value: string }> = {
    name: "persistent_test",
    description: "test",
    risk: "persistent",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    summarize: ({ value }) => value,
    async execute({ value }) {
      return { output: value };
    },
  };
  const registry = new ToolRegistry().register(persistent);
  const args = registry.parseArguments("persistent_test", '{"value":"ok"}');
  assert.equal((await registry.execute("persistent_test", args, context)).output, "ok");
  assert.equal(approvals, 0);
  context.approvalMode = "code";
  assert.equal((await registry.execute("persistent_test", args, context)).output, "ok");
  assert.equal(approvals, 1);
  assert.throws(() => registry.parseArguments("persistent_test", '{"value":1}'), /Invalid arguments/);
});

test("unrestricted mode runs critical shell and patch operations without approval", async (t) => {
  const { context, workspace } = fixture(t);
  context.config.tools.approval = "unrestricted";
  const approvals: string[] = [];
  context.approve = async (request) => {
    approvals.push(`${request.risk}:${request.summary}`);
    throw new Error("unrestricted action requested approval");
  };
  const registry = new ToolRegistry().register(bashTool).register(applyPatchTool);

  const deletionCommand = registry.parseArguments("bash", JSON.stringify({
    command: removeDirectoryCommand("disposable"),
    workdir: null,
    timeout_ms: null,
  }));
  mkdirSync(join(workspace, "disposable"));
  await registry.execute("bash", deletionCommand, context);
  assert.equal(existsSync(join(workspace, "disposable")), false);
  writeFileSync(join(workspace, "important.txt"), "keep\n");
  const deletion = registry.parseArguments("apply_patch", JSON.stringify({
    patch: "*** Begin Patch\n*** Delete File: important.txt\n*** End Patch",
  }));
  await registry.execute("apply_patch", deletion, context);
  assert.equal(existsSync(join(workspace, "important.txt")), false);
  assert.equal(approvals.length, 0);

  const safeShell = registry.parseArguments("bash", JSON.stringify({
    command: outputCommand("safe"),
    workdir: null,
    timeout_ms: null,
  }));
  assert.match((await registry.execute("bash", safeShell, context)).output, /safe/);
  writeFileSync(join(workspace, "input.txt"), "before\n");
  const ordinaryShellWrite = registry.parseArguments("bash", JSON.stringify({
    command: transformInputCommand(),
    workdir: workspace,
    timeout_ms: 5_000,
  }));
  await registry.execute("bash", ordinaryShellWrite, context);
  assert.equal(readFileSync(join(workspace, "output.txt"), "utf8"), "after\n");
  writeFileSync(join(workspace, "ordinary.txt"), "before\n");
  const ordinaryPatch = registry.parseArguments("apply_patch", JSON.stringify({
    patch: "*** Begin Patch\n*** Update File: ordinary.txt\n@@\n-before\n+after\n*** End Patch",
  }));
  assert.match((await registry.execute("apply_patch", ordinaryPatch, context)).output, /Updated ordinary.txt/);
  assert.equal(approvals.length, 0);

  assert.equal(bashCommandRisk("git status"), "shell");
  assert.equal(bashCommandRisk("systemctl status example-service"), "shell");
  assert.equal(bashCommandRisk("rm -rf /srv/data"), "critical");
  assert.equal(bashCommandRisk("'rm' -rf /srv/data"), "critical");
  assert.equal(bashCommandRisk("r\\m -rf /srv/data"), "critical");
  assert.equal(bashCommandRisk("r''m -rf /srv/data"), "critical");
  assert.equal(bashCommandRisk("git checkout -- config.json"), "critical");
  assert.equal(bashCommandRisk("curl -X DELETE https://prod.example/api"), "critical");
  assert.equal(bashCommandRisk("systemctl --user restart example-service"), "shell");
  assert.equal(bashCommandRisk("systemctl restart sshd"), "critical");
  assert.equal(bashCommandRisk("pkill sshd"), "critical");
  assert.equal(bashCommandRisk("systemd-run --unit=experiment /usr/bin/node server.js"), "shell");
  assert.equal(bashCommandRisk("nohup node server.js > server.log 2>&1 &"), "shell");
  assert.equal(bashCommandRisk("node server.js &"), "shell");
  assert.equal(bashCommandRisk("bash ./deploy.sh"), "shell");
  assert.equal(bashCommandRisk("cat input > output && sed -i s/a/b/ output"), "shell");
  assert.equal(bashCommandRisk("cat ~/.ssh/authorized_keys"), "shell");
  assert.equal(bashCommandRisk("printf key > ~/.ssh/authorized_keys"), "critical");
  assert.equal(bashCommandRisk("printf key > \"$HOME/.ssh/authorized_keys\""), "critical");
  assert.equal(bashCommandRisk("printf key >| ./.ssh/authorized_keys"), "critical");
  assert.equal(bashCommandRisk("sed -i s/old/new/ /etc/ssh/sshd_config"), "critical");
  assert.equal(bashCommandRisk("cp ~/.ssh/authorized_keys backup"), "shell");
  assert.equal(bashCommandRisk("tee backup < ~/.ssh/authorized_keys"), "shell");
  assert.equal(bashCommandRisk("curl -X POST https://prod.example/api -d data"), "shell");
  assert.equal(bashCommandRisk("iptables -L"), "shell");
  assert.equal(bashCommandRisk("iptables -F"), "critical");
  assert.equal(bashCommandRisk("sqlite3 app.db 'DELETE FROM users'"), "critical");
  assert.equal(bashCommandRisk("rg 'DELETE FROM' src"), "shell");
  assert.equal(bashCommandRisk("printf 'DELETE FROM users'"), "shell");
  assert.equal(bashCommandRisk("git push origin main"), "shell");
  assert.equal(bashCommandRisk("git push origin --delete old"), "critical");
  assert.equal(bashCommandRisk("git push --force origin main"), "critical");
  assert.equal(bashCommandRisk("git push -f origin main"), "critical");
  assert.equal(bashCommandRisk("git push -d origin old"), "critical");
  assert.equal(bashCommandRisk("git push origin +main:main"), "critical");
  assert.equal(bashCommandRisk("git push origin +main"), "critical");
  assert.equal(bashCommandRisk("git push --mirror"), "critical");
  assert.equal(bashCommandRisk("git push --prune origin"), "critical");
  assert.equal(bashCommandRisk("git -C repo push --force origin main"), "critical");
  assert.equal(bashCommandRisk("git log --grep='push --force'"), "shell");
  assert.equal(bashCommandRisk("install -t ~/.ssh authorized_keys"), "critical");
  assert.equal(bashCommandRisk("cp --target-directory=~/.ssh authorized_keys"), "critical");
  assert.equal(bashCommandRisk("redis-cli DEL prod:key"), "critical");
  assert.equal(bashCommandRisk("mongosh --eval 'db.users.deleteMany({})'"), "critical");
  assert.equal(bashCommandRisk("docker inspect platform"), "shell");
  assert.equal(bashCommandRisk("git log --all --format=preclean"), "shell");
  assert.equal(bashCommandRisk("kubectl get pod predelete"), "shell");
  assert.equal(bashCommandRisk("aws ec2 describe-tags --filters Name=tag:mode,Values=predelete"), "shell");
  assert.equal(bashCommandRisk("npm test"), "shell");
  assert.equal(bashCommandRisk("printf first && printf second 2>&1"), "shell");
  assert.equal(patchRisk("*** Begin Patch\n*** Update File: src/app.ts\n*** End Patch"), "write");
  assert.equal(patchRisk("*** Begin Patch\n*** Update File: .ssh/config\n*** End Patch"), "critical");
  assert.equal(patchRisk("*** Begin Patch\n*** Update File: .env.example\n*** End Patch"), "write");
  assert.equal(patchRisk("*** Begin Patch\n*** Update File: .env.production\n*** End Patch"), "write");
  assert.equal(patchRisk("*** Begin Patch\n*** Move to: renamed.txt\n*** End Patch"), "write");
  assert.equal(workspacePatchRisk("/root", "*** Update File: ordinary.txt"), "write");
  const sanitized = shellEnvironment({ "BASH_FUNC_printf%%": "() { rm -rf victim; }", PATH: "/bin" });
  assert.equal(sanitized["BASH_FUNC_printf%%"], undefined);
  const withoutCredential = shellEnvironment({ PATH: "/bin", TEST_API_KEY: "secret" }, ["TEST_API_KEY"]);
  assert.equal(withoutCredential.TEST_API_KEY, undefined);
});

test("sensitive mutation paths use POSIX slash semantics for Windows-style paths", () => {
  const windowsSeparator = String.fromCharCode(92);
  for (const path of [
    ".ssh/config",
    `.ssh${windowsSeparator}config`,
    "etc/passwd",
    `etc${windowsSeparator}passwd`,
    `${windowsSeparator}etc${windowsSeparator}passwd`,
  ]) {
    assert.equal(isSensitiveMutationPath(path), true, path);
    assert.equal(patchRisk(`*** Update File: ${path}`), "critical", path);
  }
  assert.equal(isSensitiveMutationPath("etc/passwd.backup"), false);
});

test("apply_patch requires approval for sensitive symlink targets when links are available", async (t) => {
  const { context, workspace } = fixture(t);
  mkdirSync(join(workspace, ".ssh"));
  writeFileSync(join(workspace, ".ssh", "config"), "safe=true\n");
  try {
    symlinkSync(join(workspace, ".ssh", "config"), join(workspace, "config-link"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
      t.skip("symlink creation requires elevated Windows privileges");
      return;
    }
    throw error;
  }
  const registry = new ToolRegistry().register(applyPatchTool);
  const sensitiveSymlink = registry.parseArguments("apply_patch", JSON.stringify({
    patch: "*** Begin Patch\n*** Update File: config-link\n@@\n-safe=true\n+safe=false\n*** End Patch",
  }));
  context.config.tools.approval = "code";
  context.approve = async () => "deny";
  await assert.rejects(registry.execute("apply_patch", sensitiveSymlink, context), /denied/);
});

test("Bash keeps executable approval scope while PowerShell stays exact-command scoped", (t) => {
  const { context, workspace } = fixture(t);
  mkdirSync(join(workspace, "subdir"));
  const windows = process.platform === "win32";
  const shell = windows ? "powershell" : "bash";
  const executable = "cat";
  const firstCommand = windows ? "Get-Content one.txt" : "cat one.txt";
  const secondCommand = windows ? "Get-Content two.txt" : "/usr/bin/cat two.txt";
  const first = bashTool.approvalSignature?.({ command: firstCommand, workdir: null, timeout_ms: null }, context);
  const second = bashTool.approvalSignature?.({ command: secondCommand, workdir: "subdir", timeout_ms: 5_000 }, context);
  if (windows) {
    assert.deepEqual(parseApprovalSignature(first), [
      "shell-exec", 1, "powershell", firstCommand, workspace, context.config.tools.shellTimeoutMs,
    ]);
    assert.deepEqual(parseApprovalSignature(second), [
      "shell-exec", 1, "powershell", secondCommand, join(workspace, "subdir"), 5_000,
    ]);
    assert.notEqual(second, first);
  } else {
    assert.deepEqual(parseApprovalSignature(first), ["shell-executable", 1, shell, executable]);
    assert.deepEqual(parseApprovalSignature(second), ["shell-executable", 1, shell, executable]);
  }
  assert.equal(bashApprovalExecutable("VALUE='hello world' cat file"), "cat");
  assert.equal(bashApprovalExecutable("'cat' file"), "cat");
  assert.equal(bashApprovalExecutable("cat file | grep value"), "cat");
  assert.equal(bashApprovalExecutable("cat $(rm victim)"), "cat");
  assert.equal(bashApprovalExecutable("sudo cat file"), "sudo");
  assert.equal(bashApprovalExecutable("dash -c 'printf safe'"), "dash");
  assert.equal(bashApprovalExecutable("source harmless.sh"), "source");
  assert.equal(bashApprovalExecutable("FOO+=x cat file"), "cat");
  const ordinaryGit = bashTool.approvalSignature?.({ command: "git status", workdir: null, timeout_ms: null }, context);
  const criticalGit = bashTool.approvalSignature?.({ command: "git push --force origin main", workdir: null, timeout_ms: null }, context);
  if (windows) {
    assert.notEqual(ordinaryGit, criticalGit);
    assert.deepEqual(parseApprovalSignature(ordinaryGit), [
      "shell-exec", 1, "powershell", "git status", workspace, context.config.tools.shellTimeoutMs,
    ]);
  } else {
    assert.equal(ordinaryGit, criticalGit);
    assert.deepEqual(parseApprovalSignature(ordinaryGit), ["shell-executable", 1, shell, "git"]);
  }

  const relativeCommand = process.platform === "win32" ? ".\\task one" : "./task one";
  const movedRelativeCommand = process.platform === "win32" ? ".\\task two" : "./task two";
  const relative = bashTool.approvalSignature?.({ command: relativeCommand, workdir: null, timeout_ms: null }, context);
  const movedRelative = bashTool.approvalSignature?.({ command: movedRelativeCommand, workdir: "subdir", timeout_ms: null }, context);
  if (windows) {
    assert.notEqual(relative, movedRelative);
    assert.deepEqual(parseApprovalSignature(relative), [
      "shell-exec", 1, "powershell", relativeCommand, workspace, context.config.tools.shellTimeoutMs,
    ]);
  } else {
    assert.equal(relative, movedRelative);
    assert.deepEqual(parseApprovalSignature(relative), ["shell-executable", 1, shell, "./task"]);
  }

  const compound = {
    command: process.platform === "win32" ? "Set-Location subdir; npm test" : "cd subdir && npm test",
    workdir: null,
    timeout_ms: null,
  };
  const scoped = bashTool.approvalSignature?.(compound, context);
  if (windows) {
    assert.deepEqual(parseApprovalSignature(scoped), [
      "shell-exec", 1, "powershell", compound.command, workspace, context.config.tools.shellTimeoutMs,
    ]);
    assert.notEqual(bashTool.approvalSignature?.({ ...compound, workdir: "subdir" }, context), scoped);
    assert.notEqual(bashTool.approvalSignature?.({ ...compound, timeout_ms: 5_000 }, context), scoped);
  } else {
    assert.deepEqual(parseApprovalSignature(scoped), ["shell-executable", 1, shell, "cd"]);
    assert.equal(bashTool.approvalSignature?.({ ...compound, workdir: "subdir" }, context), scoped);
    assert.equal(bashTool.approvalSignature?.({ ...compound, timeout_ms: 5_000 }, context), scoped);
  }
});

test("shell selection, Windows safety classification, and environment filtering are platform-aware", () => {
  assert.equal(shellKind("linux"), "bash");
  assert.equal(shellKind("win32"), "powershell");
  assert.deepEqual(shellCommand("linux", "printf ok"), {
    executable: "/bin/bash",
    args: ["--noprofile", "--norc", "-c", "printf ok"],
  });
  assert.deepEqual(shellCommand("win32", "Write-Output ok"), {
    executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    args: powershellArguments("Write-Output ok"),
  });
  assert.equal(windowsSystemRoot(undefined), "C:\\Windows");
  assert.equal(windowsSystemRoot("relative\\Windows"), "C:\\Windows");
  assert.equal(windowsSystemRoot("C:relative\\Windows"), "C:\\Windows");
  assert.equal(windowsSystemRoot("\\\\server\\share\\Windows"), "C:\\Windows");
  assert.equal(windowsSystemRoot("\\\\?\\C:\\Windows"), "C:\\Windows");
  assert.equal(windowsSystemRoot("\\\\.\\C:\\Windows"), "C:\\Windows");
  assert.equal(windowsSystemRoot("D:/Windows"), "D:\\Windows");
  assert.equal(powershellExecutable("D:\\Windows"), "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(taskkillExecutable("D:\\Windows"), "D:\\Windows\\System32\\taskkill.exe");
  assert.equal(decodePowerShellCommand(powershellArguments("Write-Output café")),
    "$OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = $OutputEncoding; Write-Output café");
  assert.match(shellDefinition("win32").description, /PowerShell/);

  for (const command of [
    "Remove-Item -Recurse target",
    "& 'Remove-Item' -Recurse target",
    "del target",
    "Stop-Service sshd",
    "Restart-Service sshd",
    "Stop-Process -Name node",
    "taskkill.exe /PID 42 /T /F",
    "shutdown /s /t 0",
    "& \"shutdown.exe\" /s /t 0",
    "format.exe E:",
    "diskpart /s wipe.txt",
    "Set-Acl target $acl",
    "takeown.exe /f target",
    "icacls target /grant everyone:F",
    "netsh advfirewall set allprofiles state off",
    "New-NetIPAddress -InterfaceAlias Ethernet -IPAddress 192.0.2.1",
    "cmd.exe /c Remove-Item target",
    "powershell.exe -NoProfile -Command Remove-Item target",
    "pwsh -EncodedCommand ZABlAGwA",
    "[Diagnostics.Process]::Start('cmd.exe')",
    "[System.Diagnostics.Process]::Start('cmd.exe')",
    "sc.exe delete ExampleService",
    "reg delete HKLM\\Software\\Example /f",
    "Set-ItemProperty -Path HKLM:\\Software\\Example -Name Enabled -Value 0",
    "bcdedit.exe /deletevalue {current} safeboot",
    "Remove-LocalUser test-user",
    "Add-LocalGroupMember Administrators test-user",
    "net localgroup Administrators test-user /delete",
  ]) assert.equal(powershellCommandRisk(command), "critical", command);
  assert.equal(powershellCommandRisk("Get-Service sshd"), "shell");
  for (const command of [
    "Write-Output value > C:\\Windows\\System32\\drivers\\etc\\hosts",
    "Write-Output value >> \"$env:SystemRoot\\System32\\drivers\\etc\\hosts\"",
    "[System.IO.File]::WriteAllText('C:\\Windows\\System32\\drivers\\etc\\hosts', 'value')",
    "[System.IO.File]::AppendAllText($env:SystemRoot + '\\System32\\drivers\\etc\\hosts', 'value')",
    "[System.IO.File]::Delete('target.txt')",
    "File.Delete('target.txt')",
  ]) assert.equal(powershellCommandRisk(command), "critical", command);
  for (const command of [
    "Write-Output value > output.txt",
    "[System.IO.File]::WriteAllText('output.txt', 'value')",
  ]) assert.equal(powershellCommandRisk(command), "shell", command);
  for (const command of [
    "Invoke-Expression $command",
    "iex $command",
    "& $command",
    "Start-Process $command",
    "Set-Content C:\\Windows\\System32\\drivers\\etc\\hosts value",
    "Set-Content output.txt value -Force",
    "Clear-Content output.txt",
    "Move-Item input.txt output.txt -Force",
  ]) assert.equal(powershellCommandRisk(command), "critical", command);
  assert.equal(powershellCommandRisk("Set-Content output.txt value"), "shell");
  assert.equal(powershellCommandRisk("Copy-Item input.txt backup.txt"), "shell");
  assert.equal(powershellApprovalExecutable("Get-Content file.txt"), null);
  assert.equal(powershellApprovalExecutable("& Get-Content file.txt"), null);
  for (const command of [
    "Invoke-Expression $command",
    "iex $command",
    "Start-Process $command",
    "& $command",
    "& (Get-Command $command)",
    "{ Get-Content file.txt }",
    "if ($true) { Get-Content file.txt }",
    "function Invoke-Something { Get-Content file.txt }",
    "foreach ($item in $items) { Get-Content $item }",
    "while ($true) { Get-Content file.txt }",
    "for ($i = 0; $i -lt 1; $i++) { Get-Content file.txt }",
    "switch ($value) { default { Get-Content file.txt } }",
    "try { Get-Content file.txt } catch { }",
    ". .\\script.ps1",
  ]) assert.equal(powershellApprovalExecutable(command), null, command);
  assert.equal(bashCommandRisk("rm -rf target"), "critical");

  const windowsEnv = shellEnvironment({
    path: "C:\\Windows",
    Mixed_Api_Key: "secret",
    pSmOdUlEpAtH: "injected",
    PSExecutionPolicyPreference: "Bypass",
    PROFILE: "profile.ps1",
    Bash_Env: "injected.sh",
    SAFE: "yes",
  }, ["MIXED_API_KEY"], "win32");
  assert.equal(windowsEnv.Mixed_Api_Key, undefined);
  assert.equal(windowsEnv.pSmOdUlEpAtH, undefined);
  assert.equal(windowsEnv.PSExecutionPolicyPreference, undefined);
  assert.equal(windowsEnv.PROFILE, undefined);
  assert.equal(windowsEnv.Bash_Env, undefined);
  assert.equal(windowsEnv.SAFE, "yes");
  const duplicateWindowsEnv = shellEnvironment({
    ENV: "one",
    env: "two",
    PSModulePath: "one",
    pSmOdUlEpAtH: "two",
    SAFE: "yes",
  }, [], "win32");
  assert.equal(duplicateWindowsEnv.ENV, undefined);
  assert.equal(duplicateWindowsEnv.env, undefined);
  assert.equal(duplicateWindowsEnv.PSModulePath, undefined);
  assert.equal(duplicateWindowsEnv.pSmOdUlEpAtH, undefined);
  assert.equal(duplicateWindowsEnv.SAFE, "yes");
});

test("default code mode asks before every shell command", async (t) => {
  const { context } = fixture(t);
  context.config.tools.approval = "code";
  let approvals = 0;
  context.approve = async () => {
    approvals += 1;
    return "deny";
  };
  const registry = new ToolRegistry().register(bashTool);
  const args = registry.parseArguments("bash", JSON.stringify({
    command: "git status",
    workdir: null,
    timeout_ms: null,
  }));
  await assert.rejects(registry.execute("bash", args, context), /denied/);
  assert.equal(approvals, 1);
});

test("always approval remembers Bash executables or exact PowerShell commands", async (t) => {
  const { context, workspace } = fixture(t);
  const windows = process.platform === "win32";
  const rememberedCommand = outputCommand("remembered");
  context.approvalMode = "review";
  const registry = new ToolRegistry().register(bashTool);
  const args = registry.parseArguments("bash", JSON.stringify({
    command: rememberedCommand,
    workdir: null,
    timeout_ms: null,
  }));
  const requests: { canAlwaysApprove: boolean; details: string }[] = [];
  context.approve = async (request) => {
    requests.push({ canAlwaysApprove: request.canAlwaysApprove, details: request.details });
    return "always";
  };

  assert.match((await registry.execute("bash", args, context)).output, /remembered/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.canAlwaysApprove, true);
  if (windows) {
    assert.ok((requests[0]?.details ?? "").includes("Only this exact PowerShell command"));
  } else {
    assert.ok((requests[0]?.details ?? "").includes("All Bash commands starting with 'printf'"));
  }
  assert.equal(context.sessions.listCommandApprovals(context.sessionId).length, 1);

  context.approve = async () => {
    throw new Error("remembered command prompted again");
  };
  assert.match((await registry.execute("bash", args, context)).output, /remembered/);

  context.automated = true;
  context.readOnly = true;
  context.approve = async () => {
    throw new Error("automated remembered command prompted again");
  };
  assert.match((await registry.execute("bash", args, context)).output, /remembered/);
  context.automated = false;
  context.readOnly = false;

  const abortController = new AbortController();
  context.signal = abortController.signal;
  context.approve = async () => {
    abortController.abort();
    return "always";
  };
  const aborted = registry.parseArguments("bash", JSON.stringify({
    command: windows ? "Get-Location" : "uname",
    workdir: null,
    timeout_ms: null,
  }));
  await assert.rejects(registry.execute("bash", aborted, context), /abort/i);
  assert.equal(context.sessions.listCommandApprovals(context.sessionId).length, 1);
  context.signal = new AbortController().signal;

  let changedPrompts = 0;
  context.approve = async (request) => {
    changedPrompts += 1;
    assert.equal(request.canAlwaysApprove, true);
    return "deny";
  };
  const changedTimeout = registry.parseArguments("bash", JSON.stringify({
    command: rememberedCommand,
    workdir: null,
    timeout_ms: 5_000,
  }));
  if (windows) {
    await assert.rejects(registry.execute("bash", changedTimeout, context), /denied/);
  } else {
    assert.match((await registry.execute("bash", changedTimeout, context)).output, /remembered/);
  }
  mkdirSync(join(workspace, "subdir"));
  const changedWorkdir = registry.parseArguments("bash", JSON.stringify({
    command: rememberedCommand,
    workdir: "subdir",
    timeout_ms: null,
  }));
  if (windows) {
    await assert.rejects(registry.execute("bash", changedWorkdir, context), /denied/);
  } else {
    assert.match((await registry.execute("bash", changedWorkdir, context)).output, /remembered/);
  }
  const compound = registry.parseArguments("bash", JSON.stringify({
    command: compoundWriteCommand("compound.txt", "compound"),
    workdir: "subdir",
    timeout_ms: 5_000,
  }));
  if (windows) {
    await assert.rejects(registry.execute("bash", compound, context), /denied/);
  } else {
    assert.match((await registry.execute("bash", compound, context)).output, /exit: 0/);
    assert.equal(readFileSync(join(workspace, "subdir", "compound.txt"), "utf8"), "compound");
  }
  assert.equal(changedPrompts, windows ? 3 : 0);

  const otherExecutable = registry.parseArguments("bash", JSON.stringify({
    command: windows ? "Get-Location" : "pwd",
    workdir: null,
    timeout_ms: null,
  }));
  await assert.rejects(registry.execute("bash", otherExecutable, context), /denied/);
  assert.equal(changedPrompts, windows ? 4 : 1);

  const other = context.sessions.create({
    workspace,
    model: "test",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
  });
  context.sessionId = other.id;
  await assert.rejects(registry.execute("bash", args, context), /denied/);
  assert.equal(changedPrompts, windows ? 5 : 2);

  context.sessionId = context.sessions.list(workspace).find((session) => session.id !== other.id)!.id;
  context.approvalMode = "unrestricted";
  context.approve = async () => {
    throw new Error("unrestricted critical command prompted");
  };
  const critical = registry.parseArguments("bash", JSON.stringify({
    command: removeDirectoryCommand("disposable"),
    workdir: null,
    timeout_ms: null,
  }));
  assert.match((await registry.execute("bash", critical, context)).output, /exit: 0/);
  assert.equal(context.sessions.listCommandApprovals(context.sessionId).length, 1);
  context.automated = true;
  context.readOnly = true;
  context.approve = async () => {
    throw new Error("automated remembered critical command prompted again");
  };
  assert.match((await registry.execute("bash", critical, context)).output, /exit: 0/);
});

test("always approval applies to every tool action with canonical arguments", async (t) => {
  const { context } = fixture(t);
  context.approvalMode = "code";
  let executions = 0;
  let prompts = 0;
  const action: GlassTool<{ alpha: string; beta: number }> = {
    name: "critical_action",
    description: "test exact action approvals",
    risk: "critical",
    parameters: {
      type: "object",
      properties: { alpha: { type: "string" }, beta: { type: "number" } },
      required: ["alpha", "beta"],
      additionalProperties: false,
    },
    summarize: ({ alpha }) => alpha,
    async execute({ alpha, beta }) {
      executions += 1;
      return { output: `${alpha}:${beta}` };
    },
  };
  const registry = new ToolRegistry().register(action);
  context.approve = async (request) => {
    prompts += 1;
    assert.equal(request.canAlwaysApprove, true);
    return "always";
  };
  assert.equal((await registry.execute(action.name, { beta: 2, alpha: "same" }, context)).output, "same:2");
  assert.equal(prompts, 1);

  context.approve = async () => {
    throw new Error("canonically identical action prompted again");
  };
  assert.equal((await registry.execute(action.name, { alpha: "same", beta: 2 }, context)).output, "same:2");
  context.automated = true;
  context.readOnly = true;
  assert.equal((await registry.execute(action.name, { alpha: "same", beta: 2 }, context)).output, "same:2");
  assert.equal(executions, 3);

  await assert.rejects(
    registry.execute(action.name, { alpha: "different", beta: 2 }, context),
    /read-only session policy/,
  );

  const composed = "\u00e9";
  const decomposed = "e\u0301";
  assert.equal(
    toolApprovalSignature("unicode", { [composed]: 1, [decomposed]: 2 }),
    toolApprovalSignature("unicode", { [decomposed]: 2, [composed]: 1 }),
  );
});

test("leaf sessions inherit remembered approvals from their parent authorization session", async (t) => {
  const { context, workspace } = fixture(t);
  const parentId = context.sessionId;
  const child = context.sessions.create({
    workspace,
    model: "test",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
    approvalMode: "code",
    kind: "agent",
    parentSessionId: parentId,
  });
  const action: GlassTool<{ value: string }> = {
    name: "parent_approved",
    description: "test inherited approval",
    risk: "critical",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    summarize: ({ value }) => value,
    async execute({ value }) {
      return { output: value };
    },
  };
  const registry = new ToolRegistry().register(action);
  const args = { value: "approved" };
  context.sessions.registerCommandApproval(parentId, toolApprovalSignature(action.name, args));
  context.sessionId = child.id;
  context.authorizationSessionId = parentId;
  context.approvalMode = "review";
  context.automated = true;
  context.readOnly = true;
  context.approve = async () => {
    throw new Error("leaf attempted a new approval");
  };
  assert.equal((await registry.execute(action.name, args, context)).output, "approved");
});

test("read-only turns reject mutations without invoking approval", async (t) => {
  const { context } = fixture(t);
  context.readOnly = true;
  let approvals = 0;
  context.approve = async () => {
    approvals += 1;
    return "once";
  };
  const write: GlassTool<{ value: string }> = {
    name: "write_test",
    description: "test",
    risk: "write",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    summarize: ({ value }) => value,
    async execute({ value }) {
      return { output: value };
    },
  };
  const registry = new ToolRegistry().register(write);
  await assert.rejects(registry.execute("write_test", { value: "blocked" }, context), /read-only/);
  assert.equal(approvals, 0);
});

test("automated turns require remembered approval for nested schedules", async (t) => {
  const { context } = fixture(t);
  context.approvalMode = "unrestricted";
  context.automated = true;
  let writes = 0;
  const write: GlassTool<Record<string, never>> = {
    name: "write_test",
    description: "scheduled write",
    risk: "write",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    summarize: () => "scheduled write",
    async execute() {
      writes += 1;
      return { output: "written" };
    },
  };
  const nestedSchedule: GlassTool<Record<string, never>> = {
    ...write,
    name: "schedule_create",
    risk: "persistent",
  };
  const registry = new ToolRegistry().register(write).register(nestedSchedule);

  assert.equal((await registry.execute("write_test", {}, context)).output, "written");
  await assert.rejects(registry.execute("schedule_create", {}, context), /noninteractive scheduled-session/);
  assert.equal(writes, 1);

  context.automated = false;
  context.approvalMode = "code";
  context.approve = async () => "always";
  assert.equal((await registry.execute("schedule_create", {}, context)).output, "written");
  context.automated = true;
  context.readOnly = true;
  context.approve = async () => {
    throw new Error("remembered nested schedule prompted again");
  };
  assert.equal((await registry.execute("schedule_create", {}, context)).output, "written");
  assert.equal(writes, 3);
});

test("unrestricted schedule actions never prompt for destructive commands", async (t) => {
  const { context, db } = fixture(t);
  context.approvalMode = "unrestricted";
  let approvals = 0;
  context.approve = async () => {
    approvals += 1;
    throw new Error("unrestricted schedule action requested approval");
  };
  const store = new SchedulerStore(db);
  const scheduledCommand = process.platform === "win32" ? "& 'Remove-Item' -Recurse data" : "rm -rf data";
  assert.equal(
    createScheduleTools(store)[0]?.classifyRisk?.({ kind: "command", command: scheduledCommand }, context),
    "critical",
  );
  const registry = new ToolRegistry();
  for (const tool of createScheduleTools(store)) registry.register(tool);
  const input = (command: string) => registry.parseArguments("schedule_create", JSON.stringify({
    kind: "command",
    schedule_kind: "once",
    schedule: "2099-01-01T00:00:00Z",
    timezone: "UTC",
    message: null,
    command,
    prompt: null,
    cwd: null,
    timeout_ms: 5_000,
  }));

  assert.match((await registry.execute("schedule_create", input("printf safe"), context)).output, /created/);
  assert.equal(approvals, 0);
  assert.match((await registry.execute("schedule_create", input("rm -rf data"), context)).output, /created/);
  assert.equal(approvals, 0);
  const destructive = store.createCommand({
    command: "rm -rf data",
    cwd: context.workspace,
    scheduleKind: "once",
    schedule: "2099-01-02T00:00:00Z",
    timezone: "UTC",
    startGraceMs: 60_000,
    timeoutMs: 5_000,
    outputBytes: 1_024,
  });
  const resolveUnknown = registry.parseArguments("schedule_manage", JSON.stringify({
    action: "resolve_unknown",
    id: destructive.id,
  }));
  assert.match((await registry.execute("schedule_manage", resolveUnknown, context)).output, /Unknown outcome/);
  assert.equal(approvals, 0);
});

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { openDatabase } from "../src/storage/database.js";
import { SessionStore } from "../src/storage/session-store.js";
import { SchedulerStore } from "../src/scheduler/store.js";
import { applyPatchTool } from "../src/tools/apply-patch.js";
import { bashTool } from "../src/tools/bash.js";
import { readTool } from "../src/tools/read.js";
import { ToolRegistry, toolApprovalSignature } from "../src/tools/registry.js";
import { createScheduleTools } from "../src/tools/schedule.js";
import { bashApprovalExecutable, bashCommandRisk, patchRisk, shellEnvironment, workspacePatchRisk } from "../src/tools/safety.js";
import { globTool, grepTool } from "../src/tools/search.js";
import type { GlassTool, ToolContext } from "../src/tools/types.js";

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

test("read handles files, directories, artifacts, and symlink boundaries", async (t) => {
  const { base, workspace, context } = fixture(t);
  assert.equal(statSync(join(base, "state.db")).mode & 0o077, 0);
  mkdirSync(join(workspace, "src"));
  writeFileSync(join(workspace, "src", "file.txt"), "alpha\nbeta\ngamma\n");
  const file = await readTool.execute({ path: "src/file.txt", offset: 2, limit: 1 }, context);
  assert.equal(file.output, "2: beta\n\n[Truncated. Continue at line 3.]");
  const directory = await readTool.execute({ path: "src", offset: null, limit: null }, context);
  assert.equal(directory.output, "file.txt");

  const artifact = context.artifacts.save(context.sessionId, "test", "0123456789");
  const range = await readTool.execute({ path: artifact.uri, offset: 3, limit: 4 }, context);
  assert.match(range.output, /^3456/);

  const outside = join(base, "outside.txt");
  writeFileSync(outside, "secret");
  symlinkSync(outside, join(workspace, "escape.txt"));
  await assert.rejects(
    readTool.execute({ path: "escape.txt", offset: null, limit: null }, context),
    /outside the workspace/,
  );
  assert.equal(dirname(outside), base);
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

test("bash bounds model output, stores an artifact, and cancels process groups", async (t) => {
  const { context } = fixture(t);
  const large = await bashTool.execute({
    command: "node -e \"process.stdout.write('x'.repeat(3000))\"",
    workdir: null,
    timeout_ms: 10_000,
  }, context);
  assert.equal(large.truncated, true);
  assert.match(large.artifactUri ?? "", /^artifact:\/\//);
  assert.ok(context.artifacts.get(large.artifactUri ?? "")?.byteCount);

  const controller = new AbortController();
  const cancelledContext = { ...context, signal: controller.signal };
  const started = Date.now();
  const running = bashTool.execute({ command: "sleep 5", workdir: null, timeout_ms: 10_000 }, cancelledContext);
  setTimeout(() => controller.abort(), 30);
  const cancelled = await running;
  assert.ok(Date.now() - started < 2_000);
  assert.match(cancelled.output, /exit: SIGTERM|exit: SIGKILL/);
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
    command: "rm -rf disposable",
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
    command: "printf safe",
    workdir: null,
    timeout_ms: null,
  }));
  assert.match((await registry.execute("bash", safeShell, context)).output, /safe/);
  writeFileSync(join(workspace, "input.txt"), "before\n");
  const ordinaryShellWrite = registry.parseArguments("bash", JSON.stringify({
    command: "cat input.txt > output.txt && sed -i 's/before/after/' output.txt",
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

  mkdirSync(join(workspace, ".ssh"));
  writeFileSync(join(workspace, ".ssh", "config"), "safe=true\n");
  symlinkSync(join(workspace, ".ssh", "config"), join(workspace, "config-link"));
  const sensitiveSymlink = registry.parseArguments("apply_patch", JSON.stringify({
    patch: "*** Begin Patch\n*** Update File: config-link\n@@\n-safe=true\n+safe=false\n*** End Patch",
  }));
  context.config.tools.approval = "code";
  context.approve = async (request) => {
    approvals.push(`${request.risk}:${request.summary}`);
    return "deny";
  };
  await assert.rejects(registry.execute("apply_patch", sensitiveSymlink, context), /denied/);
  assert.equal(approvals.at(-1)?.startsWith("critical:"), true);

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

test("Bash approval signatures scope commands by leading executable", (t) => {
  const { context, workspace } = fixture(t);
  mkdirSync(join(workspace, "subdir"));
  const first = bashTool.approvalSignature?.({ command: "cat one.txt", workdir: null, timeout_ms: null }, context);
  assert.equal(first, JSON.stringify(["bash-executable", 2, "cat"]));
  assert.equal(
    bashTool.approvalSignature?.({ command: "/usr/bin/cat two.txt", workdir: "subdir", timeout_ms: 5_000 }, context),
    first,
  );
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
  assert.equal(ordinaryGit, criticalGit);
  assert.match(ordinaryGit ?? "", /"bash-executable",2,"git"/);

  const relative = bashTool.approvalSignature?.({ command: "./task one", workdir: null, timeout_ms: null }, context);
  const movedRelative = bashTool.approvalSignature?.({ command: "./task two", workdir: "subdir", timeout_ms: null }, context);
  assert.equal(relative, movedRelative);
  assert.match(relative ?? "", /"\.\/task"/);

  const compound = { command: "cd subdir && npm test", workdir: null, timeout_ms: null };
  const scoped = bashTool.approvalSignature?.(compound, context);
  assert.equal(scoped, JSON.stringify(["bash-executable", 2, "cd"]));
  assert.equal(bashTool.approvalSignature?.({ ...compound, workdir: "subdir" }, context), scoped);
  assert.equal(bashTool.approvalSignature?.({ ...compound, timeout_ms: 5_000 }, context), scoped);
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

test("always approval remembers Bash executables for main and automated work", async (t) => {
  const { context, workspace } = fixture(t);
  context.approvalMode = "review";
  const registry = new ToolRegistry().register(bashTool);
  const args = registry.parseArguments("bash", JSON.stringify({
    command: "printf remembered",
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
  assert.match(requests[0]?.details ?? "", /All Bash commands starting with 'printf'/);
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
    command: "uname",
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
    command: "printf another-value",
    workdir: null,
    timeout_ms: 5_000,
  }));
  assert.match((await registry.execute("bash", changedTimeout, context)).output, /another-value/);
  mkdirSync(join(workspace, "subdir"));
  const changedWorkdir = registry.parseArguments("bash", JSON.stringify({
    command: "printf from-subdir",
    workdir: "subdir",
    timeout_ms: null,
  }));
  assert.match((await registry.execute("bash", changedWorkdir, context)).output, /from-subdir/);
  const compound = registry.parseArguments("bash", JSON.stringify({
    command: "printf compound > compound.txt && true",
    workdir: "subdir",
    timeout_ms: 5_000,
  }));
  assert.match((await registry.execute("bash", compound, context)).output, /exit: 0/);
  assert.equal(readFileSync(join(workspace, "subdir", "compound.txt"), "utf8"), "compound");
  assert.equal(changedPrompts, 0);

  const otherExecutable = registry.parseArguments("bash", JSON.stringify({
    command: "pwd",
    workdir: null,
    timeout_ms: null,
  }));
  await assert.rejects(registry.execute("bash", otherExecutable, context), /denied/);
  assert.equal(changedPrompts, 1);

  const other = context.sessions.create({
    workspace,
    model: "test",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
  });
  context.sessionId = other.id;
  await assert.rejects(registry.execute("bash", args, context), /denied/);
  assert.equal(changedPrompts, 2);

  context.sessionId = context.sessions.list(workspace).find((session) => session.id !== other.id)!.id;
  context.approvalMode = "unrestricted";
  context.approve = async () => {
    throw new Error("unrestricted critical command prompted");
  };
  const critical = registry.parseArguments("bash", JSON.stringify({
    command: "rm -rf disposable",
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

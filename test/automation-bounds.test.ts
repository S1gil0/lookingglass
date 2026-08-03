import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { Response } from "openai/resources/responses/responses";
import { AgentCoordinator } from "../src/agents/coordinator.js";
import { DEFAULT_CONFIG, loadConfig, serializeConfig, writeGlobalConfig } from "../src/config.js";
import { ConversationEngine } from "../src/engine/engine.js";
import {
  AutomatedProviderRetryExhaustedError,
  runWithTransientRetries,
} from "../src/retry.js";
import { SchedulerStore } from "../src/scheduler/store.js";
import { SessionPromptRunner } from "../src/scheduler/runner.js";
import type { CreateSessionPromptInput } from "../src/scheduler/types.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { openDatabase, type GlassDatabase } from "../src/storage/database.js";
import { SessionStore } from "../src/storage/session-store.js";
import { createWorkerToolRegistry } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { GatewayModel, ModelInfo } from "../src/types.js";

const model: GatewayModel = {
  id: "automation-test-model",
  provider: "custom",
  name: "Automation test model",
  description: "",
  contextWindow: 100_000,
  maxOutputTokens: null,
  reasoningEfforts: ["medium"],
  defaultReasoningEffort: "medium",
  defaultVerbosity: "low",
  supportsReasoning: true,
  supportsImages: false,
  supportsParallelToolCalls: true,
  supportsFast: false,
  priority: 1,
};

const modelInfo: ModelInfo = model;

function response(text: string): Response {
  return {
    id: randomUUID(),
    status: "completed",
    output: [],
    output_text: text,
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  } as unknown as Response;
}

function createSession(db: GlassDatabase, workspace: string, persistent = true): string {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO sessions(
      id, workspace, title, model, reasoning_effort, verbosity, fast,
      show_reasoning, persistent, prompt_cache_key, created_at, updated_at
    ) VALUES (?, ?, 'Automation test', ?, 'medium', 'low', 0, 0, ?, ?, ?, ?)
  `).run(id, workspace, model.id, persistent ? 1 : 0, randomUUID(), now, now);
  return id;
}

function sessionPromptInput(
  sessionId: string,
  prompt: string,
  schedule: string,
  overrides: Partial<CreateSessionPromptInput> = {},
): CreateSessionPromptInput {
  return {
    sessionId,
    prompt,
    scheduleKind: "once",
    schedule,
    timezone: "UTC",
    startGraceMs: 60_000,
    timeoutMs: 10_000,
    outputBytes: 1_024,
    ...overrides,
  };
}

function fixture(t: TestContext): { root: string; db: GlassDatabase; sessions: SessionStore; sessionId: string } {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-automation-bounds-"));
  const db = openDatabase(join(root, "state.db"));
  const sessions = new SessionStore(db);
  const sessionId = createSession(db, root);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, db, sessions, sessionId };
}

test("automated provider retries cap attempts, report bounds, and preserve the unlimited default", async () => {
  let attempts = 0;
  const statuses: string[] = [];
  await assert.rejects(
    runWithTransientRetries(
      async () => {
        attempts += 1;
        throw Object.assign(new Error("temporary"), { status: 503 });
      },
      new AbortController().signal,
      { maxAttempts: 3, maxElapsedMs: 1_000, delay: async () => undefined, onStatus: (value) => statuses.push(value) },
    ),
    (error: unknown) => error instanceof AutomatedProviderRetryExhaustedError
      && error.code === "automated_provider_retry_exhausted",
  );
  assert.equal(attempts, 3);
  assert.ok(statuses.some((status) => /attempt 2\/3.*max 3.*delay/u.test(status)));

  attempts = 0;
  const found = await runWithTransientRetries(
    async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("temporary"), { status: 503 });
      return "ok";
    },
    new AbortController().signal,
    { delay: async () => undefined },
  );
  assert.equal(found, "ok");
  assert.equal(attempts, 3);
});

test("automated retry elapsed budgets and caller cancellation take precedence", async () => {
  let attempts = 0;
  await assert.rejects(
    runWithTransientRetries(
      async () => {
        attempts += 1;
        throw Object.assign(new Error("temporary"), { status: 503 });
      },
      new AbortController().signal,
      { maxAttempts: 8, maxElapsedMs: 1, startedAt: Date.now() - 10, delay: async () => undefined },
    ),
    (error: unknown) => error instanceof AutomatedProviderRetryExhaustedError,
  );
  assert.equal(attempts, 0);

  const controller = new AbortController();
  const waiting = runWithTransientRetries(
    async () => {
      throw Object.assign(new Error("temporary"), { status: 503 });
    },
    controller.signal,
    { maxAttempts: 8, maxElapsedMs: 1_000, delay: async () => new Promise<void>(() => undefined) },
  );
  controller.abort(new Error("caller stopped"));
  await assert.rejects(waiting, /caller stopped/u);
});

test("automation config defaults, layering, validation, and serialization are bounded", () => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-automation-config-"));
  const configHome = join(root, "config");
  const previous = process.env.XDG_CONFIG_HOME;
  try {
    mkdirSync(configHome, { recursive: true });
    process.env.XDG_CONFIG_HOME = configHome;
    const defaults = loadConfig(root);
    assert.deepEqual(defaults.automation, DEFAULT_CONFIG.automation);
    writeFileSync(join(root, ".looking-glass.json"), JSON.stringify({
      automation: {
        providerRetryMaxAttempts: 2,
        providerRetryMaxElapsedMs: 3_000,
        agentTurnTimeoutMs: 4_000,
        scheduledTurnTimeoutMs: 5_000,
      },
    }));
    assert.deepEqual(loadConfig(root).automation, {
      providerRetryMaxAttempts: 2,
      providerRetryMaxElapsedMs: 3_000,
      agentTurnTimeoutMs: 4_000,
      scheduledTurnTimeoutMs: 5_000,
    });
    assert.deepEqual(serializeConfig(loadConfig(root)).automation, {
      providerRetryMaxAttempts: 2,
      providerRetryMaxElapsedMs: 3_000,
      agentTurnTimeoutMs: 4_000,
      scheduledTurnTimeoutMs: 5_000,
    });
    writeFileSync(join(root, ".looking-glass.json"), JSON.stringify({ automation: { agentTurnTimeoutMs: 0 } }));
    assert.equal(loadConfig(root).automation.agentTurnTimeoutMs, DEFAULT_CONFIG.automation.agentTurnTimeoutMs);
    const saved = writeGlobalConfig({
      provider: "custom",
      baseURL: "http://127.0.0.1:9999/v1",
      automation: { agentTurnTimeoutMs: 6_000 },
    });
    const persisted = JSON.parse(readFileSync(saved, "utf8")) as { automation?: Record<string, number> };
    assert.equal(persisted.automation?.agentTurnTimeoutMs, 6_000);
    assert.throws(() => writeGlobalConfig({
      provider: "custom",
      baseURL: "http://127.0.0.1:9999/v1",
      automation: { scheduledTurnTimeoutMs: 2_147_483_647 },
    }), /automation\.scheduledTurnTimeoutMs/u);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent timeout fails one child while siblings continue", async (t) => {
  const { root, db, sessions, sessionId } = fixture(t);
  mkdirSync(join(root, "artifacts"));
  const artifacts = new ArtifactStore(db, join(root, "artifacts"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.automation.agentTurnTimeoutMs = 100;
  const client = {
    supportsResponseContinuity: () => true,
    async stream(request: { input: unknown; signal?: AbortSignal }): Promise<Response> {
      const slow = JSON.stringify(request.input).includes("SLOW");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, slow ? 500 : 2);
        request.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(request.signal?.reason);
        }, { once: true });
      });
      return response("done");
    },
  };
  const coordinator = new AgentCoordinator(
    config,
    root,
    sessions,
    artifacts,
    () => client as never,
    createWorkerToolRegistry(),
    "instructions",
    async () => model,
  );
  const context = {
    workspace: root,
    sessionId,
    config,
    approvalMode: "unrestricted" as const,
    artifacts,
    sessions,
    signal: new AbortController().signal,
    approve: async () => "deny" as const,
    ask: async () => "",
  };
  const result = await coordinator.run({
    tasks: [{ id: "slow", prompt: "SLOW" }, { id: "fast", prompt: "FAST" }],
    concurrency: 2,
  }, context);
  assert.match(result.output, /## slow \[failed\]/u);
  assert.match(result.output, /automated_turn_timeout/u);
  assert.match(result.output, /## fast \[succeeded\]/u);
});

test("scheduled prompt timeout persists and records a fenced timed_out outcome", async (t) => {
  const { db, sessionId } = fixture(t);
  const store = new SchedulerStore(db);
  const now = Date.now();
  const job = store.createSessionPrompt({
    sessionId,
    prompt: "scheduled",
    scheduleKind: "once",
    schedule: new Date(now).toISOString(),
    timezone: "UTC",
    startGraceMs: 60_000,
    timeoutMs: 10,
    outputBytes: 1_024,
  }, now - 1);
  assert.equal(job.timeoutMs, 10);
  store.materialize(now);
  assert.equal(store.acquireLease("automation-daemon", "automation-boot", now, 60_000), true);
  const claim = store.claimSessionPrompts("automation-daemon", "automation-boot", now, 60_000, 1)[0];
  assert.ok(claim);
  const runner = new SessionPromptRunner(store, async (_job, signal) => await new Promise<string>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const occurrence = await runner.run(claim);
  assert.equal(occurrence.state, "timed_out");
  assert.match(occurrence.reason ?? "", /automated turn timed out/iu);
  assert.match(occurrence.reason ?? "", /\[automated_turn_timeout\]/u);
  assert.match(occurrence.stderr.toString("utf8"), /automated turn timed out/iu);
  assert.match(store.listInbox()[0]?.message ?? "", /\[automated_turn_timeout\]/u);
  assert.equal(db.prepare("SELECT 1 FROM session_operation_leases WHERE session_id = ?").get(sessionId), undefined);
});

test("a late scheduled session prompt is unknown and blocks recurring safety", async (t) => {
  const { db, sessionId } = fixture(t);
  const store = new SchedulerStore(db);
  const now = Date.now();
  const job = store.createSessionPrompt(sessionPromptInput(sessionId, "late scheduled turn", "* * * * *", {
    scheduleKind: "cron",
    timeoutMs: 10,
  }), now);
  assert.equal(store.runNow(job.id, now).state, "pending");
  assert.equal(store.acquireLease("late-daemon", "late-boot", now, 60_000), true);
  const claim = store.claimSessionPrompts("late-daemon", "late-boot", now, 60_000, 1)[0];
  assert.ok(claim);
  const runner = new SessionPromptRunner(store, async (_job, signal) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => {
        setTimeout(resolve, 5);
      }, { once: true });
    });
    return "late output";
  });

  const occurrence = await runner.run(claim);
  assert.equal(occurrence.state, "unknown");
  assert.notEqual(occurrence.state, "timed_out");
  assert.notEqual(occurrence.state, "succeeded");
  const durableDiagnostic = [
    occurrence.reason,
    occurrence.stderr.toString("utf8"),
    store.listInbox()[0]?.message,
  ].filter((value): value is string => value !== undefined && value !== null).join("\n");
  assert.match(durableDiagnostic, /automated_turn_timeout/u);
  assert.equal(store.getJob(job.id)?.enabled, false);
  assert.match(store.getJob(job.id)?.blockedReason ?? "", /unknown outcome/iu);
  assert.equal(store.listRuns(job.id)[0]?.state, "unknown");
});

test("session operation lease errors are persisted as unknown outcomes", async (t) => {
  for (const code of ["session_operation_lease_lost", "session_operation_lease_unavailable"] as const) {
    const { db, sessionId } = fixture(t);
    const store = new SchedulerStore(db);
    const now = Date.now();
    const job = store.createSessionPrompt(sessionPromptInput(sessionId, `lease error: ${code}`, "* * * * *", {
      scheduleKind: "cron",
      timeoutMs: 60_000,
    }), now);
    assert.equal(store.runNow(job.id, now).state, "pending");
    assert.equal(store.acquireLease("lease-daemon", "lease-boot", now, 60_000), true);
    const claim = store.claimSessionPrompts("lease-daemon", "lease-boot", now, 60_000, 1)[0];
    assert.ok(claim);
    const runner = new SessionPromptRunner(store, async () => {
      throw Object.assign(new Error(code), { code });
    });

    const occurrence = await runner.run(claim);
    assert.equal(occurrence.state, "unknown");
    assert.equal(store.listRuns(job.id)[0]?.state, "unknown");
    assert.match(occurrence.reason ?? "", new RegExp(`\\[${code}\\]`, "u"));
    assert.match(store.listInbox()[0]?.message ?? "", new RegExp(`\\[${code}\\]`, "u"));
    assert.equal(store.getJob(job.id)?.enabled, false);
    assert.match(store.getJob(job.id)?.blockedReason ?? "", /unknown outcome/iu);
  }
});

test("a deadline racing with session operation lease errors persists unknown and blocks recurrence", async (t) => {
  for (const code of ["session_operation_lease_lost", "session_operation_lease_unavailable"] as const) {
    const { db, sessionId } = fixture(t);
    const store = new SchedulerStore(db);
    const now = Date.now();
    const job = store.createSessionPrompt(sessionPromptInput(sessionId, `deadline race: ${code}`, "* * * * *", {
      scheduleKind: "cron",
      timeoutMs: 10,
    }), now);
    assert.equal(store.runNow(job.id, now).state, "pending");
    assert.equal(store.acquireLease("deadline-daemon", "deadline-boot", now, 60_000), true);
    const claim = store.claimSessionPrompts("deadline-daemon", "deadline-boot", now, 60_000, 1)[0];
    assert.ok(claim);
    const runner = new SessionPromptRunner(store, async (_job, signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw Object.assign(new Error(code), { code });
    });

    const occurrence = await runner.run(claim);
    assert.equal(occurrence.state, "unknown");
    assert.equal(store.listRuns(job.id)[0]?.state, "unknown");
    assert.match(occurrence.reason ?? "", new RegExp(`\\[${code}\\]`, "u"));
    assert.match(store.listInbox()[0]?.message ?? "", new RegExp(`\\[${code}\\]`, "u"));
    assert.equal(store.getJob(job.id)?.enabled, false);
    assert.match(store.getJob(job.id)?.blockedReason ?? "", /unknown outcome/iu);
  }
});

test("scheduled retry exhaustion retains its safe completion code in durable results", async (t) => {
  const { db, sessionId } = fixture(t);
  const store = new SchedulerStore(db);
  const now = Date.now();
  const job = store.createSessionPrompt(sessionPromptInput(
    sessionId,
    "retry exhaustion",
    new Date(now).toISOString(),
    { timeoutMs: 60_000 },
  ), now - 1);
  assert.equal(store.materialize(now).length, 1);
  assert.equal(store.acquireLease("retry-daemon", "retry-boot", now, 60_000), true);
  const claim = store.claimSessionPrompts("retry-daemon", "retry-boot", now, 60_000, 1)[0];
  assert.ok(claim);
  const runner = new SessionPromptRunner(store, async () => {
    throw Object.assign(new Error("provider retries exhausted"), {
      code: "automated_provider_retry_exhausted",
    });
  });

  const occurrence = await runner.run(claim);
  assert.equal(occurrence.state, "failed");
  assert.equal(store.listRuns(job.id)[0]?.state, "failed");
  assert.match(occurrence.reason ?? "", /\[automated_provider_retry_exhausted\]/u);
  assert.match(store.listInbox()[0]?.message ?? "", /\[automated_provider_retry_exhausted\]/u);
});

test("successful scheduled session output replaces terminal controls", async (t) => {
  const { db, sessionId } = fixture(t);
  const store = new SchedulerStore(db);
  const now = Date.now();
  const job = store.createSessionPrompt(sessionPromptInput(
    sessionId,
    "sanitize output",
    new Date(now).toISOString(),
    { outputBytes: 1_024 },
  ), now - 1);
  assert.equal(store.materialize(now).length, 1);
  assert.equal(store.acquireLease("sanitize-daemon", "sanitize-boot", now, 60_000), true);
  const claim = store.claimSessionPrompts("sanitize-daemon", "sanitize-boot", now, 60_000, 1)[0];
  assert.ok(claim);
  const runner = new SessionPromptRunner(store, async () => "safe\u0000\u0007\u001b[31m output");

  const occurrence = await runner.run(claim);
  assert.equal(occurrence.state, "succeeded");
  assert.equal(store.listRuns(job.id)[0]?.state, "succeeded");
  const output = occurrence.stdout.toString("utf8");
  assert.equal(output, "safe���[31m output");
  assert.doesNotMatch(output, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u);
});

test("automated engine retry exhaustion is durably coded and metered", async (t) => {
  const { root, db, sessions, sessionId } = fixture(t);
  mkdirSync(join(root, "artifacts"));
  const artifacts = new ArtifactStore(db, join(root, "artifacts"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.automation.providerRetryMaxAttempts = 1;
  const client = {
    supportsResponseContinuity: () => true,
    async stream(): Promise<Response> {
      throw Object.assign(new Error("temporary"), { status: 503 });
    },
  };
  const engine = new ConversationEngine(
    config,
    root,
    sessions,
    artifacts,
    client as never,
    new ToolRegistry(),
    "instructions",
  );
  let metrics: { errorCode?: string; termination?: string } | undefined;
  await assert.rejects(engine.turn(sessionId, "retry", {
    signal: new AbortController().signal,
    interaction: { approve: async () => "deny", ask: async () => "" },
    modelInfo,
    automated: true,
    callbacks: { onTurnComplete: (value) => { metrics = value; } },
  }), (error: unknown) => error instanceof AutomatedProviderRetryExhaustedError);
  assert.equal(metrics?.errorCode, "automated_provider_retry_exhausted");
  assert.equal(metrics?.termination, "retry_exhausted");
  const errors = sessions.events(sessionId).filter((event) => event.kind === "error");
  assert.equal((errors.at(-1)?.payload as { code?: string }).code, "automated_provider_retry_exhausted");
});
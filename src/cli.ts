#!/usr/bin/env node
import { LookingGlassApp } from "./app.js";
import { spawnSync } from "node:child_process";
import { stdioCallbacks, stdioInteraction } from "./ui/stdio.js";
import { SchedulerDaemon } from "./scheduler/daemon.js";
import { scheduledSessionReadOnly } from "./scheduler/runner.js";
import { installService, serviceStatus, uninstallService } from "./scheduler/service.js";
import { configDir, stateDbPath } from "./paths.js";
import { runTui } from "./ui/tui.js";
import { resolveWorkspacePath } from "./tools/paths.js";
import { resolveExecutableFromPath } from "./tools/executable.js";
import { credentialEnvironmentNames } from "./security.js";
import { schedulerDoctorCheck, type DoctorCheck } from "./doctor.js";

const VERSION = "0.2.4";

function usage(): string {
  return `Looking Glass ${VERSION}

Usage:
  glass                         Start the interactive chat
  glass run [--yes] [--session ID] PROMPT
  glass models
  glass sessions
  glass sessions persist ID on|off
  glass config
  glass doctor
  glass cron list|inbox|status
  glass cron reminder (--once ISO|--cron EXPR) [--timezone TZ] MESSAGE
  glass cron command  (--once ISO|--cron EXPR) [--timezone TZ] [--cwd PATH] "COMMAND"
  glass cron prompt   (--once ISO|--cron EXPR) [--session ID] PROMPT
  glass cron pause|resume|resolve|delete|run|ack ID
  glass cron install|uninstall|daemon
  glass help

Safety: --yes never approves critical/destructive or persistent actions.

Environment:
  LM_STUDIO_API_KEY             Optional local gateway API key
  LOOKING_GLASS_CONFIG          Explicit JSON/JSONC config path
  LOOKING_GLASS_DB              Explicit SQLite state path
`;
}

async function runDoctor(app: LookingGlassApp): Promise<void> {
  const checks: DoctorCheck[] = [];
  const integrity = app.db.pragma("integrity_check") as Array<{ integrity_check: string }>;
  checks.push({
    name: "SQLite",
    ok: integrity[0]?.integrity_check === "ok",
    detail: integrity.map((row) => row.integrity_check).join(", ") || "no result",
  });
  try {
    const rg = spawnSync(resolveExecutableFromPath("rg"), ["--version"], { encoding: "utf8" });
    checks.push({
      name: "ripgrep",
      ok: rg.status === 0,
      detail: rg.error ? "not found" : (rg.stdout || rg.stderr || "not found").split(/\r?\n/, 1)[0] ?? "not found",
    });
  } catch {
    checks.push({ name: "ripgrep", ok: false, detail: "not found" });
  }
  for (const provider of app.configuredProviders()) {
    try {
      const models = await app.modelsForProvider(provider, true);
      const gateway = [app.config.gateway, ...app.config.gateways].find((item) => item.provider === provider)!;
      checks.push({ name: provider, ok: models.length > 0, detail: `${models.length} models at ${gateway.baseURL}` });
    } catch (error) {
      checks.push({ name: provider, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  checks.push(schedulerDoctorCheck(serviceStatus));
  for (const check of checks) process.stdout.write(`${check.ok ? "ok" : "fail"}\t${check.name}\t${check.detail}\n`);
  if (checks.some((check) => !check.ok && check.fatal !== false)) process.exitCode = 1;
}

interface ScheduleCliArgs {
  scheduleKind: "once" | "cron";
  schedule: string;
  timezone: string;
  cwd: string | null;
  timeoutMs: number | null;
  sessionId: string | null;
  text: string;
  textArgs: string[];
}

function parseScheduleArgs(args: string[], defaultTimezone: string): ScheduleCliArgs {
  let scheduleKind: "once" | "cron" | null = null;
  let schedule = "";
  let timezone = defaultTimezone;
  let cwd: string | null = null;
  let timeoutMs: number | null = null;
  let sessionId: string | null = null;
  const text: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--") {
      text.push(...args.slice(index + 1));
      break;
    }
    if (["--once", "--cron", "--timezone", "--cwd", "--timeout", "--session"].includes(value ?? "")) {
      const next = args[index + 1];
      if (!next) throw new Error(`${value} requires a value`);
      index += 1;
      if (value === "--once" || value === "--cron") {
        if (scheduleKind) throw new Error("Specify exactly one of --once or --cron");
        scheduleKind = value === "--once" ? "once" : "cron";
        schedule = next;
      } else if (value === "--timezone") timezone = next;
      else if (value === "--cwd") cwd = next;
      else if (value === "--session") sessionId = next;
      else {
        timeoutMs = Number(next);
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100) throw new Error("--timeout must be an integer >= 100");
      }
      continue;
    }
    if (value?.startsWith("--")) throw new Error(`Unknown scheduler option: ${value}`);
    if (value !== undefined) text.push(value);
  }
  if (!scheduleKind) throw new Error("Specify exactly one of --once or --cron");
  const joined = text.join(" ").trim();
  if (!joined) throw new Error("A reminder message or command is required");
  return { scheduleKind, schedule, timezone, cwd, timeoutMs, sessionId, text: joined, textArgs: text };
}

function printJobs(app: LookingGlassApp): void {
  const jobs = app.scheduler.listJobs();
  if (jobs.length === 0) {
    process.stdout.write("No schedules.\n");
    return;
  }
  for (const job of jobs) {
    const action = job.kind === "reminder" ? job.message : job.kind === "session_prompt" ? job.prompt : job.command;
    process.stdout.write([
      job.id,
      job.enabled ? "enabled" : "disabled",
      job.kind,
      `${job.scheduleKind}:${job.schedule}`,
      job.nextDue === null ? "next:none" : `next:${new Date(job.nextDue).toISOString()}`,
      action ?? "",
      job.blockedReason ? `blocked:${job.blockedReason}` : "",
    ].filter(Boolean).join("\t") + "\n");
  }
}

async function runSchedulerDaemon(app: LookingGlassApp): Promise<void> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const daemon = new SchedulerDaemon(app.scheduler, {
    pollIntervalMs: app.config.scheduler.pollIntervalMs,
    leaseMs: app.config.scheduler.leaseMs,
    maxConcurrentCommands: app.config.scheduler.maxConcurrentCommands,
    sensitiveEnvKeys: credentialEnvironmentNames(app.config),
    sessionPromptHandler: async (job, signal, reservation) => {
      const storedSession = app.sessions.get(job.sessionId);
      if (!storedSession?.persistent) throw new Error("Session persistence is disabled");
      const scopedApp = storedSession.workspace === app.workspace ? app : new LookingGlassApp(storedSession.workspace);
      try {
        const scheduledSession = scopedApp.sessions.get(job.sessionId);
        if (!scheduledSession?.persistent) throw new Error("Session persistence is disabled");
        if (!scopedApp.hasProvider(scheduledSession.provider)) {
          throw new Error(`Session provider is not configured: ${scheduledSession.provider}`);
        }
        const model = await scopedApp.model(scheduledSession.model, signal, scheduledSession.provider);
        const result = await scopedApp.engine.turnReserved(scheduledSession.id, job.prompt, {
          signal,
          modelInfo: model,
          readOnly: scheduledSessionReadOnly(scheduledSession.approvalMode),
          automated: true,
          interaction: {
            approve: async () => "deny",
            ask: async () => {
              throw new Error("Scheduled session turns cannot wait for user input");
            },
          },
        }, reservation);
        return result.text || `Scheduled session turn completed with ${result.toolCalls} tool call(s).`;
      } finally {
        if (scopedApp !== app) scopedApp.close();
      }
    },
  });
  process.stdout.write(`Looking Glass scheduler started as ${daemon.owner}\n`);
  try {
    await daemon.run(controller.signal);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

async function runCron(app: LookingGlassApp, args: string[]): Promise<void> {
  const action = args[0] ?? "list";
  if (action === "list") {
    printJobs(app);
    return;
  }
  if (action === "inbox") {
    const inbox = app.scheduler.listInbox({ unackedOnly: !args.includes("--all"), limit: 200 });
    if (inbox.length === 0) process.stdout.write("Inbox is empty.\n");
    for (const item of inbox) {
      process.stdout.write(`${item.id}\t${item.kind}\t${item.occurrence.state}\t${new Date(item.createdAt).toISOString()}\t${item.message}\n`);
      if (item.occurrence.stdout.length > 0) process.stdout.write(`stdout:\n${item.occurrence.stdout.toString("utf8")}\n`);
      if (item.occurrence.stderr.length > 0) process.stdout.write(`stderr:\n${item.occurrence.stderr.toString("utf8")}\n`);
    }
    return;
  }
  if (action === "status") {
    process.stdout.write(`${serviceStatus()}\n`);
    const lease = app.scheduler.getLease();
    process.stdout.write(`lease=${lease ? `${lease.owner} until ${new Date(lease.expiresAt).toISOString()}` : "none"}\n`);
    process.stdout.write(`jobs=${app.scheduler.listJobs().length} inbox=${app.scheduler.listInbox().length}\n`);
    return;
  }
  if (action === "daemon") {
    await runSchedulerDaemon(app);
    return;
  }
  if (action === "install") {
    const cliPath = process.argv[1];
    if (!cliPath || cliPath.endsWith(".ts")) throw new Error("Build Looking Glass before installing the scheduler service");
    process.stdout.write(`Installed ${installService(cliPath, stateDbPath())}\n`);
    return;
  }
  if (action === "uninstall") {
    process.stdout.write(uninstallService() ? "Scheduler service removed. State was preserved.\n" : "Scheduler service was not installed.\n");
    return;
  }
  if (action === "reminder" || action === "command" || action === "prompt") {
    const parsed = parseScheduleArgs(args.slice(1), app.config.scheduler.timezone);
    if (action === "reminder") {
      const job = app.scheduler.createReminder({
        message: parsed.text,
        scheduleKind: parsed.scheduleKind,
        schedule: parsed.schedule,
        timezone: parsed.timezone,
      });
      process.stdout.write(`Created reminder ${job.id}; next ${new Date(job.nextDue ?? 0).toISOString()}\n`);
      return;
    }
    if (action === "prompt") {
      const target = await app.currentOrNewSession(parsed.sessionId ?? undefined);
      const job = app.scheduler.createSessionPrompt({
        sessionId: target.id,
        prompt: parsed.text,
        scheduleKind: parsed.scheduleKind,
        schedule: parsed.schedule,
        timezone: parsed.timezone,
        startGraceMs: app.config.scheduler.commandStartGraceMs,
        outputBytes: app.config.scheduler.commandOutputBytes,
      });
      process.stdout.write(`Created session prompt ${job.id}; next ${new Date(job.nextDue ?? 0).toISOString()}\n`);
      return;
    }
    if (parsed.textArgs.length !== 1) {
      throw new Error("A scheduled command must be passed as one quoted argument so its exact shell text is preserved");
    }
    const job = app.scheduler.createCommand({
      command: parsed.text,
      cwd: parsed.cwd ? resolveWorkspacePath(app.workspace, parsed.cwd) : app.workspace,
      scheduleKind: parsed.scheduleKind,
      schedule: parsed.schedule,
      timezone: parsed.timezone,
      startGraceMs: app.config.scheduler.commandStartGraceMs,
      timeoutMs: parsed.timeoutMs ?? app.config.scheduler.commandTimeoutMs,
      outputBytes: app.config.scheduler.commandOutputBytes,
    });
    process.stdout.write(`Created command ${job.id}; next ${new Date(job.nextDue ?? 0).toISOString()}\n`);
    return;
  }

  const id = args[1];
  if (!id) throw new Error(`cron ${action} requires an id`);
  if (action === "pause") process.stdout.write(`Paused ${app.scheduler.pauseJob(id).id}\n`);
  else if (action === "resume") process.stdout.write(`Resumed ${app.scheduler.resumeJob(id).id}\n`);
  else if (action === "resolve") process.stdout.write(`Acknowledged unknown outcome for ${app.scheduler.acknowledgeUnknown(id).id}\n`);
  else if (action === "delete") process.stdout.write(`Deleted ${app.scheduler.deleteJob(id).id}\n`);
  else if (action === "run") process.stdout.write(`Queued occurrence ${app.scheduler.runNow(id).id}\n`);
  else if (action === "ack") {
    const inboxId = Number(id);
    if (!Number.isSafeInteger(inboxId) || inboxId < 1) throw new Error("Inbox id must be a positive integer");
    process.stdout.write(app.scheduler.ackInbox(inboxId) ? `Acknowledged ${inboxId}\n` : `Inbox item ${inboxId} was missing or already acknowledged\n`);
  } else throw new Error(`Unknown cron command: ${action}`);
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function runPrompt(app: LookingGlassApp, args: string[]): Promise<void> {
  const assumeYes = args.includes("--yes");
  const sessionId = valueAfter(args, "--session");
  const promptParts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--yes") continue;
    if (value === "--session") {
      index += 1;
      continue;
    }
    if (value !== undefined) promptParts.push(value);
  }
  const prompt = promptParts.join(" ").trim();
  if (!prompt) throw new Error("run requires a prompt");
  const session = await app.currentOrNewSession(sessionId);
  const model = await app.catalogModel(session.model, session.provider);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await app.engine.turn(session.id, prompt, {
      signal: controller.signal,
      interaction: stdioInteraction(assumeYes),
      callbacks: stdioCallbacks(),
      modelInfo: model,
    });
    process.stdout.write("\n");
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "chat";
  if (["help", "--help", "-h"].includes(command)) {
    process.stdout.write(usage());
    return;
  }
  if (["version", "--version", "-v"].includes(command)) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const app = new LookingGlassApp();
  try {
    if (command === "models") {
      for (const model of await app.models()) {
        process.stdout.write(`${model.provider}\t${model.id}\t${model.contextWindow}\t${model.name}\n`);
      }
      return;
    }
    if (command === "sessions") {
      if (args[1] === "persist") {
        const id = args[2];
        const value = args[3]?.toLowerCase();
        if (!id || !value || !["on", "off"].includes(value)) {
          throw new Error("sessions persist requires ID and on|off");
        }
        const target = await app.currentOrNewSession(id);
        const persistent = value === "on";
        const updated = app.sessions.updateSettings(target.id, { persistent });
        app.scheduler.setSessionJobsEnabled(target.id, persistent);
        process.stdout.write(`Session ${updated.id} persistence ${persistent ? "enabled" : "disabled"}.\n`);
        return;
      }
      for (const session of app.sessions.listWithMessages(app.workspace)) {
        const jobs = app.scheduler.listJobsForSession(session.id).length;
        process.stdout.write(`${session.id}\t${session.provider}\t${session.approvalMode}\t${session.persistent ? "persistent" : "manual"}\t${jobs} schedules\t${new Date(session.updatedAt).toISOString()}\t${session.model}\t${session.title}\n`);
      }
      return;
    }
    if (command === "config") {
      process.stdout.write(`${JSON.stringify({
        workspace: app.workspace,
        configDirectory: configDir(),
        stateDatabase: stateDbPath(),
        instructionFiles: app.instructions.files,
        instructionsTruncated: app.instructions.truncated,
        effective: app.config,
      }, null, 2)}\n`);
      return;
    }
    if (command === "doctor") {
      await runDoctor(app);
      return;
    }
    if (command === "run") {
      await runPrompt(app, args.slice(1));
      return;
    }
    if (command === "cron") {
      await runCron(app, args.slice(1));
      return;
    }
    if (command === "chat") {
      await runTui(app, valueAfter(args, "--session"));
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  } finally {
    app.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`glass: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

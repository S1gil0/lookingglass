import type { SchedulerStore } from "../scheduler/store.js";
import type { GlassTool } from "./types.js";
import { isWithin, resolveWorkspacePath } from "./paths.js";
import { shellCommandRisk } from "./safety.js";
import { shellKind } from "./shell.js";

interface ScheduleCreateArgs {
  kind: "reminder" | "command" | "session_prompt";
  schedule_kind: "once" | "cron";
  schedule: string;
  timezone: string | null;
  message: string | null;
  command: string | null;
  prompt: string | null;
  cwd: string | null;
  timeout_ms: number | null;
}

interface ScheduleListArgs {
  include_inbox: boolean;
}

interface ScheduleManageArgs {
  action: "pause" | "resume" | "delete" | "run_now" | "ack_inbox" | "resolve_unknown";
  id: string;
}

function formatJob(job: ReturnType<SchedulerStore["getJob"]>): string {
  if (!job) return "Job not found.";
  const action = job.kind === "reminder" ? job.message : job.kind === "session_prompt" ? job.prompt : job.command;
  return [
    `id: ${job.id}`,
    `kind: ${job.kind}`,
    `schedule: ${job.scheduleKind} ${job.schedule}${job.scheduleKind === "cron" ? ` (${job.timezone})` : ""}`,
    `next: ${job.nextDue === null ? "none" : new Date(job.nextDue).toISOString()}`,
    `state: ${job.enabled ? "enabled" : "disabled"}${job.blockedReason ? `, blocked: ${job.blockedReason}` : ""}`,
    `action: ${action ?? ""}`,
  ].join("\n");
}

function canManageJob(job: NonNullable<ReturnType<SchedulerStore["getJob"]>>, context: Parameters<GlassTool["execute"]>[1]): boolean {
  if (job.kind === "session_prompt") return job.sessionId === context.sessionId;
  if (job.kind === "command") {
    const root = resolveWorkspacePath(context.workspace, ".");
    return job.cwd !== null && isWithin(root, job.cwd);
  }
  return true;
}

export function createScheduleTools(store: SchedulerStore): GlassTool[] {
  const create: GlassTool<ScheduleCreateArgs> = {
    name: "schedule_create",
    description: "Create a persistent reminder, deterministic shell command, or prompt for this persistent session. Use only after an explicit user request.",
    risk: "persistent",
    classifyRisk: (args) => args.kind === "command" && args.command && shellCommandRisk(args.command, shellKind()) === "critical"
      ? "critical"
      : "persistent",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["reminder", "command", "session_prompt"] },
        schedule_kind: { type: "string", enum: ["once", "cron"] },
        schedule: { type: "string", minLength: 1, description: "ISO timestamp with offset, or exactly five cron fields" },
        timezone: { type: ["string", "null"], description: "IANA timezone for cron schedules" },
        message: { type: ["string", "null"] },
        command: { type: ["string", "null"] },
        prompt: { type: ["string", "null"], description: "Prompt to run later in the current persistent session" },
        cwd: { type: ["string", "null"], description: "Workspace-relative command directory" },
        timeout_ms: { type: ["integer", "null"], minimum: 100, maximum: 3600000 },
      },
      required: ["kind", "schedule_kind", "schedule", "timezone", "message", "command", "prompt", "cwd", "timeout_ms"],
      additionalProperties: false,
    },
    summarize: (args) => {
      const action = args.kind === "reminder" ? args.message : args.kind === "session_prompt" ? args.prompt : args.command;
      return `Create ${args.schedule_kind} ${args.kind}: ${action ?? ""} at ${args.schedule}`;
    },
    async execute(args, context) {
      const timezone = args.timezone ?? context.config.scheduler.timezone;
      if (args.kind === "reminder") {
        if (!args.message || args.command || args.prompt || args.cwd || args.timeout_ms) {
          throw new Error("Reminder schedules require message and no command fields");
        }
        const job = store.createReminder({
          message: args.message,
          scheduleKind: args.schedule_kind,
          schedule: args.schedule,
          timezone,
        });
        return { output: `Persistent reminder created.\n${formatJob(job)}` };
      }
      if (args.kind === "session_prompt") {
        if (!args.prompt || args.message || args.command || args.cwd || args.timeout_ms) {
          throw new Error("Session prompt schedules require prompt and no command fields");
        }
        const job = store.createSessionPrompt({
          sessionId: context.sessionId,
          prompt: args.prompt,
          scheduleKind: args.schedule_kind,
          schedule: args.schedule,
          timezone,
          startGraceMs: context.config.scheduler.commandStartGraceMs,
          outputBytes: context.config.scheduler.commandOutputBytes,
        });
        return { output: `Persistent session prompt created.\n${formatJob(job)}` };
      }
      if (!args.command || args.message || args.prompt) throw new Error("Command schedules require command and no message or prompt");
      const cwd = args.cwd ? resolveWorkspacePath(context.workspace, args.cwd) : context.workspace;
      const job = store.createCommand({
        command: args.command,
        cwd,
        scheduleKind: args.schedule_kind,
        schedule: args.schedule,
        timezone,
        startGraceMs: context.config.scheduler.commandStartGraceMs,
        timeoutMs: args.timeout_ms ?? context.config.scheduler.commandTimeoutMs,
        outputBytes: context.config.scheduler.commandOutputBytes,
      });
      return { output: `Persistent command created.\n${formatJob(job)}` };
    },
  };

  const list: GlassTool<ScheduleListArgs> = {
    name: "schedule_list",
    description: "List persistent schedules and optionally unread scheduler inbox results.",
    risk: "read",
    parameters: {
      type: "object",
      properties: { include_inbox: { type: "boolean" } },
      required: ["include_inbox"],
      additionalProperties: false,
    },
    summarize: () => "List persistent schedules",
    async execute(args, context) {
      const jobs = store.listJobs().filter((job) => canManageJob(job, context));
      const sections = [jobs.length > 0 ? jobs.map((job) => formatJob(job)).join("\n\n") : "No schedules."];
      if (args.include_inbox) {
        const inbox = store.listInboxForJobs(jobs.map((job) => job.id), { unackedOnly: true, limit: 50 });
        sections.push(inbox.length > 0
          ? `Unread inbox:\n${inbox.map((item) => `${item.id}: ${item.message} (${new Date(item.createdAt).toISOString()})`).join("\n")}`
          : "Unread inbox: empty");
      }
      return { output: sections.join("\n\n") };
    },
  };

  const manage: GlassTool<ScheduleManageArgs> = {
    name: "schedule_manage",
    description: "Pause, resume, delete, run immediately, or acknowledge a persistent schedule item.",
    risk: "persistent",
    classifyRisk: (args) => {
      if (args.action === "delete") return "critical";
      const job = store.getJob(args.id);
      if (
        job?.kind === "command"
        && (args.action === "resume" || args.action === "run_now" || args.action === "resolve_unknown")
        && shellCommandRisk(job.command ?? "", shellKind()) === "critical"
      ) return "critical";
      return "persistent";
    },
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["pause", "resume", "delete", "run_now", "ack_inbox", "resolve_unknown"] },
        id: { type: "string", minLength: 1 },
      },
      required: ["action", "id"],
      additionalProperties: false,
    },
    summarize: (args) => {
      if (args.action === "ack_inbox") return `Acknowledge scheduler inbox item ${args.id}`;
      const job = store.getJob(args.id);
      if (!job) return `${args.action} missing schedule ${args.id}`;
      const action = job.kind === "reminder" ? job.message : job.kind === "session_prompt" ? job.prompt : job.command;
      return [
        `${args.action} ${job.kind} schedule ${job.id}`,
        `${job.scheduleKind}:${job.schedule} (${job.timezone})`,
        job.cwd ? `cwd: ${job.cwd}` : "",
        `Exact action: ${action ?? ""}`,
      ].filter(Boolean).join("\n");
    },
    async execute(args, context) {
      if (args.action === "ack_inbox") {
        const id = Number(args.id);
        if (!Number.isSafeInteger(id) || id < 1) throw new Error("Inbox id must be a positive integer");
        const item = store.getInbox(id);
        if (!item) return { output: `Inbox item ${id} is missing.` };
        const job = store.getJob(item.jobId);
        if (!job || !canManageJob(job, context)) throw new Error("Scheduler item belongs to another workspace or session");
        return { output: store.ackInbox(id) ? `Acknowledged inbox item ${id}.` : `Inbox item ${id} was already acknowledged or missing.` };
      }
      const job = store.getJob(args.id);
      if (!job) throw new Error(`Schedule not found: ${args.id}`);
      if (!canManageJob(job, context)) throw new Error("Schedule belongs to another workspace or session");
      if (args.action === "pause") return { output: `Paused.\n${formatJob(store.pauseJob(args.id))}` };
      if (args.action === "resume") return { output: `Resumed.\n${formatJob(store.resumeJob(args.id))}` };
      if (args.action === "resolve_unknown") {
        return { output: `Unknown outcome acknowledged.\n${formatJob(store.acknowledgeUnknown(args.id))}` };
      }
      if (args.action === "delete") return { output: `Deleted.\n${formatJob(store.deleteJob(args.id))}` };
      const run = store.runNow(args.id);
      return { output: `Queued occurrence ${run.id} with state ${run.state}.` };
    },
  };

  return [create, list, manage];
}

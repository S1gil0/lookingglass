import { Cron } from "croner";

const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

export function rejectNul(value: string, field: string): void {
  if (value.includes("\0")) throw new Error(`${field} must not contain NUL bytes`);
}

export function validateTimezone(timezone: string): void {
  rejectNul(timezone, "timezone");
  if (timezone.length === 0) throw new Error("timezone must not be empty");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
  } catch {
    throw new Error(`Invalid timezone: ${timezone}`);
  }
}

export function parseOnceSchedule(schedule: string): number {
  rejectNul(schedule, "schedule");
  const match = ISO_WITH_OFFSET.exec(schedule);
  if (!match) throw new Error("One-shot schedule must be an ISO datetime with Z or an explicit offset");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");
  const millisecond = Number((match[7] ?? "").padEnd(3, "0"));
  const offset = match[8];
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    throw new Error(`Invalid one-shot schedule: ${schedule}`);
  }
  if (offset !== "Z") {
    const offsetHour = Number(offset?.slice(1, 3));
    const offsetMinute = Number(offset?.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) throw new Error(`Invalid one-shot schedule: ${schedule}`);
  }

  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);
  if (
    local.getUTCFullYear() !== year
    || local.getUTCMonth() !== month - 1
    || local.getUTCDate() !== day
    || local.getUTCHours() !== hour
    || local.getUTCMinutes() !== minute
    || local.getUTCSeconds() !== second
  ) {
    throw new Error(`Invalid one-shot schedule: ${schedule}`);
  }

  const timestamp = Date.parse(schedule);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid one-shot schedule: ${schedule}`);
  return timestamp;
}

function cron(schedule: string, timezone: string): Cron {
  rejectNul(schedule, "schedule");
  validateTimezone(timezone);
  if (schedule.trim().split(/\s+/).length !== 5) {
    throw new Error("Cron schedule must contain exactly five fields");
  }
  try {
    return new Cron(schedule, { timezone, mode: "5-part", paused: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid cron schedule: ${detail}`);
  }
}

export function validateSchedule(kind: "once" | "cron", schedule: string, timezone: string): void {
  if (kind !== "once" && kind !== "cron") throw new Error(`Invalid schedule kind: ${String(kind)}`);
  validateTimezone(timezone);
  if (kind === "once") {
    parseOnceSchedule(schedule);
  } else {
    cron(schedule, timezone);
  }
}

export function initialDue(kind: "once" | "cron", schedule: string, timezone: string, now: number): number {
  validateSchedule(kind, schedule, timezone);
  if (kind === "once") return parseOnceSchedule(schedule);
  return nextCronDue(schedule, timezone, now);
}

export function nextCronDue(schedule: string, timezone: string, scheduledAt: number): number {
  const next = cron(schedule, timezone).nextRun(new Date(scheduledAt));
  if (!next || !Number.isFinite(next.getTime()) || next.getTime() <= scheduledAt) {
    throw new Error("Cron schedule has no next occurrence");
  }
  return next.getTime();
}

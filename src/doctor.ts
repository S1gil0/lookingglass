import type { OperationalSnapshot } from "./operations.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  fatal?: boolean;
}

/** Convert aggregate operational telemetry into concise health checks. */
export function operationalDoctorChecks(snapshot: OperationalSnapshot): DoctorCheck[] {
  const staleCalls = snapshot.sessions.toolCalls.orphanedStarted;
  const staleLeases = snapshot.sessions.leases.stale;
  const schedulerIssues = snapshot.scheduler.staleClaims + snapshot.scheduler.terminalClaims;
  return [
    {
      name: "version",
      ok: true,
      detail: `glass ${snapshot.appVersion}, telemetry ${snapshot.telemetrySchemaVersion}, Node ${snapshot.runtime.node}, SQLite ${snapshot.sqlite.libraryVersion}, schema ${snapshot.sqlite.schemaMigrationVersion}`,
    },
    {
      name: "storage",
      ok: true,
      detail: `SQLite ${snapshot.sqlite.logicalUsedBytes}/${snapshot.sqlite.logicalAllocatedBytes} bytes used, artifacts ${snapshot.artifacts.total}/${snapshot.artifacts.logicalBytes} bytes (${snapshot.artifacts.detached} detached)`,
    },
    {
      name: "tool calls",
      ok: staleCalls === 0,
      detail: `${snapshot.sessions.toolCalls.started} started, ${snapshot.sessions.toolCalls.unknown} unknown, ${staleCalls} orphaned stale`,
      fatal: false,
    },
    {
      name: "leases",
      ok: staleLeases === 0 && schedulerIssues === 0,
      detail: `${snapshot.sessions.leases.active} active session, ${staleLeases} stale session, ${snapshot.scheduler.staleClaims} stale claims, ${snapshot.scheduler.terminalClaims} terminal claims`,
      fatal: false,
    },
    {
      name: "queue",
      ok: snapshot.scheduler.occurrences.unknown === 0,
      detail: `${snapshot.scheduler.occurrences.pending} pending, ${snapshot.scheduler.occurrences.claimed} claimed, ${snapshot.scheduler.occurrences.running} running, ${snapshot.scheduler.occurrences.unknown} unknown, ${snapshot.scheduler.inbox.unread} unread`,
      fatal: false,
    },
  ];
}

/**
 * Keep scheduler discovery independent from the other doctor checks. A
 * scheduler backend can fail because its native service manager is missing or
 * inaccessible, but that must still be reported as one check rather than
 * aborting the rest of the diagnostic.
 */
export function schedulerDoctorCheck(status: () => string): DoctorCheck {
  try {
    const value = status();
    return {
      name: "scheduler",
      ok: /ActiveState=active/.test(value),
      detail: value.replace(/\n/g, ", "),
      fatal: false,
    };
  } catch (error) {
    return {
      name: "scheduler",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      fatal: true,
    };
  }
}
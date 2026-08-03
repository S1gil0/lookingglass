import type {
  AgentSessionRetentionReport,
  AgentSessionRetentionPolicy,
  SessionStore,
} from "./storage/session-store.js";
import type {
  ArtifactMaintenancePolicy,
  ArtifactMaintenanceReport,
  ArtifactStore,
} from "./storage/artifact-store.js";
import type { SchedulerStore } from "./scheduler/store.js";
import type {
  SchedulerRetentionPolicy,
  SchedulerRetentionReport,
} from "./scheduler/types.js";

export type MaintenanceMode = "dry-run" | "apply";

/** Version of the aggregate maintenance report shape. */
export const MAINTENANCE_SCHEMA_VERSION = 1;

export interface OrphanedToolMaintenanceReport {
  /** Started calls that were pending reconciliation at the start of the run. */
  pending: number;
  /** Started calls marked unknown by an apply run. */
  reconciled: number;
}

/**
 * Aggregate maintenance output.  The report intentionally contains counts,
 * policy values, and store reports only; it never contains row identifiers,
 * paths, or stored payloads.
 */
export interface MaintenanceReport {
  schemaVersion: number;
  mode: MaintenanceMode;
  dryRun: boolean;
  now: number;
  orphanedTools: OrphanedToolMaintenanceReport;
  expiredLeasesDeleted: number;
  agentSessions: AgentSessionRetentionReport;
  detachedArtifacts: ArtifactMaintenanceReport;
  schedulerHistory: SchedulerRetentionReport;
}

/** The maintenance portion of the application configuration. */
export interface MaintenanceConfig {
  runOnStartup: boolean;
  reconcileOrphanedTools: boolean;
  agentSessions: AgentSessionRetentionPolicy;
  detachedArtifacts: ArtifactMaintenancePolicy;
  schedulerHistory: SchedulerRetentionPolicy;
}

function validateNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("now must be a non-negative safe integer");
  }
}

function validateMode(mode: MaintenanceMode): void {
  if (mode !== "dry-run" && mode !== "apply") {
    throw new Error("Maintenance mode must be dry-run or apply");
  }
}

function estimateOrphanedTools(sessions: SessionStore, now: number): number {
  // Reconciliation marks every started call without a live lease.  Use a zero
  // stale age here so a dry-run estimates that same set rather than applying
  // the operational five-minute stale-call diagnostic threshold.
  return sessions.getStats({ now, staleStartedToolCallAgeMs: 0 }).toolCalls.orphanedStarted;
}

function buildReport(
  mode: MaintenanceMode,
  now: number,
  orphanedTools: OrphanedToolMaintenanceReport,
  expiredLeasesDeleted: number,
  agentSessions: AgentSessionRetentionReport,
  detachedArtifacts: ArtifactMaintenanceReport,
  schedulerHistory: SchedulerRetentionReport,
): MaintenanceReport {
  return {
    schemaVersion: MAINTENANCE_SCHEMA_VERSION,
    mode,
    dryRun: mode === "dry-run",
    now,
    orphanedTools,
    expiredLeasesDeleted,
    agentSessions,
    detachedArtifacts,
    schedulerHistory,
  };
}

/**
 * Run the independent maintenance stages in dependency order.
 *
 * Dry-runs call only store planning/statistics methods.  Apply runs do not add
 * a transaction around the stages: each store owns its database transaction,
 * and artifact maintenance deliberately performs filesystem deletion outside
 * any database transaction.
 */
export function runMaintenance(
  sessions: SessionStore,
  artifacts: ArtifactStore,
  scheduler: SchedulerStore,
  config: { maintenance: MaintenanceConfig },
  mode: MaintenanceMode = "dry-run",
  now = Date.now(),
): MaintenanceReport {
  validateMode(mode);
  validateNow(now);

  const maintenance = config.maintenance;

  if (mode === "dry-run") {
    const schedulerHistory = scheduler.planSchedulerRetention(
      maintenance.schedulerHistory,
      now,
    );
    const orphanedTools = maintenance.reconcileOrphanedTools
      ? { pending: estimateOrphanedTools(sessions, now), reconciled: 0 }
      : { pending: 0, reconciled: 0 };
    const agentSessions = sessions.planAgentSessionRetention(
      maintenance.agentSessions,
      now,
    );
    const detachedArtifacts = artifacts.planDetachedArtifactMaintenance(
      maintenance.detachedArtifacts,
      now,
    );
    return buildReport(
      mode,
      now,
      orphanedTools,
      0,
      agentSessions,
      detachedArtifacts,
      schedulerHistory,
    );
  }

  // Keep this order: scheduler rows first, then orphan reconciliation, then
  // session deletion, and finally artifacts so newly detached old artifacts
  // are visible to the artifact maintenance plan.
  const schedulerHistory = scheduler.applySchedulerRetention(
    maintenance.schedulerHistory,
    now,
  );
  let orphanedTools: OrphanedToolMaintenanceReport = { pending: 0, reconciled: 0 };
  let expiredLeasesDeleted = 0;
  if (maintenance.reconcileOrphanedTools) {
    orphanedTools = { pending: estimateOrphanedTools(sessions, now), reconciled: 0 };
    const reconciliation = sessions.reconcileOrphanedToolCalls(now);
    orphanedTools.reconciled = reconciliation.toolCallsMarkedUnknown;
    expiredLeasesDeleted = reconciliation.expiredLeasesDeleted;
  }
  const agentSessions = sessions.applyAgentSessionRetention(
    maintenance.agentSessions,
    now,
  );
  const detachedArtifacts = artifacts.applyDetachedArtifactMaintenance(
    maintenance.detachedArtifacts,
    now,
  );
  return buildReport(
    mode,
    now,
    orphanedTools,
    expiredLeasesDeleted,
    agentSessions,
    detachedArtifacts,
    schedulerHistory,
  );
}
import type { GlassDatabase } from "./storage/database.js";
import type { ArtifactStatsSnapshot, ArtifactStore } from "./storage/artifact-store.js";
import type { SessionStatsSnapshot, SessionStore } from "./storage/session-store.js";
import type { SchedulerStore } from "./scheduler/store.js";
import type { SchedulerStats } from "./scheduler/types.js";

/** Version of the aggregate-only operational telemetry shape. */
export const TELEMETRY_SCHEMA_VERSION = 1;

const MAX_TEXT_BYTES = 256;

export interface OperationalRuntime {
  node: string;
  platform: NodeJS.Platform;
  arch: string;
}

export interface OperationalSqliteStats {
  libraryVersion: string;
  schemaMigrationVersion: number;
  pageCount: number;
  pageSize: number;
  freelistCount: number;
  logicalAllocatedBytes: number;
  logicalUsedBytes: number;
  logicalFreeBytes: number;
}

/**
 * Aggregate operational state. The shape intentionally contains no durable
 * identifiers, paths, configuration, scheduler payloads, or content.
 */
export interface OperationalSnapshot {
  telemetrySchemaVersion: number;
  appVersion: string;
  generatedAt: number;
  runtime: OperationalRuntime;
  sqlite: OperationalSqliteStats;
  sessions: SessionStatsSnapshot;
  artifacts: ArtifactStatsSnapshot;
  scheduler: SchedulerStats;
}

interface NumericRow {
  [key: string]: unknown;
}

function boundedText(name: string, value: unknown, maximumBytes = MAX_TEXT_BYTES): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const sanitized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "�");
  if (Buffer.byteLength(sanitized, "utf8") <= maximumBytes) return sanitized;
  let result = "";
  let bytes = 0;
  for (const character of sanitized) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function boundedInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
}

function boundedNullableInteger(name: string, value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return boundedInteger(name, value);
}

function safeProduct(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  if (left > Number.MAX_SAFE_INTEGER / right) return Number.MAX_SAFE_INTEGER;
  return left * right;
}

function readPragma(db: GlassDatabase, pragma: "page_count" | "page_size" | "freelist_count"): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as NumericRow | undefined;
  if (!row) throw new Error(`SQLite pragma ${pragma} returned no row`);
  return boundedInteger(`SQLite ${pragma}`, row[pragma]);
}

function readSqliteStats(db: GlassDatabase): OperationalSqliteStats {
  const libraryRow = db.prepare("SELECT sqlite_version() AS version").get() as NumericRow | undefined;
  if (!libraryRow) throw new Error("SQLite version query returned no row");
  const libraryVersion = boundedText("SQLite library version", libraryRow.version);
  if (libraryVersion.length === 0) throw new Error("SQLite library version must not be empty");

  const migrationRow = db.prepare(
    "SELECT MAX(version) AS version FROM schema_migrations",
  ).get() as NumericRow | undefined;
  if (!migrationRow) throw new Error("Schema migration query returned no row");
  const schemaMigrationVersion = boundedInteger(
    "SQLite schema migration version",
    migrationRow.version ?? 0,
  );

  const pageCount = readPragma(db, "page_count");
  const pageSize = readPragma(db, "page_size");
  const freelistCount = Math.min(readPragma(db, "freelist_count"), pageCount);
  const logicalAllocatedBytes = safeProduct(pageCount, pageSize);
  const logicalFreeBytes = Math.min(
    logicalAllocatedBytes,
    safeProduct(freelistCount, pageSize),
  );

  return {
    libraryVersion,
    schemaMigrationVersion,
    pageCount,
    pageSize,
    freelistCount,
    logicalAllocatedBytes,
    logicalUsedBytes: logicalAllocatedBytes - logicalFreeBytes,
    logicalFreeBytes,
  };
}

function readSessionStats(store: SessionStore, now: number): SessionStatsSnapshot {
  const stats = store.getStats({ now });
  return {
    sessions: {
      total: boundedInteger("session count", stats.sessions.total),
      interactive: boundedInteger("interactive session count", stats.sessions.interactive),
      agent: boundedInteger("agent session count", stats.sessions.agent),
      persistent: boundedInteger("persistent session count", stats.sessions.persistent),
    },
    events: {
      total: boundedInteger("event count", stats.events.total),
      user: boundedInteger("user event count", stats.events.user),
      response: boundedInteger("response event count", stats.events.response),
      toolStarted: boundedInteger("tool-started event count", stats.events.toolStarted),
      toolResult: boundedInteger("tool-result event count", stats.events.toolResult),
      toolDenied: boundedInteger("tool-denied event count", stats.events.toolDenied),
      error: boundedInteger("error event count", stats.events.error),
      note: boundedInteger("note event count", stats.events.note),
    },
    checkpoints: {
      total: boundedInteger("checkpoint count", stats.checkpoints.total),
    },
    toolCalls: {
      total: boundedInteger("tool-call count", stats.toolCalls.total),
      started: boundedInteger("started tool-call count", stats.toolCalls.started),
      completed: boundedInteger("completed tool-call count", stats.toolCalls.completed),
      denied: boundedInteger("denied tool-call count", stats.toolCalls.denied),
      failed: boundedInteger("failed tool-call count", stats.toolCalls.failed),
      unknown: boundedInteger("unknown tool-call count", stats.toolCalls.unknown),
      staleStarted: boundedInteger("stale started tool-call count", stats.toolCalls.staleStarted),
      orphanedStarted: boundedInteger("orphaned started tool-call count", stats.toolCalls.orphanedStarted),
      oldestStaleStartedAgeMs: boundedNullableInteger(
        "oldest stale started tool-call age",
        stats.toolCalls.oldestStaleStartedAgeMs,
      ),
    },
    leases: {
      total: boundedInteger("session lease count", stats.leases.total),
      active: boundedInteger("active session lease count", stats.leases.active),
      stale: boundedInteger("stale session lease count", stats.leases.stale),
      oldestStaleAgeMs: boundedNullableInteger("oldest stale session lease age", stats.leases.oldestStaleAgeMs),
    },
  };
}

function readArtifactStats(store: ArtifactStore): ArtifactStatsSnapshot {
  const stats = store.getStats();
  return {
    total: boundedInteger("artifact count", stats.total),
    attached: boundedInteger("attached artifact count", stats.attached),
    detached: boundedInteger("detached artifact count", stats.detached),
    logicalBytes: boundedInteger("artifact logical bytes", stats.logicalBytes),
  };
}

function readSchedulerStats(store: SchedulerStore, now: number): SchedulerStats {
  const stats = store.getStats(now);
  return {
    jobs: {
      total: boundedInteger("scheduler job count", stats.jobs.total),
      enabled: boundedInteger("enabled scheduler job count", stats.jobs.enabled),
      blocked: boundedInteger("blocked scheduler job count", stats.jobs.blocked),
      deleted: boundedInteger("deleted scheduler job count", stats.jobs.deleted),
    },
    occurrences: {
      total: boundedInteger("scheduler occurrence count", stats.occurrences.total),
      pending: boundedInteger("pending scheduler occurrence count", stats.occurrences.pending),
      claimed: boundedInteger("claimed scheduler occurrence count", stats.occurrences.claimed),
      running: boundedInteger("running scheduler occurrence count", stats.occurrences.running),
      terminal: boundedInteger("terminal scheduler occurrence count", stats.occurrences.terminal),
      unknown: boundedInteger("unknown scheduler occurrence count", stats.occurrences.unknown),
    },
    inbox: {
      total: boundedInteger("scheduler inbox count", stats.inbox.total),
      unread: boundedInteger("unread scheduler inbox count", stats.inbox.unread),
      acknowledged: boundedInteger("acknowledged scheduler inbox count", stats.inbox.acknowledged),
    },
    leases: {
      daemon: boundedInteger("scheduler daemon lease count", stats.leases.daemon),
      sessionOperations: boundedInteger("session-operation lease count", stats.leases.sessionOperations),
      total: boundedInteger("scheduler lease count", stats.leases.total),
      active: boundedInteger("active scheduler lease count", stats.leases.active),
      stale: boundedInteger("stale scheduler lease count", stats.leases.stale),
    },
    staleClaims: boundedInteger("stale scheduler claim count", stats.staleClaims),
    terminalClaims: boundedInteger("terminal scheduler claim count", stats.terminalClaims),
    queueAges: {
      pendingMs: boundedNullableInteger("pending scheduler queue age", stats.queueAges.pendingMs),
      claimedMs: boundedNullableInteger("claimed scheduler queue age", stats.queueAges.claimedMs),
      runningMs: boundedNullableInteger("running scheduler queue age", stats.queueAges.runningMs),
    },
    output: {
      stdoutBytes: boundedInteger("scheduler stdout bytes", stats.output.stdoutBytes),
      stderrBytes: boundedInteger("scheduler stderr bytes", stats.output.stderrBytes),
      bytes: boundedInteger("scheduler output bytes", stats.output.bytes),
      stdoutStoredBytes: boundedInteger("stored scheduler stdout bytes", stats.output.stdoutStoredBytes),
      stderrStoredBytes: boundedInteger("stored scheduler stderr bytes", stats.output.stderrStoredBytes),
      storedBytes: boundedInteger("stored scheduler output bytes", stats.output.storedBytes),
      stdoutTruncated: boundedInteger("truncated scheduler stdout count", stats.output.stdoutTruncated),
      stderrTruncated: boundedInteger("truncated scheduler stderr count", stats.output.stderrTruncated),
      truncated: boundedInteger("truncated scheduler output count", stats.output.truncated),
    },
  };
}

/**
 * Collect a synchronous, aggregate-only operational snapshot.
 *
 * The store methods used here already query aggregate columns only; the
 * explicit copies below keep that privacy boundary stable if a store grows
 * additional diagnostic fields in the future.
 */
export function collectOperationalSnapshot(
  db: GlassDatabase,
  sessions: SessionStore,
  artifacts: ArtifactStore,
  scheduler: SchedulerStore,
  appVersion: string,
  now = Date.now(),
): OperationalSnapshot {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("now must be a non-negative safe integer");
  }
  const normalizedAppVersion = boundedText("appVersion", appVersion);
  if (normalizedAppVersion.trim().length === 0) {
    throw new Error("appVersion must not be empty");
  }

  return {
    telemetrySchemaVersion: TELEMETRY_SCHEMA_VERSION,
    appVersion: normalizedAppVersion,
    generatedAt: now,
    runtime: {
      node: boundedText("Node version", process.version),
      platform: process.platform,
      arch: boundedText("Node architecture", process.arch),
    },
    sqlite: readSqliteStats(db),
    sessions: readSessionStats(sessions, now),
    artifacts: readArtifactStats(artifacts),
    scheduler: readSchedulerStats(scheduler, now),
  };
}

/** Descriptive alias for callers that use getter-style diagnostics APIs. */
export const getOperationalSnapshot = collectOperationalSnapshot;
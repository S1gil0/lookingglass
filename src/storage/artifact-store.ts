import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { shouldEnforcePosixPermissions } from "../paths.js";
import type { GlassDatabase } from "./database.js";

export interface ArtifactMaintenancePolicy {
  maxAgeMs?: number;
  minAgeMs?: number;
  maxArtifacts?: number;
  maxBytes?: number;
  maxArtifactsPerRun?: number;
  maxBytesPerRun?: number;
}

export type DetachedArtifactMaintenancePolicy = ArtifactMaintenancePolicy;

export interface ArtifactMaintenanceEstimate {
  artifacts: number;
  bytes: number;
}

export type DetachedArtifactMaintenanceEstimate = ArtifactMaintenanceEstimate;

export type ArtifactMaintenanceMode = "dry-run" | "apply";

export interface ArtifactMaintenanceReport {
  mode: ArtifactMaintenanceMode;
  dryRun: boolean;
  now: number;
  policy: ArtifactMaintenancePolicy;
  total: ArtifactMaintenanceEstimate;
  candidate: ArtifactMaintenanceEstimate;
  eligible: ArtifactMaintenanceEstimate;
  protected: ArtifactMaintenanceEstimate;
  selected: ArtifactMaintenanceEstimate;
  remaining: ArtifactMaintenanceEstimate;
  batchLimited: boolean;
  deletedMetadata: number;
  deletedMetadataBytes: number;
  deletedFiles: number;
  deletedFileBytes: number;
  errors: number;
  errorBytes: number;
}

export type DetachedArtifactMaintenanceReport = ArtifactMaintenanceReport;

/** Aggregate artifact metadata suitable for operational diagnostics. */
export interface ArtifactStatsSnapshot {
  total: number;
  attached: number;
  detached: number;
  logicalBytes: number;
}

export type ArtifactOperationalStats = ArtifactStatsSnapshot;
export type ArtifactStats = ArtifactStatsSnapshot;

export interface ArtifactRecord {
  id: string;
  uri: string;
  path: string;
  byteCount: number;
  kind: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

interface ArtifactRow {
  id: string;
  kind: string;
  file_path: string;
  byte_count: number;
  metadata_json: string;
  created_at: number;
}

interface ArtifactMaintenanceRow {
  id: string;
  session_id: string | null;
  file_path: string;
  byte_count: number;
  created_at: number;
}

interface ArtifactMaintenancePlan {
  rows: ArtifactMaintenanceRow[];
  eligible: ArtifactMaintenanceRow[];
  candidate: ArtifactMaintenanceRow[];
  selected: ArtifactMaintenanceRow[];
}

type ArtifactPathCheck =
  | { kind: "missing" }
  | { kind: "regular"; path: string }
  | { kind: "unsafe" }
  | { kind: "error" };

interface ArtifactApplyOutcome {
  metadataDeleted: boolean;
  fileDeleted: boolean;
  fileBytes: number;
  error: boolean;
}

const ARTIFACT_MAINTENANCE_POLICY_KEYS = new Set<keyof ArtifactMaintenancePolicy>([
  "maxAgeMs",
  "minAgeMs",
  "maxArtifacts",
  "maxBytes",
  "maxArtifactsPerRun",
  "maxBytesPerRun",
]);

function finiteNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function validateNow(now: number): void {
  finiteNonNegativeInteger("now", now);
}

function validateArtifactMaintenancePolicy(
  policy: ArtifactMaintenancePolicy,
): ArtifactMaintenancePolicy {
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("Artifact maintenance policy must be an object");
  }
  for (const key of Object.keys(policy) as Array<keyof ArtifactMaintenancePolicy>) {
    if (!ARTIFACT_MAINTENANCE_POLICY_KEYS.has(key)) {
      throw new Error(`Unknown artifact maintenance policy field: ${key}`);
    }
  }
  for (const key of ARTIFACT_MAINTENANCE_POLICY_KEYS) {
    const value = policy[key];
    if (value !== undefined) finiteNonNegativeInteger(key, value);
  }
  return { ...policy };
}

function artifactBytes(row: { byte_count: number }): number {
  return Math.max(0, row.byte_count);
}

function artifactEstimate(rows: Array<{ byte_count: number }>): ArtifactMaintenanceEstimate {
  return {
    artifacts: rows.length,
    bytes: rows.reduce((sum, row) => sum + artifactBytes(row), 0),
  };
}

function subtractArtifactEstimate(
  total: ArtifactMaintenanceEstimate,
  removed: ArtifactMaintenanceEstimate,
): ArtifactMaintenanceEstimate {
  return {
    artifacts: total.artifacts - removed.artifacts,
    bytes: total.bytes - removed.bytes,
  };
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

function strictlyContains(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path);
}

export class ArtifactStore {
  constructor(
    private readonly db: GlassDatabase,
    private readonly directory: string,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  save(sessionId: string | null, kind: string, content: string | Buffer, metadata: Record<string, unknown> = {}): ArtifactRecord {
    const id = randomUUID();
    const path = join(this.directory, id);
    const data = typeof content === "string" ? Buffer.from(content) : content;
    const enforcePermissions = shouldEnforcePosixPermissions(this.platform);
    let ownsFile = false;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(path, "wx", enforcePermissions ? 0o600 : undefined);
      ownsFile = true;
      writeFileSync(descriptor, data);
      closeSync(descriptor);
      descriptor = null;
      if (enforcePermissions) chmodSync(path, 0o600);
      const createdAt = Date.now();
      this.db.prepare(`
        INSERT INTO artifacts(id, session_id, kind, file_path, byte_count, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, sessionId, kind, path, data.byteLength, JSON.stringify(metadata), createdAt);
      return { id, uri: `artifact://${id}`, path, byteCount: data.byteLength, kind, metadata, createdAt };
    } catch (error) {
      if (descriptor !== null) {
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the original save error.
        }
      }
      if (ownsFile) {
        try {
          unlinkSync(path);
        } catch {
          // Preserve the original save error if cleanup itself fails.
        }
      }
      throw error;
    }
  }

  planDetachedArtifactMaintenance(
    policy: ArtifactMaintenancePolicy,
    now = Date.now(),
  ): ArtifactMaintenanceReport {
    const checkedPolicy = validateArtifactMaintenancePolicy(policy);
    validateNow(now);
    return this.buildArtifactMaintenanceReport(
      checkedPolicy,
      now,
      "dry-run",
      this.buildArtifactMaintenancePlan(checkedPolicy, now),
    );
  }

  previewDetachedArtifactMaintenance(
    policy: ArtifactMaintenancePolicy,
    now = Date.now(),
  ): ArtifactMaintenanceReport {
    return this.planDetachedArtifactMaintenance(policy, now);
  }

  previewDetachedArtifacts(
    policy: ArtifactMaintenancePolicy,
    now = Date.now(),
  ): ArtifactMaintenanceReport {
    return this.previewDetachedArtifactMaintenance(policy, now);
  }

  previewArtifactMaintenance(
    policy: ArtifactMaintenancePolicy,
    now = Date.now(),
  ): ArtifactMaintenanceReport {
    return this.previewDetachedArtifactMaintenance(policy, now);
  }

  applyDetachedArtifactMaintenance(
    policy: ArtifactMaintenancePolicy,
    now = Date.now(),
  ): ArtifactMaintenanceReport {
    const checkedPolicy = validateArtifactMaintenancePolicy(policy);
    validateNow(now);
    const plan = this.buildArtifactMaintenancePlan(checkedPolicy, now);
    let deletedMetadata = 0;
    let deletedMetadataBytes = 0;
    let deletedFiles = 0;
    let deletedFileBytes = 0;
    let errors = 0;
    let errorBytes = 0;
    const deletedRows: ArtifactMaintenanceRow[] = [];

    for (const row of plan.selected) {
      const outcome = this.applyArtifactMaintenanceRow(row, checkedPolicy, now);
      if (outcome.metadataDeleted) {
        deletedMetadata += 1;
        deletedMetadataBytes += artifactBytes(row);
        deletedRows.push(row);
      }
      if (outcome.fileDeleted) {
        deletedFiles += 1;
        deletedFileBytes += outcome.fileBytes;
      }
      if (outcome.error) {
        errors += 1;
        errorBytes += artifactBytes(row);
      }
    }

    return this.buildArtifactMaintenanceReport(
      checkedPolicy,
      now,
      "apply",
      plan,
      {
        deletedRows,
        deletedMetadata,
        deletedMetadataBytes,
        deletedFiles,
        deletedFileBytes,
        errors,
        errorBytes,
      },
    );
  }

  applyDetachedArtifacts(
    policy: ArtifactMaintenancePolicy,
    now = Date.now(),
  ): ArtifactMaintenanceReport {
    return this.applyDetachedArtifactMaintenance(policy, now);
  }

  applyArtifactMaintenance(
    policy: ArtifactMaintenancePolicy,
    now = Date.now(),
  ): ArtifactMaintenanceReport {
    return this.applyDetachedArtifactMaintenance(policy, now);
  }

  detachedArtifactMaintenance(
    policy: ArtifactMaintenancePolicy,
    mode: ArtifactMaintenanceMode = "dry-run",
    now = Date.now(),
  ): ArtifactMaintenanceReport {
    if (mode === "dry-run") return this.planDetachedArtifactMaintenance(policy, now);
    if (mode === "apply") return this.applyDetachedArtifactMaintenance(policy, now);
    throw new Error("Artifact maintenance mode must be dry-run or apply");
  }

  get(idOrUri: string): ArtifactRecord | null {
    const id = idOrUri.startsWith("artifact://") ? idOrUri.slice("artifact://".length) : idOrUri;
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      uri: `artifact://${row.id}`,
      path: row.file_path,
      byteCount: row.byte_count,
      kind: row.kind,
      metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
      createdAt: row.created_at,
    };
  }

  /**
   * Return aggregate artifact metadata only. In particular, this query does
   * not select artifact ids, paths, kinds, or metadata payloads.
   */
  getStats(): ArtifactStatsSnapshot {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN session_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS attached,
        COALESCE(SUM(CASE WHEN session_id IS NULL THEN 1 ELSE 0 END), 0) AS detached,
        COALESCE(SUM(CASE WHEN byte_count >= 0 THEN byte_count ELSE 0 END), 0) AS logical_bytes
      FROM artifacts
    `).get() as {
      total: number;
      attached: number;
      detached: number;
      logical_bytes: number;
    };
    return {
      total: row.total,
      attached: row.attached,
      detached: row.detached,
      logicalBytes: row.logical_bytes,
    };
  }

  stats(): ArtifactStatsSnapshot {
    return this.getStats();
  }

  getArtifactStats(): ArtifactStatsSnapshot {
    return this.getStats();
  }

  read(idOrUri: string, offset = 0, limit = 64 * 1024): Buffer {
    const artifact = this.get(idOrUri);
    if (!artifact) throw new Error(`Artifact not found: ${idOrUri}`);
    const data = readFileSync(artifact.path);
    return data.subarray(offset, Math.min(data.length, offset + limit));
  }

  private buildArtifactMaintenancePlan(
    policy: ArtifactMaintenancePolicy,
    now: number,
  ): ArtifactMaintenancePlan {
    const rows = this.readDetachedArtifactRows();
    const ordered = [...rows].sort(
      (left, right) => left.created_at - right.created_at
        || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
    const minimumAge = policy.minAgeMs ?? 0;
    const eligible = ordered.filter((row) => this.artifactIsAgeEligible(row, now, minimumAge));
    let remainingArtifacts = rows.length;
    let remainingBytes = rows.reduce((sum, row) => sum + artifactBytes(row), 0);
    const candidate: ArtifactMaintenanceRow[] = [];
    for (const row of eligible) {
      const age = now - row.created_at;
      const oldEnough = policy.maxAgeMs !== undefined && age > policy.maxAgeMs;
      const quotaNeeded = (policy.maxArtifacts !== undefined && remainingArtifacts > policy.maxArtifacts)
        || (policy.maxBytes !== undefined && remainingBytes > policy.maxBytes);
      if (!oldEnough && !quotaNeeded) continue;
      candidate.push(row);
      remainingArtifacts -= 1;
      remainingBytes = Math.max(0, remainingBytes - artifactBytes(row));
    }

    let artifactBudget = policy.maxArtifactsPerRun ?? Number.MAX_SAFE_INTEGER;
    let byteBudget = policy.maxBytesPerRun ?? Number.MAX_SAFE_INTEGER;
    const selected: ArtifactMaintenanceRow[] = [];
    for (const row of candidate) {
      if (artifactBudget === 0) break;
      const bytes = artifactBytes(row);
      if (bytes > byteBudget) continue;
      selected.push(row);
      artifactBudget -= 1;
      byteBudget -= bytes;
    }
    return { rows, eligible, candidate, selected };
  }

  private readDetachedArtifactRows(): ArtifactMaintenanceRow[] {
    return this.db.prepare(`
      SELECT id, session_id, file_path, byte_count, created_at
      FROM artifacts
      WHERE session_id IS NULL
      ORDER BY created_at ASC, id ASC
    `).all() as ArtifactMaintenanceRow[];
  }

  private artifactIsAgeEligible(
    row: ArtifactMaintenanceRow,
    now: number,
    minimumAge: number,
  ): boolean {
    return row.created_at <= now && now - row.created_at >= minimumAge;
  }

  private buildArtifactMaintenanceReport(
    policy: ArtifactMaintenancePolicy,
    now: number,
    mode: ArtifactMaintenanceMode,
    plan: ArtifactMaintenancePlan,
    applied?: {
      deletedRows: ArtifactMaintenanceRow[];
      deletedMetadata: number;
      deletedMetadataBytes: number;
      deletedFiles: number;
      deletedFileBytes: number;
      errors: number;
      errorBytes: number;
    },
  ): ArtifactMaintenanceReport {
    const total = artifactEstimate(plan.rows);
    const candidate = artifactEstimate(plan.candidate);
    const eligible = artifactEstimate(plan.eligible);
    const protectedRows = plan.rows.filter((row) => !plan.eligible.includes(row));
    const selected = artifactEstimate(applied?.deletedRows ?? plan.selected);
    return {
      mode,
      dryRun: mode === "dry-run",
      now,
      policy: { ...policy },
      total,
      candidate,
      eligible,
      protected: artifactEstimate(protectedRows),
      selected,
      remaining: subtractArtifactEstimate(total, selected),
      batchLimited: plan.selected.length < plan.candidate.length,
      deletedMetadata: applied?.deletedMetadata ?? 0,
      deletedMetadataBytes: applied?.deletedMetadataBytes ?? 0,
      deletedFiles: applied?.deletedFiles ?? 0,
      deletedFileBytes: applied?.deletedFileBytes ?? 0,
      errors: applied?.errors ?? 0,
      errorBytes: applied?.errorBytes ?? 0,
    };
  }

  private applyArtifactMaintenanceRow(
    planned: ArtifactMaintenanceRow,
    policy: ArtifactMaintenancePolicy,
    now: number,
  ): ArtifactApplyOutcome {
    const fileBytes = artifactBytes(planned);
    const beforeDelete = this.checkArtifactPath(planned.file_path);
    if (beforeDelete.kind === "unsafe" || beforeDelete.kind === "error") {
      return { metadataDeleted: false, fileDeleted: false, fileBytes: 0, error: true };
    }
    let metadataDeleted = false;
    try {
      const apply = this.db.transaction(() => {
        const current = this.db.prepare(`
          SELECT id, session_id, file_path, byte_count, created_at
          FROM artifacts
          WHERE id = ?
        `).get(planned.id) as ArtifactMaintenanceRow | undefined;
        if (!current || current.session_id !== null || !this.sameMaintenanceMetadata(current, planned)) {
          return false;
        }
        if (!this.artifactIsAgeEligible(current, now, policy.minAgeMs ?? 0)) {
          return false;
        }

        const deleted = this.db.prepare(`
          DELETE FROM artifacts
          WHERE id = ? AND session_id IS NULL AND file_path = ?
            AND byte_count = ? AND created_at = ?
        `).run(current.id, current.file_path, current.byte_count, current.created_at);
        return deleted.changes === 1;
      });
      metadataDeleted = apply.immediate();
    } catch {
      // Database failures leave the file and metadata together for retry.
      return { metadataDeleted: false, fileDeleted: false, fileBytes: 0, error: true };
    }
    if (!metadataDeleted) {
      return { metadataDeleted: false, fileDeleted: false, fileBytes: 0, error: false };
    }
    if (beforeDelete.kind === "missing") {
      return { metadataDeleted: true, fileDeleted: false, fileBytes: 0, error: false };
    }

    const immediatelyBeforeUnlink = this.checkArtifactPath(planned.file_path);
    if (immediatelyBeforeUnlink.kind === "missing") {
      return { metadataDeleted: true, fileDeleted: false, fileBytes: 0, error: false };
    }
    if (immediatelyBeforeUnlink.kind !== "regular") {
      // Metadata is already gone, but an unsafe or changed path is never
      // unlinked. A later bounded orphan-file sweep may reclaim safe files.
      return { metadataDeleted: true, fileDeleted: false, fileBytes: 0, error: true };
    }
    try {
      unlinkSync(immediatelyBeforeUnlink.path);
    } catch (error) {
      if (isMissingFileError(error)) {
        return { metadataDeleted: true, fileDeleted: false, fileBytes: 0, error: false };
      }
      return { metadataDeleted: true, fileDeleted: false, fileBytes: 0, error: true };
    }
    return {
      metadataDeleted: true,
      fileDeleted: true,
      fileBytes,
      error: false,
    };
  }

  private sameMaintenanceMetadata(
    current: ArtifactMaintenanceRow,
    planned: ArtifactMaintenanceRow,
  ): boolean {
    return current.file_path === planned.file_path
      && current.byte_count === planned.byte_count
      && current.created_at === planned.created_at;
  }

  private checkArtifactPath(filePath: string): ArtifactPathCheck {
    const configuredDirectory = resolve(this.directory);
    const candidate = resolve(filePath);
    if (!strictlyContains(configuredDirectory, candidate)) return { kind: "unsafe" };

    let realDirectory: string;
    try {
      realDirectory = realpathSync(configuredDirectory);
      const directoryStats = lstatSync(realDirectory);
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) return { kind: "unsafe" };
    } catch {
      return { kind: "error" };
    }

    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(candidate);
    } catch (error) {
      return isMissingFileError(error) ? { kind: "missing" } : { kind: "error" };
    }
    if (stats.isSymbolicLink() || !stats.isFile()) return { kind: "unsafe" };

    let actual: string;
    try {
      actual = realpathSync(candidate);
    } catch {
      return { kind: "error" };
    }
    if (!strictlyContains(realDirectory, actual)) return { kind: "unsafe" };
    // Unlink the canonical path rather than the potentially symlinked lexical
    // path so a parent directory replacement cannot redirect removal.
    return { kind: "regular", path: actual };
  }
}

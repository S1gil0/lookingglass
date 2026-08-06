import { randomUUID } from "node:crypto";
import type { GlassDatabase } from "./database.js";
import {
  normalizeTaskPlan,
  parseTaskPlanSnapshotPayload,
  type TaskPlan,
  type TaskPlanSnapshot,
} from "../task-plan.js";
import type {
  ApprovalMode,
  EventKind,
  GatewayProvider,
  ReasoningEffort,
  SessionEvent,
  SessionKind,
  SessionRecord,
  Verbosity,
} from "../types.js";

interface SessionRow {
  id: string;
  workspace: string;
  provider: GatewayProvider;
  agent_provider: GatewayProvider | null;
  title: string;
  model: string;
  agent_model: string | null;
  reasoning_effort: ReasoningEffort;
  agent_reasoning_effort: ReasoningEffort | null;
  agents_enabled: number;
  verbosity: Verbosity;
  fast: number;
  approval_mode: ApprovalMode;
  show_reasoning: number;
  persistent: number;
  prompt_cache_key: string;
  last_response_id: string | null;
  session_kind: SessionKind;
  parent_session_id: string | null;
  fork_count: number;
  created_at: number;
  updated_at: number;
}

interface EventRow {
  id: number;
  session_id: string;
  sequence: number;
  kind: EventKind;
  payload_json: string;
  created_at: number;
}

export interface ContextCheckpoint {
  id: number;
  sessionId: string;
  throughSequence: number;
  compact: Record<string, unknown>;
  inputTokens: number | null;
  createdAt: number;
}

export type ToolCallState = "started" | "completed" | "denied" | "failed" | "unknown";

export interface ToolCallRecord {
  sessionId: string;
  callId: string;
  name: string;
  arguments: unknown;
  state: ToolCallState;
  output: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  executionToken: string | null;
}

interface ToolCallRow {
  session_id: string;
  call_id: string;
  name: string;
  arguments_json: string;
  state: ToolCallState;
  output_text: string | null;
  error_text: string | null;
  started_at: number;
  finished_at: number | null;
  execution_token: string | null;
}

interface OperationLeaseRow {
  owner: string;
  token: string;
  acquired_at: number;
  renewed_at: number;
  expires_at: number;
}

export interface ToolCallClaim {
  record: ToolCallRecord;
  acquired: boolean;
}

export interface NewSession {
  workspace: string;
  provider?: GatewayProvider;
  model: string;
  reasoningEffort: ReasoningEffort;
  verbosity: Verbosity;
  fast: boolean;
  approvalMode?: ApprovalMode;
  agentProvider?: GatewayProvider;
  agentModel?: string;
  agentReasoningEffort?: ReasoningEffort;
  agentsEnabled?: boolean;
  kind?: SessionKind;
  parentSessionId?: string | null;
}

export interface SessionDeletionSummary {
  events: number;
  checkpoints: number;
  toolCalls: number;
  schedules: number;
  occurrences: number;
  inboxItems: number;
  commandApprovals: number;
  retainedArtifacts: number;
}

export interface AgentSessionRetentionPolicy {
  maxAgeMs?: number;
  minAgeMs?: number;
  maxSessions?: number;
  maxLogicalBytes?: number;
  maxSessionsPerRun?: number;
  maxLogicalBytesPerRun?: number;
}

export interface AgentSessionRetentionEstimate {
  sessions: number;
  logicalBytes: number;
  rows: number;
  artifacts: number;
  artifactBytes: number;
}

export type AgentSessionRetentionMode = "dry-run" | "apply";

export interface AgentSessionRetentionReport {
  mode: AgentSessionRetentionMode;
  dryRun: boolean;
  now: number;
  policy: AgentSessionRetentionPolicy;
  total: AgentSessionRetentionEstimate;
  candidate: AgentSessionRetentionEstimate;
  eligible: AgentSessionRetentionEstimate;
  protected: AgentSessionRetentionEstimate;
  selected: AgentSessionRetentionEstimate;
  remaining: AgentSessionRetentionEstimate;
  batchLimited: boolean;
}

export interface OrphanedToolCallReconciliationReport {
  toolCallsMarkedUnknown: number;
  expiredLeasesDeleted: number;
}

export interface CommandApprovalRecord {
  signature: string;
  approvedAt: number;
}

/**
 * A lease state is deliberately limited to ownership-independent information.
 * In particular, it never contains the session id, owner, or execution token
 * that were used to inspect the row.
 */
export type OperationLeaseStateKind = "active" | "expired" | "missing" | "replaced";

export interface OperationLeaseState {
  kind: OperationLeaseStateKind;
  /** The duration represented by the observed row, when one exists. */
  leaseDurationMs: number | null;
  /** Time since the observed row was last renewed, when one exists. */
  renewalAgeMs: number | null;
  /** Positive until expiry and zero/negative after expiry, when one exists. */
  expiryOffsetMs: number | null;
}

export interface OperationLeaseCheck {
  ok: boolean;
  state: OperationLeaseState;
}

/**
 * Optional inputs for the aggregate session-storage stats snapshot.  The
 * second age name is retained as a descriptive alias for callers that want
 * to make it explicit that only started calls are considered.
 */
export interface SessionStatsSnapshotOptions {
  now?: number;
  staleToolCallAgeMs?: number;
  staleStartedToolCallAgeMs?: number;
}

export interface SessionStatsSnapshot {
  sessions: {
    total: number;
    interactive: number;
    agent: number;
    persistent: number;
  };
  events: {
    total: number;
    user: number;
    response: number;
    toolStarted: number;
    toolResult: number;
    toolDenied: number;
    error: number;
    note: number;
  };
  checkpoints: {
    total: number;
  };
  toolCalls: {
    total: number;
    started: number;
    completed: number;
    denied: number;
    failed: number;
    unknown: number;
    /** Started calls at least staleToolCallAgeMs old, regardless of lease. */
    staleStarted: number;
    /** Stale started calls without a matching live operation lease. */
    orphanedStarted: number;
    oldestStaleStartedAgeMs: number | null;
  };
  leases: {
    total: number;
    active: number;
    stale: number;
    oldestStaleAgeMs: number | null;
  };
}

export type SessionOperationalStats = SessionStatsSnapshot;
export type SessionStats = SessionStatsSnapshot;

interface RetentionSessionRow {
  id: string;
  session_kind: SessionKind;
  persistent: number;
  updated_at: number;
  events: number;
  checkpoints: number;
  tool_calls: number;
  approvals: number;
  logical_bytes: number;
  artifacts: number;
  artifact_bytes: number;
  active_lease: number;
  scheduler_jobs: number;
  active_schedule: number;
  child_sessions: number;
  uncertain_tool_calls: number;
}

interface RetentionPlan {
  rows: RetentionSessionRow[];
  candidate: RetentionSessionRow[];
  eligible: RetentionSessionRow[];
  selected: RetentionSessionRow[];
}

const RETENTION_POLICY_KEYS = new Set<keyof AgentSessionRetentionPolicy>([
  "maxAgeMs",
  "minAgeMs",
  "maxSessions",
  "maxLogicalBytes",
  "maxSessionsPerRun",
  "maxLogicalBytesPerRun",
]);

const ORPHANED_TOOL_DIAGNOSTIC = "Tool execution was orphaned before a durable result was recorded.";

/** Five minutes avoids treating a legitimately long-running tool as stale. */
export const DEFAULT_STALE_STARTED_TOOL_CALL_AGE_MS = 5 * 60 * 1000;
export const DEFAULT_STALE_TOOL_CALL_AGE_MS = DEFAULT_STALE_STARTED_TOOL_CALL_AGE_MS;

function finiteInteger(name: string, value: number, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function validateNow(now: number): void {
  finiteInteger("now", now);
}

function isPortableCheckpoint(compact: unknown): boolean {
  if (compact === null || typeof compact !== "object" || Array.isArray(compact)) return false;
  const output = (compact as Record<string, unknown>).output;
  if (!Array.isArray(output) || output.length === 0) return false;
  return output.every((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
    const message = item as Record<string, unknown>;
    if (message.type !== "message" || message.role !== "user") return false;
    const content = message.content;
    if (!Array.isArray(content) || content.length === 0) return false;
    return content.every((part) => {
      if (part === null || typeof part !== "object" || Array.isArray(part)) return false;
      const inputText = part as Record<string, unknown>;
      return inputText.type === "input_text" && typeof inputText.text === "string";
    });
  });
}

const SESSION_STATS_OPTION_KEYS = new Set<keyof SessionStatsSnapshotOptions>([
  "now",
  "staleToolCallAgeMs",
  "staleStartedToolCallAgeMs",
]);

function normalizeSessionStatsInput(
  nowOrOptions: number | SessionStatsSnapshotOptions,
  positionalStaleToolCallAgeMs: number | undefined,
): { now: number; staleToolCallAgeMs: number } {
  if (positionalStaleToolCallAgeMs !== undefined) {
    finiteInteger("staleToolCallAgeMs", positionalStaleToolCallAgeMs);
  }
  if (typeof nowOrOptions === "number") {
    validateNow(nowOrOptions);
    const staleToolCallAgeMs = positionalStaleToolCallAgeMs ?? DEFAULT_STALE_STARTED_TOOL_CALL_AGE_MS;
    finiteInteger("staleToolCallAgeMs", staleToolCallAgeMs);
    return { now: nowOrOptions, staleToolCallAgeMs };
  }
  if (nowOrOptions === null || typeof nowOrOptions !== "object" || Array.isArray(nowOrOptions)) {
    throw new Error("Session stats options must be an object or a timestamp");
  }
  for (const key of Object.keys(nowOrOptions) as Array<keyof SessionStatsSnapshotOptions>) {
    if (!SESSION_STATS_OPTION_KEYS.has(key)) throw new Error(`Unknown session stats option: ${key}`);
  }
  if (positionalStaleToolCallAgeMs !== undefined
    && (nowOrOptions.staleToolCallAgeMs !== undefined
      || nowOrOptions.staleStartedToolCallAgeMs !== undefined)) {
    throw new Error("Stale tool-call age must be supplied once");
  }
  const optionAge = nowOrOptions.staleToolCallAgeMs;
  const startedOptionAge = nowOrOptions.staleStartedToolCallAgeMs;
  if (nowOrOptions.now !== undefined) validateNow(nowOrOptions.now);
  if (optionAge !== undefined) finiteInteger("staleToolCallAgeMs", optionAge);
  if (startedOptionAge !== undefined) finiteInteger("staleToolCallAgeMs", startedOptionAge);
  if (optionAge !== undefined && startedOptionAge !== undefined && optionAge !== startedOptionAge) {
    throw new Error("Stale tool-call age options must agree");
  }
  const now = nowOrOptions.now === undefined ? Date.now() : nowOrOptions.now;
  const staleToolCallAgeMs = positionalStaleToolCallAgeMs
    ?? optionAge
    ?? startedOptionAge
    ?? DEFAULT_STALE_STARTED_TOOL_CALL_AGE_MS;
  validateNow(now);
  finiteInteger("staleToolCallAgeMs", staleToolCallAgeMs);
  return { now, staleToolCallAgeMs };
}

function validateRetentionPolicy(policy: AgentSessionRetentionPolicy): AgentSessionRetentionPolicy {
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("Agent session retention policy must be an object");
  }
  for (const key of Object.keys(policy) as Array<keyof AgentSessionRetentionPolicy>) {
    if (!RETENTION_POLICY_KEYS.has(key)) throw new Error(`Unknown retention policy field: ${key}`);
  }
  for (const key of RETENTION_POLICY_KEYS) {
    const value = policy[key];
    if (value !== undefined) finiteInteger(key, value);
  }
  return { ...policy };
}

function retentionRowIsEligible(row: RetentionSessionRow): boolean {
  return row.session_kind === "agent"
    && row.persistent === 0
    && row.active_lease === 0
    && row.scheduler_jobs === 0
    && row.active_schedule === 0
    && row.child_sessions === 0
    && row.uncertain_tool_calls === 0;
}

function retentionEstimate(rows: RetentionSessionRow[]): AgentSessionRetentionEstimate {
  let logicalBytes = 0;
  let events = 0;
  let checkpoints = 0;
  let toolCalls = 0;
  let approvals = 0;
  let artifacts = 0;
  let artifactBytes = 0;
  for (const row of rows) {
    logicalBytes += row.logical_bytes;
    events += row.events;
    checkpoints += row.checkpoints;
    toolCalls += row.tool_calls;
    approvals += row.approvals;
    artifacts += row.artifacts;
    artifactBytes += row.artifact_bytes;
  }
  return {
    sessions: rows.length,
    logicalBytes,
    rows: rows.length + events + checkpoints + toolCalls + approvals,
    artifacts,
    artifactBytes,
  };
}

function subtractRetentionEstimate(
  total: AgentSessionRetentionEstimate,
  removed: AgentSessionRetentionEstimate,
): AgentSessionRetentionEstimate {
  return {
    sessions: total.sessions - removed.sessions,
    logicalBytes: total.logicalBytes - removed.logicalBytes,
    rows: total.rows - removed.rows,
    // Session deletion detaches artifacts with ON DELETE SET NULL; it does
    // not remove either their rows or their external files.
    artifacts: total.artifacts,
    artifactBytes: total.artifactBytes,
  };
}

function sessionFromRow(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    workspace: row.workspace,
    provider: row.provider,
    agentProvider: row.agent_provider ?? row.provider,
    title: row.title,
    model: row.model,
    agentModel: row.agent_model ?? row.model,
    reasoningEffort: row.reasoning_effort,
    agentReasoningEffort: row.agent_reasoning_effort ?? row.reasoning_effort,
    agentsEnabled: row.agents_enabled === 1,
    verbosity: row.verbosity,
    fast: row.fast === 1,
    approvalMode: row.approval_mode,
    showReasoning: row.show_reasoning === 1,
    persistent: row.persistent === 1,
    promptCacheKey: row.prompt_cache_key,
    lastResponseId: row.last_response_id,
    kind: row.session_kind,
    parentSessionId: row.parent_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function eventFromRow(row: EventRow): SessionEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    sequence: row.sequence,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as unknown,
    createdAt: row.created_at,
  };
}

function toolCallFromRow(row: ToolCallRow): ToolCallRecord {
  return {
    sessionId: row.session_id,
    callId: row.call_id,
    name: row.name,
    arguments: JSON.parse(row.arguments_json) as unknown,
    state: row.state,
    output: row.output_text,
    error: row.error_text,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    executionToken: row.execution_token,
  };
}

export class SessionStore {
  constructor(private readonly db: GlassDatabase) {}

  create(input: NewSession): SessionRecord {
    const now = Date.now();
    const session: SessionRecord = {
      id: randomUUID(),
      workspace: input.workspace,
      provider: input.provider ?? "codex-lb",
      agentProvider: input.agentProvider ?? input.provider ?? "codex-lb",
      title: "New session",
      model: input.model,
      agentModel: input.agentModel ?? input.model,
      reasoningEffort: input.reasoningEffort,
      agentReasoningEffort: input.agentReasoningEffort ?? input.reasoningEffort,
      agentsEnabled: input.agentsEnabled ?? true,
      verbosity: input.verbosity,
      fast: input.fast,
      approvalMode: input.approvalMode ?? "code",
      showReasoning: false,
      persistent: false,
      promptCacheKey: randomUUID(),
      lastResponseId: null,
      kind: input.kind ?? "interactive",
      parentSessionId: input.parentSessionId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO sessions(
        id, workspace, provider, agent_provider, title, model, agent_model,
        reasoning_effort, agent_reasoning_effort, agents_enabled, verbosity, fast, approval_mode,
        prompt_cache_key, last_response_id, session_kind, parent_session_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
    `).run(
      session.id,
      session.workspace,
      session.provider,
      session.agentProvider,
      session.title,
      session.model,
      session.agentModel,
      session.reasoningEffort,
      session.agentReasoningEffort,
      session.agentsEnabled ? 1 : 0,
      session.verbosity,
      session.fast ? 1 : 0,
      session.approvalMode,
      session.promptCacheKey,
      session.kind,
      session.parentSessionId,
      now,
      now,
    );
    return session;
  }

  fork(sourceId: string): SessionRecord {
    const fork = this.db.transaction(() => {
      const sourceRow = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sourceId) as SessionRow | undefined;
      if (!sourceRow) throw new Error(`Session not found: ${sourceId}`);
      const source = sessionFromRow(sourceRow);
      if (source.kind !== "interactive") {
        throw new Error("Agent sessions cannot be forked; only interactive sessions may be forked");
      }

      const now = Date.now();
      const activeLease = this.db.prepare(`
        SELECT kind FROM session_operation_leases
        WHERE session_id = ? AND expires_at > ?
      `).get(sourceId, now) as { kind: string } | undefined;
      if (activeLease) throw new Error(`Session is busy with an active ${activeLease.kind}`);

      const forkNumber = sourceRow.fork_count + 1;
      const forkId = randomUUID();
      const suffix = `(fork ${forkNumber})`;
      const title = `${source.title.slice(0, Math.max(1, 120 - suffix.length - 1)).trimEnd()} ${suffix}`;
      this.db.prepare("UPDATE sessions SET fork_count = ?, updated_at = ? WHERE id = ?")
        .run(forkNumber, now, sourceId);
      this.db.prepare(`
        INSERT INTO sessions(
          id, workspace, provider, agent_provider, title, model, agent_model,
          reasoning_effort, agent_reasoning_effort, agents_enabled, verbosity, fast,
          approval_mode, show_reasoning, persistent, prompt_cache_key, last_response_id,
          session_kind, parent_session_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'interactive', NULL, ?, ?)
      `).run(
        forkId,
        source.workspace,
        source.provider,
        source.agentProvider,
        title,
        source.model,
        source.agentModel,
        source.reasoningEffort,
        source.agentReasoningEffort,
        source.agentsEnabled ? 1 : 0,
        source.verbosity,
        source.fast ? 1 : 0,
        source.approvalMode,
        source.showReasoning ? 1 : 0,
        source.persistent ? 1 : 0,
        randomUUID(),
        now,
        now,
      );
      this.db.prepare(`
        INSERT INTO session_events(session_id, sequence, kind, payload_json, created_at)
        SELECT ?, sequence, kind, payload_json, created_at
        FROM session_events WHERE session_id = ? ORDER BY sequence
      `).run(forkId, sourceId);
      this.db.prepare(`
        INSERT INTO context_checkpoints(
          session_id, through_sequence, compact_json, input_tokens, created_at
        )
        SELECT ?, through_sequence, compact_json, input_tokens, created_at
        FROM context_checkpoints WHERE session_id = ? ORDER BY through_sequence
      `).run(forkId, sourceId);
      this.db.prepare(`
        INSERT INTO tool_calls(
          session_id, call_id, name, arguments_json, state, output_text, error_text,
          started_at, finished_at, execution_token
        )
        SELECT ?, call_id, name, arguments_json, state, output_text, error_text,
          started_at, finished_at, NULL
        FROM tool_calls WHERE session_id = ? ORDER BY call_id
      `).run(forkId, sourceId);
      return this.require(forkId);
    });
    return fork.immediate();
  }

  get(id: string): SessionRecord | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? sessionFromRow(row) : null;
  }

  list(workspace?: string, limit = 50): SessionRecord[] {
    const rows = workspace
      ? this.db.prepare("SELECT * FROM sessions WHERE workspace = ? AND session_kind = 'interactive' ORDER BY updated_at DESC LIMIT ?").all(workspace, limit)
      : this.db.prepare("SELECT * FROM sessions WHERE session_kind = 'interactive' ORDER BY updated_at DESC LIMIT ?").all(limit);
    return (rows as SessionRow[]).map(sessionFromRow);
  }

  listWithMessages(workspace?: string, limit = 50): SessionRecord[] {
    const rows = workspace
      ? this.db.prepare(`
          SELECT s.* FROM sessions s
          WHERE s.workspace = ? AND s.session_kind = 'interactive'
            AND EXISTS (
              SELECT 1 FROM session_events e
              WHERE e.session_id = s.id AND e.kind IN ('user', 'response')
            )
          ORDER BY s.updated_at DESC LIMIT ?
        `).all(workspace, limit)
      : this.db.prepare(`
          SELECT s.* FROM sessions s
          WHERE s.session_kind = 'interactive'
            AND EXISTS (
              SELECT 1 FROM session_events e
              WHERE e.session_id = s.id AND e.kind IN ('user', 'response')
            )
          ORDER BY s.updated_at DESC LIMIT ?
        `).all(limit);
    return (rows as SessionRow[]).map(sessionFromRow);
  }

  deleteIfEmpty(id: string): boolean {
    return this.db.prepare(`
      DELETE FROM sessions
      WHERE id = ? AND session_kind = 'interactive'
        AND NOT EXISTS (SELECT 1 FROM session_events WHERE session_id = sessions.id)
        AND NOT EXISTS (SELECT 1 FROM sessions child WHERE child.parent_session_id = sessions.id)
        AND NOT EXISTS (SELECT 1 FROM scheduler_jobs WHERE session_id = sessions.id)
        AND NOT EXISTS (SELECT 1 FROM session_operation_leases WHERE session_id = sessions.id)
    `).run(id).changes === 1;
  }

  updateSettings(
    id: string,
    changes: Partial<Pick<
      SessionRecord,
      "provider" | "model" | "reasoningEffort" | "agentProvider" | "agentModel" | "agentReasoningEffort"
      | "agentsEnabled" | "verbosity" | "fast" | "approvalMode" | "showReasoning" | "persistent"
    >>,
  ): SessionRecord {
    const update = this.db.transaction(() => {
      const now = Date.now();
      const lease = this.db.prepare(
        "SELECT 1 FROM session_operation_leases WHERE session_id = ? AND expires_at > ?",
      ).get(id, now);
      if (lease) throw new Error("Session is busy with another operation");
      const current = this.require(id);
      const resetContinuity = changes.model !== undefined || changes.provider !== undefined;
      const next = {
        ...current,
        ...changes,
        promptCacheKey: resetContinuity ? randomUUID() : current.promptCacheKey,
        lastResponseId: resetContinuity ? null : current.lastResponseId,
      };
      this.db.prepare(`
        UPDATE sessions
        SET provider = ?, model = ?, reasoning_effort = ?,
            agent_provider = ?, agent_model = ?, agent_reasoning_effort = ?, agents_enabled = ?, verbosity = ?, fast = ?,
            approval_mode = ?, show_reasoning = ?, persistent = ?,
            prompt_cache_key = ?, last_response_id = ?, updated_at = ?
        WHERE id = ?
      `).run(
        next.provider,
        next.model,
        next.reasoningEffort,
        next.agentProvider,
        next.agentModel,
        next.agentReasoningEffort,
        next.agentsEnabled ? 1 : 0,
        next.verbosity,
        next.fast ? 1 : 0,
        next.approvalMode,
        next.showReasoning ? 1 : 0,
        next.persistent ? 1 : 0,
        next.promptCacheKey,
        next.lastResponseId,
        now,
        id,
      );
      if (changes.provider !== undefined && changes.provider !== current.provider) {
        const checkpoints = this.db.prepare(`
          SELECT id, compact_json FROM context_checkpoints
          WHERE session_id = ?
          ORDER BY through_sequence DESC
        `).all(id) as Array<{ id: number; compact_json: string }>;
        let portableCheckpointId: number | null = null;
        for (const checkpoint of checkpoints) {
          try {
            if (isPortableCheckpoint(JSON.parse(checkpoint.compact_json) as unknown)) {
              portableCheckpointId = checkpoint.id;
              break;
            }
          } catch {
            // Skip malformed checkpoints and continue to an older portable one.
          }
        }
        if (portableCheckpointId !== null) {
          this.db.prepare("DELETE FROM context_checkpoints WHERE session_id = ? AND id <> ?")
            .run(id, portableCheckpointId);
        } else {
          this.db.prepare("DELETE FROM context_checkpoints WHERE session_id = ?").run(id);
        }
      }
      return this.require(id);
    });
    return update.immediate();
  }

  setLastResponseId(id: string, responseId: string | null): void {
    this.db.prepare("UPDATE sessions SET last_response_id = ?, updated_at = ? WHERE id = ?")
      .run(responseId, Date.now(), id);
  }

  resetContinuity(id: string): SessionRecord {
    this.db.prepare(`
      UPDATE sessions
      SET prompt_cache_key = ?, last_response_id = NULL, updated_at = ?
      WHERE id = ?
    `).run(randomUUID(), Date.now(), id);
    return this.require(id);
  }

  setTitleFromPrompt(id: string, prompt: string): void {
    const current = this.require(id);
    if (current.title !== "New session") return;
    const title = prompt.replace(/\s+/g, " ").trim().slice(0, 72) || "New session";
    this.db.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(title, Date.now(), id);
  }

  rename(id: string, title: string): SessionRecord {
    const normalized = title.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!normalized) throw new Error("Session title must not be empty");
    this.db.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
      .run(normalized, Date.now(), id);
    return this.require(id);
  }

  hasCommandApproval(sessionId: string, signature: string): boolean {
    if (!signature) return false;
    return Boolean(this.db.prepare(`
      SELECT 1 FROM session_command_approvals WHERE session_id = ? AND signature = ?
    `).get(sessionId, signature));
  }

  registerCommandApproval(sessionId: string, signature: string, now = Date.now()): boolean {
    if (!signature) throw new Error("Command approval signature must not be empty");
    this.require(sessionId);
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO session_command_approvals(session_id, signature, approved_at)
      VALUES (?, ?, ?)
    `).run(sessionId, signature, now);
    return result.changes === 1;
  }

  listCommandApprovals(sessionId: string): CommandApprovalRecord[] {
    this.require(sessionId);
    const rows = this.db.prepare(`
      SELECT signature, approved_at FROM session_command_approvals
      WHERE session_id = ? ORDER BY approved_at DESC
    `).all(sessionId) as { signature: string; approved_at: number }[];
    return rows.map((row) => ({ signature: row.signature, approvedAt: row.approved_at }));
  }

  revokeCommandApproval(sessionId: string, signature: string): boolean {
    return this.db.prepare(`
      DELETE FROM session_command_approvals WHERE session_id = ? AND signature = ?
    `).run(sessionId, signature).changes === 1;
  }

  deletionSummary(id: string): SessionDeletionSummary {
    this.require(id);
    return this.readDeletionSummary(id);
  }

  delete(id: string, expected?: SessionDeletionSummary): SessionDeletionSummary {
    const remove = this.db.transaction(() => {
      this.require(id);
      const now = Date.now();
      const activeLease = this.db.prepare(`
        WITH RECURSIVE targets(id) AS (
          SELECT ? UNION ALL
          SELECT s.id FROM sessions s JOIN targets t ON s.parent_session_id = t.id
        )
        SELECT kind FROM session_operation_leases
        WHERE session_id IN (SELECT id FROM targets) AND expires_at > ?
      `).get(id, now) as { kind: string } | undefined;
      if (activeLease) throw new Error(`Session is busy with an active ${activeLease.kind}`);
      const activeSchedule = this.db.prepare(`
        WITH RECURSIVE targets(id) AS (
          SELECT ? UNION ALL
          SELECT s.id FROM sessions s JOIN targets t ON s.parent_session_id = t.id
        )
        SELECT o.state FROM scheduler_occurrences o
        JOIN scheduler_jobs j ON j.id = o.job_id
        WHERE j.session_id IN (SELECT id FROM targets) AND o.state IN ('claimed', 'running')
        LIMIT 1
      `).get(id) as { state: string } | undefined;
      if (activeSchedule) throw new Error(`Session has ${activeSchedule.state} scheduled work`);

      const summary = this.readDeletionSummary(id);
      if (expected && JSON.stringify(summary) !== JSON.stringify(expected)) {
        throw new Error("Session changed after deletion was confirmed; review it again");
      }
      this.db.prepare(`
        WITH RECURSIVE targets(id) AS (
          SELECT ? UNION ALL
          SELECT s.id FROM sessions s JOIN targets t ON s.parent_session_id = t.id
        )
        DELETE FROM scheduler_inbox
        WHERE job_id IN (SELECT id FROM scheduler_jobs WHERE session_id IN (SELECT id FROM targets))
      `).run(id);
      this.db.prepare(`
        WITH RECURSIVE targets(id) AS (
          SELECT ? UNION ALL
          SELECT s.id FROM sessions s JOIN targets t ON s.parent_session_id = t.id
        )
        DELETE FROM scheduler_occurrences
        WHERE job_id IN (SELECT id FROM scheduler_jobs WHERE session_id IN (SELECT id FROM targets))
      `).run(id);
      this.db.prepare(`
        WITH RECURSIVE targets(id) AS (
          SELECT ? UNION ALL
          SELECT s.id FROM sessions s JOIN targets t ON s.parent_session_id = t.id
        )
        DELETE FROM scheduler_jobs WHERE session_id IN (SELECT id FROM targets)
      `).run(id);
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      return summary;
    });
    return remove.immediate();
  }

  planAgentSessionRetention(
    policy: AgentSessionRetentionPolicy,
    now = Date.now(),
  ): AgentSessionRetentionReport {
    const checkedPolicy = validateRetentionPolicy(policy);
    validateNow(now);
    return this.buildAgentSessionRetentionReport(checkedPolicy, now, "dry-run");
  }

  previewAgentSessionRetention(
    policy: AgentSessionRetentionPolicy,
    now = Date.now(),
  ): AgentSessionRetentionReport {
    return this.planAgentSessionRetention(policy, now);
  }

  applyAgentSessionRetention(
    policy: AgentSessionRetentionPolicy,
    now = Date.now(),
  ): AgentSessionRetentionReport {
    const checkedPolicy = validateRetentionPolicy(policy);
    validateNow(now);
    // Keep the expensive byte-accounting scan outside the writer transaction.
    // The short transaction below revalidates every candidate before deletion.
    const plan = this.buildAgentSessionRetentionPlan(checkedPolicy, now);
    const apply = this.db.transaction(() => {
      const removed: RetentionSessionRow[] = [];
      for (const row of plan.selected) {
        // Recheck mutability and every protection predicate under BEGIN
        // IMMEDIATE. Artifacts detach through their existing foreign key.
        const result = this.db.prepare(`
          DELETE FROM sessions
          WHERE id = ? AND session_kind = 'agent' AND persistent = 0 AND updated_at = ?
            AND NOT EXISTS (
              WITH RECURSIVE ancestors(id) AS (
                SELECT id FROM sessions WHERE id = ?
                UNION ALL
                SELECT current.parent_session_id FROM sessions current
                JOIN ancestors child ON current.id = child.id
                WHERE current.parent_session_id IS NOT NULL
              )
              SELECT 1 FROM session_operation_leases lease
              JOIN ancestors ON ancestors.id = lease.session_id
              WHERE lease.expires_at > ?
            )
            AND NOT EXISTS (SELECT 1 FROM sessions child WHERE child.parent_session_id = sessions.id)
            AND NOT EXISTS (SELECT 1 FROM scheduler_jobs job WHERE job.session_id = sessions.id)
            AND NOT EXISTS (
              SELECT 1 FROM tool_calls call
              WHERE call.session_id = sessions.id AND call.state IN ('started', 'unknown')
            )
        `).run(row.id, row.updated_at, row.id, now);
        if (result.changes === 1) removed.push(row);
      }
      return this.buildAgentSessionRetentionReportFromPlan(
        checkedPolicy,
        now,
        "apply",
        { ...plan, selected: removed },
      );
    });
    return apply.immediate();
  }

  agentSessionRetention(
    policy: AgentSessionRetentionPolicy,
    mode: AgentSessionRetentionMode = "dry-run",
    now = Date.now(),
  ): AgentSessionRetentionReport {
    if (mode === "dry-run") return this.planAgentSessionRetention(policy, now);
    if (mode === "apply") return this.applyAgentSessionRetention(policy, now);
    throw new Error("Retention mode must be dry-run or apply");
  }

  pruneAgentSessions(
    policy: AgentSessionRetentionPolicy,
    now = Date.now(),
  ): AgentSessionRetentionReport {
    return this.applyAgentSessionRetention(policy, now);
  }

  appendEvent<T>(sessionId: string, kind: EventKind, payload: T): SessionEvent<T> {
    const append = this.db.transaction(() => {
      return this.appendEventRow(sessionId, kind, payload, Date.now());
    });
    return append.immediate();
  }

  appendResponseAndSetContinuity<T>(sessionId: string, payload: T, responseId: string): SessionEvent<T> {
    const append = this.db.transaction(() => {
      const now = Date.now();
      const event = this.appendEventRow(sessionId, "response", payload, now);
      this.db.prepare("UPDATE sessions SET last_response_id = ?, updated_at = ? WHERE id = ?")
        .run(responseId, now, sessionId);
      return event;
    });
    return append.immediate();
  }

  appendResponseAndSetContinuityFenced<T>(
    sessionId: string,
    executionToken: string,
    payload: T,
    responseId: string,
  ): SessionEvent<T> | null {
    const append = this.db.transaction(() => {
      const now = Date.now();
      if (!this.hasOperationLeaseRow(sessionId, executionToken, now)) return null;
      const event = this.appendEventRow(sessionId, "response", payload, now);
      this.db.prepare("UPDATE sessions SET last_response_id = ?, updated_at = ? WHERE id = ?")
        .run(responseId, now, sessionId);
      return event;
    });
    return append.immediate();
  }

  appendUserAndSetTitle<T>(sessionId: string, prompt: string, payload: T): SessionEvent<T> {
    const append = this.db.transaction(() => {
      const now = Date.now();
      const current = this.require(sessionId);
      if (current.title === "New session") {
        const title = prompt.replace(/\s+/g, " ").trim().slice(0, 72) || "New session";
        this.db.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
          .run(title, now, sessionId);
      }
      return this.appendEventRow(sessionId, "user", payload, now);
    });
    return append.immediate();
  }

  appendUserAndSetTitleFenced<T>(
    sessionId: string,
    executionToken: string,
    prompt: string,
    payload: T,
  ): SessionEvent<T> | null {
    const append = this.db.transaction(() => {
      const now = Date.now();
      if (!this.hasOperationLeaseRow(sessionId, executionToken, now)) return null;
      const current = this.require(sessionId);
      if (current.title === "New session") {
        const title = prompt.replace(/\s+/g, " ").trim().slice(0, 72) || "New session";
        this.db.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
          .run(title, now, sessionId);
      }
      return this.appendEventRow(sessionId, "user", payload, now);
    });
    return append.immediate();
  }

  appendEventFenced<T>(
    sessionId: string,
    executionToken: string,
    kind: EventKind,
    payload: T,
  ): SessionEvent<T> | null {
    const append = this.db.transaction(() => {
      const now = Date.now();
      if (!this.hasOperationLeaseRow(sessionId, executionToken, now)) return null;
      return this.appendEventRow(sessionId, kind, payload, now);
    });
    return append.immediate();
  }

  events(sessionId: string, afterSequence = 0): SessionEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM session_events
      WHERE session_id = ? AND sequence > ?
      ORDER BY sequence ASC
    `).all(sessionId, afterSequence) as EventRow[];
    return rows.map(eventFromRow);
  }

  recentEvents(sessionId: string, limit: number): SessionEvent[] {
    const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
    if (boundedLimit === 0) return [];
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM session_events
        WHERE session_id = ?
        ORDER BY sequence DESC
        LIMIT ?
      )
      ORDER BY sequence ASC
    `).all(sessionId, boundedLimit) as EventRow[];
    return rows.map(eventFromRow);
  }

  eventCount(sessionId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?",
    ).get(sessionId) as { count: number };
    return row.count;
  }

  latestResponseUsage(sessionId: string): { sequence: number; inputTokens: number } | null {
    const row = this.db.prepare(`
      SELECT sequence, json_extract(payload_json, '$.response.usage.input_tokens') AS input_tokens
      FROM session_events
      WHERE session_id = ? AND kind = 'response'
        AND json_type(payload_json, '$.response.usage.input_tokens') IN ('integer', 'real')
      ORDER BY sequence DESC LIMIT 1
    `).get(sessionId) as { sequence: number; input_tokens: number } | undefined;
    return row ? { sequence: row.sequence, inputTokens: row.input_tokens } : null;
  }

  semanticEventCount(sessionId: string, afterSequence = 0): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM session_events
      WHERE session_id = ? AND sequence > ?
        AND kind IN ('user', 'response', 'tool_result', 'tool_denied')
    `).get(sessionId, afterSequence) as { count: number };
    return row.count;
  }

  latestSequence(sessionId: string): number {
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM session_events WHERE session_id = ?",
    ).get(sessionId) as { sequence: number };
    return row.sequence;
  }

  latestTaskPlan(sessionId: string): TaskPlanSnapshot | null {
    const rows = this.db.prepare(`
      SELECT sequence, payload_json, created_at
      FROM session_events
      WHERE session_id = ? AND kind = 'note'
      ORDER BY sequence DESC
    `).all(sessionId) as Array<Pick<EventRow, "sequence" | "payload_json" | "created_at">>;

    for (const row of rows) {
      let rawPayload: unknown;
      try {
        rawPayload = JSON.parse(row.payload_json) as unknown;
      } catch {
        continue;
      }
      const payload = parseTaskPlanSnapshotPayload(rawPayload);
      if (payload) return { plan: payload.plan, sequence: row.sequence, createdAt: row.created_at };
    }
    return null;
  }

  saveTaskPlan(sessionId: string, executionToken: string, plan: TaskPlan): TaskPlanSnapshot | null {
    const normalizedPlan = normalizeTaskPlan(plan);
    const save = this.db.transaction(() => {
      const now = Date.now();
      if (!this.hasOperationLeaseRow(sessionId, executionToken, now)) return null;
      const session = this.require(sessionId);
      if (session.kind === "agent") throw new Error("Task plans can only be saved in the main session");
      const event = this.appendEventRow(sessionId, "note", {
        type: "task_plan",
        version: 1,
        plan: normalizedPlan,
      }, now);
      return { plan: normalizedPlan, sequence: event.sequence, createdAt: event.createdAt };
    });
    return save.immediate();
  }

  saveCheckpoint(
    sessionId: string,
    throughSequence: number,
    compact: Record<string, unknown>,
    inputTokens: number | null,
  ): ContextCheckpoint {
    const createdAt = Date.now();
    const result = this.db.prepare(`
      INSERT INTO context_checkpoints(
        session_id, through_sequence, compact_json, input_tokens, created_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, through_sequence) DO UPDATE SET
        compact_json = excluded.compact_json,
        input_tokens = excluded.input_tokens,
        created_at = excluded.created_at
      RETURNING id
    `).get(sessionId, throughSequence, JSON.stringify(compact), inputTokens, createdAt) as { id: number };
    return { id: result.id, sessionId, throughSequence, compact, inputTokens, createdAt };
  }

  saveCheckpointAndResetContinuity(
    sessionId: string,
    throughSequence: number,
    compact: Record<string, unknown>,
    inputTokens: number | null,
  ): ContextCheckpoint {
    const save = this.db.transaction(() => {
      const createdAt = Date.now();
      const result = this.db.prepare(`
        INSERT INTO context_checkpoints(
          session_id, through_sequence, compact_json, input_tokens, created_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id, through_sequence) DO UPDATE SET
          compact_json = excluded.compact_json,
          input_tokens = excluded.input_tokens,
          created_at = excluded.created_at
        RETURNING id
      `).get(sessionId, throughSequence, JSON.stringify(compact), inputTokens, createdAt) as { id: number };
      this.db.prepare("UPDATE sessions SET last_response_id = NULL, updated_at = ? WHERE id = ?")
        .run(createdAt, sessionId);
      return { id: result.id, sessionId, throughSequence, compact, inputTokens, createdAt };
    });
    return save.immediate();
  }

  saveCheckpointAndResetContinuityFenced(
    sessionId: string,
    executionToken: string,
    throughSequence: number,
    compact: Record<string, unknown>,
    inputTokens: number | null,
  ): ContextCheckpoint | null {
    const save = this.db.transaction(() => {
      const createdAt = Date.now();
      if (!this.hasOperationLeaseRow(sessionId, executionToken, createdAt)) return null;
      const result = this.db.prepare(`
        INSERT INTO context_checkpoints(
          session_id, through_sequence, compact_json, input_tokens, created_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id, through_sequence) DO UPDATE SET
          compact_json = excluded.compact_json,
          input_tokens = excluded.input_tokens,
          created_at = excluded.created_at
        RETURNING id
      `).get(sessionId, throughSequence, JSON.stringify(compact), inputTokens, createdAt) as { id: number };
      this.db.prepare("UPDATE sessions SET last_response_id = NULL, updated_at = ? WHERE id = ?")
        .run(createdAt, sessionId);
      return { id: result.id, sessionId, throughSequence, compact, inputTokens, createdAt };
    });
    return save.immediate();
  }

  latestCheckpoint(sessionId: string): ContextCheckpoint | null {
    const row = this.db.prepare(`
      SELECT * FROM context_checkpoints
      WHERE session_id = ?
      ORDER BY through_sequence DESC
      LIMIT 1
    `).get(sessionId) as {
      id: number;
      session_id: string;
      through_sequence: number;
      compact_json: string;
      input_tokens: number | null;
      created_at: number;
    } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      throughSequence: row.through_sequence,
      compact: JSON.parse(row.compact_json) as Record<string, unknown>,
      inputTokens: row.input_tokens,
      createdAt: row.created_at,
    };
  }

  beginToolCall(
    sessionId: string,
    callId: string,
    name: string,
    args: unknown,
    executionToken: string,
  ): ToolCallClaim {
    const begin = this.db.transaction(() => {
      const now = Date.now();
      if (!this.hasOperationLeaseRow(sessionId, executionToken, now)) {
        throw new Error("Session operation lease was lost before tool claim");
      }
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO tool_calls(
          session_id, call_id, name, arguments_json, state, started_at, execution_token
        ) VALUES (?, ?, ?, ?, 'started', ?, ?)
      `).run(sessionId, callId, name, JSON.stringify(args), now, executionToken);
      if (result.changes === 1) {
        this.appendEventRow(sessionId, "tool_started", { callId, name, arguments: args }, now);
      }
      return { record: this.requireToolCall(sessionId, callId), acquired: result.changes === 1 };
    });
    return begin.immediate();
  }

  finishToolCall(
    sessionId: string,
    callId: string,
    state: Extract<ToolCallState, "completed" | "denied" | "failed">,
    output: string | null,
    error: string | null,
  ): ToolCallRecord {
    this.db.prepare(`
      UPDATE tool_calls
      SET state = ?, output_text = ?, error_text = ?, finished_at = ?
      WHERE session_id = ? AND call_id = ?
    `).run(state, output, error, Date.now(), sessionId, callId);
    return this.requireToolCall(sessionId, callId);
  }

  finishToolCallWithEvent<T>(
    sessionId: string,
    callId: string,
    executionToken: string,
    state: Extract<ToolCallState, "completed" | "denied" | "failed">,
    output: string,
    error: string | null,
    kind: Extract<EventKind, "tool_result" | "tool_denied">,
    payload: T,
  ): ToolCallRecord {
    const finish = this.db.transaction(() => {
      const now = Date.now();
      if (!this.hasOperationLeaseRow(sessionId, executionToken, now)) {
        throw new Error("Session operation lease was lost before tool completion");
      }
      const result = this.db.prepare(`
        UPDATE tool_calls
        SET state = ?, output_text = ?, error_text = ?, finished_at = ?
        WHERE session_id = ? AND call_id = ? AND state = 'started' AND execution_token = ?
      `).run(state, output, error, now, sessionId, callId, executionToken);
      if (result.changes !== 1) throw new Error(`Tool call ownership was lost: ${callId}`);
      this.appendEventRow(sessionId, kind, payload, now);
      return this.requireToolCall(sessionId, callId);
    });
    return finish.immediate();
  }

  markToolCallUnknownWithEvent<T>(
    sessionId: string,
    callId: string,
    executionToken: string,
    payload: T,
  ): ToolCallRecord {
    const mark = this.db.transaction(() => {
      const now = Date.now();
      if (!this.hasOperationLeaseRow(sessionId, executionToken, now)) {
        throw new Error("Session operation lease was lost before recording an uncertain tool");
      }
      const message = "Tool execution was interrupted; its side effects may have occurred.";
      const result = this.db.prepare(`
        UPDATE tool_calls
        SET state = 'unknown', output_text = ?, error_text = ?, finished_at = ?
        WHERE session_id = ? AND call_id = ? AND state = 'started' AND execution_token = ?
      `).run(message, message, now, sessionId, callId, executionToken);
      if (result.changes !== 1) throw new Error(`Tool call ownership was lost: ${callId}`);
      this.appendEventRow(sessionId, "tool_denied", payload, now);
      return this.requireToolCall(sessionId, callId);
    });
    return mark.immediate();
  }

  resetUnknownToolCall(sessionId: string, callId: string, executionToken: string): ToolCallClaim {
    const reset = this.db.transaction(() => {
      const now = Date.now();
      if (!this.hasOperationLeaseRow(sessionId, executionToken, now)) {
        throw new Error("Session operation lease was lost before retrying an uncertain tool");
      }
      const result = this.db.prepare(`
        UPDATE tool_calls
        SET state = 'started', output_text = NULL, error_text = NULL,
            started_at = ?, finished_at = NULL, execution_token = ?
        WHERE session_id = ? AND call_id = ? AND state = 'unknown'
      `).run(now, executionToken, sessionId, callId);
      return { record: this.requireToolCall(sessionId, callId), acquired: result.changes === 1 };
    });
    return reset.immediate();
  }

  markInterruptedToolCallsUnknown(): number {
    const result = this.db.prepare(`
      UPDATE tool_calls
      SET state = 'unknown', error_text = 'Looking Glass stopped before recording the tool result', finished_at = ?
      WHERE state = 'started'
    `).run(Date.now());
    return result.changes;
  }

  acquireOperationLease(
    sessionId: string,
    owner: string,
    token: string,
    kind: "turn" | "compact",
    now = Date.now(),
    leaseMs = 30_000,
  ): boolean {
    const acquire = this.db.transaction(() => {
      const current = this.db.prepare(
        "SELECT token, expires_at FROM session_operation_leases WHERE session_id = ?",
      ).get(sessionId) as { token: string; expires_at: number } | undefined;
      if (current && current.expires_at > now) return false;
      this.db.prepare(`
        UPDATE tool_calls
        SET state = 'unknown', output_text = COALESCE(output_text, ?),
            error_text = COALESCE(error_text, ?), finished_at = ?
        WHERE session_id = ? AND state = 'started'
      `).run(
        "Previous Looking Glass process stopped before recording the tool result.",
        "Previous Looking Glass process stopped before recording the tool result.",
        now,
        sessionId,
      );
      this.db.prepare(`
        INSERT INTO session_operation_leases(
          session_id, owner, token, kind, acquired_at, renewed_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          owner = excluded.owner, token = excluded.token, kind = excluded.kind,
          acquired_at = excluded.acquired_at, renewed_at = excluded.renewed_at,
          expires_at = excluded.expires_at
      `).run(sessionId, owner, token, kind, now, now, now + leaseMs);
      return true;
    });
    return acquire.immediate();
  }

  /**
   * Keep the successful heartbeat path to one conditional write. If it
   * fails, inspect the current row only to produce a safe best-effort
   * diagnosis; the failed renewal remains fenced regardless of classification.
   */
  renewOperationLeaseChecked(
    sessionId: string,
    owner: string,
    token: string,
    now = Date.now(),
    leaseMs = 30_000,
  ): OperationLeaseCheck {
    const result = this.db.prepare(`
      UPDATE session_operation_leases SET renewed_at = ?, expires_at = ?
      WHERE session_id = ? AND owner = ? AND token = ? AND expires_at > ?
    `).run(now, now + leaseMs, sessionId, owner, token, now);
    if (result.changes === 1) {
      return {
        ok: true,
        state: {
          kind: "active",
          leaseDurationMs: leaseMs,
          renewalAgeMs: 0,
          expiryOffsetMs: leaseMs,
        },
      };
    }
    return { ok: false, state: this.readOperationLeaseState(sessionId, owner, token, now) };
  }

  renewOperationLease(sessionId: string, owner: string, token: string, now = Date.now(), leaseMs = 30_000): boolean {
    return this.renewOperationLeaseChecked(sessionId, owner, token, now, leaseMs).ok;
  }

  /** Check ownership and expiry while retaining a safe diagnosis on failure. */
  assertOperationLeaseChecked(
    sessionId: string,
    owner: string,
    token: string,
    now = Date.now(),
  ): OperationLeaseCheck {
    const state = this.readOperationLeaseState(sessionId, owner, token, now);
    return { ok: state.kind === "active", state };
  }

  assertOperationLease(sessionId: string, owner: string, token: string, now = Date.now()): boolean {
    return this.assertOperationLeaseChecked(sessionId, owner, token, now).ok;
  }

  /** Check a fencing token without exposing the corresponding owner. */
  assertOperationTokenChecked(sessionId: string, token: string, now = Date.now()): OperationLeaseCheck {
    const state = this.readOperationLeaseState(sessionId, undefined, token, now);
    return { ok: state.kind === "active", state };
  }

  assertOperationToken(sessionId: string, token: string, now = Date.now()): boolean {
    return this.assertOperationTokenChecked(sessionId, token, now).ok;
  }

  /**
   * Inspect the current row using the expected ownership, returning only
   * timing and classification data.  This is useful for diagnostics after a
   * failed renewal or final assertion; it is not a way to bypass fencing.
   */
  inspectOperationLease(
    sessionId: string,
    owner: string,
    token: string,
    now = Date.now(),
  ): OperationLeaseState {
    return this.readOperationLeaseState(sessionId, owner, token, now);
  }

  releaseOperationLease(sessionId: string, owner: string, token: string): boolean {
    return this.db.prepare(`
      DELETE FROM session_operation_leases WHERE session_id = ? AND owner = ? AND token = ?
    `).run(sessionId, owner, token).changes === 1;
  }

  reconcileOrphanedToolCalls(now = Date.now()): OrphanedToolCallReconciliationReport {
    validateNow(now);
    const reconcile = this.db.transaction(() => {
      const marked = this.db.prepare(`
        UPDATE tool_calls
        SET state = 'unknown', output_text = NULL, error_text = ?, finished_at = ?
        WHERE state = 'started'
          AND NOT EXISTS (
            SELECT 1 FROM session_operation_leases l
            WHERE l.session_id = tool_calls.session_id
              AND l.token = tool_calls.execution_token
              AND l.expires_at > ?
          )
      `).run(ORPHANED_TOOL_DIAGNOSTIC, now, now);
      const deleted = this.db.prepare(
        "DELETE FROM session_operation_leases WHERE expires_at <= ?",
      ).run(now);
      return {
        toolCallsMarkedUnknown: marked.changes,
        expiredLeasesDeleted: deleted.changes,
      };
    });
    return reconcile.immediate();
  }

  reconcileToolCallEvents(sessionId: string, executionToken: string): number {
    const reconcile = this.db.transaction(() => {
      const now = Date.now();
      if (!this.hasOperationLeaseRow(sessionId, executionToken, now)) {
        throw new Error("Session operation lease was lost during tool reconciliation");
      }
      const responses = this.db.prepare(`
        SELECT payload_json FROM session_events WHERE session_id = ? AND kind = 'response'
      `).all(sessionId) as { payload_json: string }[];
      for (const row of responses) {
        const payload = JSON.parse(row.payload_json) as { response?: { output?: unknown[] } };
        for (const value of payload.response?.output ?? []) {
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          const item = value as Record<string, unknown>;
          if (item.type !== "function_call" || typeof item.call_id !== "string" || typeof item.name !== "string") continue;
          const rawArguments = typeof item.arguments === "string" ? item.arguments : "{}";
          let args: unknown;
          try {
            args = JSON.parse(rawArguments) as unknown;
          } catch {
            args = { raw_arguments: rawArguments };
          }
          this.db.prepare(`
            INSERT OR IGNORE INTO tool_calls(
              session_id, call_id, name, arguments_json, state, output_text,
              error_text, started_at, finished_at, execution_token
            ) VALUES (?, ?, ?, ?, 'unknown', ?, ?, ?, ?, NULL)
          `).run(
            sessionId,
            item.call_id,
            item.name,
            JSON.stringify(args),
            "No durable tool result was recorded.",
            "No durable tool result was recorded.",
            now,
            now,
          );
        }
      }

      const missing = this.db.prepare(`
        SELECT tc.* FROM tool_calls tc
        WHERE tc.session_id = ? AND tc.state <> 'started' AND tc.call_id NOT IN (
          SELECT json_extract(e.payload_json, '$.callId')
          FROM session_events e
          WHERE e.session_id = ? AND e.kind IN ('tool_result', 'tool_denied')
            AND json_extract(e.payload_json, '$.callId') IS NOT NULL
        )
      `).all(sessionId, sessionId) as ToolCallRow[];
      for (const row of missing) {
        const call = toolCallFromRow(row);
        const output = call.output ?? call.error ?? "Tool result is unavailable.";
        const payload = {
          name: call.name,
          callId: call.callId,
          item: { type: "function_call_output", call_id: call.callId, output },
          output,
        };
        this.appendEventRow(sessionId, call.state === "completed" ? "tool_result" : "tool_denied", payload, now);
      }
      return missing.length;
    });
    return reconcile.immediate();
  }

  hasUnanchoredContext(sessionId: string): boolean {
    const latestResponse = this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM session_events WHERE session_id = ? AND kind = 'response'
    `).get(sessionId) as { sequence: number };
    return Boolean(this.db.prepare(`
      SELECT 1 FROM session_events
      WHERE session_id = ? AND sequence > ? AND kind IN ('user', 'tool_result', 'tool_denied')
      LIMIT 1
    `).get(sessionId, latestResponse.sequence));
  }

  resetContinuityFenced(sessionId: string, executionToken: string): SessionRecord | null {
    const reset = this.db.transaction(() => {
      const now = Date.now();
      if (!this.hasOperationLeaseRow(sessionId, executionToken, now)) return null;
      this.db.prepare(`
        UPDATE sessions
        SET prompt_cache_key = ?, last_response_id = NULL, updated_at = ?
        WHERE id = ?
      `).run(randomUUID(), now, sessionId);
      return this.require(sessionId);
    });
    return reset.immediate();
  }

  getToolCall(sessionId: string, callId: string): ToolCallRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM tool_calls WHERE session_id = ? AND call_id = ?",
    ).get(sessionId, callId) as ToolCallRow | undefined;
    return row ? toolCallFromRow(row) : null;
  }

  /**
   * Return an aggregate-only session storage snapshot.  The queries below
   * intentionally select no identifiers or payload columns; the tool-call
   * lease check is used only to classify stale rows and is never returned.
   */
  getStats(
    nowOrOptions: number | SessionStatsSnapshotOptions = Date.now(),
    positionalStaleToolCallAgeMs?: number,
  ): SessionStatsSnapshot {
    const { now, staleToolCallAgeMs } = normalizeSessionStatsInput(
      nowOrOptions,
      positionalStaleToolCallAgeMs,
    );
    const sessions = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN session_kind = 'interactive' THEN 1 ELSE 0 END), 0) AS interactive,
        COALESCE(SUM(CASE WHEN session_kind = 'agent' THEN 1 ELSE 0 END), 0) AS agent,
        COALESCE(SUM(CASE WHEN persistent = 1 THEN 1 ELSE 0 END), 0) AS persistent
      FROM sessions
    `).get() as {
      total: number;
      interactive: number;
      agent: number;
      persistent: number;
    };
    const events = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN kind = 'user' THEN 1 ELSE 0 END), 0) AS user,
        COALESCE(SUM(CASE WHEN kind = 'response' THEN 1 ELSE 0 END), 0) AS response,
        COALESCE(SUM(CASE WHEN kind = 'tool_started' THEN 1 ELSE 0 END), 0) AS tool_started,
        COALESCE(SUM(CASE WHEN kind = 'tool_result' THEN 1 ELSE 0 END), 0) AS tool_result,
        COALESCE(SUM(CASE WHEN kind = 'tool_denied' THEN 1 ELSE 0 END), 0) AS tool_denied,
        COALESCE(SUM(CASE WHEN kind = 'error' THEN 1 ELSE 0 END), 0) AS error,
        COALESCE(SUM(CASE WHEN kind = 'note' THEN 1 ELSE 0 END), 0) AS note
      FROM session_events
    `).get() as {
      total: number;
      user: number;
      response: number;
      tool_started: number;
      tool_result: number;
      tool_denied: number;
      error: number;
      note: number;
    };
    const checkpoints = this.db.prepare(
      "SELECT COUNT(*) AS total FROM context_checkpoints",
    ).get() as { total: number };
    const toolCalls = this.db.prepare(`
      WITH parameters(snapshot_now, stale_age_ms) AS (VALUES (?, ?))
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN state = 'started' THEN 1 ELSE 0 END), 0) AS started,
        COALESCE(SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
        COALESCE(SUM(CASE WHEN state = 'denied' THEN 1 ELSE 0 END), 0) AS denied,
        COALESCE(SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
        COALESCE(SUM(CASE WHEN state = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown,
        COALESCE(SUM(CASE WHEN state = 'started'
          AND started_at <= p.snapshot_now
          AND p.snapshot_now - started_at >= p.stale_age_ms
          THEN 1 ELSE 0 END), 0) AS stale_started,
        COALESCE(SUM(CASE WHEN state = 'started'
          AND started_at <= p.snapshot_now
          AND p.snapshot_now - started_at >= p.stale_age_ms
          AND NOT EXISTS (
            SELECT 1 FROM session_operation_leases lease
            WHERE lease.session_id = tool_calls.session_id
              AND lease.token = tool_calls.execution_token
              AND lease.expires_at > p.snapshot_now
          )
          THEN 1 ELSE 0 END), 0) AS orphaned_started,
        MAX(CASE WHEN state = 'started'
          AND started_at <= p.snapshot_now
          AND p.snapshot_now - started_at >= p.stale_age_ms
          THEN p.snapshot_now - started_at END) AS oldest_stale_started_age_ms
      FROM tool_calls CROSS JOIN parameters p
    `).get(now, staleToolCallAgeMs) as {
      total: number;
      started: number;
      completed: number;
      denied: number;
      failed: number;
      unknown: number;
      stale_started: number;
      orphaned_started: number;
      oldest_stale_started_age_ms: number | null;
    };
    const leases = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN expires_at > ? THEN 1 ELSE 0 END), 0) AS active,
        COALESCE(SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END), 0) AS stale,
        MAX(CASE WHEN expires_at <= ? THEN ? - expires_at END) AS oldest_stale_age_ms
      FROM session_operation_leases
    `).get(now, now, now, now) as {
      total: number;
      active: number;
      stale: number;
      oldest_stale_age_ms: number | null;
    };
    return {
      sessions: {
        total: sessions.total,
        interactive: sessions.interactive,
        agent: sessions.agent,
        persistent: sessions.persistent,
      },
      events: {
        total: events.total,
        user: events.user,
        response: events.response,
        toolStarted: events.tool_started,
        toolResult: events.tool_result,
        toolDenied: events.tool_denied,
        error: events.error,
        note: events.note,
      },
      checkpoints: { total: checkpoints.total },
      toolCalls: {
        total: toolCalls.total,
        started: toolCalls.started,
        completed: toolCalls.completed,
        denied: toolCalls.denied,
        failed: toolCalls.failed,
        unknown: toolCalls.unknown,
        staleStarted: toolCalls.stale_started,
        orphanedStarted: toolCalls.orphaned_started,
        oldestStaleStartedAgeMs: toolCalls.oldest_stale_started_age_ms,
      },
      leases: {
        total: leases.total,
        active: leases.active,
        stale: leases.stale,
        oldestStaleAgeMs: leases.oldest_stale_age_ms,
      },
    };
  }

  stats(
    nowOrOptions: number | SessionStatsSnapshotOptions = Date.now(),
    positionalStaleToolCallAgeMs?: number,
  ): SessionStatsSnapshot {
    return this.getStats(nowOrOptions, positionalStaleToolCallAgeMs);
  }

  getSessionStats(
    nowOrOptions: number | SessionStatsSnapshotOptions = Date.now(),
    positionalStaleToolCallAgeMs?: number,
  ): SessionStatsSnapshot {
    return this.getStats(nowOrOptions, positionalStaleToolCallAgeMs);
  }

  getOperationalStats(
    nowOrOptions: number | SessionStatsSnapshotOptions = Date.now(),
    positionalStaleToolCallAgeMs?: number,
  ): SessionStatsSnapshot {
    return this.getStats(nowOrOptions, positionalStaleToolCallAgeMs);
  }

  private buildAgentSessionRetentionPlan(
    policy: AgentSessionRetentionPolicy,
    now: number,
  ): RetentionPlan {
    const rows = this.readAgentSessionRetentionRows(now);
    const agentRows = rows.filter((row) => row.session_kind === "agent");
    const eligible = agentRows.filter(retentionRowIsEligible);
    const ordered = [...eligible].sort(
      (left, right) => left.updated_at - right.updated_at || left.id.localeCompare(right.id),
    );
    let remainingSessions = agentRows.length;
    let remainingBytes = agentRows.reduce((sum, row) => sum + row.logical_bytes, 0);
    const candidate: RetentionSessionRow[] = [];
    for (const row of ordered) {
      const age = now >= row.updated_at ? now - row.updated_at : -1;
      const minimumAge = policy.minAgeMs ?? 0;
      const oldEnough = age >= minimumAge
        && policy.maxAgeMs !== undefined
        && age > policy.maxAgeMs;
      const quotaAge = age >= minimumAge;
      const quotaNeeded = (policy.maxSessions !== undefined && remainingSessions > policy.maxSessions)
        || (policy.maxLogicalBytes !== undefined && remainingBytes > policy.maxLogicalBytes);
      if (!oldEnough && !(quotaAge && quotaNeeded)) continue;
      candidate.push(row);
      remainingSessions -= 1;
      remainingBytes = Math.max(0, remainingBytes - row.logical_bytes);
    }

    const maxSessionsPerRun = policy.maxSessionsPerRun ?? Number.MAX_SAFE_INTEGER;
    const maxBytesPerRun = policy.maxLogicalBytesPerRun ?? Number.MAX_SAFE_INTEGER;
    let sessionBudget = maxSessionsPerRun;
    let bytesBudget = maxBytesPerRun;
    const selected: RetentionSessionRow[] = [];
    for (const row of candidate) {
      if (sessionBudget === 0) break;
      if (row.logical_bytes > bytesBudget) continue;
      selected.push(row);
      sessionBudget -= 1;
      bytesBudget -= row.logical_bytes;
    }
    return { rows, candidate, eligible, selected };
  }

  private readAgentSessionRetentionRows(now: number): RetentionSessionRow[] {
    return this.db.prepare(`
      WITH
        agent_sessions AS MATERIALIZED (
          SELECT * FROM sessions WHERE session_kind = 'agent'
        ),
        event_stats AS (
          SELECT e.session_id, COUNT(*) AS events,
            COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS logical_bytes
          FROM session_events e JOIN agent_sessions a ON a.id = e.session_id
          GROUP BY e.session_id
        ),
        tool_stats AS (
          SELECT tc.session_id, COUNT(*) AS tool_calls,
            COALESCE(SUM(
              length(CAST(arguments_json AS BLOB))
              + COALESCE(length(CAST(output_text AS BLOB)), 0)
              + COALESCE(length(CAST(error_text AS BLOB)), 0)
            ), 0) AS logical_bytes
          FROM tool_calls tc JOIN agent_sessions a ON a.id = tc.session_id
          GROUP BY tc.session_id
        ),
        checkpoint_stats AS (
          SELECT c.session_id, COUNT(*) AS checkpoints,
            COALESCE(SUM(length(CAST(compact_json AS BLOB))), 0) AS logical_bytes
          FROM context_checkpoints c JOIN agent_sessions a ON a.id = c.session_id
          GROUP BY c.session_id
        ),
        approval_stats AS (
          SELECT p.session_id, COUNT(*) AS approvals,
            COALESCE(SUM(length(CAST(signature AS BLOB))), 0) AS logical_bytes
          FROM session_command_approvals p JOIN agent_sessions a ON a.id = p.session_id
          GROUP BY p.session_id
        ),
        artifact_stats AS (
          SELECT ar.session_id, COUNT(*) AS artifacts,
            COALESCE(SUM(byte_count), 0) AS artifact_bytes
          FROM artifacts ar JOIN agent_sessions a ON a.id = ar.session_id
          GROUP BY ar.session_id
        )
      SELECT
        s.id,
        s.session_kind,
        s.persistent,
        s.updated_at,
        COALESCE(es.events, 0) AS events,
        COALESCE(cs.checkpoints, 0) AS checkpoints,
        COALESCE(ts.tool_calls, 0) AS tool_calls,
        COALESCE(as_.approvals, 0) AS approvals,
        COALESCE(es.logical_bytes, 0)
          + COALESCE(ts.logical_bytes, 0)
          + COALESCE(cs.logical_bytes, 0)
          + COALESCE(as_.logical_bytes, 0) AS logical_bytes,
        COALESCE(ars.artifacts, 0) AS artifacts,
        COALESCE(ars.artifact_bytes, 0) AS artifact_bytes,
        CASE WHEN EXISTS (
          WITH RECURSIVE ancestors(id) AS (
            SELECT s.id
            UNION ALL
            SELECT parent.parent_session_id FROM sessions parent
            JOIN ancestors child ON parent.id = child.id
            WHERE parent.parent_session_id IS NOT NULL
          )
          SELECT 1 FROM session_operation_leases l
          JOIN ancestors ON ancestors.id = l.session_id
          WHERE l.expires_at > ?
        ) THEN 1 ELSE 0 END AS active_lease,
        CASE WHEN EXISTS (
          SELECT 1 FROM scheduler_jobs j WHERE j.session_id = s.id
        ) THEN 1 ELSE 0 END AS scheduler_jobs,
        CASE WHEN EXISTS (
          SELECT 1 FROM scheduler_occurrences o
          JOIN scheduler_jobs j ON j.id = o.job_id
          WHERE j.session_id = s.id AND o.state IN ('claimed', 'running')
        ) THEN 1 ELSE 0 END AS active_schedule,
        CASE WHEN EXISTS (
          SELECT 1 FROM sessions child WHERE child.parent_session_id = s.id
        ) THEN 1 ELSE 0 END AS child_sessions,
        CASE WHEN EXISTS (
          SELECT 1 FROM tool_calls call
          WHERE call.session_id = s.id AND call.state IN ('started', 'unknown')
        ) THEN 1 ELSE 0 END AS uncertain_tool_calls
      FROM agent_sessions s
      LEFT JOIN event_stats es ON es.session_id = s.id
      LEFT JOIN tool_stats ts ON ts.session_id = s.id
      LEFT JOIN checkpoint_stats cs ON cs.session_id = s.id
      LEFT JOIN approval_stats as_ ON as_.session_id = s.id
      LEFT JOIN artifact_stats ars ON ars.session_id = s.id
      ORDER BY s.updated_at, s.id
    `).all(now) as RetentionSessionRow[];
  }

  private buildAgentSessionRetentionReport(
    policy: AgentSessionRetentionPolicy,
    now: number,
    mode: AgentSessionRetentionMode,
  ): AgentSessionRetentionReport {
    const plan = this.buildAgentSessionRetentionPlan(policy, now);
    return this.buildAgentSessionRetentionReportFromPlan(policy, now, mode, plan);
  }

  private buildAgentSessionRetentionReportFromPlan(
    policy: AgentSessionRetentionPolicy,
    now: number,
    mode: AgentSessionRetentionMode,
    plan: RetentionPlan,
  ): AgentSessionRetentionReport {
    const agentRows = plan.rows.filter((row) => row.session_kind === "agent");
    const total = retentionEstimate(agentRows);
    const candidate = retentionEstimate(plan.candidate);
    const eligible = retentionEstimate(plan.eligible);
    const selected = retentionEstimate(plan.selected);
    const protectedRows = agentRows.filter((row) => !retentionRowIsEligible(row));
    return {
      mode,
      dryRun: mode === "dry-run",
      now,
      policy: { ...policy },
      total,
      candidate,
      eligible,
      protected: retentionEstimate(protectedRows),
      selected,
      remaining: subtractRetentionEstimate(total, selected),
      batchLimited: plan.selected.length < plan.candidate.length,
    };
  }

  private readDeletionSummary(id: string): SessionDeletionSummary {
    const row = this.db.prepare(`
      WITH RECURSIVE targets(id) AS (
        SELECT ? UNION ALL
        SELECT s.id FROM sessions s JOIN targets t ON s.parent_session_id = t.id
      )
      SELECT
        (SELECT COUNT(*) FROM session_events WHERE session_id IN (SELECT id FROM targets)) AS events,
        (SELECT COUNT(*) FROM context_checkpoints WHERE session_id IN (SELECT id FROM targets)) AS checkpoints,
        (SELECT COUNT(*) FROM tool_calls WHERE session_id IN (SELECT id FROM targets)) AS tool_calls,
        (SELECT COUNT(*) FROM scheduler_jobs WHERE session_id IN (SELECT id FROM targets)) AS schedules,
        (SELECT COUNT(*) FROM scheduler_occurrences
          WHERE job_id IN (SELECT id FROM scheduler_jobs WHERE session_id IN (SELECT id FROM targets))) AS occurrences,
        (SELECT COUNT(*) FROM scheduler_inbox
          WHERE job_id IN (SELECT id FROM scheduler_jobs WHERE session_id IN (SELECT id FROM targets))) AS inbox_items,
        (SELECT COUNT(*) FROM session_command_approvals WHERE session_id IN (SELECT id FROM targets)) AS command_approvals,
        (SELECT COUNT(*) FROM artifacts WHERE session_id IN (SELECT id FROM targets)) AS retained_artifacts
    `).get(id) as {
      events: number;
      checkpoints: number;
      tool_calls: number;
      schedules: number;
      occurrences: number;
      inbox_items: number;
      command_approvals: number;
      retained_artifacts: number;
    };
    return {
      events: row.events,
      checkpoints: row.checkpoints,
      toolCalls: row.tool_calls,
      schedules: row.schedules,
      occurrences: row.occurrences,
      inboxItems: row.inbox_items,
      commandApprovals: row.command_approvals,
      retainedArtifacts: row.retained_artifacts,
    };
  }

  private require(id: string): SessionRecord {
    const session = this.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    return session;
  }

  private requireToolCall(sessionId: string, callId: string): ToolCallRecord {
    const call = this.getToolCall(sessionId, callId);
    if (!call) throw new Error(`Tool call not found: ${callId}`);
    return call;
  }

  private appendEventRow<T>(sessionId: string, kind: EventKind, payload: T, createdAt: number): SessionEvent<T> {
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM session_events WHERE session_id = ?",
    ).get(sessionId) as { sequence: number };
    const result = this.db.prepare(`
      INSERT INTO session_events(session_id, sequence, kind, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, row.sequence, kind, JSON.stringify(payload), createdAt);
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(createdAt, sessionId);
    return {
      id: Number(result.lastInsertRowid),
      sessionId,
      sequence: row.sequence,
      kind,
      payload,
      createdAt,
    };
  }

  private readOperationLeaseState(
    sessionId: string,
    owner: string | undefined,
    token: string,
    now: number,
  ): OperationLeaseState {
    const row = this.db.prepare(`
      SELECT owner, token, acquired_at, renewed_at, expires_at
      FROM session_operation_leases WHERE session_id = ?
    `).get(sessionId) as OperationLeaseRow | undefined;
    if (!row) {
      return {
        kind: "missing",
        leaseDurationMs: null,
        renewalAgeMs: null,
        expiryOffsetMs: null,
      };
    }

    const expiryOffsetMs = row.expires_at - now;
    if (row.token !== token || (owner !== undefined && row.owner !== owner)) {
      return {
        kind: "replaced",
        leaseDurationMs: null,
        renewalAgeMs: null,
        expiryOffsetMs: null,
      };
    }
    return {
      kind: expiryOffsetMs > 0 ? "active" : "expired",
      leaseDurationMs: Math.max(0, row.expires_at - row.renewed_at),
      renewalAgeMs: Math.max(0, now - row.renewed_at),
      expiryOffsetMs,
    };
  }

  private hasOperationLeaseRow(sessionId: string, executionToken: string, now: number): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM session_operation_leases
      WHERE session_id = ? AND token = ? AND expires_at > ?
    `).get(sessionId, executionToken, now));
  }
}

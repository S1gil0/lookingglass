import { randomUUID } from "node:crypto";
import type { GlassDatabase } from "./database.js";
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

export interface CommandApprovalRecord {
  signature: string;
  approvedAt: number;
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
        this.db.prepare("DELETE FROM context_checkpoints WHERE session_id = ?").run(id);
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

  renewOperationLease(sessionId: string, owner: string, token: string, now = Date.now(), leaseMs = 30_000): boolean {
    return this.db.prepare(`
      UPDATE session_operation_leases SET renewed_at = ?, expires_at = ?
      WHERE session_id = ? AND owner = ? AND token = ? AND expires_at > ?
    `).run(now, now + leaseMs, sessionId, owner, token, now).changes === 1;
  }

  assertOperationLease(sessionId: string, owner: string, token: string, now = Date.now()): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM session_operation_leases
      WHERE session_id = ? AND owner = ? AND token = ? AND expires_at > ?
    `).get(sessionId, owner, token, now));
  }

  assertOperationToken(sessionId: string, token: string, now = Date.now()): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM session_operation_leases
      WHERE session_id = ? AND token = ? AND expires_at > ?
    `).get(sessionId, token, now));
  }

  releaseOperationLease(sessionId: string, owner: string, token: string): boolean {
    return this.db.prepare(`
      DELETE FROM session_operation_leases WHERE session_id = ? AND owner = ? AND token = ?
    `).run(sessionId, owner, token).changes === 1;
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
        WHERE tc.session_id = ? AND tc.call_id NOT IN (
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

  private hasOperationLeaseRow(sessionId: string, executionToken: string, now: number): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM session_operation_leases
      WHERE session_id = ? AND token = ? AND expires_at > ?
    `).get(sessionId, executionToken, now));
  }
}

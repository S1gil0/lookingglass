import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import type { ResponseInputItem, ResponseOutputItem } from "openai/resources/responses/responses";
import type { ContextCheckpoint, SessionStore } from "../storage/session-store.js";
import type { SessionEvent } from "../types.js";
import type {
  ProjectedContext,
  StoredResponsePayload,
  StoredToolResultPayload,
  StoredUserPayload,
} from "./types.js";

function stripSdkParsedFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripSdkParsedFields) as T;
  if (!value || typeof value !== "object") return value;
  const cleaned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "parsed" || key === "parsed_arguments") continue;
    cleaned[key] = stripSdkParsedFields(child);
  }
  return cleaned as T;
}

function normalizeCompactionOutput(items: unknown[]): ResponseInputItem[] {
  const normalized = items.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const item = value as Record<string, unknown>;
    if (item.type === "compaction_summary" && typeof item.encrypted_content === "string") {
      return { type: "compaction", encrypted_content: item.encrypted_content };
    }
    return item;
  });
  return stripSdkParsedFields(
    toResponseInputItems(normalized as Array<ResponseInputItem | ResponseOutputItem>),
  );
}

function toolResultItem(
  payload: StoredToolResultPayload,
  storedOutput: (callId: string) => string | undefined,
): ResponseInputItem {
  return payload.item ?? {
    type: "function_call_output",
    call_id: payload.callId,
    output: payload.output ?? storedOutput(payload.callId) ?? "Tool result is unavailable.",
  };
}

function itemsFromEvent(
  event: SessionEvent,
  storedOutput: (callId: string) => string | undefined,
): ResponseInputItem[] {
  switch (event.kind) {
    case "user":
      return [(event.payload as StoredUserPayload).item];
    case "response": {
      const output = (event.payload as StoredResponsePayload).response.output;
      return stripSdkParsedFields(toResponseInputItems(output as ResponseOutputItem[]));
    }
    case "tool_result":
    case "tool_denied":
      return [toolResultItem(event.payload as StoredToolResultPayload, storedOutput)];
    default:
      return [];
  }
}

export function projectContext(
  store: SessionStore,
  sessionId: string,
  options: {
    ignoreCheckpoint?: boolean;
    /** Explicit source anchor for repair; null replays original stored events. */
    checkpoint?: ContextCheckpoint | null;
    /** Recover opaque state from the newest portable checkpoint, not the entire session. */
    portableCheckpointOnly?: boolean;
    throughSequence?: number;
    /** Compact an older prefix, keeping a bounded suffix of complete exchanges verbatim. */
    retainRecentCharacters?: number;
  } = {},
): ProjectedContext {
  const checkpoint = options.ignoreCheckpoint ? null : options.checkpoint !== undefined ? options.checkpoint : store.latestCheckpoint(sessionId, {
    ...(options.throughSequence !== undefined ? { throughSequence: options.throughSequence } : {}),
    ...(options.portableCheckpointOnly ? { portableOnly: true } : {}),
  });
  const input: ResponseInputItem[] = [];
  let checkpointSequence = 0;
  let latestSequence = 0;

  if (checkpoint) {
    checkpointSequence = checkpoint.throughSequence;
    const output = checkpoint.compact.output;
    if (!Array.isArray(output)) throw new Error("Stored compact response has no output array");
    input.push(...normalizeCompactionOutput(output));
  }

  const events = store.events(sessionId, checkpointSequence)
    .filter((event) => options.throughSequence === undefined || event.sequence <= options.throughSequence);
  const outputlessCallIds = events.flatMap((event) => {
    if (event.kind !== "tool_result" && event.kind !== "tool_denied") return [];
    const payload = event.payload as StoredToolResultPayload;
    return payload.item === undefined && payload.output === undefined ? [payload.callId] : [];
  });
  const toolOutputs = store.toolCallOutputs(sessionId, outputlessCallIds);
  const storedOutput = (callId: string): string | undefined => toolOutputs.get(callId);
  const boundaries: Array<{ sequence: number; items: number; characters: number }> = [];
  const pendingCalls = new Set<string>();
  if (options.retainRecentCharacters) {
    for (const item of input) {
      if (item.type === "function_call") pendingCalls.add(item.call_id);
      if (item.type === "function_call_output") pendingCalls.delete(item.call_id);
    }
  }
  let characters = JSON.stringify(input).length;
  latestSequence = checkpointSequence;
  for (const event of events) {
    const items = itemsFromEvent(event, storedOutput);
    if (items.length === 0) continue;
    input.push(...items);
    latestSequence = event.sequence;
    if (options.retainRecentCharacters) {
      for (const item of items) {
        characters += JSON.stringify(item).length + 1;
        if (item.type === "function_call") pendingCalls.add(item.call_id);
        if (item.type === "function_call_output") pendingCalls.delete(item.call_id);
      }
      if (pendingCalls.size === 0) boundaries.push({ sequence: latestSequence, items: input.length, characters });
    }
  }
  const recentLimit = options.retainRecentCharacters ?? 0;
  if (recentLimit > 0 && pendingCalls.size > 0) {
    throw Object.assign(new Error("Cannot compact unresolved tool calls; reconcile the interrupted turn first"), {
      code: "compaction_pending_tools",
    });
  }
  // Small histories keep the existing behavior. Never cut between a tool call
  // (including a parallel batch) and its results, or at the checkpoint itself.
  if (recentLimit > 0 && characters > recentLimit * 2) {
    const latestUser = input.findLastIndex((item) => (item as { role?: string }).role === "user");
    const candidates = boundaries.filter((entry) => entry.items < input.length
      && characters - entry.characters <= recentLimit
      && ((input[entry.items - 1] as { role?: string }).role !== "user"
        || (input[entry.items] as { role?: string }).role === "user"));
    // Keep the current user request along with the working exchange when it
    // fits. Long single-user tool loops still retain their latest complete rounds.
    const boundary = candidates.find((entry) => entry.items <= latestUser) ?? candidates[0];
    if (boundary) {
      input.length = boundary.items;
      latestSequence = boundary.sequence;
    }
  }
  return {
    input,
    checkpointSequence,
    latestSequence,
  };
}

export function responseOutputToInput(output: unknown[]): ResponseInputItem[] {
  return stripSdkParsedFields(toResponseInputItems(output as ResponseOutputItem[]));
}

export interface ContextUsage {
  inputTokens: number;
  estimated: boolean;
}

/** Prefer provider usage only when it was measured against the current checkpoint. */
export function contextUsage(store: SessionStore, sessionId: string, stateless = false): ContextUsage {
  const usage = store.latestResponseUsage(sessionId);
  const checkpoint = store.latestCheckpoint(sessionId);
  const source = (checkpoint?.compact.compaction_details as { source_sequence?: unknown } | undefined)?.source_sequence;
  const sourceSequence = typeof source === "number" && Number.isSafeInteger(source)
    && source >= (checkpoint?.throughSequence ?? 0) && source <= store.latestSequence(sessionId) ? source : undefined;
  // A retained response may follow throughSequence but still predate compaction.
  // New checkpoints use an event watermark (not wall-clock ordering). For legacy
  // checkpoints, prefer an estimate when timestamps cannot establish freshness.
  const fresh = usage && Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0
    && (!checkpoint || (sourceSequence !== undefined
      ? usage.sequence > sourceSequence
      : usage.sequence > checkpoint.throughSequence && usage.createdAt > checkpoint.createdAt));
  const projected = !fresh || stateless ? Math.ceil(JSON.stringify(projectContext(store, sessionId).input).length / 4) : 0;
  return fresh ? { inputTokens: Math.max(usage.inputTokens, projected), estimated: projected > usage.inputTokens }
    : { inputTokens: projected, estimated: true };
}

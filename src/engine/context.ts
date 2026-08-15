import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import type { ResponseInputItem, ResponseOutputItem } from "openai/resources/responses/responses";
import type { SessionStore } from "../storage/session-store.js";
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
  options: { ignoreCheckpoint?: boolean } = {},
): ProjectedContext {
  const checkpoint = options.ignoreCheckpoint ? null : store.latestCheckpoint(sessionId);
  const input: ResponseInputItem[] = [];
  let checkpointSequence = 0;
  let latestSequence = 0;

  if (checkpoint) {
    checkpointSequence = checkpoint.throughSequence;
    const output = checkpoint.compact.output;
    if (!Array.isArray(output)) throw new Error("Stored compact response has no output array");
    input.push(...normalizeCompactionOutput(output));
  }

  const events = store.events(sessionId, checkpointSequence);
  const outputlessCallIds = events.flatMap((event) => {
    if (event.kind !== "tool_result" && event.kind !== "tool_denied") return [];
    const payload = event.payload as StoredToolResultPayload;
    return payload.item === undefined && payload.output === undefined ? [payload.callId] : [];
  });
  const toolOutputs = store.toolCallOutputs(sessionId, outputlessCallIds);
  const storedOutput = (callId: string): string | undefined => toolOutputs.get(callId);
  latestSequence = checkpointSequence;
  for (const event of events) {
    const items = itemsFromEvent(event, storedOutput);
    if (items.length === 0) continue;
    input.push(...items);
    latestSequence = event.sequence;
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

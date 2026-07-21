import type { ResponseInputItem } from "openai/resources/responses/responses";

export interface StoredUserPayload {
  item: ResponseInputItem;
}

export interface StoredResponsePayload {
  response: {
    id: string;
    status: string | null;
    output: unknown[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    } | null;
  };
}

export interface StoredToolResultPayload {
  name: string;
  callId: string;
  item: ResponseInputItem;
  output: string;
  artifactUri?: string;
  truncated?: boolean;
}

export interface StoredErrorPayload {
  message: string;
  code?: string;
  recoverable: boolean;
}

export interface ProjectedContext {
  input: ResponseInputItem[];
  checkpointSequence: number;
  latestSequence: number;
}

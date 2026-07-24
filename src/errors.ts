const MAX_DETAIL = 512;
const MAX_RAW_DETAIL = 16 * 1024;
const MAX_CONTEXT_PART = 96;
const MAX_CAUSE_DEPTH = 8;

export interface ProviderErrorContext {
  provider: string;
  operation: string;
  status?: number;
  responseStatus?: number | string;
  configuredSecrets?: readonly string[];
  timeoutSignal?: AbortSignal;
  callerSignal?: AbortSignal;
  /** Useful at boundaries which already know which abort path fired. */
  timedOut?: boolean;
  callerAborted?: boolean;
  /** Marks a response whose shape or encoding could not be understood. */
  protocol?: boolean;
}

interface ProviderErrorFields {
  code?: string;
  type?: string;
  param?: string;
  status?: number;
  responseStatus?: number | string;
}

export interface NormalizedProviderError extends Error, ProviderErrorFields {}

interface DetailFields {
  message?: string;
  code?: string;
  type?: string;
  param?: string;
  status?: number;
  responseStatus?: number | string;
}

interface CauseEntry {
  code?: string;
  name?: string;
  message?: string;
}

interface CauseClues {
  entries: CauseEntry[];
}

type ErrorKind = "timeout" | "cancelled" | "refused" | "dns" | "network" | "protocol" | "generic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function read(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseJsonString(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) || Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function statusValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  if (typeof value === "string" && /^\d{3}$/.test(value)) {
    const status = Number(value);
    return status >= 100 && status <= 599 ? status : undefined;
  }
  return undefined;
}

function responseStatusValue(value: unknown): number | string | undefined {
  const status = statusValue(value);
  if (status !== undefined) return status;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(trimmed) ? trimmed : undefined;
}

function collectDetails(value: unknown, result: DetailFields, seen: Set<object>, depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const parsed = parseJsonString(value);
    if (parsed !== undefined) collectDetails(parsed, result, seen, depth + 1);
    else if (result.message === undefined) result.message = value;
    return;
  }
  if (!isRecord(value)) {
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 8)) collectDetails(item, result, seen, depth + 1);
    }
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);

  // Prefer the useful nested provider object over an SDK's generic outer message.
  for (const key of ["error", "detail", "errors"]) {
    collectDetails(read(value, key), result, seen, depth + 1);
  }

  // OpenRouter sometimes wraps the actual upstream response in metadata.raw.
  // Inspect it before the generic outer message, while bounding both parsing
  // and the eventual diagnostic detail.
  const metadata = read(value, "metadata");
  const raw = read(metadata, "raw");
  if (typeof raw === "string") {
    const bounded = raw.slice(0, MAX_RAW_DETAIL);
    const parsed = parseJsonString(bounded);
    if (parsed !== undefined) collectDetails(parsed, result, seen, depth + 1);
    else if (result.message === undefined) result.message = bounded;
  } else if (raw !== undefined) {
    collectDetails(raw, result, seen, depth + 1);
  }

  const message = textValue(read(value, "message"));
  const rawCode = read(value, "code");
  const numericCode = statusValue(rawCode);
  if (result.status === undefined && numericCode !== undefined) result.status = numericCode;
  const code = textValue(rawCode);
  // A numeric three-digit OpenRouter code is an HTTP status, not the useful
  // provider error code. Keep the latter when it is available deeper in raw.
  const usefulCode = code !== undefined && statusValue(code) === undefined ? code : undefined;
  const type = textValue(read(value, "type"));
  const param = textValue(read(value, "param"));
  if (result.message === undefined && message !== undefined) result.message = message;
  if (result.code === undefined && usefulCode !== undefined) result.code = usefulCode;
  if (result.type === undefined && type !== undefined) result.type = type;
  if (result.param === undefined && param !== undefined) result.param = param;

  const rawStatus = read(value, "status");
  const status = statusValue(rawStatus);
  if (result.status === undefined && status !== undefined) result.status = status;
  if (result.responseStatus === undefined) {
    const responseStatus = responseStatusValue(read(value, "responseStatus"))
      ?? (status === undefined ? responseStatusValue(rawStatus) : undefined);
    if (responseStatus !== undefined) result.responseStatus = responseStatus;
  }
}

function inspectCauses(value: unknown, result: CauseClues, seen: Set<object>, depth = 0): void {
  if (depth > MAX_CAUSE_DEPTH || value === null || value === undefined) return;
  if (typeof value === "string") {
    result.entries.push({ message: value });
    return;
  }
  if (!isRecord(value) || seen.has(value)) return;
  seen.add(value);
  const entry: CauseEntry = {};
  const code = textValue(read(value, "code"));
  const name = textValue(read(value, "name"));
  const message = textValue(read(value, "message"));
  if (code !== undefined) entry.code = code;
  if (name !== undefined) entry.name = name;
  if (message !== undefined) entry.message = message;
  if (code !== undefined || name !== undefined || message !== undefined) result.entries.push(entry);
  inspectCauses(read(value, "cause"), result, seen, depth + 1);
}

function sanitizeText(value: string, secrets: readonly string[], limit = MAX_DETAIL): string {
  let result = value;
  for (const secret of [...secrets].filter((item) => item.length > 0).sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join("[REDACTED]");
  }
  result = result
    .replace(/\bBearer(?:\s*[:=]\s*|\s+)(?!\[REDACTED\])[^,\s;)}\]>"]+/gi, "Bearer [REDACTED]")
    .replace(/(\b(?:authorization|proxy[-_ ]authorization|cookie|set[-_ ]cookie|api[-_ ]?key|(?:access|refresh|client|private|auth|session)[-_ ]?(?:token|secret|key)|aws[-_ ]?secret[-_ ]?access[-_ ]?key|token|secret|password)\s*[:=]\s*)(?!Bearer(?:\s|[:=]))(?:"[^"]*"|'[^']*'|[^\s,;)}>\"']+)/gi, "$1[REDACTED]")
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, (url) => {
      const withoutQuery = url.slice(0, url.search(/[?#]/) >= 0 ? url.search(/[?#]/) : url.length);
      return withoutQuery.replace(/^(https?:\/\/)[^/@\s]+@/i, "$1");
    })
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return result.length <= limit ? result : `${result.slice(0, Math.max(0, limit - 1))}…`;
}

function safeField(value: string | undefined, secrets: readonly string[], limit = 128): string | undefined {
  if (value === undefined) return undefined;
  const safe = sanitizeText(value, secrets, limit);
  return safe || undefined;
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  try {
    return signal?.aborted === true;
  } catch {
    return false;
  }
}

function has(value: string, pattern: RegExp): boolean {
  return pattern.test(value);
}

function classifyError(
  context: ProviderErrorContext,
  clues: CauseClues,
  hasStatus: boolean,
  detail: DetailFields,
): ErrorKind {
  const callerAborted = context.callerAborted === true || signalAborted(context.callerSignal);
  const timedOut = context.timedOut === true || signalAborted(context.timeoutSignal);
  if (callerAborted) return "cancelled";
  if (timedOut) return "timeout";

  const entries = clues.entries.map((entry) => ({
    code: entry.code?.toUpperCase() ?? "",
    name: entry.name?.toUpperCase() ?? "",
    text: [entry.code, entry.name, entry.message].filter((part): part is string => part !== undefined).join(" "),
  }));
  if (entries.some((entry) => has(entry.code, /^(?:ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_(?:CONNECT|HEADERS)_TIMEOUT|ERR_SOCKET_TIMEOUT)$/)
    || entry.name === "TIMEOUTERROR")) return "timeout";
  if (entries.some((entry) => has(entry.code, /^(?:ABORT_ERR|ERR_ABORTED)$/) || entry.name === "ABORTERROR"
    || has(entry.text, /\b(?:aborted|cancelled|canceled)\b/i))) return "cancelled";
  if (entries.some((entry) => has(entry.code, /^(?:ENOTFOUND|EAI_AGAIN|EAI_FAIL|EAI_NODATA)$/)
    || has(entry.text, /(?:dns|\bgetaddrinfo\b|name resolution|could not resolve)/i))) return "dns";
  if (entries.some((entry) => has(entry.code, /^(?:ECONNREFUSED)$/)
    || has(entry.text, /connection refused/i))) return "refused";
  if (entries.some((entry) => has(entry.code, /^(?:ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EPIPE|ECONNABORTED|UND_ERR_SOCKET|ERR_NETWORK)$/)
    || has(entry.text, /(?:socket hang up|network error|network connection)/i))) return "network";
  if (context.protocol === true || entries.some((entry) => has(entry.code, /(?:MALFORMED|INVALID_(?:JSON|RESPONSE)|PROTOCOL)/)
    || has(entry.text, /(?:malformed|invalid json|unexpected token|unexpected end|not valid json|response (?:had no body|shape|schema))/i)
    || has(detail.message ?? "", /(?:malformed|invalid json|unexpected token|unexpected end|not valid json|response (?:had no body|shape|schema))/i))) {
    return "protocol";
  }
  if (!hasStatus && entries.some((entry) => has(entry.text, /\b(?:timed? ?out|timeout)\b/i))) return "timeout";
  return "generic";
}

function fieldSummary(detail: DetailFields, secrets: readonly string[]): string {
  const message = safeField(detail.message, secrets);
  const fields = [
    ["code", detail.code],
    ["type", detail.type],
    ["param", detail.param],
  ].flatMap(([key, value]) => {
    const safe = safeField(value, secrets, 96);
    return safe === undefined ? [] : [`${key}=${safe}`];
  });
  if (message !== undefined && fields.length > 0) return `${message} (${fields.join(", ")})`;
  return message ?? fields.join(", ");
}

function contextPart(value: string, secrets: readonly string[], fallback: string): string {
  return safeField(value, secrets, MAX_CONTEXT_PART) ?? fallback;
}

export function providerError(error: unknown, context: ProviderErrorContext): NormalizedProviderError {
  const secrets = [...(context.configuredSecrets ?? [])].filter((secret): secret is string => typeof secret === "string");
  const detail: DetailFields = {};
  collectDetails(error, detail, new Set<object>());
  const clues: CauseClues = { entries: [] };
  inspectCauses(error, clues, new Set<object>());

  const contextStatus = statusValue(context.status);
  const status = contextStatus ?? detail.status ?? statusValue(context.responseStatus) ?? statusValue(detail.responseStatus);
  const responseStatus = responseStatusValue(context.responseStatus)
    ?? responseStatusValue(detail.responseStatus)
    ?? (status === undefined ? undefined : status);
  const kind = classifyError(context, clues, status !== undefined, detail);
  const provider = contextPart(context.provider, secrets, "provider");
  const operation = contextPart(context.operation, secrets, "operation");
  const prefix = `${provider} ${operation}`;
  const summary = fieldSummary(detail, secrets);
  let message: string;
  if (status !== undefined && kind !== "timeout" && kind !== "cancelled") {
    const httpDetail = kind === "protocol" && detail.message === undefined ? "malformed provider response" : summary;
    message = `${prefix} failed with HTTP ${status}${httpDetail ? `: ${httpDetail}` : ""}`;
  } else {
    switch (kind) {
      case "timeout":
        message = `${prefix} timed out`;
        break;
      case "cancelled":
        message = `${prefix} was cancelled by the caller`;
        break;
      case "refused":
        message = `${prefix} failed: connection refused`;
        break;
      case "dns":
        message = `${prefix} failed: DNS lookup failed`;
        break;
      case "network":
        message = `${prefix} failed: network connection failed`;
        break;
      case "protocol":
        message = `${prefix} failed: malformed provider response`;
        break;
      default:
        message = `${prefix} failed${summary ? `: ${summary}` : ""}`;
        break;
    }
  }

  const normalized = new Error(sanitizeText(message, secrets));
  normalized.name = "ProviderError";
  const fields: ProviderErrorFields = {};
  const code = safeField(detail.code, secrets, 96);
  const type = safeField(detail.type, secrets, 96);
  const param = safeField(detail.param, secrets, 96);
  if (code !== undefined) fields.code = code;
  if (type !== undefined) fields.type = type;
  if (param !== undefined) fields.param = param;
  if (status !== undefined) fields.status = status;
  if (responseStatus !== undefined) fields.responseStatus = responseStatus;
  Object.assign(normalized, fields);
  return normalized as NormalizedProviderError;
}

interface HttpResponseLike {
  readonly status: number;
}

export function providerHttpError(status: number, payload: unknown, context: ProviderErrorContext): NormalizedProviderError;
export function providerHttpError(response: HttpResponseLike, payload: unknown, context: ProviderErrorContext): NormalizedProviderError;
export function providerHttpError(payload: unknown, context: ProviderErrorContext): NormalizedProviderError;
export function providerHttpError(
  first: unknown,
  second: unknown,
  third?: ProviderErrorContext,
): NormalizedProviderError {
  const hasExplicitStatus = third !== undefined;
  const context = (hasExplicitStatus ? third : second) as ProviderErrorContext;
  const status = hasExplicitStatus
    ? (typeof first === "number" ? statusValue(first) : statusValue(read(first, "status")))
    : undefined;
  const payload = hasExplicitStatus ? second : first;
  const malformedJson = typeof payload === "string"
    && (payload.trim().startsWith("{") || payload.trim().startsWith("["))
    && parseJsonString(payload) === undefined;
  const nextContext: ProviderErrorContext = {
    ...context,
    ...(status === undefined ? {} : { status }),
    ...(malformedJson ? { protocol: true } : {}),
  };
  return providerError(malformedJson ? { code: "malformed_response" } : payload, nextContext);
}

export const normalizeProviderError = providerError;
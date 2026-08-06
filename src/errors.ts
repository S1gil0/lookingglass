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
  incompleteReason?: string;
  /** Safe classification metadata used by retry policy. */
  kind?: ErrorKind;
  retryable?: boolean;
}

export interface NormalizedProviderError extends Error, ProviderErrorFields {}

interface DetailFields {
  message?: string;
  code?: string;
  type?: string;
  param?: string;
  status?: number;
  responseStatus?: number | string;
  incompleteReason?: string;
}

interface CauseEntry {
  code?: string;
  name?: string;
  message?: string;
}

interface CauseClues {
  entries: CauseEntry[];
}

type ErrorKind =
  | "timeout"
  | "cancelled"
  | "refused"
  | "dns"
  | "network"
  | "protocol"
  | "availability"
  | "auth"
  | "invalid_request"
  | "context_overflow"
  | "unsupported"
  | "generic";

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
  for (const key of ["error", "detail", "errors", "incomplete_details", "incompleteDetails"]) {
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
  if (result.incompleteReason === undefined) {
    const incompleteReason = textValue(read(value, "incompleteReason"))
      ?? textValue(read(value, "incomplete_reason"));
    if (incompleteReason !== undefined) result.incompleteReason = incompleteReason;
  }
}

function responseIncompleteReason(value: unknown, seen: Set<object>, depth = 0): string | undefined {
  if (depth > 6 || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const direct = textValue(read(value, "reason"));
  if (direct !== undefined) return direct;
  for (const key of ["incomplete_details", "incompleteDetails", "response", "error", "detail"]) {
    const found = responseIncompleteReason(read(value, key), seen, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
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

function token(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function clueText(detail: DetailFields, clues: CauseClues): string {
  return [
    detail.message,
    detail.code,
    detail.type,
    detail.param,
    typeof detail.responseStatus === "string" ? detail.responseStatus : undefined,
    detail.incompleteReason,
    ...clues.entries.flatMap((entry) => [entry.code, entry.name, entry.message]),
  ].filter((part): part is string => part !== undefined).join(" ");
}

function clueCodes(detail: DetailFields, clues: CauseClues): string[] {
  return [
    detail.code,
    detail.type,
    ...clues.entries.flatMap((entry) => [entry.code, entry.name]),
  ].filter((part): part is string => part !== undefined).map(token);
}

function hasCancellationClue(detail: DetailFields, clues: CauseClues): boolean {
  const text = clueText(detail, clues);
  const codes = clueCodes(detail, clues);
  const transportAborted = codes.some((code) => code === "ECONNABORTED");
  return codes.some((code) => /^(?:ABORT_ERR|ERR_ABORTED)$/.test(code))
    || clues.entries.some((entry) => token(entry.name ?? "") === "ABORTERROR")
    || (!transportAborted && has(text, /\b(?:aborted|cancelled|canceled)\b/i));
}

function hasTimeoutClue(detail: DetailFields, clues: CauseClues): boolean {
  const text = clueText(detail, clues);
  return hasTimeoutCodeClue(detail, clues)
    || clues.entries.some((entry) => token(entry.name ?? "") === "TIMEOUTERROR")
    || has(text, /\b(?:timed? ?out|timeout)\b/i);
}

function hasTimeoutCodeClue(detail: DetailFields, clues: CauseClues): boolean {
  return clueCodes(detail, clues).some((code) => /^(?:ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_(?:CONNECT|HEADERS)_TIMEOUT|ERR_SOCKET_TIMEOUT)$/.test(code))
    || clues.entries.some((entry) => token(entry.name ?? "") === "TIMEOUTERROR");
}

function hasProtocolClue(context: ProviderErrorContext, detail: DetailFields, clues: CauseClues): boolean {
  const text = clueText(detail, clues);
  return context.protocol === true || clueCodes(detail, clues).some((code) =>
    /(?:MALFORMED|INVALID_(?:JSON|RESPONSE)|PROTOCOL|PARSE_ERROR|DECODE_ERROR)/.test(code))
    || has(text, /(?:malformed|invalid (?:json|response)|unexpected (?:token|end|response)|not valid json|protocol (?:error|response|violation)|could not parse response|response (?:had no body|shape|schema))/i);
}

function hasAuthOrPermissionClue(detail: DetailFields, clues: CauseClues, status: number | undefined): boolean {
  const text = clueText(detail, clues);
  return status === 401 || status === 403 || status === 407
    || clueCodes(detail, clues).some((code) => /^(?:UNAUTHORIZED|AUTHENTICATION(?:_ERROR)?|INVALID_API_KEY|MISSING_API_KEY|FORBIDDEN|PERMISSION_DENIED|ACCESS_DENIED|INSUFFICIENT_PERMISSIONS|NOT_ALLOWED)$/.test(code))
    || has(text, /\b(?:unauthori[sz]ed|authentication(?: failed|required|error|failure)?|invalid (?:api|access) key|missing (?:api|access) key|invalid credentials|permission denied|forbidden|access denied|insufficient permissions)\b/i);
}

function hasContextOrInvalidRequestClue(detail: DetailFields, clues: CauseClues): "context_overflow" | "invalid_request" | false {
  const text = clueText(detail, clues);
  const codes = clueCodes(detail, clues);
  if (codes.some((code) => /^(?:CONTEXT_LENGTH_EXCEEDED|CONTEXT_WINDOW_EXCEEDED|MAX_TOKENS_EXCEEDED|PROMPT_TOO_LONG|INPUT_TOO_LONG|CONTEXT_OVERFLOW)$/.test(code))
    || has(text, /(?:context (?:length|window)|prompt).*(?:too long|exceed|maximum|limit|token limit)|maximum context length|context overflow/i)) {
    return "context_overflow";
  }
  if (codes.some((code) => /^(?:INVALID_REQUEST(?:_ERROR)?|BAD_REQUEST|INVALID_PARAMETER|INVALID_ARGUMENT|INVALID_INPUT|INVALID_MODEL|VALIDATION_ERROR|PAYLOAD_TOO_LARGE)$/.test(code))
    || has(text, /\b(?:invalid request|bad request|invalid parameter|invalid argument|invalid input|invalid model|validation failed|payload too large)\b/i)) {
    return "invalid_request";
  }
  return false;
}

function hasUnsupportedClue(detail: DetailFields, clues: CauseClues): boolean {
  const text = clueText(detail, clues);
  const codes = clueCodes(detail, clues);
  return codes.some((code) => /^(?:UNSUPPORTED|UNSUPPORTED_MODEL|UNSUPPORTED_CAPABILITY|CAPABILITY_NOT_SUPPORTED|FEATURE_NOT_SUPPORTED|NOT_IMPLEMENTED|NO_COMPATIBLE_ENDPOINT|NO_COMPATIBLE_PROVIDER|NO_COMPATIBLE_MODEL|ENDPOINT_NOT_SUPPORTED|MODEL_NOT_FOUND|MODEL_DOES_NOT_EXIST|MODEL_NOT_SUPPORTED|PROVIDER_NOT_SUPPORTED|CAPABILITY_UNAVAILABLE)$/.test(code))
    || has(text, /(?:unsupported|not supported|does not support|cannot support|no compatible|incompatible endpoint|model (?:was )?not found|model does not exist)/i);
}

function hasTemporaryAvailabilityClue(detail: DetailFields, clues: CauseClues): boolean {
  const text = clueText(detail, clues);
  const codes = clueCodes(detail, clues);
  if (codes.some((code) => /(?:OVERLOAD|OVERLOADED|TEMPORAR(?:Y|ILY)_UNAVAILABLE|(?:SERVICE|MODEL|PROVIDER|UPSTREAM|GATEWAY)_(?:UNAVAILABLE|NOT_AVAILABLE)|NO_(?:AVAILABLE_PROVIDER|PROVIDER_AVAILABLE)(?:S)?|CAPACITY(?:_EXCEEDED)?|RATE_LIMIT(?:ED)?|TOO_MANY_REQUESTS|MODEL_NOT_READY)/.test(code))) {
    return true;
  }
  return has(text, /\boverloaded\b|\bno available provider(?:s)?\b|\b(?:service|upstream|gateway) (?:is )?unavailable\b|\b(?:model|provider) (?:is )?(?:temporarily|currently|momentarily) unavailable\b|\btemporarily unavailable\b|\b(?:try again|retry) later\b|\bcapacity (?:is )?(?:full|exceeded|unavailable)\b/i);
}

function hasNetworkClue(detail: DetailFields, clues: CauseClues): boolean {
  const text = clueText(detail, clues);
  const codes = clueCodes(detail, clues);
  return codes.some((code) => /^(?:ENOTFOUND|EAI_AGAIN|EAI_FAIL|EAI_NODATA|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EPIPE|ECONNABORTED|UND_ERR_SOCKET|ERR_NETWORK|ERR_CONNECTION_RESET)$/.test(code))
    || has(text, /(?:dns|\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED)\b|\bgetaddrinfo\b|name resolution|could not resolve|connection refused|connection reset|socket hang up|network (?:error|failure|connection))/i);
}

function transientHttpStatus(status: number | undefined): boolean {
  return status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500 && status <= 599);
}

function errorKind(value: unknown): ErrorKind | undefined {
  if (typeof value !== "string") return undefined;
  switch (value) {
    case "timeout":
    case "cancelled":
    case "refused":
    case "dns":
    case "network":
    case "protocol":
    case "availability":
    case "auth":
    case "invalid_request":
    case "context_overflow":
    case "unsupported":
    case "generic":
      return value;
    default:
      return undefined;
  }
}

function nestedStatus(value: unknown, seen: Set<object>, depth = 0): number | undefined {
  if (depth > 6 || !isRecord(value) || seen.has(value)) return undefined;
  seen.add(value);
  for (const key of ["status", "statusCode", "httpStatus", "responseStatus"]) {
    const status = statusValue(read(value, key));
    if (status !== undefined) return status;
  }
  for (const key of ["response", "error", "detail", "data", "body", "cause", "metadata"]) {
    const status = nestedStatus(read(value, key), seen, depth + 1);
    if (status !== undefined) return status;
  }
  return undefined;
}

function classifyError(
  context: ProviderErrorContext,
  clues: CauseClues,
  detail: DetailFields,
): ErrorKind {
  const status = statusValue(context.status) ?? detail.status ?? statusValue(context.responseStatus) ?? statusValue(detail.responseStatus);
  const callerAborted = context.callerAborted === true || signalAborted(context.callerSignal);
  const timedOut = context.timedOut === true || signalAborted(context.timeoutSignal);
  if (callerAborted) return "cancelled";
  if (timedOut) return "timeout";

  const entries = clues.entries.map((entry) => ({
    code: entry.code?.toUpperCase() ?? "",
    name: entry.name?.toUpperCase() ?? "",
    text: [entry.code, entry.name, entry.message].filter((part): part is string => part !== undefined).join(" "),
  }));
  if (hasTimeoutCodeClue(detail, clues) || (status === undefined && hasTimeoutClue(detail, clues))) return "timeout";
  if (hasCancellationClue(detail, clues)) return "cancelled";
  if (hasProtocolClue(context, detail, clues)) return "protocol";
  if (hasAuthOrPermissionClue(detail, clues, status)) return "auth";
  const invalidKind = hasContextOrInvalidRequestClue(detail, clues);
  if (invalidKind) return invalidKind;
  if (hasUnsupportedClue(detail, clues)) return "unsupported";
  if (hasTemporaryAvailabilityClue(detail, clues) || transientHttpStatus(status)) return "availability";
  if (entries.some((entry) => has(entry.code, /^(?:ENOTFOUND|EAI_AGAIN|EAI_FAIL|EAI_NODATA)$/)
    || has(entry.text, /(?:dns|\bgetaddrinfo\b|name resolution|could not resolve)/i))) return "dns";
  if (entries.some((entry) => has(entry.code, /^(?:ECONNREFUSED)$/)
    || has(entry.text, /connection refused/i))) return "refused";
  if (hasNetworkClue(detail, clues)) return "network";
  return "generic";
}

function retryableClassification(
  status: number | undefined,
  detail: DetailFields,
  clues: CauseClues,
  kind: ErrorKind,
  explicitRetryable: boolean | undefined,
): boolean {
  // Explicit permanent categories always win. This is important for a malformed
  // 5xx response, or an auth error wrapped by a retrying transport.
  const protocol = kind === "protocol" || hasProtocolClue({ provider: "provider", operation: "operation" }, detail, clues);
  const cancelled = kind === "cancelled"
    || (kind !== "timeout" && hasCancellationClue(detail, clues) && !hasTimeoutClue(detail, clues));
  if (cancelled || protocol) return false;
  if (hasAuthOrPermissionClue(detail, clues, status)) return false;
  if (hasContextOrInvalidRequestClue(detail, clues) || hasUnsupportedClue(detail, clues)) return false;
  if (explicitRetryable === false) return false;

  if (hasTemporaryAvailabilityClue(detail, clues)
    || kind === "availability"
    || transientHttpStatus(status)
    || kind === "timeout"
    || kind === "refused"
    || kind === "dns"
    || kind === "network") return true;
  return explicitRetryable === true;
}

/**
 * Return whether a provider failure is safe for the engine to retry.
 *
 * Normalized provider errors carry `kind` and `retryable`; the bounded raw
 * inspection below is intentionally kept as a convenience for adapters/tests
 * which have not crossed the normalization boundary yet.
 */
export function isTransientProviderError(error: unknown): boolean {
  try {
    const detail: DetailFields = {};
    collectDetails(error, detail, new Set<object>());
    const clues: CauseClues = { entries: [] };
    inspectCauses(error, clues, new Set<object>());
    const directStatus = isRecord(error)
      ? statusValue(read(error, "status"))
        ?? statusValue(read(error, "statusCode"))
        ?? statusValue(read(error, "httpStatus"))
        ?? statusValue(read(error, "responseStatus"))
      : undefined;
    const status = directStatus
      ?? detail.status
      ?? statusValue(detail.responseStatus)
      ?? nestedStatus(error, new Set<object>());
    const detailForClassification = status !== undefined && detail.status === undefined
      ? { ...detail, status }
      : detail;
    const explicitKind = isRecord(error) ? errorKind(read(error, "kind")) : undefined;
    const kind = explicitKind ?? classifyError({
      provider: "provider",
      operation: "operation",
      protocol: isRecord(error) && read(error, "protocol") === true,
    }, clues, detailForClassification);
    const retryableValue = isRecord(error) ? read(error, "retryable") : undefined;
    const explicitRetryable = typeof retryableValue === "boolean" ? retryableValue : undefined;
    return retryableClassification(status, detailForClassification, clues, kind, explicitRetryable);
  } catch {
    return false;
  }
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
  const classificationDetail = context.responseStatus !== undefined && detail.responseStatus === undefined
    ? { ...detail, responseStatus: context.responseStatus }
    : detail;
  const kind = classifyError(context, clues, classificationDetail);
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
        message = detail.code === "empty_response"
          ? `${prefix} failed: provider returned an empty completion stream (no choices or output; possible context overflow or upstream model failure)`
          : `${prefix} failed: malformed provider response`;
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
  const incompleteReason = safeField(
    detail.incompleteReason
      ?? (responseStatus === "incomplete" ? responseIncompleteReason(error, new Set<object>()) : undefined),
    secrets,
    128,
  );
  if (code !== undefined) fields.code = code;
  if (type !== undefined) fields.type = type;
  if (param !== undefined) fields.param = param;
  if (status !== undefined) fields.status = status;
  if (responseStatus !== undefined) fields.responseStatus = responseStatus;
  if (incompleteReason !== undefined) fields.incompleteReason = incompleteReason;
  fields.kind = kind;
  fields.retryable = retryableClassification(status, classificationDetail, clues, kind, undefined);
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
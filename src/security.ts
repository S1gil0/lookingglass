import type { GlassConfig } from "./types.js";

export function credentialEnvironmentNames(config: GlassConfig): string[] {
  return [...new Set([config.gateway, ...config.gateways].map((gateway) => gateway.apiKeyEnv).filter(Boolean))];
}

export function configuredCredentialValues(config: GlassConfig): string[] {
  return credentialEnvironmentNames(config)
    .map((name) => process.env[name])
    .filter((value): value is string => typeof value === "string" && value.length >= 8);
}

export function redactSensitiveText(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) redacted = redacted.replaceAll(secret, "[REDACTED]");
  return redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))=(\S+)/g, "$1=[REDACTED]");
}

export function redactSensitiveValue<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === "string") return redactSensitiveText(value, secrets) as T;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item, secrets)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, redactSensitiveValue(child, secrets)]),
  ) as T;
}

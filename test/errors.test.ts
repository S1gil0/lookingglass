import assert from "node:assert/strict";
import test from "node:test";
import { providerError, providerHttpError } from "../src/errors.js";

const context = { provider: "test-provider", operation: "responses.create" };

test("normalizes nested HTTP JSON detail and preserves safe fields", () => {
  const error = providerHttpError(429, JSON.stringify({
    error: {
      message: "Too many requests",
      code: "rate_limit",
      type: "rate_limit_error",
      param: "model",
    },
  }), context);

  assert.match(error.message, /HTTP 429/);
  assert.match(error.message, /Too many requests/);
  assert.equal(error.status, 429);
  assert.equal(error.responseStatus, 429);
  assert.equal(error.code, "rate_limit");
  assert.equal(error.type, "rate_limit_error");
  assert.equal(error.param, "model");
});

test("normalizes OpenRouter numeric status and bounded raw upstream detail", () => {
  const secret = "raw-provider-secret";
  const error = providerError({
    error: {
      code: 429,
      message: "Provider returned error",
      metadata: {
        raw: JSON.stringify({
          error: {
            message: `Upstream quota exceeded; token=${secret}`,
            code: "upstream_rate_limit",
          },
        }),
      },
    },
  }, { ...context, configuredSecrets: [secret] });

  assert.match(error.message, /HTTP 429/);
  assert.match(error.message, /Upstream quota exceeded/);
  assert.doesNotMatch(error.message, /Provider returned error/);
  assert.doesNotMatch(error.message, new RegExp(secret));
  assert.equal(error.status, 429);
  assert.equal(error.responseStatus, 429);
  assert.equal(error.code, "upstream_rate_limit");
});

test("uses safe plain-text OpenRouter raw metadata without leaking controls", () => {
  const error = providerError({
    error: {
      code: "429",
      message: "Provider returned error",
      metadata: { raw: "upstream temporarily unavailable\u0000" },
    },
  }, context);

  assert.match(error.message, /HTTP 429.*upstream temporarily unavailable/);
  assert.doesNotMatch(error.message, /[\u0000-\u001f\u007f]/);
});

test("recognizes a recursively nested connection refusal", () => {
  const cause = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
  const error = providerError(Object.assign(new Error("fetch failed"), { cause: { cause } }), context);
  assert.match(error.message, /connection refused/i);
  assert.doesNotMatch(error.message, /fetch failed/);
});

test("recognizes DNS failures without exposing the hostname", () => {
  const error = providerError(Object.assign(new Error("fetch failed"), {
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND private.example"), { code: "ENOTFOUND" }),
  }), context);
  assert.match(error.message, /DNS lookup failed/i);
  assert.doesNotMatch(error.message, /private\.example/);
});

test("distinguishes timeout and caller cancellation signals", () => {
  const timeout = new AbortController();
  timeout.abort();
  const caller = new AbortController();
  caller.abort();

  assert.match(providerError(new Error("The operation was aborted"), {
    ...context,
    timeoutSignal: timeout.signal,
  }).message, /timed out/i);
  assert.match(providerError(new Error("The operation was aborted"), {
    ...context,
    callerSignal: caller.signal,
  }).message, /cancelled by the caller/i);
});

test("keeps useful plain and string payload details", () => {
  assert.match(providerError("plain provider failure", context).message, /plain provider failure/);
  assert.match(providerError({ message: "structured provider failure" }, context).message, /structured provider failure/);
});

test("redacts bearer assignments, configured secrets, URLs, and controls", () => {
  const secret = "very-secret-token";
  const error = providerError(new Error(
    `Authorization: Bearer ${secret}; token=${secret}; https://provider.invalid/v1?api_key=${secret}&q=1\u0000`,
  ), { ...context, configuredSecrets: [secret] });

  assert.doesNotMatch(error.message, new RegExp(secret));
  assert.match(error.message, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(error.message, /\?/);
  assert.doesNotMatch(error.message, /[\u0000-\u001f\u007f]/);
});

test("redacts qualified credential fields and URL userinfo", () => {
  const error = providerError(new Error([
    ["access", "_token=", "fabricated-access-value"].join(""),
    ["client", "_secret=", "fabricated-client-value"].join(""),
    ["private", "_key=", "fabricated-private-value"].join(""),
    ["https://fabricated-user", ":fabricated-pass@", "example.invalid/path", "?token=fabricated-query-value"].join(""),
  ].join("; ")), context);

  assert.doesNotMatch(error.message, /fabricated-(?:access|client|private|user|pass|query)-value/);
  assert.match(error.message, /access_token=\[REDACTED\]/);
  assert.match(error.message, /client_secret=\[REDACTED\]/);
  assert.match(error.message, /private_key=\[REDACTED\]/);
  assert.match(error.message, /https:\/\/example\.invalid\/path/);
  assert.doesNotMatch(error.message, /@|\?/);
});

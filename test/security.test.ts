import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { configuredCredentialValues, redactSensitiveText } from "../src/security.js";

test("redacts configured short nonempty credential values", () => {
  const firstName = "LOOKING_GLASS_SHORT_CREDENTIAL_A";
  const secondName = "LOOKING_GLASS_SHORT_CREDENTIAL_B";
  const previousFirst = process.env[firstName];
  const previousSecond = process.env[secondName];
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateway.apiKeyEnv = firstName;
  config.gateways = [{
    ...DEFAULT_CONFIG.gateway,
    provider: "custom",
    baseURL: "http://127.0.0.1:9999/v1",
    apiKeyEnv: secondName,
  }];

  try {
    process.env[firstName] = "x";
    process.env[secondName] = "y";
    const secrets = configuredCredentialValues(config);
    assert.deepEqual(secrets, ["x", "y"]);
    const redacted = redactSensitiveText("first=x second=y", secrets);
    assert.equal(redacted, "first=[REDACTED] second=[REDACTED]");
  } finally {
    if (previousFirst === undefined) delete process.env[firstName];
    else process.env[firstName] = previousFirst;
    if (previousSecond === undefined) delete process.env[secondName];
    else process.env[secondName] = previousSecond;
  }
});
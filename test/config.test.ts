import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultApiKeyEnv, defaultProtocol, loadConfig } from "../src/config.js";

function withIsolatedGlobalConfig<T>(root: string, run: () => T): T {
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  const previousExplicitConfig = process.env.LOOKING_GLASS_CONFIG;
  process.env.XDG_CONFIG_HOME = join(root, "config-home");
  delete process.env.LOOKING_GLASS_CONFIG;
  try {
    return run();
  } finally {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    if (previousExplicitConfig === undefined) delete process.env.LOOKING_GLASS_CONFIG;
    else process.env.LOOKING_GLASS_CONFIG = previousExplicitConfig;
  }
}

test("loads scheduler.env with a leading UTF-8 BOM", () => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-config-"));
  const config = join(root, "looking-glass");
  const envName = "LOOKING_GLASS_BOM_TEST_KEY";
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  const previousExplicitConfig = process.env.LOOKING_GLASS_CONFIG;
  const previousValue = process.env[envName];

  try {
    mkdirSync(config, { recursive: true, mode: 0o700 });
    const environmentFile = join(config, "scheduler.env");
    writeFileSync(environmentFile, `\uFEFF${envName}=bom-value\n`, "utf8");
    chmodSync(environmentFile, 0o600);
    process.env.XDG_CONFIG_HOME = root;
    delete process.env.LOOKING_GLASS_CONFIG;
    delete process.env[envName];

    loadConfig(root);

    assert.equal(process.env[envName], "bom-value");
  } finally {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    if (previousExplicitConfig === undefined) delete process.env.LOOKING_GLASS_CONFIG;
    else process.env.LOOKING_GLASS_CONFIG = previousExplicitConfig;
    if (previousValue === undefined) delete process.env[envName];
    else process.env[envName] = previousValue;
    rmSync(root, { recursive: true, force: true });
  }
});

test("custom gateway defaults to Responses and CUSTOM_API_KEY", () => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-config-custom-"));
  try {
    writeFileSync(join(root, ".looking-glass.json"), JSON.stringify({
      gateway: { provider: "custom", baseURL: "http://127.0.0.1:9999/v1" },
    }));
    const config = loadConfig(root);
    assert.equal(config.gateway.provider, "custom");
    assert.equal(config.gateway.protocol, "responses");
    assert.equal(config.gateway.apiKeyEnv, "CUSTOM_API_KEY");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode Go gateway defaults to Chat and OPENCODE_API_KEY", () => {
  assert.equal(defaultProtocol("opencode-go"), "chat");
  assert.equal(defaultApiKeyEnv("opencode-go"), "OPENCODE_API_KEY");
  const root = mkdtempSync(join(tmpdir(), "looking-glass-config-opencode-go-"));
  try {
    writeFileSync(join(root, ".looking-glass.json"), JSON.stringify({
      gateway: { provider: "opencode-go", baseURL: "https://opencode.ai/zen/go/v1" },
    }));
    const config = loadConfig(root);
    assert.equal(config.gateway.provider, "opencode-go");
    assert.equal(config.gateway.protocol, "chat");
    assert.equal(config.gateway.apiKeyEnv, "OPENCODE_API_KEY");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts the standard minimal reasoning effort", () => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-config-minimal-effort-"));
  try {
    writeFileSync(join(root, ".looking-glass.json"), JSON.stringify({ reasoningEffort: "minimal" }));
    assert.equal(loadConfig(root).reasoningEffort, "minimal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skips an invalid custom gateway protocol", () => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-config-protocol-"));
  try {
    writeFileSync(join(root, ".looking-glass.json"), JSON.stringify({
      gateway: { provider: "custom", protocol: "invalid", baseURL: "http://127.0.0.1:9999/v1" },
    }));
    withIsolatedGlobalConfig(root, () => assert.equal(loadConfig(root).gateway.provider, "codex-lb"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skips a protocol that does not match a built-in gateway profile", () => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-config-built-in-protocol-"));
  try {
    writeFileSync(join(root, ".looking-glass.json"), JSON.stringify({
      gateway: { provider: "openrouter", protocol: "responses", baseURL: "https://gateway.invalid/v1" },
    }));
    withIsolatedGlobalConfig(root, () => assert.equal(loadConfig(root).gateway.provider, "codex-lb"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skips a Responses protocol for OpenCode Go", () => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-config-opencode-go-protocol-"));
  try {
    writeFileSync(join(root, ".looking-glass.json"), JSON.stringify({
      gateway: { provider: "opencode-go", protocol: "responses", baseURL: "https://opencode.ai/zen/go/v1" },
    }));
    withIsolatedGlobalConfig(root, () => assert.equal(loadConfig(root).gateway.provider, "codex-lb"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves inherited custom protocol and credentials when a workspace only changes the URL", () => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-config-layering-"));
  const configHome = mkdtempSync(join(tmpdir(), "looking-glass-config-home-"));
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  const previousExplicitConfig = process.env.LOOKING_GLASS_CONFIG;
  try {
    mkdirSync(join(configHome, "looking-glass"), { recursive: true });
    writeFileSync(join(configHome, "looking-glass", "config.json"), JSON.stringify({
      gateway: {
        provider: "custom",
        protocol: "chat",
        baseURL: "http://127.0.0.1:9999/v1",
        apiKeyEnv: "MY_CUSTOM_KEY",
      },
    }));
    writeFileSync(join(root, ".looking-glass.json"), JSON.stringify({
      gateway: { baseURL: "http://127.0.0.1:9998/v1" },
    }));
    process.env.XDG_CONFIG_HOME = configHome;
    delete process.env.LOOKING_GLASS_CONFIG;

    const config = loadConfig(root);
    assert.equal(config.gateway.protocol, "chat");
    assert.equal(config.gateway.apiKeyEnv, "MY_CUSTOM_KEY");
    assert.equal(config.gateway.baseURL, "http://127.0.0.1:9998/v1");
  } finally {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    if (previousExplicitConfig === undefined) delete process.env.LOOKING_GLASS_CONFIG;
    else process.env.LOOKING_GLASS_CONFIG = previousExplicitConfig;
    rmSync(root, { recursive: true, force: true });
    rmSync(configHome, { recursive: true, force: true });
  }
});
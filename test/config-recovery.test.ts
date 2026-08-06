import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, loadConfig, persistGatewayConfig, writeGlobalConfig, writeSchedulerEnv } from "../src/config.js";

test("repairs malformed global config without retaining gateway secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-config-repair-"));
  const workspace = mkdtempSync(join(tmpdir(), "looking-glass-config-workspace-"));
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = root;
    const configDirectory = join(root, "looking-glass");
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(configDirectory, "config.json"), "{ malformed", "utf8");
    persistGatewayConfig({
      provider: "custom",
      baseURL: "http://127.0.0.1:9999/v1",
      apiKeyEnv: "LOOKING_GLASS_REPAIR_KEY",
      apiKey: "must-not-be-persisted",
    });
    const persisted = readFileSync(join(configDirectory, "config.json"), "utf8");
    assert.doesNotMatch(persisted, /must-not-be-persisted|"(?:apiKey|token|secret)"/i);
    assert.equal(loadConfig(workspace).gateway.apiKeyEnv, "LOOKING_GLASS_REPAIR_KEY");
  } finally {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("switching the primary provider retains the previous provider and existing gateways", () => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-config-provider-switch-"));
  const workspace = mkdtempSync(join(tmpdir(), "looking-glass-config-provider-workspace-"));
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = root;
    const configDirectory = join(root, "looking-glass");
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(configDirectory, "config.jsonc"), JSON.stringify({
      gateway: {
        provider: "codex-lb",
        protocol: "responses",
        baseURL: "http://127.0.0.1:2455/v1",
        apiKeyEnv: "CODEX_LB_API_KEY",
        timeoutMs: 1_234,
      },
      gateways: [{
        provider: "openrouter",
        protocol: "chat",
        baseURL: "https://openrouter.ai/api/v1",
        apiKeyEnv: "OPENROUTER_API_KEY",
        timeoutMs: 2_345,
      }],
    }), "utf8");

    writeGlobalConfig({
      provider: "opencode-go",
      baseURL: "https://opencode.ai/zen/go/v1",
      apiKeyEnv: "OPENCODE_API_KEY",
    });

    const config = loadConfig(workspace);
    assert.equal(config.gateway.provider, "opencode-go");
    assert.deepEqual(config.gateways.map((gateway) => gateway.provider), ["codex-lb", "openrouter"]);
    assert.deepEqual(config.gateways[0], {
      provider: "codex-lb",
      protocol: "responses",
      baseURL: "http://127.0.0.1:2455/v1",
      apiKeyEnv: "CODEX_LB_API_KEY",
      timeoutMs: 1_234,
    });
  } finally {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("provider persistence avoids duplicates and discards invalid retained gateways", () => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-config-provider-repair-"));
  const workspace = mkdtempSync(join(tmpdir(), "looking-glass-config-provider-repair-workspace-"));
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = root;
    const configDirectory = join(root, "looking-glass");
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(configDirectory, "config.json"), JSON.stringify({
      gateway: {
        provider: "custom",
        protocol: "chat",
        baseURL: "https://old.example/v1",
        apiKeyEnv: "OLD_CUSTOM_KEY",
        timeoutMs: 3_456,
      },
      gateways: [
        { provider: "custom", baseURL: "https://duplicate.example/v1" },
        { provider: "lm-studio", baseURL: "not-a-url" },
        { provider: "openrouter", baseURL: "https://openrouter.ai/api/v1" },
        { provider: "openrouter", baseURL: "https://duplicate-openrouter.example/v1" },
      ],
    }), "utf8");

    writeGlobalConfig({ provider: "custom", baseURL: "https://new.example/v1" });
    let config = loadConfig(workspace);
    assert.deepEqual(config.gateway, {
      provider: "custom",
      protocol: "chat",
      baseURL: "https://new.example/v1",
      apiKeyEnv: "OLD_CUSTOM_KEY",
      timeoutMs: 3_456,
    });
    assert.deepEqual(config.gateways.map((gateway) => gateway.provider), ["openrouter"]);
    assert.equal(config.gateways[0]?.baseURL, "https://openrouter.ai/api/v1");

    writeGlobalConfig({ provider: "openrouter", baseURL: "https://openrouter.ai/api/v1" });
    config = loadConfig(workspace);
    assert.equal(config.gateway.provider, "openrouter");
    assert.deepEqual(config.gateways.map((gateway) => gateway.provider), ["custom"]);

    writeFileSync(join(configDirectory, "config.json"), JSON.stringify({
      gateway: {
        provider: "custom",
        protocol: "invalid",
        baseURL: "https://malformed.example/v1",
        apiKeyEnv: "not valid",
        timeoutMs: -1,
      },
      gateways: [
        { provider: "lm-studio", baseURL: "http://127.0.0.1:1234/v1", protocol: null },
        { provider: "opencode-go", baseURL: "https://opencode.ai/zen/go/v1" },
      ],
    }), "utf8");
    writeGlobalConfig({ provider: "custom", baseURL: "https://repaired.example/v1" });
    config = loadConfig(workspace);
    assert.deepEqual(config.gateway, {
      provider: "custom",
      protocol: "responses",
      baseURL: "https://repaired.example/v1",
      apiKeyEnv: "CUSTOM_API_KEY",
      timeoutMs: DEFAULT_CONFIG.gateway.timeoutMs,
    });
    assert.deepEqual(config.gateways.map((gateway) => gateway.provider), ["opencode-go"]);
  } finally {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("skips malformed lower-priority config when a later layer is valid", () => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-config-layer-repair-"));
  const configHome = mkdtempSync(join(tmpdir(), "looking-glass-config-layer-home-"));
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  try {
    const configDirectory = join(configHome, "looking-glass");
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(configDirectory, "config.jsonc"), "{ malformed", "utf8");
    writeFileSync(join(configDirectory, "config.json"), JSON.stringify({
      gateway: { provider: "custom", baseURL: "http://127.0.0.1:9998/v1" },
    }), "utf8");
    process.env.XDG_CONFIG_HOME = configHome;
    assert.equal(loadConfig(root).gateway.baseURL, "http://127.0.0.1:9998/v1");
  } finally {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(configHome, { recursive: true, force: true });
  }
});

test("skips invalid apiKeyEnv layers while rejecting invalid scheduler entries", () => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-config-env-"));
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = root;
    writeFileSync(join(root, ".looking-glass.json"), JSON.stringify({
      gateway: { provider: "custom", baseURL: "http://127.0.0.1:9997/v1", apiKeyEnv: "not-valid" },
    }), "utf8");
    assert.notEqual(loadConfig(root).gateway.apiKeyEnv, "not-valid");
    assert.throws(() => writeSchedulerEnv("not-valid", "secret"), /apiKeyEnv must be a valid environment variable name/);
  } finally {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("repairs malformed scheduler environment entries", () => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-env-repair-"));
  const workspace = mkdtempSync(join(tmpdir(), "looking-glass-env-workspace-"));
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  const environmentName = "LOOKING_GLASS_ENV_REPAIR_KEY";
  const previousEnvironmentValue = process.env[environmentName];
  try {
    process.env.XDG_CONFIG_HOME = root;
    const configDirectory = join(root, "looking-glass");
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(configDirectory, "scheduler.env"), "not an assignment\n", "utf8");
    writeSchedulerEnv(environmentName, "repaired-value");
    const persisted = readFileSync(join(configDirectory, "scheduler.env"), "utf8");
    assert.doesNotMatch(persisted, /not an assignment/);
    delete process.env[environmentName];
    loadConfig(workspace);
    assert.equal(process.env[environmentName], "repaired-value");
  } finally {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    if (previousEnvironmentValue === undefined) delete process.env[environmentName];
    else process.env[environmentName] = previousEnvironmentValue;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("writeGlobalConfig rejects gateway URL query and fragment credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-config-url-"));
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = root;
    for (const baseURL of [
      "https://gateway.invalid/v1?api_key=query-secret",
      "https://gateway.invalid/v1#access_token=fragment-secret",
    ]) {
      assert.throws(() => writeGlobalConfig({ provider: "custom", baseURL }), /must not contain a query or fragment/);
    }
  } finally {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeSchedulerEnv removes duplicate assignments and rejects control characters", () => {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-env-write-"));
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  const environmentName = "LOOKING_GLASS_ENV_WRITE_KEY";
  try {
    process.env.XDG_CONFIG_HOME = root;
    const configDirectory = join(root, "looking-glass");
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(configDirectory, "scheduler.env"), [
      "OTHER_KEY=keep",
      `${environmentName}=old-one`,
      `${environmentName}=old-two`,
      "",
    ].join("\n"), "utf8");

    const path = writeSchedulerEnv(environmentName, "new-value");
    const persisted = readFileSync(path, "utf8");
    assert.equal(persisted.match(new RegExp(`^${environmentName}=`, "gm"))?.length, 1);
    assert.match(persisted, new RegExp(`^${environmentName}=new-value$`, "m"));
    assert.match(persisted, /^OTHER_KEY=keep$/m);

    for (const control of ["\u0000", "\n", "\r", "\u001f", "\u007f"]) {
      assert.throws(
        () => writeSchedulerEnv(environmentName, `safe${control}value`),
        /API key must not contain control characters/,
      );
    }
  } finally {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    rmSync(root, { recursive: true, force: true });
  }
});
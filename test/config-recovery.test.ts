import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, persistGatewayConfig, writeSchedulerEnv } from "../src/config.js";

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
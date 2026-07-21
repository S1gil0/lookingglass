import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

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
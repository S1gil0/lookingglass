import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configDir } from "../src/paths.js";
import { renderUnit } from "../src/scheduler/systemd.js";

function systemdLiteral(value: string): string {
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

test("renders a hardened user scheduler unit with explicit state path", () => {
  const unit = renderUnit(process.execPath, join(tmpdir(), "looking glass %h", "state.db"), {});
  assert.match(unit, /ExecStart=.* cron daemon/);
  assert.match(unit, /Environment="LOOKING_GLASS_DB=.*looking glass.*state\.db"/);
  assert.equal(unit.includes(`EnvironmentFile=-${systemdLiteral(join(configDir(), "scheduler.env"))}`), true);
  assert.match(unit, /looking glass %%h/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /RestartSec=25s/);
  assert.match(unit, /KillMode=control-group/);
  assert.match(unit, /UMask=0077/);
});

test("uses the current XDG config directory and only propagates scheduler environment", () => {
  const configHome = mkdtempSync(join(tmpdir(), "looking-glass-systemd-config-"));
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = configHome;
    const environment: NodeJS.ProcessEnv = {
      LOOKING_GLASS_CONFIG: "/tmp/looking-glass-config.jsonc",
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: "/tmp/looking-glass-data",
      UNRELATED_SCHEDULER_ENV: "must-not-be-inherited",
    };
    const unit = renderUnit(process.execPath, "/tmp/looking-glass-state.db", environment);

    assert.equal(
      unit.includes(`EnvironmentFile=-${systemdLiteral(join(configDir(), "scheduler.env"))}`),
      true,
    );
    assert.deepEqual(
      unit.split("\n").filter((line) => line.startsWith("Environment=")),
      [
        `Environment=${systemdLiteral("LOOKING_GLASS_DB=/tmp/looking-glass-state.db")}`,
        `Environment=${systemdLiteral("LOOKING_GLASS_CONFIG=/tmp/looking-glass-config.jsonc")}`,
        `Environment=${systemdLiteral(`XDG_CONFIG_HOME=${configHome}`)}`,
        `Environment=${systemdLiteral("XDG_DATA_HOME=/tmp/looking-glass-data")}`,
      ],
    );
    assert.equal(unit.includes("UNRELATED_SCHEDULER_ENV"), false);
  } finally {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    rmSync(configHome, { recursive: true, force: true });
  }
});

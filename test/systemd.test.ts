import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderUnit } from "../src/scheduler/systemd.js";

test("renders a hardened user scheduler unit with explicit state path", () => {
  const unit = renderUnit(process.execPath, join(tmpdir(), "looking glass %h", "state.db"));
  assert.match(unit, /ExecStart=.* cron daemon/);
  assert.match(unit, /Environment="LOOKING_GLASS_DB=.*looking glass.*state\.db"/);
  assert.match(unit, /EnvironmentFile=-%h\/\.config\/looking-glass\/scheduler\.env/);
  assert.match(unit, /looking glass %%h/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /RestartSec=25s/);
  assert.match(unit, /KillMode=control-group/);
  assert.match(unit, /UMask=0077/);
});

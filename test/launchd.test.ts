import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { schedulerForPlatform } from "../src/scheduler/service.js";
import {
  createLaunchdScheduler,
  installService,
  renderPlist,
  serviceStatus,
  uninstallService,
  LAUNCHD_LABEL,
} from "../src/scheduler/launchd.js";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "looking-glass-launchd-"));
  const cli = join(home, "cli.js");
  writeFileSync(cli, "#!/usr/bin/env node\n");
  return { home, cli, db: join(home, "state.db") };
}

function options(home: string, runner: (command: string, args: string[]) => { status: number; stdout?: string; stderr?: string }) {
  return { homeDirectory: home, uid: 501, command: runner, realpath: resolve };
}

test("renders an escaped launchd plist with the environment allowlist", () => {
  const plist = renderPlist({
    nodePath: "/Applications/Node & Tools/node\".exe",
    cliPath: "/Users/a< b>/glass.js",
    dbPath: "/Users/a's/state.db",
    home: "/Users/a&b",
    environment: {
      LOOKING_GLASS_CONFIG: "relative/config.jsonc",
      XDG_CONFIG_HOME: "/Users/a/config",
      XDG_DATA_HOME: "/Users/a/data",
      PATH: "/bin:/usr/bin",
      AWS_SECRET_ACCESS_KEY: "must-not-be-copied",
      LOOKING_GLASS_SCHEDULER_ENV: "must-not-be-copied",
    },
  });

  assert.match(plist, /<string>com\.sigil0\.looking-glass\.scheduler<\/string>/);
  assert.match(plist, /Node &amp; Tools\/node&quot;\.exe/);
  assert.match(plist, /a&lt; b&gt;\/glass\.js/);
  assert.match(plist, /a&apos;s\/state\.db/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>25<\/integer>/);
  assert.match(plist, /<key>Umask<\/key>\s*<integer>63<\/integer>/);
  for (const name of ["LOOKING_GLASS_DB", "LOOKING_GLASS_CONFIG", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "PATH"]) {
    assert.equal(plist.includes(`<key>${name}</key>`), true);
  }
  assert.equal(plist.includes(`<string>${resolve("relative/config.jsonc")}</string>`), true);
  assert.equal(plist.includes("AWS_SECRET_ACCESS_KEY"), false);
  assert.equal(plist.includes("LOOKING_GLASS_SCHEDULER_ENV"), false);
  assert.equal(plist.includes("StandardOutPath"), false);
  assert.equal(plist.includes("StandardErrorPath"), false);
});

test("runs the lifecycle through injected launchctl commands", () => {
  const { home, cli, db } = fixture();
  let loaded = false;
  const calls: string[][] = [];
  const runner = (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "print") return loaded ? { status: 0, stdout: "gui/501/label = {\n state = running\n}" } : { status: 113 };
    if (args[0] === "bootstrap") {
      loaded = true;
      return { status: 0 };
    }
    if (args[0] === "bootout") {
      loaded = false;
      return { status: 0 };
    }
    return { status: 0 };
  };
  const backend = createLaunchdScheduler(options(home, runner));
  const plistPath = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  assert.equal(backend.installService(cli, db), plistPath);
  if (process.platform !== "win32") assert.equal(statSync(plistPath).mode & 0o777, 0o600);
  assert.equal(backend.serviceStatus(), "LoadState=loaded\nActiveState=active\nSubState=running");
  assert.equal(backend.uninstallService(), true);
  assert.equal(existsSync(join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)), false);
  assert.deepEqual(calls.map((args) => args[0]), ["print", "bootstrap", "kickstart", "print", "print", "bootout"]);
  if (process.platform !== "win32") {
    assert.equal(statSync(join(home, "Library", "LaunchAgents")).mode & 0o777, 0o700);
  }
  rmSync(home, { recursive: true, force: true });
});

test("normalizes launchctl's stable missing-service status", () => {
  const { home } = fixture();
  const runner = () => ({ status: 113 });
  assert.equal(
    serviceStatus(options(home, runner)),
    "LoadState=not-found\nActiveState=inactive\nSubState=dead",
  );
  assert.equal(uninstallService(options(home, runner)), false);
  rmSync(home, { recursive: true, force: true });
});

test("reports a managed but unloaded job separately and surfaces launchctl failures", () => {
  const { home } = fixture();
  const plistPath = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plistPath, "managed");
  assert.match(serviceStatus(options(home, () => ({ status: 113 }))), /LoadState=unloaded/);
  assert.throws(
    () => serviceStatus(options(home, () => ({ status: 5, stderr: "launchctl unavailable" }))),
    /launchctl unavailable/,
  );
  rmSync(home, { recursive: true, force: true });
});

test("Darwin dispatches to launchd without invoking the host service manager", () => {
  const { home } = fixture();
  const calls: string[][] = [];
  const backend = schedulerForPlatform("darwin", {}, options(home, (_command, args) => {
    calls.push(args);
    return { status: 113 };
  }));

  assert.match(backend.serviceStatus(), /ActiveState=inactive/);
  assert.deepEqual(calls, [["print", `gui/501/${LAUNCHD_LABEL}`]]);
  rmSync(home, { recursive: true, force: true });
});

test("rolls back the plist and loaded job when activation fails", () => {
  const { home, cli, db } = fixture();
  const plistPath = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  const oldBytes = Buffer.from("old plist bytes\n");
  writeFileSync(plistPath, oldBytes);
  let bootstrapCount = 0;
  let loaded = true;
  const calls: string[][] = [];
  const runner = (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "print") return loaded ? { status: 0, stdout: "state = running" } : { status: 113 };
    if (args[0] === "bootout") {
      loaded = false;
      return { status: 0 };
    }
    if (args[0] === "bootstrap") {
      bootstrapCount += 1;
      if (bootstrapCount === 1) return { status: 1, stderr: "activation failed" };
      loaded = true;
      return { status: 0 };
    }
    return { status: 0 };
  };

  assert.throws(() => installService(cli, db, options(home, runner)), /activation failed/);
  assert.deepEqual(readFileSync(plistPath), oldBytes);
  assert.equal(loaded, true);
  assert.deepEqual(calls.map((args) => args[0]), ["print", "bootout", "bootstrap", "bootout", "bootstrap", "kickstart"]);
  rmSync(home, { recursive: true, force: true });
});

test("reports an incomplete rollback without hiding the activation failure", () => {
  const { home, cli, db } = fixture();
  const plistPath = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plistPath, "old plist");
  let bootoutCount = 0;
  let bootstrapCount = 0;
  const runner = (_command: string, args: string[]) => {
    if (args[0] === "print") return { status: 0, stdout: "state = running" };
    if (args[0] === "bootout") {
      bootoutCount += 1;
      return bootoutCount === 1 ? { status: 0 } : { status: 5, stderr: "rollback unload failed" };
    }
    if (args[0] === "bootstrap") {
      bootstrapCount += 1;
      return bootstrapCount === 1 ? { status: 5, stderr: "activation failed" } : { status: 0 };
    }
    return { status: 0 };
  };

  assert.throws(
    () => installService(cli, db, options(home, runner)),
    /launchd activation failed: activation failed; rollback was incomplete: rollback unload failed/,
  );
  assert.equal(readFileSync(plistPath, "utf8"), "old plist");
  rmSync(home, { recursive: true, force: true });
});

test("refuses an unknown loaded job without a managed plist", () => {
  const { home, cli, db } = fixture();
  const calls: string[][] = [];
  const runner = (_command: string, args: string[]) => {
    calls.push(args);
    return args[0] === "print" ? { status: 0, stdout: "state = running" } : { status: 0 };
  };
  assert.throws(() => installService(cli, db, options(home, runner)), /unmanaged loaded/);
  assert.throws(() => uninstallService(options(home, runner)), /unmanaged loaded/);
  assert.deepEqual(calls.map((args) => args[0]), ["print", "print"]);
  rmSync(home, { recursive: true, force: true });
});

test("does not replace the plist when unloading the old job fails", () => {
  const { home, cli, db } = fixture();
  const plistPath = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plistPath, "keep this plist");
  const runner = (_command: string, args: string[]) => args[0] === "print"
    ? { status: 0, stdout: "state = running" }
    : { status: 1, stderr: "unload failed" };
  assert.throws(() => installService(cli, db, options(home, runner)), /unload failed/);
  assert.equal(readFileSync(plistPath, "utf8"), "keep this plist");
  rmSync(home, { recursive: true, force: true });
});

test("uninstall preserves the managed plist when unloading fails", () => {
  const { home } = fixture();
  const plistPath = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plistPath, "keep this plist");
  const runner = (_command: string, args: string[]) => args[0] === "print"
    ? { status: 0, stdout: "state = running" }
    : { status: 1, stderr: "unload failed" };
  assert.throws(() => uninstallService(options(home, runner)), /unload failed/);
  assert.equal(readFileSync(plistPath, "utf8"), "keep this plist");
  rmSync(home, { recursive: true, force: true });
});

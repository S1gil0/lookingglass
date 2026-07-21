import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import test from "node:test";
import { configDir, dataDir, artifactsDir, stateDbPath, shouldEnforcePosixPermissions } from "../src/paths.js";

test("uses native Windows roaming and local data defaults without requiring Windows", () => {
  const home = "/test-home";
  const environment = {};
  assert.equal(configDir("win32", environment, home), win32.join(home, "AppData", "Roaming", "looking-glass"));
  assert.equal(dataDir("win32", environment, home), win32.join(home, "AppData", "Local", "looking-glass"));
  assert.equal(artifactsDir("win32", environment, home), win32.join(home, "AppData", "Local", "looking-glass", "artifacts"));
  assert.equal(stateDbPath("win32", environment, home), win32.join(home, "AppData", "Local", "looking-glass", "state.db"));
});

test("preserves XDG overrides and POSIX defaults", () => {
  const home = "/test-home";
  assert.equal(configDir("linux", {}, home), posix.join(home, ".config", "looking-glass"));
  assert.equal(dataDir("linux", {}, home), posix.join(home, ".local", "share", "looking-glass"));
  assert.equal(configDir("linux", { APPDATA: "/appdata" }, home), posix.join(home, ".config", "looking-glass"));
  assert.equal(dataDir("linux", { LOCALAPPDATA: "/localappdata" }, home), posix.join(home, ".local", "share", "looking-glass"));
  assert.equal(
    configDir("win32", { XDG_CONFIG_HOME: "/xdg/config", APPDATA: "/appdata" }, home),
    win32.join(win32.resolve("/xdg/config"), "looking-glass"),
  );
  assert.equal(
    dataDir("win32", { XDG_DATA_HOME: "/xdg/data", LOCALAPPDATA: "/localappdata" }, home),
    win32.join(win32.resolve("/xdg/data"), "looking-glass"),
  );
});

test("resolves POSIX database overrides to absolute paths", () => {
  assert.equal(
    stateDbPath("linux", { LOOKING_GLASS_DB: "relative/state.db" }),
    posix.resolve("relative/state.db"),
  );
  const absolute = "/var/lib/looking-glass/state.db";
  assert.equal(stateDbPath("linux", { LOOKING_GLASS_DB: absolute }), posix.resolve(absolute));
});

test("resolves Windows database overrides without requiring Windows", () => {
  const drivePath = "C:\\ProgramData\\looking-glass\\state.db";
  const uncPath = "\\\\server\\share\\looking-glass\\state.db";
  assert.equal(stateDbPath("win32", { LOOKING_GLASS_DB: drivePath }), drivePath);
  assert.equal(stateDbPath("win32", { LOOKING_GLASS_DB: uncPath }), uncPath);

  const relative = stateDbPath("win32", { LOOKING_GLASS_DB: "relative\\state.db" });
  assert.equal(relative, win32.resolve("relative\\state.db"));
  assert.equal(win32.isAbsolute(relative), true);
});

test("only POSIX platforms enforce mode-bit permissions", () => {
  assert.equal(shouldEnforcePosixPermissions("win32"), false);
  assert.equal(shouldEnforcePosixPermissions("linux"), true);
});
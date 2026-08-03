import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { LookingGlassApp } from "../src/app.js";
import { openDatabase } from "../src/storage/database.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { SessionStore } from "../src/storage/session-store.js";

interface Fixture {
  root: string;
  dbPath: string;
  artifactPath: string;
  agentId: string;
  artifactId: string;
  configHome: string;
  dataHome: string;
}

const environmentNames = [
  "LOOKING_GLASS_DB",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "LOOKING_GLASS_CONFIG",
] as const;

function maintenanceConfig(runOnStartup: boolean): Record<string, unknown> {
  return {
    maintenance: {
      runOnStartup,
      reconcileOrphanedTools: false,
      agentSessions: {
        maxAgeMs: 1,
        minAgeMs: 0,
        maxSessions: 500,
        maxLogicalBytes: 512 * 1024 * 1024,
        maxSessionsPerRun: 25,
        maxLogicalBytesPerRun: 64 * 1024 * 1024,
      },
      detachedArtifacts: {
        maxAgeMs: 1,
        minAgeMs: 0,
        maxArtifacts: 1_000,
        maxBytes: 1024 * 1024 * 1024,
        maxArtifactsPerRun: 100,
        maxBytesPerRun: 128 * 1024 * 1024,
      },
    },
  };
}

function createFixture(runOnStartup: boolean): Fixture {
  const root = mkdtempSync(join(tmpdir(), "looking-glass-maintenance-integration-"));
  const configHome = join(root, "config-home");
  const dataHome = join(root, "data-home");
  const dbPath = join(root, "state.db");
  const configDirectory = join(configHome, "looking-glass");
  const artifactDirectory = join(dataHome, "looking-glass", "artifacts");
  mkdirSync(configDirectory, { recursive: true });
  mkdirSync(artifactDirectory, { recursive: true });
  writeFileSync(join(configDirectory, "config.json"), JSON.stringify(maintenanceConfig(runOnStartup)));

  const db = openDatabase(dbPath);
  const sessions = new SessionStore(db);
  const artifacts = new ArtifactStore(db, artifactDirectory);
  const old = Date.now() - 60_000;
  const agent = sessions.create({
    workspace: root,
    model: "maintenance-test-model",
    reasoningEffort: "medium",
    verbosity: "low",
    fast: false,
    kind: "agent",
  });
  db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(old, agent.id);
  const artifact = artifacts.save(null, "maintenance-test", "maintenance-test-payload");
  db.prepare("UPDATE artifacts SET created_at = ? WHERE id = ?").run(old, artifact.id);
  db.close();

  return {
    root,
    dbPath,
    artifactPath: artifact.path,
    agentId: agent.id,
    artifactId: artifact.id,
    configHome,
    dataHome,
  };
}

function fixtureEnvironment(fixture: Fixture): Record<string, string> {
  return {
    LOOKING_GLASS_DB: fixture.dbPath,
    XDG_CONFIG_HOME: fixture.configHome,
    XDG_DATA_HOME: fixture.dataHome,
  };
}

function withFixtureEnvironment<T>(fixture: Fixture, callback: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const name of environmentNames) previous.set(name, process.env[name]);
  try {
    const environment = fixtureEnvironment(fixture);
    for (const name of environmentNames) {
      const value = environment[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return callback();
  } finally {
    for (const name of environmentNames) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function disposeFixture(fixture: Fixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}

function assertStored(fixture: Fixture, expected: boolean): void {
  const db = openDatabase(fixture.dbPath);
  try {
    const sessions = new SessionStore(db);
    const artifacts = new ArtifactStore(db, join(fixture.dataHome, "looking-glass", "artifacts"));
    assert.equal(sessions.get(fixture.agentId) !== null, expected);
    assert.equal(artifacts.get(fixture.artifactId) !== null, expected);
  } finally {
    db.close();
  }
  assert.equal(existsSync(fixture.artifactPath), expected);
}

test("LookingGlassApp applies startup maintenance to old ephemeral data", () => {
  const fixture = createFixture(true);
  try {
    withFixtureEnvironment(fixture, () => {
      const app = new LookingGlassApp(process.cwd());
      try {
        assert.equal(app.maintenanceError, null);
        assert.equal(app.maintenanceReport?.mode, "apply");
        assert.equal(app.maintenanceReport?.agentSessions.selected.sessions, 1);
        assert.equal(app.maintenanceReport?.detachedArtifacts.selected.artifacts, 1);
        assert.equal(app.sessions.get(fixture.agentId), null);
        assert.equal(app.artifacts.get(fixture.artifactId), null);
        assert.equal(existsSync(fixture.artifactPath), false);
      } finally {
        app.close();
      }
    });
  } finally {
    disposeFixture(fixture);
  }
});

test("startup maintenance honors a disabled configuration and remains explicitly runnable", () => {
  const fixture = createFixture(false);
  try {
    withFixtureEnvironment(fixture, () => {
      const app = new LookingGlassApp(process.cwd());
      try {
        assert.equal(app.maintenanceReport, null);
        assert.equal(app.maintenanceError, null);
        assert.ok(app.sessions.get(fixture.agentId));
        assert.ok(app.artifacts.get(fixture.artifactId));
        assert.equal(existsSync(fixture.artifactPath), true);

        const report = app.runMaintenance("apply");
        assert.equal(report.mode, "apply");
        assert.equal(report.agentSessions.selected.sessions, 1);
        assert.equal(report.detachedArtifacts.selected.artifacts, 1);
        assert.equal(app.sessions.get(fixture.agentId), null);
        assert.equal(app.artifacts.get(fixture.artifactId), null);
        assert.equal(existsSync(fixture.artifactPath), false);
      } finally {
        app.close();
      }
    });
  } finally {
    disposeFixture(fixture);
  }
});

test("workspace maintenance config cannot override the global policy for the shared database", () => {
  const fixture = createFixture(true);
  const workspace = join(fixture.root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, ".looking-glass.json"), JSON.stringify(maintenanceConfig(false)));
  try {
    withFixtureEnvironment(fixture, () => {
      const app = new LookingGlassApp(workspace);
      try {
        assert.equal(app.config.maintenance.runOnStartup, true);
        assert.equal(app.config.maintenance.agentSessions.maxAgeMs, 1);
        assert.equal(app.maintenanceReport?.mode, "apply");
        assert.equal(app.sessions.get(fixture.agentId), null);
        assert.equal(app.artifacts.get(fixture.artifactId), null);
      } finally {
        app.close();
      }
    });
  } finally {
    disposeFixture(fixture);
  }
});

test("explicit maintenance config can override the global policy", () => {
  const fixture = createFixture(false);
  const workspace = join(fixture.root, "workspace");
  const explicitPath = join(fixture.root, "explicit-config.json");
  mkdirSync(workspace);
  writeFileSync(join(workspace, ".looking-glass.json"), JSON.stringify(maintenanceConfig(false)));
  writeFileSync(explicitPath, JSON.stringify(maintenanceConfig(true)));
  try {
    withFixtureEnvironment(fixture, () => {
      process.env.LOOKING_GLASS_CONFIG = explicitPath;
      const app = new LookingGlassApp(workspace);
      try {
        assert.equal(app.config.maintenance.runOnStartup, true);
        assert.equal(app.maintenanceReport?.mode, "apply");
        assert.equal(app.sessions.get(fixture.agentId), null);
        assert.equal(app.artifacts.get(fixture.artifactId), null);
      } finally {
        app.close();
      }
    });
  } finally {
    disposeFixture(fixture);
  }
});

test("startup maintenance failures are captured without preventing app construction", () => {
  const fixture = createFixture(true);
  const db = openDatabase(fixture.dbPath);
  db.exec(`
    CREATE TRIGGER block_startup_session_delete
    BEFORE DELETE ON sessions
    BEGIN
      SELECT RAISE(ABORT, 'startup maintenance blocked');
    END;
  `);
  db.close();

  try {
    withFixtureEnvironment(fixture, () => {
      const app = new LookingGlassApp(process.cwd());
      try {
        assert.ok(app.engine);
        assert.equal(app.maintenanceReport, null);
        assert.ok(app.maintenanceError);
        assert.match(app.maintenanceError.message, /startup maintenance blocked/);
        assert.ok(app.sessions.get(fixture.agentId));
        assert.ok(app.artifacts.get(fixture.artifactId));
      } finally {
        app.close();
      }
    });
  } finally {
    disposeFixture(fixture);
  }
});

test("CLI maintenance dry-run previews old data without applying startup pruning", () => {
  const fixture = createFixture(true);
  try {
    const environment = {
      ...process.env,
      ...fixtureEnvironment(fixture),
    };
    delete environment.LOOKING_GLASS_CONFIG;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", resolve("src/cli.ts"), "maintenance", "--dry-run", "--json"],
      { cwd: process.cwd(), env: environment, encoding: "utf8" },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as {
      mode: string;
      dryRun: boolean;
      agentSessions: { selected: { sessions: number } };
      detachedArtifacts: { selected: { artifacts: number }; deletedFiles: number };
    };
    assert.equal(report.mode, "dry-run");
    assert.equal(report.dryRun, true);
    assert.equal(report.agentSessions.selected.sessions, 1);
    assert.equal(report.detachedArtifacts.selected.artifacts, 1);
    assert.equal(report.detachedArtifacts.deletedFiles, 0);
    assertStored(fixture, true);
  } finally {
    disposeFixture(fixture);
  }
});
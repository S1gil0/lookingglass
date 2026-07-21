import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SERVICE_NAME = "looking-glass-scheduler.service";

function quote(value: string): string {
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function systemctl(args: string[], tolerateFailure = false): string {
  const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
  if (result.status !== 0 && !tolerateFailure) {
    throw new Error((result.stderr || result.stdout || `systemctl exited with ${String(result.status)}`).trim());
  }
  return (result.stdout || result.stderr).trim();
}

export function userUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", SERVICE_NAME);
}

export function renderUnit(cliPath: string, dbPath: string): string {
  const nodePath = realpathSync(process.execPath);
  const resolvedCli = realpathSync(cliPath);
  return `[Unit]
Description=Looking Glass persistent scheduler
After=local-fs.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=exec
ExecStart=${quote(nodePath)} ${quote(resolvedCli)} cron daemon
Environment=${quote(`LOOKING_GLASS_DB=${dbPath}`)}
EnvironmentFile=-%h/.config/looking-glass/scheduler.env
WorkingDirectory=%h
Restart=on-failure
RestartSec=25s
KillMode=control-group
KillSignal=SIGTERM
SendSIGKILL=yes
TimeoutStopSec=20s
UMask=0077
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

export function installService(cliPath: string, dbPath: string): string {
  const path = userUnitPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const previous = existsSync(path) ? readFileSync(path) : null;
  const temp = `${path}.${randomUUID()}.service`;
  writeFileSync(temp, renderUnit(cliPath, dbPath), { mode: 0o600, flag: "wx" });
  const verify = spawnSync("systemd-analyze", ["--user", "verify", temp], { encoding: "utf8" });
  if (verify.status !== 0) {
    unlinkSync(temp);
    throw new Error((verify.stderr || verify.stdout || "systemd unit verification failed").trim());
  }
  renameSync(temp, path);
  try {
    systemctl(["daemon-reload"]);
    systemctl(["enable", SERVICE_NAME]);
    systemctl(["restart", SERVICE_NAME]);
  } catch (error) {
    if (previous) writeFileSync(path, previous, { mode: 0o600 });
    else unlinkSync(path);
    systemctl(["daemon-reload"], true);
    if (previous) systemctl(["restart", SERVICE_NAME], true);
    throw error;
  }
  return path;
}

export function serviceStatus(): string {
  const state = systemctl([
    "show",
    SERVICE_NAME,
    "--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus",
  ], true);
  return state || "systemd user service is unavailable or not installed";
}

export function uninstallService(): boolean {
  const path = userUnitPath();
  if (!existsSync(path)) {
    systemctl(["daemon-reload"], true);
    return false;
  }
  systemctl(["disable", "--now", SERVICE_NAME]);
  unlinkSync(path);
  systemctl(["daemon-reload"], true);
  return true;
}

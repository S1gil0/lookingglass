import * as systemd from "./systemd.js";
import { createWindowsScheduler, type WindowsScheduler, type WindowsServiceOptions } from "./windows.js";

export interface SchedulerService {
  installService(cliPath: string, dbPath: string): string;
  serviceStatus(): string;
  uninstallService(): boolean;
}

/** Select the native scheduler without making callers know the host OS. */
export function schedulerForPlatform(
  platform: NodeJS.Platform = process.platform,
  windowsOptions: WindowsServiceOptions = {},
): SchedulerService {
  if (platform === "win32") return createWindowsScheduler(windowsOptions);
  return systemd;
}

/** Alias that reads naturally at call sites which need the selected backend. */
export const platformScheduler = schedulerForPlatform;

export function installService(cliPath: string, dbPath: string): string {
  return schedulerForPlatform().installService(cliPath, dbPath);
}

export function serviceStatus(): string {
  return schedulerForPlatform().serviceStatus();
}

export function uninstallService(): boolean {
  return schedulerForPlatform().uninstallService();
}

export type { WindowsScheduler, WindowsServiceOptions };

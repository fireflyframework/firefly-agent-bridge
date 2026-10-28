/*!
 * Copyright (c) 2026 Signature Management Consultants SLU
 * Author: @ancongui (https://github.com/ancongui)
 * Modified by Firefly Software Foundation for Firefly Agent Bridge (2026).
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export type DaemonRole = "coordinator" | "worker";

export type DaemonPaths = {
  pidFile: string;
  logFile: string;
};

export function defaultDaemonPaths(
  dataDir: string,
  role: DaemonRole,
): DaemonPaths {
  return {
    pidFile: join(dataDir, `firefly-bridge-${role}.pid`),
    logFile: join(dataDir, `firefly-bridge-${role}.log`),
  };
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  const raw = readFileSync(pidFile, "utf8").trim();
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

export function writePidFile(pidFile: string, pid: number): void {
  mkdirSync(dirname(pidFile), { recursive: true, mode: 0o700 });
  writeFileSync(pidFile, String(pid) + "\n", { mode: 0o600 });
}

export function clearPidFile(pidFile: string): void {
  if (existsSync(pidFile)) unlinkSync(pidFile);
}

export function daemonStatus(pidFile: string): {
  running: boolean;
  pid: number | null;
} {
  const pid = readPid(pidFile);
  if (pid == null) return { running: false, pid: null };
  if (!isProcessAlive(pid)) {
    clearPidFile(pidFile);
    return { running: false, pid: null };
  }
  return { running: true, pid };
}

export type StartDaemonOptions = {
  pidFile: string;
  logFile: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  ready: () => Promise<boolean> | boolean;
  timeoutMs?: number;
  spawnFn?: typeof spawn;
};

export async function startDaemonProcess(
  options: StartDaemonOptions,
): Promise<{ pid: number }> {
  const existing = daemonStatus(options.pidFile);
  if (existing.running)
    throw new Error(`Daemon already running (pid ${existing.pid})`);
  mkdirSync(dirname(options.logFile), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(options.pidFile), { recursive: true, mode: 0o700 });
  const log = openSync(options.logFile, "a", 0o600);
  const spawnFn = options.spawnFn ?? spawn;
  let child: ChildProcess;
  try {
    child = spawnFn(options.command, options.args, {
      detached: true,
      stdio: ["ignore", log, log],
      env: options.env ?? process.env,
      cwd: options.cwd,
      windowsHide: true,
    });
  } finally {
    closeSync(log);
  }
  child.on("error", () => {});
  const pid = child.pid;
  if (pid == null) {
    child.unref();
    throw new Error("Failed to start daemon process");
  }
  writePidFile(options.pidFile, pid);
  child.unref();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      clearPidFile(options.pidFile);
      throw new Error(
        "Daemon process exited before becoming ready; inspect logfile",
      );
    }
    if (await options.ready()) return { pid };
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* ignore */
  }
  clearPidFile(options.pidFile);
  throw new Error("Daemon ready timeout; inspect logfile");
}

export async function stopDaemonProcess(
  pidFile: string,
  options: { escalateAfterMs?: number } = {},
): Promise<{ stopped: boolean; pid: number | null }> {
  const status = daemonStatus(pidFile);
  if (!status.running || status.pid == null)
    return { stopped: true, pid: null };
  const pid = status.pid;
  const escalateAfterMs = options.escalateAfterMs ?? 5_000;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    clearPidFile(pidFile);
    return { stopped: true, pid };
  }
  const softDeadline = Date.now() + escalateAfterMs;
  while (Date.now() < softDeadline) {
    if (!isProcessAlive(pid)) {
      clearPidFile(pidFile);
      return { stopped: true, pid };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* ignore */
  }
  const hardDeadline = Date.now() + 2_000;
  while (Date.now() < hardDeadline) {
    if (!isProcessAlive(pid)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  clearPidFile(pidFile);
  return { stopped: !isProcessAlive(pid), pid };
}

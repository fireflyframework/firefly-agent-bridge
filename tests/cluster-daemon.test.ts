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

import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  daemonStatus,
  defaultDaemonPaths,
  startDaemonProcess,
  stopDaemonProcess,
} from "../src/cluster-daemon.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()!;
    try {
      const status = daemonStatus(join(dir, "daemon.pid"));
      if (status.running && status.pid)
        stopDaemonProcess(join(dir, "daemon.pid"), { escalateAfterMs: 200 });
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("cluster-daemon", () => {
  it("resolves default pid and log paths under dataDir", () => {
    const paths = defaultDaemonPaths("/var/lib/ffb", "coordinator");
    expect(paths.pidFile).toContain("coordinator");
    expect(paths.pidFile.endsWith(".pid")).toBe(true);
    expect(paths.logFile.endsWith(".log")).toBe(true);
  });

  it("reports not running when pidfile is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-daemon-"));
    dirs.push(dir);
    expect(daemonStatus(join(dir, "missing.pid"))).toEqual({
      running: false,
      pid: null,
    });
  });

  it("clears stale pidfile when process is dead", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-daemon-"));
    dirs.push(dir);
    const pidFile = join(dir, "daemon.pid");
    writeFileSync(pidFile, "999999999\n", { mode: 0o600 });
    expect(daemonStatus(pidFile)).toEqual({ running: false, pid: null });
    expect(existsSync(pidFile)).toBe(false);
  });

  it("starts a detached process, writes pidfile, and stops it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-daemon-"));
    dirs.push(dir);
    const pidFile = join(dir, "daemon.pid");
    const logFile = join(dir, "daemon.log");
    const readyFile = join(dir, "ready");
    const started = await startDaemonProcess({
      pidFile,
      logFile,
      command: process.execPath,
      args: [
        "-e",
        `require('fs').writeFileSync(${JSON.stringify(readyFile)}, 'ok'); setInterval(() => {}, 1000);`,
      ],
      ready: async () => existsSync(readyFile),
      timeoutMs: 5_000,
    });
    expect(started.pid).toBeGreaterThan(0);
    expect(existsSync(pidFile)).toBe(true);
    expect(Number(readFileSync(pidFile, "utf8").trim())).toBe(started.pid);
    expect(daemonStatus(pidFile)).toEqual({ running: true, pid: started.pid });
    const stopped = await stopDaemonProcess(pidFile, { escalateAfterMs: 500 });
    expect(stopped.stopped).toBe(true);
    expect(daemonStatus(pidFile).running).toBe(false);
  });
});

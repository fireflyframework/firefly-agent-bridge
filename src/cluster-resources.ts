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

import { statfsSync as defaultStatfsSync } from "node:fs";
import {
  cpus as defaultCpus,
  freemem as defaultFreemem,
  loadavg as defaultLoadavg,
  platform as defaultPlatform,
  totalmem as defaultTotalmem,
} from "node:os";
import type { NodeResources } from "./cluster-types.js";

export type CpuTimesSample = {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
};

export type StatfsSample = {
  bsize: number;
  blocks: number;
  bavail: number;
};

export type CollectNodeResourcesOptions = {
  platform?: string;
  now?: () => Date;
  totalmem?: () => number;
  freemem?: () => number;
  cpus?: () => Array<{ times: CpuTimesSample }>;
  loadavg?: () => [number, number, number];
  statfsSync?: (path: string) => StatfsSample;
  /** Prior heartbeat CPU times; required for win32 busyRatio (and preferred everywhere). */
  previousCpuTimes?: CpuTimesSample[] | null;
  logError?: (message: string, error: unknown) => void;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizePlatform(
  platform: string,
): NodeResources["platform"] {
  if (platform === "darwin" || platform === "linux" || platform === "win32")
    return platform;
  return "unknown";
}

function sumTimes(samples: CpuTimesSample[]): {
  idle: number;
  total: number;
} {
  let idle = 0;
  let total = 0;
  for (const sample of samples) {
    const tick =
      sample.user + sample.nice + sample.sys + sample.idle + sample.irq;
    idle += sample.idle;
    total += tick;
  }
  return { idle, total };
}

/**
 * Busy ratio from two CPU times snapshots (idle/total delta), clamped 0–1.
 * Fail closed (1) when samples are empty or the delta total is zero.
 */
export function busyRatioFromCpuTimes(
  previous: CpuTimesSample[],
  next: CpuTimesSample[],
): number {
  if (previous.length === 0 || next.length === 0) return 1;
  const before = sumTimes(previous);
  const after = sumTimes(next);
  const idleDelta = after.idle - before.idle;
  const totalDelta = after.total - before.total;
  if (totalDelta <= 0) return 1;
  return clamp01(1 - idleDelta / totalDelta);
}

function failClosedMemory(): NodeResources["memory"] {
  return { totalBytes: 0, freeBytes: 0, usedRatio: 1 };
}

function failClosedDisk(path: string): NodeResources["disk"] {
  return { path, totalBytes: 0, freeBytes: 0, usedRatio: 1 };
}

function failClosedCpu(load: [number, number, number]): NodeResources["cpu"] {
  return {
    cores: 1,
    busyRatio: 1,
    load1: load[0],
    load5: load[1],
    load15: load[2],
  };
}

let loggedOnce = new Set<string>();

function logOnce(
  key: string,
  message: string,
  error: unknown,
  logError: CollectNodeResourcesOptions["logError"],
): void {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  if (logError) logError(message, error);
  else console.error(message, error);
}

/** Test-only: clear one-shot error log keys. */
export function resetResourceProbeLogKeys(): void {
  loggedOnce = new Set();
}

/**
 * Portable RAM / CPU / disk probe for worker heartbeats (darwin, linux, win32).
 * Never throws: failed dimensions report usedRatio/busyRatio 1 (fail closed).
 * Workers should pass `previousCpuTimes` from the prior beat for busyRatio on win32.
 */
export function collectNodeResources(
  workspace: string,
  options: CollectNodeResourcesOptions = {},
): NodeResources {
  const platformName = options.platform ?? defaultPlatform();
  const platform = normalizePlatform(platformName);
  const now = options.now ?? (() => new Date());
  const totalmem = options.totalmem ?? defaultTotalmem;
  const freemem = options.freemem ?? defaultFreemem;
  const cpus = options.cpus ?? defaultCpus;
  const loadavg = options.loadavg ?? defaultLoadavg;
  const statfs =
    options.statfsSync ??
    ((path: string) => defaultStatfsSync(path) as StatfsSample);
  const logError = options.logError;

  let load: [number, number, number] = [0, 0, 0];
  if (platform === "win32") {
    load = [0, 0, 0];
  } else {
    try {
      const avg = loadavg();
      load = [avg[0] ?? 0, avg[1] ?? 0, avg[2] ?? 0];
    } catch (error) {
      logOnce("loadavg", "cluster resource probe: loadavg failed", error, logError);
      load = [0, 0, 0];
    }
  }

  let memory: NodeResources["memory"];
  try {
    const totalBytes = totalmem();
    const freeBytes = freemem();
    memory = {
      totalBytes,
      freeBytes,
      usedRatio:
        totalBytes > 0 ? clamp01(1 - freeBytes / totalBytes) : 1,
    };
  } catch (error) {
    logOnce("memory", "cluster resource probe: memory failed", error, logError);
    memory = failClosedMemory();
  }

  let disk: NodeResources["disk"];
  try {
    const stats = statfs(workspace);
    const totalBytes = stats.bsize * stats.blocks;
    const freeBytes = stats.bsize * stats.bavail;
    disk = {
      path: workspace,
      totalBytes,
      freeBytes,
      usedRatio:
        totalBytes > 0 ? clamp01(1 - freeBytes / totalBytes) : 1,
    };
  } catch (error) {
    logOnce("disk", "cluster resource probe: disk failed", error, logError);
    disk = failClosedDisk(workspace);
  }

  let cpu: NodeResources["cpu"];
  try {
    const list = cpus();
    const cores = Math.max(1, list.length);
    const currentTimes = list.map((cpuInfo) => ({ ...cpuInfo.times }));
    let busyRatio: number;
    if (options.previousCpuTimes != null && options.previousCpuTimes.length > 0) {
      busyRatio = busyRatioFromCpuTimes(options.previousCpuTimes, currentTimes);
    } else if (platform !== "win32" && cores > 0) {
      busyRatio = clamp01(load[0] / cores);
    } else {
      busyRatio = 1;
    }
    cpu = {
      cores,
      busyRatio,
      load1: load[0],
      load5: load[1],
      load15: load[2],
    };
  } catch (error) {
    logOnce("cpu", "cluster resource probe: cpu failed", error, logError);
    cpu = failClosedCpu(load);
  }

  return {
    platform,
    collectedAt: now().toISOString(),
    cpu,
    memory,
    disk,
  };
}

/** Exhausted snapshot for missing capacity (fail closed for eligibility). */
export function exhaustedNodeResources(
  workspace = "",
  platform: NodeResources["platform"] = "unknown",
): NodeResources {
  return {
    platform,
    collectedAt: new Date(0).toISOString(),
    cpu: failClosedCpu([0, 0, 0]),
    memory: failClosedMemory(),
    disk: failClosedDisk(workspace),
  };
}

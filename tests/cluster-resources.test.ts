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

import { expect, it } from "vitest";
import {
  busyRatioFromCpuTimes,
  collectNodeResources,
  type CpuTimesSample,
} from "../src/cluster-resources.js";
import { nodeCapacitySchema, nodeResourcesSchema } from "../src/cluster-types.js";

const idle: CpuTimesSample = {
  user: 100,
  nice: 0,
  sys: 50,
  idle: 850,
  irq: 0,
};
const busy: CpuTimesSample = {
  user: 400,
  nice: 0,
  sys: 150,
  idle: 900,
  irq: 0,
};

it("busyRatioFromCpuTimes uses idle/total delta across CPUs", () => {
  // Delta: user+sys+nice+irq = 400, idle = 50, total = 450 → busy = 400/450
  expect(busyRatioFromCpuTimes([idle], [busy])).toBeCloseTo(400 / 450, 5);
});

it("busyRatioFromCpuTimes returns 1 when samples are empty or zero-delta", () => {
  expect(busyRatioFromCpuTimes([], [busy])).toBe(1);
  expect(busyRatioFromCpuTimes([idle], [idle])).toBe(1);
});

it("collectNodeResources probes memory, disk via statfs, and cpu times", () => {
  const resources = collectNodeResources("/workspace", {
    platform: "linux",
    now: () => new Date("2026-10-27T12:00:00.000Z"),
    totalmem: () => 8_000_000_000,
    freemem: () => 2_000_000_000,
    cpus: () => [{ times: busy }, { times: busy }],
    loadavg: () => [1.5, 1.0, 0.5],
    previousCpuTimes: [idle, idle],
    statfsSync: () => ({
      bsize: 4096,
      blocks: 1_000_000,
      bavail: 250_000,
    }),
  });
  expect(nodeResourcesSchema.parse(resources)).toEqual(resources);
  expect(resources.platform).toBe("linux");
  expect(resources.collectedAt).toBe("2026-10-27T12:00:00.000Z");
  expect(resources.cpu.cores).toBe(2);
  expect(resources.cpu.load1).toBe(1.5);
  expect(resources.cpu.load5).toBe(1.0);
  expect(resources.cpu.load15).toBe(0.5);
  expect(resources.cpu.busyRatio).toBeCloseTo(400 / 450, 5);
  expect(resources.memory).toEqual({
    totalBytes: 8_000_000_000,
    freeBytes: 2_000_000_000,
    usedRatio: 0.75,
  });
  expect(resources.disk).toEqual({
    path: "/workspace",
    totalBytes: 4096 * 1_000_000,
    freeBytes: 4096 * 250_000,
    usedRatio: 0.75,
  });
});

it("win32 reports zero loadavg and still computes busyRatio from cpu times", () => {
  const resources = collectNodeResources("C:\\\\jobs", {
    platform: "win32",
    now: () => new Date("2026-10-27T12:00:00.000Z"),
    totalmem: () => 16_000_000_000,
    freemem: () => 8_000_000_000,
    cpus: () => [{ times: busy }],
    loadavg: () => {
      throw new Error("loadavg unsupported");
    },
    previousCpuTimes: [idle],
    statfsSync: () => ({
      bsize: 4096,
      blocks: 100,
      bavail: 50,
    }),
  });
  expect(resources.platform).toBe("win32");
  expect(resources.cpu.load1).toBe(0);
  expect(resources.cpu.load5).toBe(0);
  expect(resources.cpu.load15).toBe(0);
  expect(resources.cpu.busyRatio).toBeCloseTo(400 / 450, 5);
});

it("fails closed with usedRatio/busyRatio 1 when probes throw", () => {
  const logged: string[] = [];
  const resources = collectNodeResources("/bad", {
    platform: "darwin",
    now: () => new Date("2026-10-27T12:00:00.000Z"),
    totalmem: () => {
      throw new Error("mem boom");
    },
    freemem: () => {
      throw new Error("mem boom");
    },
    cpus: () => {
      throw new Error("cpu boom");
    },
    loadavg: () => {
      throw new Error("load boom");
    },
    statfsSync: () => {
      throw new Error("disk boom");
    },
    logError: (message) => {
      logged.push(message);
    },
  });
  expect(resources.memory.usedRatio).toBe(1);
  expect(resources.memory.freeBytes).toBe(0);
  expect(resources.disk.usedRatio).toBe(1);
  expect(resources.disk.freeBytes).toBe(0);
  expect(resources.cpu.busyRatio).toBe(1);
  expect(resources.cpu.cores).toBe(1);
  expect(logged.length).toBeGreaterThan(0);
});

it("nodeCapacitySchema requires resources", () => {
  expect(() =>
    nodeCapacitySchema.parse({
      worker: "claude",
      concurrency: 1,
      active: 0,
      freeSlots: 1,
      authentication: "authenticated",
      quota: {
        state: "ok",
        resetAt: null,
        windowStartedAt: "2026-10-27T00:00:00.000Z",
        estimatedUsedUnits: 0,
        estimatedCapacityUnits: 100,
      },
      reservePercent: 10,
      draining: false,
    }),
  ).toThrow();

  const ok = nodeCapacitySchema.parse({
    worker: "claude",
    concurrency: 1,
    active: 0,
    freeSlots: 1,
    authentication: "authenticated",
    quota: {
      state: "ok",
      resetAt: null,
      windowStartedAt: "2026-10-27T00:00:00.000Z",
      estimatedUsedUnits: 0,
      estimatedCapacityUnits: 100,
    },
    resources: collectNodeResources("/tmp", {
      platform: "linux",
      now: () => new Date("2026-10-27T12:00:00.000Z"),
      totalmem: () => 4_000_000_000,
      freemem: () => 2_000_000_000,
      cpus: () => [{ times: idle }],
      loadavg: () => [0, 0, 0],
      previousCpuTimes: [idle],
      statfsSync: () => ({ bsize: 1024, blocks: 1000, bavail: 500 }),
    }),
    reservePercent: 10,
    draining: false,
  });
  expect(ok.resources.platform).toBe("linux");
});

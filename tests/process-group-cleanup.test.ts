/*!
 * Copyright 2026 Firefly Software Foundation
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under https://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it, vi } from "vitest";
import { ProcessGroupCleanup } from "../src/process-group-cleanup.js";

function failure(code: string) {
  return Object.assign(new Error("private diagnostic must never escape"), {
    code,
  });
}
function boundary(probes: Array<string | "live">) {
  let now = 0;
  const waits: number[] = [];
  const signals: Array<[number, NodeJS.Signals | 0]> = [];
  const pending = [...probes];
  return {
    waits,
    signals,
    now: () => now,
    wait: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
    signal: (pid: number, signal: NodeJS.Signals | 0) => {
      signals.push([pid, signal]);
      if (signal !== 0) throw failure("EPERM");
      const probe = pending.shift() ?? probes.at(-1)!;
      if (probe !== "live") throw failure(probe);
      return true;
    },
  };
}

describe("owned process-group cleanup", () => {
  it("requires observed group absence after transient permission failures", async () => {
    const io = boundary(["EPERM", "live", "ESRCH"]);
    const cleanup = new ProcessGroupCleanup(123, io);
    cleanup.signal("SIGTERM", "stop");
    cleanup.signal("SIGKILL", "close");
    await expect(cleanup.complete()).resolves.toBeUndefined();
    expect(io.signals).toEqual([
      [-123, "SIGTERM"],
      [-123, "SIGKILL"],
      [-123, 0],
      [-123, 0],
      [-123, 0],
    ]);
    expect(io.waits).toEqual([10, 10]);
  });
  it.each(["EPERM", "live"])(
    "fails closed within the fixed budget for persistent %s",
    async (probe) => {
      const io = boundary([probe]);
      const cleanup = new ProcessGroupCleanup(123, io);
      cleanup.signal("SIGKILL", "close");
      await expect(cleanup.complete()).resolves.toBe(
        "process_cleanup_failed:close:EPERM",
      );
      expect(io.now()).toBe(250);
      expect(io.waits).toHaveLength(25);
      expect(io.signals.filter(([, signal]) => signal === 0)).toHaveLength(25);
    },
  );
  it.each(["EACCES", "EINVAL", "EIO", "PRIVATE_ERROR"])(
    "keeps prior %s failures sticky even if the group later disappears",
    async (code) => {
      const io = boundary(["ESRCH"]);
      const signal = io.signal;
      let first = true;
      io.signal = (pid, kind) => {
        if (first) {
          first = false;
          throw failure(code);
        }
        return signal(pid, kind);
      };
      const cleanup = new ProcessGroupCleanup(123, io);
      cleanup.signal("SIGTERM", "stop");
      cleanup.signal("SIGKILL", "close");
      await expect(cleanup.complete()).resolves.toBe(
        `process_cleanup_failed:stop:${code === "PRIVATE_ERROR" ? "UNKNOWN" : code}`,
      );
      expect(io.signals.some(([, kind]) => kind === 0)).toBe(false);
      expect(io.waits).toEqual([]);
    },
  );
  it.each(["EACCES", "PRIVATE_ERROR"])(
    "fails closed on a new observation error %s",
    async (code) => {
      const io = boundary([code]);
      const cleanup = new ProcessGroupCleanup(123, io);
      cleanup.signal("SIGKILL", "escalate");
      await expect(cleanup.complete()).resolves.toBe(
        `process_cleanup_failed:observe:${code === "PRIVATE_ERROR" ? "UNKNOWN" : code}`,
      );
      expect(io.waits).toEqual([]);
    },
  );
  it("does not poll or delay when signals succeed or report an absent group", async () => {
    for (const absent of [false, true]) {
      const signal = vi.fn(() => {
        if (absent) throw failure("ESRCH");
      });
      const wait = vi.fn(async () => {});
      const cleanup = new ProcessGroupCleanup(123, {
        signal,
        now: () => 0,
        wait,
      });
      cleanup.signal("SIGKILL", "close");
      await expect(cleanup.complete()).resolves.toBeUndefined();
      expect(signal).toHaveBeenCalledExactlyOnceWith(-123, "SIGKILL");
      expect(wait).not.toHaveBeenCalled();
    }
  });
  it("awaits the final observation instead of returning before its decision", async () => {
    const io = boundary(["EPERM", "ESRCH"]);
    let release!: () => void;
    io.wait = async () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const cleanup = new ProcessGroupCleanup(123, io);
    cleanup.signal("SIGKILL", "close");
    let settled = false;
    const result = cleanup.complete().then((fault) => {
      settled = true;
      return fault;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(result).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });
  it("does not wait or signal again after a probe consumes the budget", async () => {
    const io = boundary(["EPERM"]);
    const clock = [0, 0, 251];
    io.now = () => clock.shift() ?? 251;
    const cleanup = new ProcessGroupCleanup(123, io);
    cleanup.signal("SIGKILL", "close");
    await expect(cleanup.complete()).resolves.toBe(
      "process_cleanup_failed:close:EPERM",
    );
    expect(io.waits).toEqual([]);
    expect(io.signals).toEqual([
      [-123, "SIGKILL"],
      [-123, 0],
    ]);
  });
  it("sanitizes thrown non-Error values", async () => {
    const cleanup = new ProcessGroupCleanup(123, {
      signal: () => {
        throw "private unknown exception";
      },
      now: () => 0,
      wait: async () => {},
    });
    cleanup.signal("SIGKILL", "close");
    await expect(cleanup.complete()).resolves.toBe(
      "process_cleanup_failed:close:UNKNOWN",
    );
  });
});

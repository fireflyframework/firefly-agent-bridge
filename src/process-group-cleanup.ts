/*!
 * Copyright 2026 Firefly Software Foundation
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under https://www.apache.org/licenses/LICENSE-2.0
 */

import { setTimeout as pause } from "node:timers/promises";

type Phase = "stop" | "escalate" | "close" | "observe";
type Failure = { phase: Phase; code: string };
type Boundary = {
  signal: (pid: number, signal: NodeJS.Signals | 0) => unknown;
  now: () => number;
  wait: (ms: number) => Promise<unknown>;
};
const errorCodes = new Set([
  "EPERM",
  "ESRCH",
  "EACCES",
  "EINVAL",
  "EIO",
  "EINTR",
  "ENOSYS",
  "EAGAIN",
]);
function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "UNKNOWN";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && errorCodes.has(code) ? code : "UNKNOWN";
}
function fault({ phase, code }: Failure): string {
  return `process_cleanup_failed:${phase}:${code}`;
}

/** Signals remain synchronous; only close-time observation may wait. */
export class ProcessGroupCleanup {
  private failures: Failure[] = [];
  constructor(
    private pid: number,
    private boundary: Boundary = {
      signal: (pid, signal) => process.kill(pid, signal),
      now: () => performance.now(),
      wait: pause,
    },
  ) {}
  signal(signal: NodeJS.Signals, phase: Exclude<Phase, "observe">): void {
    try {
      this.boundary.signal(-this.pid, signal);
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ESRCH") this.failures.push({ phase, code });
    }
  }
  async complete(): Promise<string | undefined> {
    const first = this.failures[0];
    if (!first) return;
    const genuine = this.failures.find(({ code }) => code !== "EPERM");
    if (genuine) return fault(genuine);
    // Darwin can report EPERM for an unreaped, zombie-only group. Permission
    // errors alone never establish cleanup: require a later native ESRCH.
    const deadline = this.boundary.now() + 250;
    while (this.boundary.now() < deadline) {
      try {
        this.boundary.signal(-this.pid, 0);
      } catch (error) {
        const code = errorCode(error);
        if (code === "ESRCH") return;
        if (code !== "EPERM") return fault({ phase: "observe", code });
      }
      const remaining = deadline - this.boundary.now();
      if (remaining <= 0) break;
      await this.boundary.wait(Math.min(10, remaining));
    }
    return fault(first);
  }
}

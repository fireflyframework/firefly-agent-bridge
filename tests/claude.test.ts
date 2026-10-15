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

import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { ClaudeWorker } from "../src/claude.js";
import { prepareCompletion } from "../src/completion-protocol.js";
import type { Job, Attempt } from "../src/contracts.js";
let dir: string;
const fixture = resolve("tests/fixtures/claude-process.mjs");
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-worker-"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});
function worker(overrides: Record<string, unknown> = {}) {
  return new ClaudeWorker({
    path: process.execPath,
    args: [fixture],
    env: { PATH: process.env.PATH },
    timeoutMs: 2000,
    maxOutputBytes: 20000,
    tools: ["Read", "Write", "Bash"],
    permissionMode: "bypass",
    ...overrides,
  });
}
function input(prompt: string) {
  const job: Job = {
    id: "job",
    principalId: "owner",
    status: "running",
    prompt,
    mode: "cli",
    profile: "default",
    createdAt: "now",
    updatedAt: "now",
    messages: [{ id: "m", role: "user", text: prompt, createdAt: "now" }],
  };
  const attempt: Attempt = {
    id: "attempt",
    jobId: job.id,
    owner: "test",
    fence: "fence",
    status: "running",
    createdAt: "now",
    updatedAt: "now",
  };
  return { job, attempt, cwd: dir };
}
describe("official CLI boundary", () => {
  it.skipIf(process.platform === "win32")(
    "confirms a departed group after a transient cleanup permission error",
    async () => {
      const nativeKill = process.kill.bind(process);
      let injected = false;
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid < 0 && signal === "SIGKILL" && !injected) {
          injected = true;
          try {
            nativeKill(pid, signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
          throw Object.assign(new Error("private operating-system detail"), {
            code: "EPERM",
          });
        }
        return nativeKill(pid, signal);
      });
      const outcome = await worker().run(
        input("fixture:partial"),
        () => {},
        new AbortController().signal,
      );
      expect(injected).toBe(true);
      expect(outcome).toMatchObject({
        status: "succeeded",
        result: "split result",
      });
    },
  );
  it.skipIf(process.platform === "win32")(
    "awaits group disappearance before acknowledging cancellation",
    async () => {
      const nativeKill = process.kill.bind(process);
      let injected = false;
      let observations = 0;
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid < 0 && signal === "SIGKILL" && !injected) {
          injected = true;
          try {
            nativeKill(pid, signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
          throw Object.assign(new Error("private detail"), { code: "EPERM" });
        }
        if (pid < 0 && signal === 0 && ++observations === 1)
          throw Object.assign(new Error("private detail"), { code: "EPERM" });
        return nativeKill(pid, signal);
      });
      const controller = new AbortController();
      const pending = worker().run(
        input("fixture:hang"),
        () => {},
        controller.signal,
      );
      try {
        await expect
          .poll(() => existsSync(join(dir, "child.pid")), { timeout: 1500 })
          .toBe(true);
        controller.abort();
        expect(await pending).toMatchObject({ status: "canceled" });
        expect(injected).toBe(true);
        expect(observations).toBeGreaterThanOrEqual(2);
        const pid = Number(readFileSync(join(dir, "child.pid"), "utf8"));
        await expect
          .poll(
            () => {
              try {
                nativeKill(pid, 0);
                return false;
              } catch (error) {
                return (error as NodeJS.ErrnoException).code === "ESRCH";
              }
            },
            { timeout: 3000 },
          )
          .toBe(true);
      } finally {
        controller.abort();
        await pending;
      }
    },
  );
  it.skipIf(process.platform === "win32")(
    "does not acknowledge a live group or expose private cleanup diagnostics",
    async () => {
      const nativeKill = process.kill.bind(process);
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid < 0 && signal === "SIGKILL") {
          try {
            nativeKill(pid, signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
          throw Object.assign(new Error("private detail"), { code: "EPERM" });
        }
        if (pid < 0 && signal === 0) return true;
        return nativeKill(pid, signal);
      });
      const outcome = await worker().run(
        input("fixture:partial"),
        () => {},
        new AbortController().signal,
      );
      expect(outcome).toMatchObject({
        status: "failed",
        error: "process_cleanup_failed:close:EPERM",
      });
      expect(JSON.stringify(outcome)).not.toContain("private detail");
    },
  );
  it("emits nested native tool requests and results from streamed messages", async () => {
    const tools: unknown[] = [];
    const sessions: string[] = [];
    const outcome = await worker().run(
      input("fixture:tools"),
      (e) => {
        if (e.kind === "tool") tools.push(e.tool);
        if (e.kind === "session") sessions.push(String(e.data?.sessionId));
      },
      new AbortController().signal,
    );
    expect(outcome.status).toBe("succeeded");
    expect(sessions).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(tools).toEqual([
      expect.objectContaining({
        toolId: "native-write",
        phase: "requested",
        parentToolUseId: "agent-parent",
        file: { path: "notes.md", operation: "write" },
      }),
      expect.objectContaining({
        toolId: "native-write",
        phase: "succeeded",
        parentToolUseId: "agent-parent",
      }),
    ]);
    expect(JSON.stringify(tools)).toContain("PRIVATE_CONTENT");
    expect(JSON.stringify(tools)).toContain("PRIVATE_RESULT");
  });
  it("runs completion jobs without native tools or agents and persists structured output and observed usage", async () => {
    const execution = input("completion");
    execution.job.completion = prepareCompletion({
      model: "bridge/default",
      messages: [{ role: "user", content: "Hello" }],
    }).request;
    const outcome = await worker({
      agents: {
        danger: { description: "agent", prompt: "test", tools: ["Bash"] },
      },
    }).run(execution, () => {}, new AbortController().signal);
    expect(outcome.status).toBe("succeeded");
    const envelope = JSON.parse(outcome.result!);
    const args = JSON.parse(envelope.content).args as string[];
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).not.toContain("--agents");
    expect(args).toContain("--json-schema");
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1]!).$schema).toBe(
      "http://json-schema.org/draft-07/schema#",
    );
    expect(args).toContain("--system-prompt");
    expect(outcome.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 7,
      total_tokens: 17,
    });
  });
  it("surfaces native compaction and child-task events and preserves rate-limit resets even on nonzero exit", async () => {
    const events: string[] = [];
    const outcome = await worker().run(
      input("fixture:events"),
      (e) => events.push(e.kind),
      new AbortController().signal,
    );
    expect(events).toEqual(
      expect.arrayContaining([
        "session",
        "compaction",
        "subagent",
        "rate_limit",
      ]),
    );
    expect(outcome).toMatchObject({
      status: "paused",
      sessionId: "11111111-1111-4111-8111-111111111111",
      retryAt: 2000000005000,
    });
  });
  it("resumes the exact native session instead of replaying the transcript after compaction", async () => {
    const execution = input("original");
    execution.job.sessionId = "11111111-1111-4111-8111-111111111111";
    execution.job.resumePending = true;
    const outcome = await worker().run(
      execution,
      () => {},
      new AbortController().signal,
    );
    const result = JSON.parse(outcome.result!);
    expect(result.args).toContain("--resume");
    expect(result.args).toContain(execution.job.sessionId);
    expect(result.args).not.toContain("--no-session-persistence");
    expect(result.prompt).not.toContain("original");
  });
  it("preflights subscription authentication and rejects alternate billing environments", async () => {
    expect((await worker().ready()).ready).toBe(true);
    expect(
      (await worker({ env: { ANTHROPIC_API_KEY: "not-a-real-key" } }).ready())
        .ready,
    ).toBe(false);
  });
  it("passes prompts over stdin and preserves native bypass and configuration isolation", async () => {
    const events: string[] = [];
    const prompt = "Hello $(touch must-not-exist)";
    const result = await worker().run(
      input(prompt),
      (e) => events.push(e.text),
      new AbortController().signal,
    );
    expect(result.status).toBe("succeeded");
    const parsed = JSON.parse(result.result!);
    expect(parsed.bypass).toBe(true);
    expect(parsed.prompt).toBe(prompt);
    expect(parsed.args).toContain("--safe-mode");
    expect(parsed.args).not.toContain("--bare");
    expect(parsed.args).not.toContain(prompt);
    expect(existsSync(join(dir, "must-not-exist"))).toBe(false);
    expect(events).toContain("working");
  });
  it("parses split output and does not confuse process exit with successful completion", async () => {
    expect(
      (
        await worker().run(
          input("fixture:partial"),
          () => {},
          new AbortController().signal,
        )
      ).result,
    ).toBe("split result");
    expect(
      (
        await worker().run(
          input("fixture:bad"),
          () => {},
          new AbortController().signal,
        )
      ).status,
    ).toBe("failed");
  });
  it("bounds output and reports quota failures as actionable errors", async () => {
    expect(
      (
        await worker().run(
          input("fixture:huge"),
          () => {},
          new AbortController().signal,
        )
      ).error,
    ).toMatch(/output/i);
    expect(
      (
        await worker().run(
          input("fixture:error"),
          () => {},
          new AbortController().signal,
        )
      ).error,
    ).toMatch(/quota/);
  });
  it("terminates the owned process group on timeout", async () => {
    const executor = worker({ timeoutMs: 300 });
    const readiness = await executor.ready();
    expect(readiness.ready, readiness.reason).toBe(true);
    vi.spyOn(executor, "ready").mockResolvedValue(readiness);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const controller = new AbortController();
    const pending = executor.run(
      input("fixture:hang"),
      () => {},
      controller.signal,
    );
    let completed = false;
    void pending.then(
      () => {
        completed = true;
      },
      () => {
        completed = true;
      },
    );
    const settle = async () => {
      const deadline = Date.now() + 4000;
      while (!completed && Date.now() < deadline) {
        await pause(10);
        await vi.advanceTimersByTimeAsync(30);
      }
      expect(completed, "Owned fixture must settle before cleanup").toBe(true);
      return pending;
    };
    let outcome;
    try {
      const deadline = Date.now() + 4000;
      while (!existsSync(join(dir, "child.pid")) && Date.now() < deadline)
        await pause(10);
      expect(existsSync(join(dir, "child.pid"))).toBe(true);
      await vi.advanceTimersByTimeAsync(300);
      outcome = await settle();
    } finally {
      try {
        controller.abort();
        await vi.advanceTimersByTimeAsync(2000);
        await settle();
      } finally {
        vi.useRealTimers();
        vi.restoreAllMocks();
      }
    }
    expect(outcome.status, outcome.error).toBe("timed_out");
    if (process.platform !== "win32") {
      const pid = Number(readFileSync(join(dir, "child.pid"), "utf8"));
      await expect
        .poll(
          () => {
            try {
              process.kill(pid, 0);
              return false;
            } catch {
              return true;
            }
          },
          { timeout: 3000 },
        )
        .toBe(true);
    }
  });
  it("aborts active work without waiting for the execution timeout", async () => {
    const controller = new AbortController();
    const run = worker().run(
      input("fixture:hang"),
      () => {},
      controller.signal,
    );
    let outcome;
    try {
      await expect
        .poll(() => existsSync(join(dir, "child.pid")), { timeout: 1500 })
        .toBe(true);
      controller.abort();
      outcome = await run;
    } finally {
      controller.abort();
      await run;
    }
    expect(outcome.status, JSON.stringify(outcome)).toBe("canceled");
    if (process.platform !== "win32") {
      const pid = Number(readFileSync(join(dir, "child.pid"), "utf8"));
      await expect
        .poll(
          () => {
            try {
              process.kill(pid, 0);
              return false;
            } catch {
              return true;
            }
          },
          { timeout: 3000 },
        )
        .toBe(true);
    }
  });
});

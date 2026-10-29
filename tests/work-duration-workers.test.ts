/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * Licensed under https://www.apache.org/licenses/LICENSE-2.0
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { QueueStore } from "../src/store.js";
import { ClaudeWorker } from "../src/claude.js";
import { CodexWorker } from "../src/codex.js";
import { prepareCompletion } from "../src/completion-protocol.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-duration-fictional-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const owner = { id: "fixture-owner", owner: true, profiles: ["default"] };

it.each([
  { name: "Claude", Worker: ClaudeWorker },
  { name: "Codex", Worker: CodexWorker },
])("new $name work survives a tiny legacy attempt cap", async ({ Worker }) => {
  const store = new QueueStore(":memory:");
  try {
    const job = store.submit(
      {
        prompt: "delayed fictional result",
        workDuration: { version: 1, timeoutMs: null },
      },
      owner,
    );
    const attempt = store.claim("fixture-worker", "cli", job.id)!;
    const worker = new Worker({
      path: process.execPath,
      args: [resolve("tests/fixtures/duration-worker.mjs")],
      env: { PATH: process.env.PATH },
      tools: [],
      timeoutMs: 25,
      maxOutputBytes: 20000,
    });
    const result = await worker.run(
      { job, attempt, cwd: dir },
      () => {},
      new AbortController().signal,
    );
    expect(result.status).toBe("succeeded");
    expect(result.result).toBe("duration-ready");
  } finally {
    store.close();
  }
});

it.each([
  { name: "Claude", Worker: ClaudeWorker },
  { name: "Codex", Worker: CodexWorker },
])("$name honors an explicit admission deadline", async ({ Worker }) => {
  const store = new QueueStore(":memory:");
  try {
    const job = store.submit(
      {
        prompt: "delayed fictional result",
        workDuration: { version: 1, timeoutMs: 180 },
      },
      owner,
    );
    const attempt = store.claim("fixture-worker", "cli", job.id)!;
    const worker = new Worker({
      path: process.execPath,
      args: [resolve("tests/fixtures/duration-worker.mjs")],
      env: { PATH: process.env.PATH },
      tools: [],
      timeoutMs: 5000,
      maxOutputBytes: 20000,
    });
    const result = await worker.run(
      { job, attempt, cwd: dir },
      () => {},
      new AbortController().signal,
    );
    expect(result.status).toBe("timed_out");
  } finally {
    store.close();
  }
});

it.each([
  { name: "Claude", Worker: ClaudeWorker },
  { name: "Codex", Worker: CodexWorker },
])(
  "selected $name inference reaches its validated result beyond the old cap",
  async ({ Worker }) => {
    const store = new QueueStore(":memory:");
    try {
      const request = prepareCompletion({
        model: "bridge/default",
        messages: [{ role: "user", content: "Fictional inference" }],
        bridge: { workDuration: { version: 1, timeoutMs: null } },
      }).request;
      const job = store.submit(
        {
          prompt: "Fictional inference",
          workDuration: { version: 1, timeoutMs: null },
        },
        owner,
        undefined,
        request,
      );
      const attempt = store.claim("fixture-worker", "cli", job.id)!;
      const worker = new Worker({
        path: process.execPath,
        args: [resolve("tests/fixtures/duration-worker.mjs")],
        env: { PATH: process.env.PATH },
        tools: [],
        timeoutMs: 25,
        maxOutputBytes: 20000,
      });
      const result = await worker.run(
        { job, attempt, cwd: dir },
        () => {},
        new AbortController().signal,
      );
      expect(result.status).toBe("succeeded");
      expect(result.result).toContain("duration-ready");
    } finally {
      store.close();
    }
  },
);

it.each([
  { name: "Claude", Worker: ClaudeWorker },
  { name: "Codex", Worker: CodexWorker },
])(
  "cancel drains selected uncapped $name work and its descendant",
  async ({ Worker }) => {
    const store = new QueueStore(":memory:");
    try {
      const job = store.submit(
        { prompt: "hang", workDuration: { version: 1, timeoutMs: null } },
        owner,
      );
      const attempt = store.claim("fixture-worker", "cli", job.id)!;
      const worker = new Worker({
        path: process.execPath,
        args: [resolve("tests/fixtures/duration-worker.mjs")],
        env: { PATH: process.env.PATH },
        tools: [],
        timeoutMs: 25,
        maxOutputBytes: 20000,
      });
      const controller = new AbortController();
      const running = worker.run(
        { job, attempt, cwd: dir },
        () => {},
        controller.signal,
      );
      try {
        await expect
          .poll(() => existsSync(join(dir, "duration-descendant.pid")))
          .toBe(true);
        const descendant = Number(
          readFileSync(join(dir, "duration-descendant.pid"), "utf8"),
        );
        controller.abort();
        expect((await running).status).toBe("canceled");
        await expect
          .poll(() => {
            try {
              process.kill(descendant, 0);
              return true;
            } catch {
              return false;
            }
          })
          .toBe(false);
      } finally {
        controller.abort();
        await running;
      }
    } finally {
      store.close();
    }
  },
);

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

import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareCompletion } from "../src/completion-protocol.js";
import { parseConfig } from "../src/config.js";
import { ClaudeWorker } from "../src/claude.js";
import type { Execution, Worker, WorkerEvent } from "../src/worker.js";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forge-codex-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
function input(prompt: string): Execution {
  return {
    cwd: dir,
    job: {
      id: "job",
      principalId: "owner",
      profile: "default",
      mode: "cli",
      status: "running",
      prompt,
      createdAt: "now",
      updatedAt: "now",
      messages: [{ id: "m", role: "user", text: prompt, createdAt: "now" }],
    },
    attempt: {
      id: "attempt",
      jobId: "job",
      owner: "test",
      fence: "fence",
      status: "running",
      createdAt: "now",
      updatedAt: "now",
    },
  };
}
async function worker(
  overrides: Record<string, unknown> = {},
): Promise<Worker> {
  const module = await import("../src/codex.js").catch(() => undefined);
  expect(
    module?.CodexWorker,
    "a Codex subscription worker must exist",
  ).toBeDefined();
  return new module!.CodexWorker({
    path: process.execPath,
    args: [resolve("tests/fixtures/codex-process.mjs")],
    env: { PATH: process.env.PATH },
    tools: ["Read", "Write", "Bash"],
    timeoutMs: 2000,
    maxOutputBytes: 20000,
    ...overrides,
  });
}
it("selects the official Codex worker through validated configuration", () => {
  const config = parseConfig({
    dataDir: dir,
    workspace: dir,
    worker: "codex",
    codexPath: process.execPath,
  });
  expect(config.worker).toBe("codex");
  expect(config.profiles.default!.permissionMode).toBe("default");
});
it("Claude permissions stay enabled unless an operator selects bypass", async () => {
  const options = {
    path: process.execPath,
    args: [resolve("tests/fixtures/claude-process.mjs")],
    env: { PATH: process.env.PATH },
    tools: ["Read"],
    timeoutMs: 2000,
    maxOutputBytes: 20000,
  };
  const outcome = await new ClaudeWorker(options).run(
    input("hello"),
    () => {},
    new AbortController().signal,
  );
  expect(JSON.parse(outcome.result!).bypass).toBe(false);
});
it("requires ChatGPT auth and rejects alternate billing overrides", async () => {
  expect(await (await worker()).ready()).toEqual({ ready: true });
  expect(
    (await (await worker({ env: { CODEX_API_KEY: "not-real" } })).ready())
      .ready,
  ).toBe(false);
  expect(
    (
      await (
        await worker({ env: { PATH: process.env.PATH, FIXTURE_AUTH: "api" } })
      ).ready()
    ).ready,
  ).toBe(false);
});
it("streams session, command audit and observed usage without shell interpolation", async () => {
  const events: WorkerEvent[] = [];
  const result = await (
    await worker()
  ).run(
    input("hello $(touch nope)"),
    (e) => events.push(e),
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    status: "succeeded",
    sessionId: "11111111-1111-4111-8111-111111111111",
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  });
  const output = JSON.parse(result.result!);
  expect(output.prompt).toBe("hello $(touch nope)");
  expect(output.args).toContain("workspace-write");
  expect(output.args).not.toContain(
    "--dangerously-bypass-approvals-and-sandbox",
  );
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "tool",
        tool: expect.objectContaining({ name: "Bash", phase: "succeeded" }),
      }),
    ]),
  );
});
it("resumes an exact Codex thread without replaying prior side effects", async () => {
  const execution = input("original");
  execution.job.sessionId = "11111111-1111-4111-8111-111111111111";
  execution.job.resumePending = true;
  const result = await (
    await worker()
  ).run(execution, () => {}, new AbortController().signal);
  const output = JSON.parse(result.result!);
  expect(output.args).toContain("resume");
  expect(output.args).toContain(execution.job.sessionId);
  expect(output.prompt).not.toContain("original");
});
it("does not equate a zero exit code with a completed turn", async () => {
  expect(
    (
      await (
        await worker()
      ).run(input("fixture:missing"), () => {}, new AbortController().signal)
    ).status,
  ).toBe("failed");
});
it("pauses quota failures without guessing a reset time", async () => {
  const result = await (
    await worker()
  ).run(input("fixture:quota"), () => {}, new AbortController().signal);
  expect(result).toMatchObject({
    status: "paused",
    error: expect.stringMatching(/^quota_exhausted/),
  });
  expect(result.retryAt).toBeUndefined();
});
it("enforces timeout and output bounds", async () => {
  expect(
    (
      await (
        await worker({ timeoutMs: 80 })
      ).run(input("fixture:hang"), () => {}, new AbortController().signal)
    ).status,
  ).toBe("timed_out");
  expect(
    (
      await (
        await worker({ maxOutputBytes: 1000 })
      ).run(input("fixture:huge"), () => {}, new AbortController().signal)
    ).status,
  ).toBe("failed");
});

it("reports Codex ownership in status, models and durable audit", async () => {
  const { startService } = await import("../src/service.js");
  const service = await startService(
    parseConfig({
      dataDir: dir,
      workspace: join(dir, "jobs"),
      worker: "codex",
      codexPath: process.execPath,
      port: 0,
    }),
    {
      worker: () => ({
        ready: async () => ({ ready: true }),
        run: async (_input, emit) => {
          emit({
            kind: "session",
            text: "session",
            data: { sessionId: "codex-session", worker: "codex" },
          });
          emit({
            kind: "tool",
            text: "command",
            tool: {
              toolId: "t",
              name: "Bash",
              phase: "succeeded",
              output: { exit_code: 0 },
            },
          });
          return { status: "succeeded", result: "done" };
        },
      }),
    },
  );
  try {
    const headers = {
      Authorization: "Bearer " + service.ownerToken,
      "Content-Type": "application/json",
    };
    const status = await (
      await fetch(service.address + "/v1/bridge/status", { headers })
    ).json();
    expect(status).toMatchObject({
      worker: "codex",
      execution: "local-codex",
      permissionMode: "default",
    });
    const models = await (
      await fetch(service.address + "/v1/models", { headers })
    ).json();
    expect(models.data[0].worker).toBe("codex");
    const job = service.store.submit(
      { prompt: "test" },
      { id: "owner", owner: true, profiles: ["default"] },
    );
    for (
      let i = 0;
      i < 200 && service.store.get(job.id).status !== "succeeded";
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    const audit = await (
      await fetch(
        service.address +
          "/v1/bridge/jobs/" +
          job.id +
          "/audit?includePayloads=true",
        { headers },
      )
    ).json();
    expect(audit.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "codex", type: "tool.succeeded" }),
      ]),
    );
  } finally {
    await service.close();
  }
});

it("cancellation stops TERM-ignoring descendants even when the leader exits first", async () => {
  const controller = new AbortController();
  const running = (await worker({ timeoutMs: 10000 })).run(
    input("fixture:ignore-child"),
    () => {},
    controller.signal,
  );
  const file = join(dir, "child.pid");
  for (let i = 0; i < 100 && !existsSync(file); i++)
    await new Promise((r) => setTimeout(r, 20));
  expect(existsSync(file)).toBe(true);
  const pid = Number(readFileSync(file, "utf8"));
  await new Promise((r) => setTimeout(r, 100));
  controller.abort();
  expect((await running).status).toBe("canceled");
  try {
    let alive = true;
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(
      alive,
      "owned descendant must stop before cancellation is considered settled",
    ).toBe(false);
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* Already reconciled by the worker. */
    }
  }
});

function inference(prompt: string): Execution {
  const execution = input(prompt);
  execution.job.completion = prepareCompletion({
    model: "bridge/default",
    messages: [{ role: "user", content: prompt }],
  }).request;
  return execution;
}
it("disables every native inference feature including newer multi-agent and media tools", async () => {
  const result = await (
    await worker()
  ).run(inference("hello"), () => {}, new AbortController().signal);
  expect(result.status).toBe("succeeded");
  const args = JSON.parse(JSON.parse(result.result!).content).args as string[];
  for (const feature of [
    "multi_agent_v2",
    "image_generation",
    "view_image",
    "in_app_browser",
    "shell_tool",
    "unified_exec",
    "apply_patch_freeform",
    "js_repl",
    "multi_agent",
    "apps",
    "browser_use",
    "computer_use",
    "memories",
  ]) {
    const at = args.indexOf(feature);
    expect(at, feature + " must be disabled").toBeGreaterThan(0);
    expect(args[at - 1]).toBe("--disable");
  }
});
it.each([
  "web_search",
  "image_generation",
  "collab_tool_call",
  "dynamic_tool_call",
  "unknown_native_action",
])("rejects inference native action item %s", async (type) => {
  const result = await (
    await worker()
  ).run(
    inference("fixture:native-" + type),
    () => {},
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    status: "failed",
    error: expect.stringMatching(/^unexpected_tool_execution/),
  });
});

it("preserves nonterminal provider diagnostics without treating them as native actions", async () => {
  const events: WorkerEvent[] = [];
  const result = await (
    await worker()
  ).run(
    inference("fixture:native-error"),
    (event) => events.push(event),
    new AbortController().signal,
  );
  expect(result.status).toBe("succeeded");
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "progress",
        text: "provider unavailable",
        data: { diagnostic: true },
      }),
    ]),
  );
});

function imageInference(caption = "inspect"): Execution {
  const execution = input(caption);
  const prepared = prepareCompletion({
    model: "bridge/default",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: caption },
          {
            type: "image_url",
            image_url: {
              url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC",
            },
          },
        ],
      },
    ],
  });
  execution.job.prompt = prepared.prompt;
  execution.job.completion = prepared.request;
  return execution;
}
it("passes owned image attachments to Codex and removes them after success or cancellation", async () => {
  const result = await (
    await worker()
  ).run(imageInference(), () => {}, new AbortController().signal);
  expect(result.status).toBe("succeeded");
  const content = JSON.parse(JSON.parse(result.result!).content);
  expect(content.args).toContain("--image");
  expect(content.images[0].bytes).toBeGreaterThan(0);
  if (process.platform !== "win32") expect(content.images[0].mode).toBe(0o600);
  expect(existsSync(join(dir, "completion-image-1.png"))).toBe(false);
  const controller = new AbortController(),
    running = (await worker()).run(
      imageInference("fixture:image-hang"),
      () => {},
      controller.signal,
    );
  for (
    let i = 0;
    i < 100 && !existsSync(join(dir, "completion-image-1.png"));
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  expect(existsSync(join(dir, "completion-image-1.png"))).toBe(true);
  controller.abort();
  expect((await running).status).toBe("canceled");
  expect(existsSync(join(dir, "completion-image-1.png"))).toBe(false);
});
it("cleans images when schema creation fails and refuses image session replay", async () => {
  const execution = imageInference();
  execution.job.sessionId = "11111111-1111-4111-8111-111111111111";
  expect(
    (
      await (
        await worker()
      ).run(execution, () => {}, new AbortController().signal)
    ).error,
  ).toContain("image_replay_unsupported");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "completion-schema.json"));
  await expect(
    (await worker()).run(
      imageInference(),
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(existsSync(join(dir, "completion-image-1.png"))).toBe(false);
});
it("encodes Claude images through stream-json without enabling native tools", async () => {
  const worker = new ClaudeWorker({
    path: process.execPath,
    args: [resolve("tests/fixtures/claude-process.mjs")],
    env: { PATH: process.env.PATH },
    tools: ["Read"],
    timeoutMs: 2000,
    maxOutputBytes: 20000,
  });
  const result = await worker.run(
    imageInference(),
    () => {},
    new AbortController().signal,
  );
  expect(result.status).toBe("succeeded");
  const content = JSON.parse(JSON.parse(result.result!).content);
  expect(content.args).toContain("--input-format");
  expect(content.input.message.content[1]).toMatchObject({
    type: "image",
    source: { type: "base64", media_type: "image/png" },
  });
  expect(content.input.message.content[0].text).not.toContain("iVBORw0");
  expect(content.args[content.args.indexOf("--tools") + 1]).toBe("");
});

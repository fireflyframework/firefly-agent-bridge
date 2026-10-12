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

import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { startService } from "../src/service.js";
import { parseConfig } from "../src/config.js";
import assert from "node:assert/strict";
const dir = mkdtempSync(resolve("work/live-codex-"));
const service = await startService(
  parseConfig({
    dataDir: dir,
    workspace: join(dir, "jobs"),
    worker: "codex",
    codexPath:
      process.env.FORGE_CODEX_PATH ??
      resolve(process.env.HOME!, ".local/bin/codex"),
    port: 0,
    profiles: { default: { timeoutMs: 120000, maxOutputBytes: 2000000 } },
  }),
);
const headers = {
  Authorization: "Bearer " + service.ownerToken,
  "Content-Type": "application/json",
};
const request = async (path: string, body?: unknown) => {
  const r = await fetch(service.address + path, {
    headers,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  const data = await r.json();
  assert(r.ok, JSON.stringify(data));
  return data as Record<string, unknown>;
};
const wait = async (id: string) => {
  const deadline = Date.now() + 130000;
  while (Date.now() < deadline) {
    const job = await request("/v1/bridge/jobs/" + id + "/result");
    if (job.status === "succeeded") return job;
    if (
      ["failed", "timed_out", "canceled", "interrupted", "paused"].includes(
        String(job.status),
      )
    )
      throw new Error(JSON.stringify(job));
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("live job timeout");
};
try {
  const admitted = await request("/v1/chat/completions", {
    model: "bridge/default",
    messages: [
      {
        role: "user",
        content:
          "Create the file bridge-live.txt in the current working directory with exactly FIRE FLY LIVE (no extra text). Read it back and report the contents. Use only that file. Do not inspect other paths.",
      },
    ],
    bridge: { execution: "agent", background: true },
  });
  const id = String(admitted.id);
  const first = await wait(id);
  const file = join(dir, "jobs", id, "bridge-live.txt");
  assert(existsSync(file));
  assert.equal(readFileSync(file, "utf8").trim(), "FIRE FLY LIVE");
  await request("/v1/bridge/jobs/" + id + "/messages", {
    text: "Read bridge-live.txt from this session's working directory and return its exact contents. Do not modify files or inspect any other paths.",
  });
  const followup = await wait(id);
  const detail = await request("/v1/bridge/jobs/" + id);
  assert(detail.sessionId);
  const audit = await request(
    "/v1/bridge/jobs/" + id + "/audit?includePayloads=true",
  );
  const completion = await request("/v1/chat/completions", {
    model: "bridge/default",
    messages: [
      {
        role: "user",
        content: "Reply with exactly FIREFLY_BRIDGE_OK. Do not use any tools.",
      },
    ],
  });
  const choices = completion.choices as { message: { content: string } }[];
  assert.equal(choices[0]!.message.content, "FIREFLY_BRIDGE_OK");
  const evidence = {
    testedAt: new Date().toISOString(),
    worker: "codex",
    jobId: id,
    sessionId: detail.sessionId,
    native: first.status,
    followup: followup.status,
    completion: true,
    audit,
    usage: completion.usage,
  };
  writeFileSync(join(dir, "evidence.json"), JSON.stringify(evidence, null, 2), {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      passed: true,
      evidence: join(dir, "evidence.json"),
      sessionId: detail.sessionId,
    }),
  );
} finally {
  await service.close();
}

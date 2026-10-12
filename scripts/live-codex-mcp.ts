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

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startService } from "../src/service.js";
import { toolsQuery } from "../src/audit.js";
import { parseConfig } from "../src/config.js";
const directory = mkdtempSync(resolve("work/live-codex-native-mcp-"));
const config = parseConfig({
  dataDir: directory,
  workspace: join(directory, "jobs"),
  worker: "codex",
  codexPath:
    process.env.FORGE_CODEX_PATH ??
    resolve(process.env.HOME!, ".local/bin/codex"),
  port: 0,
  profiles: { default: { timeoutMs: 120000, maxOutputBytes: 2000000 } },
});
writeFileSync(join(directory, "config.json"), JSON.stringify(config), {
  mode: 0o600,
});
const service = await startService(config);
const client = new Client({ name: "firefly-codex-native-proof", version: "1" });
const request = async (path: string, body?: unknown) => {
  const response = await fetch(service.address + path, {
    headers: {
      Authorization: "Bearer " + service.ownerToken,
      "Content-Type": "application/json",
    },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  assert(response.ok, "HTTP bridge request failed: " + response.status);
  return value;
};
try {
  await client.connect(
    new StdioClientTransport({
      command: resolve(
        "dist/firefly-bridge" + (process.platform === "win32" ? ".exe" : ""),
      ),
      args: ["mcp", "--data-dir", directory],
      stderr: "pipe",
    }),
  );
  const status = await client.callTool({
    name: "bridge_status",
    arguments: {},
  });
  assert(!status.isError);
  const state = JSON.parse((status.content as { text: string }[])[0]!.text);
  assert.equal(state.worker, "codex");
  assert.equal(state.readiness.ready, true);
  const receipt = await client.callTool({
    name: "bridge_submit",
    arguments: {
      mode: "cli",
      prompt:
        "Create only native-mcp-proof.txt in this job working directory with exactly FIREFLY_NATIVE_MCP_OK. Read that file back. Do not inspect other paths or perform any other actions.",
    },
  });
  assert(!receipt.isError);
  const job = JSON.parse((receipt.content as { text: string }[])[0]!.text);
  const deadline = Date.now() + 130000;
  let result;
  while (Date.now() < deadline) {
    result = await request("/v1/bridge/jobs/" + job.id + "/result");
    if (result.status === "succeeded") break;
    if (
      ["failed", "paused", "timed_out", "canceled", "interrupted"].includes(
        result.status,
      )
    )
      throw Error("Native MCP job failed: " + result.status);
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(result.status, "succeeded");
  assert.equal(
    readFileSync(
      join(directory, "jobs", job.id, "native-mcp-proof.txt"),
      "utf8",
    ).trim(),
    "FIREFLY_NATIVE_MCP_OK",
  );
  const tools = [
    {
      type: "function",
      function: {
        name: "add",
        description: "Add two integers in the calling application",
        parameters: {
          type: "object",
          properties: { a: { type: "integer" }, b: { type: "integer" } },
          required: ["a", "b"],
          additionalProperties: false,
        },
        strict: true,
      },
    },
  ];
  const messages: unknown[] = [
    {
      role: "user",
      content:
        "Call add with a=2 and b=5; after its tool result, return only the total.",
    },
  ];
  const first = await request("/v1/chat/completions", {
    model: "bridge/default",
    messages,
    tools,
    tool_choice: { type: "function", function: { name: "add" } },
  });
  const answer = first.choices[0].message;
  assert.equal(first.choices[0].finish_reason, "tool_calls");
  assert.equal(answer.tool_calls.length, 1);
  const call = answer.tool_calls[0];
  assert.equal(call.function.name, "add");
  const args = JSON.parse(call.function.arguments);
  assert.deepEqual(args, { a: 2, b: 5 });
  let executions = 0;
  const total = (() => {
    executions++;
    return args.a + args.b;
  })();
  messages.push(answer, {
    role: "tool",
    tool_call_id: call.id,
    content: String(total),
  });
  const final = await request("/v1/chat/completions", {
    model: "bridge/default",
    messages,
    tools,
    tool_choice: "none",
  });
  assert.equal(final.choices[0].message.content, "7");
  assert.equal(executions, 1);
  const inference = service.store.list().filter((j) => Boolean(j.completion));
  for (const job of inference)
    assert.equal(
      service.store.tools(
        job.id,
        {
          id: "owner",
          owner: true,
          profiles: ["default"],
        },
        toolsQuery.parse({}),
      ).tools.length,
      0,
    );
  const evidence = {
    testedAt: new Date().toISOString(),
    worker: "codex",
    auth: "official ChatGPT CLI login",
    nativePackage: true,
    mcp: {
      readiness: true,
      job: job.id,
      status: result.status,
      fileVerified: true,
    },
    callerFunctions: {
      executed: executions,
      total,
      nativeActions: false,
      first,
      final,
    },
  };
  writeFileSync(
    join(directory, "evidence.json"),
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      passed: true,
      evidence: join(directory, "evidence.json"),
    }),
  );
} finally {
  await client.close();
  await service.close();
}

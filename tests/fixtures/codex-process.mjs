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

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.153.4");
  process.exit(0);
}
if (process.argv.includes("login")) {
  console.error(
    process.env.FIXTURE_AUTH === "api"
      ? "Logged in using an API key"
      : "Logged in using ChatGPT",
  );
  process.exit(0);
}
let prompt = "";
for await (const part of process.stdin) prompt += part;
const emit = (value) => console.log(JSON.stringify(value));
emit({
  type: "thread.started",
  thread_id: "11111111-1111-4111-8111-111111111111",
});
if (prompt === "fixture:ignore-child") {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    { stdio: "ignore" },
  );
  writeFileSync("child.pid", String(child.pid));
  setInterval(() => {}, 1000);
} else if (prompt === "fixture:hang") {
  setInterval(() => {}, 1000);
} else if (prompt === "fixture:huge") {
  console.log("x".repeat(100000));
} else if (prompt === "fixture:quota") {
  emit({ type: "turn.failed", error: { message: "Usage limit reached" } });
  process.exitCode = 1;
} else if (prompt !== "fixture:missing") {
  const native = prompt.match(/fixture:native-([a-z_]+)/);
  if (native)
    emit({
      type: "item.started",
      item: {
        id: "native-action",
        type: native[1],
        status: "in_progress",
        message: "provider unavailable",
      },
    });
  if (!process.argv.includes("--output-schema")) {
    emit({
      type: "item.started",
      item: {
        id: "command",
        type: "command_execution",
        command: "echo evidence",
        status: "in_progress",
      },
    });
    emit({
      type: "item.completed",
      item: {
        id: "command",
        type: "command_execution",
        command: "echo evidence",
        status: "completed",
        aggregated_output: "evidence",
        exit_code: 0,
      },
    });
  }
  emit({
    type: "item.completed",
    item: {
      id: "answer",
      type: "agent_message",
      text: process.argv.includes("--output-schema")
        ? JSON.stringify({
            content: JSON.stringify({ args: process.argv.slice(2) }),
            tool_calls: [],
          })
        : JSON.stringify({ prompt, args: process.argv.slice(2) }),
    },
  });
  emit({
    type: "turn.completed",
    usage: { input_tokens: 12, cached_input_tokens: 4, output_tokens: 3 },
  });
}

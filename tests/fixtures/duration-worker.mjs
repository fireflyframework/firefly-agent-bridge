/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * Licensed under https://www.apache.org/licenses/LICENSE-2.0
 */
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
if (process.argv.includes("--version")) {
  console.log("2.1.260 (Fictional Claude fixture)");
} else if (process.argv.includes("status")) {
  console.log(
    process.argv.includes("auth")
      ? JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          subscriptionType: "fixture",
        })
      : "Logged in using ChatGPT",
  );
} else {
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  writeFileSync("duration-child.pid", String(process.pid));
  if (prompt === "hang") {
    const descendant = spawn(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { stdio: "ignore" },
    );
    writeFileSync("duration-descendant.pid", String(descendant.pid));
    setInterval(() => {}, 1000);
  } else
    setTimeout(() => {
      const envelope = { content: "duration-ready", tool_calls: [] };
      if (process.argv.includes("--print"))
        console.log(
          JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "duration-ready",
            ...(process.argv.includes("--json-schema")
              ? { structured_output: envelope }
              : {}),
          }),
        );
      else {
        console.log(
          JSON.stringify({
            type: "thread.started",
            thread_id: "11111111-1111-4111-8111-111111111111",
          }),
        );
        console.log(
          JSON.stringify({
            type: "item.completed",
            item: {
              id: "answer",
              type: "agent_message",
              text: process.argv.includes("--output-schema")
                ? JSON.stringify(envelope)
                : "duration-ready",
            },
          }),
        );
        console.log(JSON.stringify({ type: "turn.completed" }));
      }
    }, 300);
}

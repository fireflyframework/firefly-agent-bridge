/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0 */
import { spawnSync } from "node:child_process";
import { promptPython } from "./prompt-python.js";
const render = process.argv.slice(2);
if (render.length > 1 || (render.length === 1 && render[0] !== "--render"))
  throw new Error("Expected --render or no arguments");
const commands = render.length
  ? [["scripts/render_prompt_catalog.py"]]
  : [
      ["scripts/render_prompt_catalog.py", "--check"],
      ["-m", "unittest", "scripts.test_prompt_catalog"],
    ];
for (const args of commands) {
  const result = spawnSync(promptPython(process.env), args, {
    stdio: "inherit",
    shell: false,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      "Native prompt check failed. Configure BRIDGE_PROMPT_PYTHON with scripts/prompts-requirements.txt; keep BRIDGE_PYTHON for SDK client checks.",
    );
}

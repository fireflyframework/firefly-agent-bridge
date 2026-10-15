/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0 */
import { spawnSync } from "node:child_process";
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
  const result = spawnSync(process.env.BRIDGE_PYTHON ?? "python3", args, {
    stdio: "inherit",
    shell: false,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      "Native prompt check failed. Configure BRIDGE_PYTHON with scripts/prompts-requirements.txt.",
    );
}

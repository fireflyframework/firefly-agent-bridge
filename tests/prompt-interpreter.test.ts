/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0 */
import { existsSync } from "node:fs";
import { expect, test } from "vitest";

async function selector() {
  expect(
    existsSync(new URL("../scripts/prompt-python.ts", import.meta.url)),
  ).toBe(true);
  return (await import("../scripts/prompt-python.js")).promptPython;
}

test("the compiler interpreter wins without splitting paths containing spaces", async () => {
  const select = await selector();
  const environment = {
    BRIDGE_PROMPT_PYTHON: "C:\\Program Files\\Bridge compiler\\python.exe",
    BRIDGE_PYTHON: "/sdk client/python",
  };
  expect(select(environment)).toBe(environment.BRIDGE_PROMPT_PYTHON);
  expect(environment.BRIDGE_PYTHON).toBe("/sdk client/python");
});

test("compatible existing environments keep the prior SDK interpreter fallback", async () => {
  const select = await selector();
  expect(select({ BRIDGE_PYTHON: "/owned path/compatible python" })).toBe(
    "/owned path/compatible python",
  );
  expect(select({})).toBe("python3");
});

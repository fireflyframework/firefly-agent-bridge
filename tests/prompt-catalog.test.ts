/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0 */
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true });
});

test("all released internal instructions have a native-rendered catalog with exact text", () => {
  const file = new URL("../resources/prompts/catalog.json", import.meta.url);
  expect(existsSync(file)).toBe(true);
  const catalog = JSON.parse(readFileSync(file, "utf8"));
  const baseline = JSON.parse(
    readFileSync(
      new URL("fixtures/prompt-baseline.json", import.meta.url),
      "utf8",
    ),
  );
  expect(catalog.renderer).toBe("fireflyframework-agentic@26.10.1");
  expect(Object.keys(catalog.prompts).sort()).toEqual(
    Object.keys(baseline).sort(),
  );
  for (const [id, text] of Object.entries(baseline))
    expect(catalog.prompts[id].text).toBe(text);
});

test("runtime catalog validation rejects changed text and inherited names", async () => {
  expect(existsSync(new URL("../src/prompt-catalog.ts", import.meta.url))).toBe(
    true,
  );
  const { bridgePrompt, validatePromptCatalog } =
    await import("../src/prompt-catalog.js");
  const catalog = JSON.parse(
    readFileSync(
      new URL("../resources/prompts/catalog.json", import.meta.url),
      "utf8",
    ),
  );
  const changed = structuredClone(catalog);
  changed.prompts["completion/system"].text += " altered";
  expect(() => validatePromptCatalog(changed)).toThrow();
  expect(() => bridgePrompt("constructor" as never)).toThrow();
  expect(bridgePrompt("completion/system")).toBe(
    catalog.prompts["completion/system"].text,
  );
});

test("build rejects modified or unregistered YAML before bundling", async () => {
  const { verifyPromptSources } = await import("../scripts/prompt-sources.js");
  const root = mkdtempSync(join(tmpdir(), "bridge-prompt-sources-"));
  directories.push(root);
  cpSync(new URL("../resources", import.meta.url), join(root, "resources"), {
    recursive: true,
  });
  expect(() => verifyPromptSources(root)).not.toThrow();
  const path = join(root, "resources/prompts/v1/completion/system.yaml");
  const original = readFileSync(path, "utf8");
  writeFileSync(path, original + "\n# Modified source\n");
  expect(() => verifyPromptSources(root)).toThrow("stale");
  writeFileSync(path, original);
  writeFileSync(
    join(root, "resources/prompts/v1/completion/unregistered.yaml"),
    original,
  );
  expect(() => verifyPromptSources(root)).toThrow("Unregistered");
});

test("Jinja-looking caller content stays opaque conversation data", async () => {
  const { prepareCompletion } = await import("../src/completion-protocol.js");
  const content = "{{secret}} {% include 'untrusted' %}";
  const result = prepareCompletion({
    model: "bridge/default",
    messages: [{ role: "user", content }],
  });
  expect(result.prompt).toContain(JSON.stringify(content));
});

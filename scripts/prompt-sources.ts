/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0 */
/* https://www.apache.org/licenses/LICENSE-2.0 */
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { promptSha256, validatePromptCatalog } from "../src/prompt-catalog.js";

export function verifyPromptSources(root: string): void {
  const directory = realpathSync(root);
  const catalog = validatePromptCatalog(
    JSON.parse(
      readFileSync(join(directory, "resources/prompts/catalog.json"), "utf8"),
    ),
  );
  const expected = new Set(
    Object.values(catalog.prompts).map((entry) => entry.source),
  );
  const actual = new Set<string>();
  function walk(relative: string) {
    for (const name of readdirSync(join(directory, relative))) {
      const child = relative + "/" + name;
      const file = join(directory, child);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || realpathSync(file) !== resolve(file))
        throw new Error("Prompt resources cannot use symlinks");
      if (stat.isDirectory()) walk(child);
      else {
        if (!stat.isFile() || stat.size > 32768 || !expected.has(child))
          throw new Error("Unregistered or invalid prompt source");
        actual.add(child);
        if (actual.size > 128) throw new Error("Too many prompt sources");
      }
    }
  }
  walk("resources/prompts/v1");
  if (actual.size !== expected.size)
    throw new Error("Prompt sources are missing");
  for (const entry of Object.values(catalog.prompts))
    if (
      promptSha256(readFileSync(join(directory, entry.source), "utf8")) !==
      entry.source_sha256
    )
      throw new Error("Prompt catalog is stale; regenerate it with Agentic");
}

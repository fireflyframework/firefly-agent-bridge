/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0 */
import { createHash } from "node:crypto";
import generated from "../resources/prompts/catalog.json" with { type: "json" };

type Entry = {
  version: "1.0.0";
  field: "system" | "user";
  source: string;
  source_sha256: string;
  text_sha256: string;
  text: string;
};
type Catalog = {
  format: 1;
  renderer: "fireflyframework-agentic@26.10.1";
  catalog_sha256: string;
  prompts: Record<string, Readonly<Entry>>;
};
const invalid = () =>
  new Error(
    "Invalid internal prompt catalog; regenerate it with the pinned Agentic build environment",
  );
const digest = /^[a-f0-9]{64}$/;
export const promptSha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(row)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(row[key]))
        .join(",") +
      "}"
    );
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw invalid();
  return result;
}
function keys(
  value: unknown,
  expected: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...expected].sort().join(",")
  )
    throw invalid();
}
export function validatePromptCatalog(value: unknown): Readonly<Catalog> {
  keys(value, ["format", "renderer", "catalog_sha256", "prompts"]);
  if (
    value.format !== 1 ||
    value.renderer !== "fireflyframework-agentic@26.10.1" ||
    typeof value.catalog_sha256 !== "string" ||
    !digest.test(value.catalog_sha256)
  )
    throw invalid();
  const rows = value.prompts;
  if (
    !rows ||
    typeof rows !== "object" ||
    Array.isArray(rows) ||
    Object.keys(rows).length < 1 ||
    Object.keys(rows).length > 128
  )
    throw invalid();
  const prompts: Record<string, Readonly<Entry>> = Object.create(null);
  for (const [id, entry] of Object.entries(rows)) {
    keys(entry, [
      "version",
      "field",
      "source",
      "source_sha256",
      "text_sha256",
      "text",
    ]);
    if (
      !/^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/.test(id) ||
      entry.version !== "1.0.0" ||
      !["system", "user"].includes(entry.field as string) ||
      entry.source !== `resources/prompts/v1/${id}.yaml` ||
      typeof entry.source_sha256 !== "string" ||
      !digest.test(entry.source_sha256) ||
      typeof entry.text_sha256 !== "string" ||
      !digest.test(entry.text_sha256) ||
      typeof entry.text !== "string" ||
      !entry.text.length ||
      Buffer.byteLength(entry.text) > 32768 ||
      promptSha256(entry.text) !== entry.text_sha256
    )
      throw invalid();
    prompts[id] = Object.freeze({ ...entry }) as Readonly<Entry>;
  }
  const { catalog_sha256, ...body } = value;
  if (promptSha256(canonical(body)) !== catalog_sha256) throw invalid();
  return Object.freeze({
    format: 1,
    renderer: "fireflyframework-agentic@26.10.1",
    catalog_sha256,
    prompts: Object.freeze(prompts),
  });
}
const catalog = validatePromptCatalog(generated);
export function bridgePrompt(id: keyof typeof generated.prompts): string {
  if (!Object.hasOwn(catalog.prompts, id)) throw invalid();
  return catalog.prompts[id]!.text;
}

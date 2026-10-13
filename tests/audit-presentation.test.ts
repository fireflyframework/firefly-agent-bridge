/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
class TestNode {
  textContent = "";
  childNodes: TestNode[] = [];
  constructor(public tag: string) {}
  append(...values: TestNode[]) {
    this.childNodes.push(...values);
  }
  replaceChildren(...values: TestNode[]) {
    this.childNodes = [...values];
  }
  setAttribute() {}
}
const presentation = runInNewContext(
  readFileSync("src/ui/audit.js", "utf8").replaceAll(
    "export function",
    "function",
  ) + ";({ previewText, codeTokens, reportedPatch, structuredValue })",
  { document: { createElement: (tag: string) => new TestNode(tag) } },
) as {
  structuredValue(value: unknown): TestNode;
  previewText(
    value: string,
    characters?: number,
    lines?: number,
  ): { text: string; omitted: number };
  codeTokens(value: string, path: string): { text: string; kind: string }[];
  reportedPatch(
    value: unknown,
  ):
    | { text: string; oldLine?: number; newLine?: number; kind: string }[]
    | undefined;
};
describe("native activity presentation", () => {
  it("bounds long single lines and multiline outputs without altering source", () => {
    const value = "x".repeat(200000) + "\n" + "line\n".repeat(5000);
    const preview = presentation.previewText(value);
    expect(preview.text.length).toBeLessThanOrEqual(10000);
    expect(preview.omitted).toBe(value.length - preview.text.length);
    expect(presentation.previewText("a\nb\nc", 100, 2)).toEqual({
      text: "a\nb",
      omitted: 2,
    });
    expect(value.length).toBeGreaterThan(200000);
  });
  it("keeps source code and malicious markup as text while classifying tokens", () => {
    const value = 'const image = "<img onerror=alert(1)>"; // actual text';
    const tokens = presentation.codeTokens(value, "src/example.ts");
    expect(tokens.map((token) => token.text).join("")).toBe(value);
    expect(tokens.some((token) => token.kind === "keyword")).toBe(true);
    expect(presentation.codeTokens(value, "unknown.bin")).toEqual([
      { text: value, kind: "plain" },
    ]);
  });
  it("uses actual reported patch offsets and excludes no-newline markers from numbering", () => {
    const value = Object.freeze([
      {
        oldStart: 20,
        newStart: 22,
        lines: Object.freeze([
          " same",
          "-old",
          "+new",
          "+extra",
          "\\ No newline at end of file",
          " tail",
        ]),
      },
    ]);
    const rows = presentation.reportedPatch(value)!;
    expect(rows.map(({ oldLine, newLine }) => [oldLine, newLine])).toEqual([
      [20, 22],
      [21, undefined],
      [undefined, 23],
      [undefined, 24],
      [undefined, undefined],
      [22, 25],
    ]);
    expect(value[0]!.oldStart).toBe(20);
    expect(
      presentation.reportedPatch([{ lines: ["+unknown position"] }]),
    ).toBeUndefined();
  });
  it("bounds the complete structured field tree rather than only each object", () => {
    const nested = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        "outer" + index,
        Object.fromEntries(
          Array.from({ length: 40 }, (_, child) => [
            "inner" + child,
            "Recorded value",
          ]),
        ),
      ]),
    );
    const result = presentation.structuredValue(nested);
    const count = (item: TestNode): number =>
      (item.tag === "dt" ? 1 : 0) +
      item.childNodes.reduce((total, child) => total + count(child), 0);
    expect(count(result)).toBeLessThanOrEqual(240);
  });
});

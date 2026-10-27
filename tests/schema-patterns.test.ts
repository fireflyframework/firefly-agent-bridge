/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0 */
/* Licensed under https://www.apache.org/licenses/LICENSE-2.0 */
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import {
  prepareCompletion,
  parseCompletionResult,
} from "../src/completion-protocol.js";

const base = {
  model: "bridge/default",
  messages: [{ role: "user", content: "Test schema constraints" }],
};
function request(schema: Record<string, unknown>, tool: boolean) {
  return prepareCompletion(
    tool
      ? {
          ...base,
          tools: [
            {
              type: "function",
              function: { name: "evidence", parameters: schema },
            },
          ],
          tool_choice: "required",
        }
      : {
          ...base,
          response_format: {
            type: "json_schema",
            json_schema: { name: "Evidence", schema },
          },
        },
  ).request;
}
function result(value: unknown, tool: boolean) {
  return JSON.stringify(
    tool
      ? {
          content: null,
          tool_calls: [{ name: "evidence", arguments: JSON.stringify(value) }],
        }
      : { content: JSON.stringify(value), tool_calls: [] },
  );
}
it.each([false, true])(
  "preserves Pydantic local-reference pattern constraints in output/tool=%s",
  (tool) => {
    const schema = {
      type: "object",
      properties: { query: { $ref: "#/$defs/EvidenceQuery" } },
      required: ["query"],
      additionalProperties: false,
      $defs: {
        EvidenceQuery: {
          type: "object",
          properties: {
            expected_cut: {
              anyOf: [
                { type: "string", pattern: "^[a-f0-9]{64}$" },
                { type: "null" },
              ],
            },
            record_id: {
              anyOf: [
                { type: "string", pattern: "^[a-f0-9]{32}$" },
                { type: "null" },
              ],
            },
          },
          required: ["expected_cut", "record_id"],
          additionalProperties: false,
        },
      },
    };
    const prepared = request(schema, tool);
    for (const value of [
      { query: { expected_cut: "a".repeat(64), record_id: "b".repeat(32) } },
      { query: { expected_cut: null, record_id: null } },
    ])
      expect(() =>
        parseCompletionResult(result(value, tool), prepared),
      ).not.toThrow();
    for (const value of [
      { query: { expected_cut: "g".repeat(64), record_id: null } },
      { query: { expected_cut: null, record_id: "b".repeat(31) } },
    ])
      expect(() =>
        parseCompletionResult(result(value, tool), prepared),
      ).toThrow();
  },
);
it.each([false, true])(
  "enforces unanchored and Unicode string patterns in output/tool=%s",
  (tool) => {
    const prepared = request(
      { type: "string", pattern: "café|\\u{1F600}" },
      tool,
    );
    for (const value of ["A café here", "😀"])
      expect(() =>
        parseCompletionResult(result(value, tool), prepared),
      ).not.toThrow();
    expect(() =>
      parseCompletionResult(result("plain", tool), prepared),
    ).toThrow();
  },
);
it.each([false, true])(
  "enforces patternProperties with additionalProperties in output/tool=%s",
  (tool) => {
    const prepared = request(
      {
        type: "object",
        patternProperties: { "^record_[a-f0-9]{4}$": { type: "integer" } },
        additionalProperties: false,
      },
      tool,
    );
    expect(() =>
      parseCompletionResult(result({ record_ab12: 3 }, tool), prepared),
    ).not.toThrow();
    for (const value of [
      { record_ab12: "wrong" },
      { record_ZZZZ: 3 },
      { extra: 3 },
    ])
      expect(() =>
        parseCompletionResult(result(value, tool), prepared),
      ).toThrow();
  },
);
it.each([false, true])(
  "validates property-name and unevaluated-item patterns in output/tool=%s",
  (tool) => {
    for (const [schema, valid, invalid] of [
      [
        { type: "object", propertyNames: { pattern: "^[a-z]+$" } },
        { name: 1 },
        { Name: 1 },
      ],
      [
        {
          type: "array",
          unevaluatedItems: { type: "string", pattern: "^[a-z]+$" },
        },
        ["name"],
        ["Name"],
      ],
    ] as const) {
      const prepared = request(schema, tool);
      expect(() =>
        parseCompletionResult(result(valid, tool), prepared),
      ).not.toThrow();
      expect(() =>
        parseCompletionResult(result(invalid, tool), prepared),
      ).toThrow();
    }
  },
);
it.each([false, true])(
  "rejects malformed or unsupported regex constructs before admission in output/tool=%s",
  (tool) => {
    for (const pattern of [
      "[",
      "(?=a)a",
      "(?!a)b",
      "(?<=a)b",
      "(?<!a)b",
      "(?s:.)",
      "(a)\\1",
      "(?<letter>a)\\k<letter>",
      "a".repeat(1025),
      "a{1000}b{1000}c{1000}d{1000}e{1000}",
    ])
      expect(() => request({ type: "string", pattern }, tool)).toThrow();
    expect(() => request({ type: "string", pattern: 123 }, tool)).toThrow();
  },
);
it.each([false, true])(
  "rejects unsupported surrogate patterns before admission in output/tool=%s",
  (tool) => {
    for (const pattern of [
      "\\uDE00",
      "\\uD83D",
      "\\u{DE00}",
      "\uDE00",
      "\uD83D",
      "[\\uD7FF-\\uE000]",
      "[\\u0000-\\uFFFF]",
      "[\uD7FF-\uE000]",
      "\\p{Cs}",
      "\\p{C}",
      "\\P{So}",
      "[^\\u0000-\\uD7FF\\uE000-\\u{10FFFF}]",
      "[\\u{1F600}-\\u{1F64F}]",
      "[[-\\uE000]",
      "[[-😀]",
      "[\\cA-\\uE000]",
      "[\\b-\\uE000]",
      "[\\0-\\uE000]",
    ])
      expect(() => request({ type: "string", pattern }, tool)).toThrow();
    for (const pattern of ["\\uD83D\\uDE00", "😀", "[😀]"])
      expect(() =>
        parseCompletionResult(
          result("😀", tool),
          request({ type: "string", pattern }, tool),
        ),
      ).not.toThrow();
  },
);
it.each([false, true])(
  "validates patterns in unused schema definitions before admission in output/tool=%s",
  (tool) => {
    for (const keyword of ["$defs", "definitions"])
      for (const definition of [
        { type: "string", pattern: "(?=a)a" },
        { type: "string", pattern: "\\uDE00" },
        { type: "object", patternProperties: { "(?=a)a": { type: "string" } } },
      ])
        expect(() =>
          request({ [keyword]: { unused: definition } }, tool),
        ).toThrow();
    expect(() =>
      request({ if: { type: "string", pattern: "(?=a)a" } }, tool),
    ).toThrow();
    expect(() =>
      request(
        { $defs: { unused: { type: "string", pattern: "^[a-z]+$" } } },
        tool,
      ),
    ).not.toThrow();
  },
);
it.each([
  "\\s",
  "\\S",
  "[\\S_]",
  "[^\\S_]",
  ".",
  "^a$",
  "a$",
  "^[.\\[\\]]+$",
  "\\[.\\]",
  "^\\u{1F600}$",
  "^\\uD83D\\uDE00$",
])("preserves ECMAScript Unicode matching for %s", (pattern) => {
  const oracle = new RegExp(pattern, "u");
  for (const tool of [false, true]) {
    const prepared = request({ type: "string", pattern }, tool);
    for (const value of [
      "",
      "a",
      "_",
      " ",
      "\t",
      "\n",
      "\r",
      "\u00a0",
      "\u1680",
      "\u2028",
      "\u2029",
      "\uFEFF",
      "😀",
      "a\n",
      "a\r",
      "a\r\n",
      "a\u2028",
      "a\u2029",
      ".[]",
      "[a]",
      "[\n]",
      "\uD800",
    ]) {
      const parse = () => parseCompletionResult(result(value, tool), prepared);
      if (oracle.test(value)) expect(parse).not.toThrow();
      else expect(parse).toThrow();
    }
  }
});
it("matches nested repetition in an isolated bounded process", () => {
  const code = `import {prepareCompletion,parseCompletionResult} from './src/completion-protocol.ts';const p=prepareCompletion({model:'bridge/default',messages:[{role:'user',content:'test'}],response_format:{type:'json_schema',json_schema:{name:'Test',schema:{type:'string',pattern:'^(a+)+$'}}}});let refused=false;try{parseCompletionResult(JSON.stringify({content:JSON.stringify('a'.repeat(100000)+'!'),tool_calls:[]}),p.request)}catch{refused=true}if(!refused)process.exit(1);console.log('bounded-pattern-pass');`;
  expect(
    execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      {
        timeout: 5000,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: "/nonexistent", NODE_ENV: "test" },
      },
    ),
  ).toContain("bounded-pattern-pass");
});

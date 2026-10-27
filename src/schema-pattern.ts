/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0 */
/* Licensed under https://www.apache.org/licenses/LICENSE-2.0 */

import { RE2JS } from "re2js";

// ECMAScript whitespace differs from RE2's ASCII \s. Expand both complements
// so character classes and their negations retain JSON Schema semantics.
const whitespace = [
  [9, 13],
  [32, 32],
  [160, 160],
  [5760, 5760],
  [8192, 8202],
  [8232, 8233],
  [8239, 8239],
  [8287, 8287],
  [12288, 12288],
  [65279, 65279],
] as const;
function ranges(values: readonly (readonly [number, number])[]): string {
  const point = (n: number) => "\\x{" + n.toString(16) + "}";
  return values
    .map(([a, b]) => point(a) + (a === b ? "" : "-" + point(b)))
    .join("");
}
const spaces = ranges(whitespace);
const complement: [number, number][] = [];
let start = 0;
for (const [a, b] of whitespace) {
  if (start < a) complement.push([start, a - 1]);
  start = b + 1;
}
complement.push([start, 0x10ffff]);
const nonspaces = ranges(complement);

function patternPoint(
  pattern: string,
  offset: number,
): [number | undefined, number] {
  if (pattern[offset] !== "\\") {
    const point = pattern.codePointAt(offset);
    return [point, point !== undefined && point > 0xffff ? 2 : 1];
  }
  const rest = pattern.slice(offset);
  const unicode = /^\\u(?:\{([0-9a-f]+)\}|([0-9a-f]{4}))/i.exec(rest);
  if (unicode) {
    const point = Number.parseInt(unicode[1] ?? unicode[2]!, 16);
    const low = /^\\u([dD][c-fC-F][0-9a-fA-F]{2})/.exec(
      rest.slice(unicode[0].length),
    );
    if (unicode[2] && point >= 0xd800 && point <= 0xdbff && low)
      return [
        0x10000 +
          (point - 0xd800) * 1024 +
          Number.parseInt(low[1]!, 16) -
          0xdc00,
        unicode[0].length + low[0].length,
      ];
    return [point, unicode[0].length];
  }
  const hex = /^\\x([0-9a-f]{2})/i.exec(rest);
  if (hex) return [Number.parseInt(hex[1]!, 16), hex[0].length];
  const control = /^\\c([a-z])/i.exec(rest);
  if (control) return [control[1]!.toUpperCase().charCodeAt(0) % 32, 3];
  const escapedPoints: Record<string, number> = {
    "0": 0,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
  };
  const escapedPoint = escapedPoints[pattern[offset + 1]!];
  if (escapedPoint !== undefined) return [escapedPoint, 2];
  return [
    /^[^a-zA-Z0-9]$/.test(pattern[offset + 1] ?? "")
      ? pattern.charCodeAt(offset + 1)
      : undefined,
    2,
  ];
}

function validateUnicodeSubset(pattern: string): void {
  let inClass = false,
    previous: number | undefined;
  for (let i = 0; i < pattern.length;) {
    const c = pattern[i]!;
    if (c === "\\" && /[pP]/.test(pattern[i + 1] ?? ""))
      throw new Error("Unicode property schema patterns are unsupported");
    const [point, width] = patternPoint(pattern, i);
    if (point !== undefined && point >= 0xd800 && point <= 0xdfff)
      throw new Error("Isolated surrogate schema patterns are unsupported");
    if (c === "[" && !inClass) {
      inClass = true;
      previous = undefined;
    } else if (c === "]") {
      inClass = false;
      previous = undefined;
    } else {
      // RE2's UTF-16 prefix search can enter a surrogate pair. Keep non-ASCII
      // class ranges outside the supported subset, including negated unions.
      if (
        inClass &&
        c === "-" &&
        previous !== undefined &&
        pattern[i + width] !== "]"
      ) {
        const [next] = patternPoint(pattern, i + width);
        if (next !== undefined && (previous > 0x7f || next > 0x7f))
          throw new Error("Non-ASCII schema character ranges are unsupported");
      }
      previous = point;
    }
    i += width;
  }
}

function compatiblePattern(pattern: string): string {
  let translated = "",
    inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") {
      const escape = pattern[++i]!;
      if (escape === "k" || /^[1-9]$/.test(escape))
        throw new Error("Schema pattern backreferences are unsupported");
      if (
        escape === "u" &&
        /^[0-9a-f]{4}$/i.test(pattern.slice(i + 1, i + 5))
      ) {
        const high = Number.parseInt(pattern.slice(i + 1, i + 5), 16);
        if (
          high >= 0xd800 &&
          high <= 0xdbff &&
          pattern.slice(i + 5, i + 7) === "\\u" &&
          /^[0-9a-f]{4}$/i.test(pattern.slice(i + 7, i + 11))
        ) {
          const low = Number.parseInt(pattern.slice(i + 7, i + 11), 16);
          if (low >= 0xdc00 && low <= 0xdfff) {
            translated +=
              "\\u{" +
              ((high - 0xd800) * 1024 + low - 0xdc00 + 0x10000).toString(16) +
              "}";
            i += 10;
            continue;
          }
        }
      }
      if (escape === "s" || escape === "S") {
        translated += inClass
          ? escape === "s"
            ? spaces
            : nonspaces
          : escape === "s"
            ? "[" + spaces + "]"
            : "[^" + spaces + "]";
      } else translated += "\\" + escape;
    } else {
      if (
        !inClass &&
        c === "(" &&
        pattern[i + 1] === "?" &&
        "ims-".includes(pattern[i + 2] ?? "!")
      )
        throw new Error("Inline schema pattern flags are unsupported");
      if (c === "[") inClass = true;
      if (c === "]") inClass = false;
      translated += c === "." && !inClass ? "[^\\n\\r\\x{2028}\\x{2029}]" : c;
    }
  }
  return RE2JS.translateRegExp(translated);
}

export const schemaRegExp = Object.assign(
  (pattern: string, flags: string) => {
    if (flags !== "u" || pattern.length > 1024)
      throw new Error("Bounded Unicode schema pattern required");
    // Syntax-check only: untrusted data is never matched by the backtracking VM.
    new RegExp(pattern, "u");
    validateUnicodeSubset(pattern);
    const compiled = RE2JS.compile(compatiblePattern(pattern));
    if (compiled.programSize() > 4096)
      throw new Error("Schema pattern is too complex");
    // Ajv keys its generated scope by RegExp.toString(); a generic object key
    // would alias unrelated patterns, including its own meta-schema patterns.
    return {
      test: (value: string) => compiled.test(value),
      toString: () => JSON.stringify([pattern, flags]),
    };
  },
  { code: "schemaRegExp" },
);

/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * Licensed under https://www.apache.org/licenses/LICENSE-2.0
 */
import { expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { prepareCompletion } from "../src/completion-protocol.js";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC";
const image = (url = "data:image/png;base64," + png, detail = "auto") => ({
  type: "image_url",
  image_url: { url, detail },
});
it("accepts bounded images in user-message order without base64 in the expanded prompt", () => {
  const prepared = prepareCompletion({
    model: "bridge/default",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "First caption" },
          image(),
          { type: "text", text: "Second caption" },
          image(),
        ],
      },
    ],
  });
  expect(prepared.prompt).not.toContain(png);
  expect(prepared.prompt.indexOf("First caption")).toBeLessThan(
    prepared.prompt.indexOf("Attached image 1"),
  );
  expect(prepared.prompt.indexOf("Attached image 1")).toBeLessThan(
    prepared.prompt.indexOf("Second caption"),
  );
  expect(prepared.prompt).toContain("Attached image 2");
});
it("rejects remote paths, noncanonical base64, unsupported detail and more than five images", () => {
  for (const part of [
    image("https://example.com/image.png"),
    image("file:///private/image.png"),
    image("data:image/png;base64,===="),
    image(undefined, "high"),
  ])
    expect(() =>
      prepareCompletion({
        model: "bridge/default",
        messages: [{ role: "user", content: [part] }],
      }),
    ).toThrow();
  expect(() =>
    prepareCompletion({
      model: "bridge/default",
      messages: [
        { role: "user", content: Array.from({ length: 6 }, () => image()) },
      ],
    }),
  ).toThrow(/five|5/);
});
it("rejects image data under higher-priority roles and native agent execution", () => {
  for (const role of ["system", "developer", "assistant", "tool"])
    expect(() =>
      prepareCompletion({
        model: "bridge/default",
        messages: [{ role, content: [image()] }],
      }),
    ).toThrow();
  expect(() =>
    prepareCompletion({
      model: "bridge/default",
      messages: [{ role: "user", content: [image()] }],
      bridge: { execution: "agent" },
    }),
  ).toThrow();
});
it("does not confuse a data URL string inside plain user text with an attachment", () => {
  expect(
    prepareCompletion({
      model: "bridge/default",
      messages: [{ role: "user", content: "data:image/png;base64," + png }],
    }).prompt,
  ).toContain(png);
});

import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeImage,
  crc32,
  stageImages,
  cleanupRecoveredImages,
} from "../src/images.js";
function chunk(kind: string, payload: Buffer) {
  const out = Buffer.alloc(payload.length + 12);
  out.writeUInt32BE(payload.length);
  out.write(kind, 4, "ascii");
  payload.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
  return out;
}
function padded(bytes: number) {
  const data = Buffer.from(png, "base64");
  return Buffer.concat([
    data.subarray(0, -12),
    chunk("tEXt", Buffer.alloc(bytes, 65)),
    data.subarray(-12),
  ]).toString("base64");
}
it("rejects aggregate decoded limits, CRC tampering, pixel bounds and compressed expansion bombs", () => {
  const content = [
    image("data:image/png;base64," + padded(3_010_000)),
    image("data:image/png;base64," + padded(3_010_000)),
  ];
  expect(() =>
    prepareCompletion({
      model: "bridge/default",
      messages: [{ role: "user", content }],
    }),
  ).toThrow(/decoded|6/);
  const corrupt = Buffer.from(png, "base64");
  corrupt[45] = 0;
  expect(() =>
    decodeImage("data:image/png;base64," + corrupt.toString("base64")),
  ).toThrow(/checksum/);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  const bomb = Buffer.concat([
    Buffer.from(png, "base64").subarray(0, 8),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc(1_000_000))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  expect(() =>
    decodeImage("data:image/png;base64," + bomb.toString("base64")),
  ).toThrow(/oversized|scanline/);
  header.writeUInt32BE(8193);
  const wide = Buffer.concat([
    bomb.subarray(0, 8),
    chunk("IHDR", header),
    bomb.subarray(33),
  ]);
  expect(() =>
    decodeImage("data:image/png;base64," + wide.toString("base64")),
  ).toThrow(/dimensions/);
});
it("stages only exclusive owner files, preserves existing paths and removes recovered temporary images", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-images-"));
  try {
    const decoded = decodeImage("data:image/png;base64," + png),
      staged = stageImages(dir, [decoded, decoded]);
    expect(
      staged.paths.map((path) => readFileSync(path).equals(decoded.data)),
    ).toEqual([true, true]);
    if (process.platform !== "win32")
      expect(statSync(staged.paths[0]!).mode & 0o777).toBe(0o600);
    staged.cleanup();
    expect(existsSync(staged.paths[0]!)).toBe(false);
    writeFileSync(join(dir, "completion-image-2.png"), "existing");
    expect(() => stageImages(dir, [decoded, decoded])).toThrow();
    expect(existsSync(join(dir, "completion-image-1.png"))).toBe(false);
    expect(readFileSync(join(dir, "completion-image-2.png"), "utf8")).toBe(
      "existing",
    );
    cleanupRecoveredImages(dir);
    writeFileSync(join(dir, "outside"), "do not change");
    if (process.platform !== "win32") {
      symlinkSync(join(dir, "outside"), join(dir, "completion-image-1.png"));
      expect(() => stageImages(dir, [decoded])).toThrow();
      expect(() => cleanupRecoveredImages(dir)).toThrow();
      expect(readFileSync(join(dir, "outside"), "utf8")).toBe("do not change");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
export { padded };

it("accepts a real JPEG frame and rejects signature mismatches", () => {
  const image = decodeImage(
    "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDtKKKK/Mz60//Z",
  );
  expect([image.width, image.height]).toEqual([3, 2]);
  expect(() =>
    decodeImage(
      "data:image/png;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDtKKKK/Mz60//Z",
    ),
  ).toThrow();
});

it("accepts a real WEBP frame and rejects signature mismatches", () => {
  const image = decodeImage(
    "data:image/webp;base64,UklGRjwAAABXRUJQVlA4IDAAAAAQAgCdASoDAAIAAUAmJaACdLoB+AH4AAPIAP7xuQ/98CWlQN/yBf/QjooaHuAAAAA=",
  );
  expect([image.width, image.height]).toEqual([3, 2]);
  expect(() =>
    decodeImage(
      "data:image/png;base64,UklGRjwAAABXRUJQVlA4IDAAAAAQAgCdASoDAAIAAUAmJaACdLoB+AH4AAPIAP7xuQ/98CWlQN/yBf/QjooaHuAAAAA=",
    ),
  ).toThrow();
});
it("rejects conflicting JPEG frames before decoding", () => {
  const first = Buffer.from([
    255, 216, 255, 192, 0, 11, 8, 0, 2, 0, 3, 1, 1, 17, 0,
  ]);
  const oversized = Buffer.from([
    255, 192, 0, 11, 8, 0, 2, 39, 16, 1, 1, 17, 0,
  ]);
  const tail = Buffer.from([255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 0, 255, 217]);
  expect(() =>
    decodeImage(
      "data:image/jpeg;base64," +
        Buffer.concat([first, oversized, tail]).toString("base64"),
    ),
  ).toThrow();
});
it("rejects truncated JPEG components, missing scans, later oversized frames and non-private staging directories", async () => {
  for (const hex of [
    "ffd8ffc0000b0800010001010000ffc0000b087fff7fff010000ffd9",
    "ffd8ffc0000b080001000101011100ffd9",
    "ffd8ffc0000a0800010001010111ffd9",
  ])
    expect(() =>
      decodeImage(
        "data:image/jpeg;base64," + Buffer.from(hex, "hex").toString("base64"),
      ),
    ).toThrow();
  if (process.platform !== "win32") {
    const dir = mkdtempSync(join(tmpdir(), "bridge-images-mode-")),
      { chmodSync } = await import("node:fs");
    try {
      chmodSync(dir, 0o755);
      expect(() =>
        stageImages(dir, [decodeImage("data:image/png;base64," + png)]),
      ).toThrow(/owned/);
      expect(() => cleanupRecoveredImages(dir)).toThrow(/owned/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

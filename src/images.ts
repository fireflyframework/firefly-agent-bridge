/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * Licensed under https://www.apache.org/licenses/LICENSE-2.0
 */
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import {
  constants,
  lstatSync,
  openSync,
  closeSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { BridgeError } from "./contracts.js";
export const IMAGE_LIMITS = {
  count: 5,
  decodedBytes: 6_000_000,
  maxEdge: 8192,
  pixels: 16_000_000,
  expandedBytes: 64_000_000,
} as const;
export const IMAGE_BODY_LIMIT = 9_000_000;
export type InputImage = {
  mime: "image/png" | "image/jpeg" | "image/webp";
  data: Buffer;
  width: number;
  height: number;
  sha256: string;
};
const invalid = (message: string): never => {
  throw new BridgeError("invalid_image", message, 400);
};
const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = table[(c ^ byte) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dimensions(
  width: number,
  height: number,
  bytesPerPixel = 4,
): [number, number] {
  if (
    !width ||
    !height ||
    width > IMAGE_LIMITS.maxEdge ||
    height > IMAGE_LIMITS.maxEdge ||
    width * height > IMAGE_LIMITS.pixels ||
    width * height * bytesPerPixel > IMAGE_LIMITS.expandedBytes
  )
    invalid(
      "Image dimensions or decoded expansion exceed the supported bounds",
    );
  return [width, height];
}
function pngSize(data: Buffer): [number, number] {
  if (
    !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    invalid("PNG signature does not match its media type");
  let position = 8,
    width = 0,
    height = 0,
    bits = 0,
    color = 0,
    interlace = 0,
    ended = false,
    seenData = false,
    palette = false,
    dataEnded = false;
  const compressed: Buffer[] = [];
  let chunks = 0;
  while (position < data.length) {
    if (++chunks > 4096 || position + 12 > data.length)
      invalid("PNG chunk structure is invalid");
    const length = data.readUInt32BE(position),
      end = position + length + 12;
    if (end > data.length) invalid("PNG chunk is truncated");
    const kind = data.toString("ascii", position + 4, position + 8),
      payload = data.subarray(position + 8, end - 4);
    if (
      crc32(data.subarray(position + 4, end - 4)) !== data.readUInt32BE(end - 4)
    )
      invalid("PNG checksum is invalid");
    if (!width && kind !== "IHDR")
      invalid("PNG must start with its image header");
    if (kind === "IHDR") {
      if (width || length !== 13) invalid("PNG image header is invalid");
      width = payload.readUInt32BE(0);
      height = payload.readUInt32BE(4);
      bits = payload[8]!;
      color = payload[9]!;
      interlace = payload[12]!;
      const valid: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !valid[color]?.includes(bits) ||
        payload[10] !== 0 ||
        payload[11] !== 0 ||
        interlace > 1
      )
        invalid("Unsupported PNG encoding");
      dimensions(
        width,
        height,
        ((color === 6 ? 4 : color === 4 ? 2 : color === 2 ? 3 : 1) * bits) / 8,
      );
    } else if (kind === "PLTE") {
      if (palette || seenData || !length || length % 3 || length > 768)
        invalid("PNG palette is invalid");
      palette = true;
    } else if (kind === "IDAT") {
      if (dataEnded) invalid("PNG image chunks must be consecutive");
      seenData = true;
      compressed.push(payload);
    } else if (kind === "IEND") {
      if (length || end !== data.length || !seenData)
        invalid("PNG trailer is invalid");
      ended = true;
    } else {
      if (seenData) dataEnded = true;
      if (
        ["acTL", "fcTL", "fdAT", "iCCP", "zTXt"].includes(kind) ||
        (kind === "iTXt" &&
          (payload.indexOf(0) < 0 || payload[payload.indexOf(0) + 1] !== 0))
      )
        invalid("Animated or compressed-metadata PNG files are unsupported");
      if (kind[0] === kind[0]?.toUpperCase())
        invalid("Unsupported critical PNG chunk");
    }
    position = end;
  }
  if (!ended || (color === 3 && !palette)) invalid("PNG image is incomplete");
  const channels = color === 6 ? 4 : color === 4 ? 2 : color === 2 ? 3 : 1;
  const passes = interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]];
  const rows: { count: number; bytes: number }[] = [];
  let expected = 0;
  for (const [x, y, dx, dy] of passes) {
    const w = Math.max(0, Math.ceil((width - x!) / dx!)),
      h = Math.max(0, Math.ceil((height - y!) / dy!));
    if (w && h) {
      const bytes = Math.ceil((w * channels * bits) / 8);
      rows.push({ count: h, bytes });
      expected += h * (bytes + 1);
    }
  }
  if (expected > IMAGE_LIMITS.expandedBytes)
    invalid("PNG decoded expansion exceeds its limit");
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(compressed), {
      maxOutputLength: expected + 1,
    });
  } catch {
    invalid("PNG compressed image data is invalid or oversized");
  }
  if (raw!.length !== expected)
    invalid("PNG scanline size does not match its dimensions");
  let offset = 0;
  for (const row of rows)
    for (let line = 0; line < row.count; line++) {
      if (raw![offset]! > 4) invalid("PNG filter is invalid");
      offset += row.bytes + 1;
    }
  return [width, height];
}
function jpegSize(data: Buffer): [number, number] {
  if (
    data.length < 12 ||
    data.readUInt16BE(0) !== 0xffd8 ||
    data.readUInt16BE(data.length - 2) !== 0xffd9
  )
    invalid("JPEG signature or trailer is invalid");
  let p = 2,
    segments = 0,
    scan = false,
    seenScan = false;
  let frame: [number, number] | undefined;
  let components = new Set<number>();
  while (p < data.length) {
    if (scan) {
      p = data.indexOf(255, p);
      if (p < 0) invalid("JPEG scan is truncated");
    }
    if (++segments > 4096 || data[p++] !== 255)
      invalid("JPEG segment is invalid");
    while (data[p] === 255) p++;
    if (p >= data.length) invalid("JPEG marker is truncated");
    const marker = data[p++]!;
    if (scan && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue;
    scan = false;
    if (marker === 0xd9) {
      if (!frame || !seenScan || p !== data.length)
        invalid("JPEG trailer or scan is invalid");
      return frame!;
    }
    if (marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7))
      invalid("Unexpected JPEG marker");
    if (marker === 1) continue;
    if (p + 2 > data.length) invalid("JPEG segment is truncated");
    const size = data.readUInt16BE(p);
    if (size < 2 || p + size > data.length)
      invalid("JPEG segment is truncated");
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      const count = data[p + 7];
      if (
        frame ||
        !count ||
        ![1, 3, 4].includes(count) ||
        size !== 8 + 3 * count ||
        data[p + 2] !== 8
      )
        invalid("Unsupported or conflicting JPEG frame");
      frame = dimensions(data.readUInt16BE(p + 5), data.readUInt16BE(p + 3));
      components = new Set<number>();
      for (let i = 0; i < count!; i++) {
        const offset = p + 8 + i * 3,
          id = data[offset]!,
          sampling = data[offset + 1]!;
        if (
          components.has(id) ||
          !(sampling >> 4) ||
          sampling >> 4 > 4 ||
          !(sampling & 15) ||
          (sampling & 15) > 4 ||
          data[offset + 2]! > 3
        )
          invalid("JPEG frame components are invalid");
        components.add(id);
      }
    } else if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    )
      invalid("Unsupported JPEG frame encoding");
    if (marker === 0xda) {
      const count = data[p + 2],
        selected = new Set<number>();
      if (!frame || !count || count > components.size || size !== 6 + 2 * count)
        invalid("JPEG scan header is invalid");
      for (let i = 0; i < count!; i++) {
        const id = data[p + 3 + i * 2]!;
        if (!components.has(id) || selected.has(id))
          invalid("JPEG scan components are invalid");
        selected.add(id);
      }
      scan = true;
      seenScan = true;
    }
    p += size;
  }
  return invalid("JPEG image has no complete scan and trailer");
}
function webpSize(data: Buffer): [number, number] {
  if (
    data.length < 20 ||
    data.toString("ascii", 0, 4) !== "RIFF" ||
    data.toString("ascii", 8, 12) !== "WEBP" ||
    data.readUInt32LE(4) + 8 !== data.length
  )
    invalid("WebP container is invalid");
  let p = 12,
    canvas: [number, number] | undefined,
    frame: [number, number] | undefined,
    chunks = 0;
  while (p + 8 <= data.length) {
    if (++chunks > 4096) invalid("WebP chunk bound exceeded");
    const kind = data.toString("ascii", p, p + 4),
      n = data.readUInt32LE(p + 4),
      body = p + 8;
    if (body + n > data.length) invalid("WebP chunk is truncated");
    if (kind === "ANIM" || kind === "ANMF")
      invalid("Animated WebP is unsupported");
    if (kind === "VP8X") {
      if (canvas || n !== 10 || data[body]! & 2)
        invalid("Unsupported WebP extended image");
      canvas = dimensions(
        1 + data.readUIntLE(body + 4, 3),
        1 + data.readUIntLE(body + 7, 3),
      );
    } else if (kind === "VP8 ") {
      if (
        frame ||
        n < 10 ||
        data[body]! & 1 ||
        !data.subarray(body + 3, body + 6).equals(Buffer.from([157, 1, 42]))
      )
        invalid("WebP lossy frame is invalid");
      frame = dimensions(
        data.readUInt16LE(body + 6) & 0x3fff,
        data.readUInt16LE(body + 8) & 0x3fff,
      );
    } else if (kind === "VP8L") {
      if (frame || n < 5 || data[body] !== 47 || data[body + 4]! >>> 5 !== 0)
        invalid("WebP lossless frame is invalid");
      frame = dimensions(
        1 + (data[body + 1]! | ((data[body + 2]! & 63) << 8)),
        1 +
          ((data[body + 2]! >>> 6) |
            (data[body + 3]! << 2) |
            ((data[body + 4]! & 15) << 10)),
      );
    }
    p = body + n + (n & 1);
  }
  if (
    p !== data.length ||
    !frame ||
    (canvas && (canvas[0] !== frame[0] || canvas[1] !== frame[1]))
  )
    invalid("WebP frame and container dimensions disagree");
  return frame!;
}
export function decodeImage(url: string): InputImage {
  const match =
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
  if (
    !match ||
    !match[2] ||
    match[2].length > Math.ceil(IMAGE_LIMITS.decodedBytes / 3) * 4
  )
    invalid(
      "Images require bounded PNG, JPEG or WebP base64 data URLs; external URLs and file paths are unavailable",
    );
  const data = Buffer.from(match![2]!, "base64");
  if (
    !data.length ||
    data.length > IMAGE_LIMITS.decodedBytes ||
    data.toString("base64") !== match![2]
  )
    invalid("Image base64 must use its canonical encoding");
  const mime = match![1] as InputImage["mime"];
  const [width, height] =
    mime === "image/png"
      ? pngSize(data)
      : mime === "image/jpeg"
        ? jpegSize(data)
        : webpSize(data);
  return {
    mime,
    data,
    width,
    height,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}
export function cleanupRecoveredImages(cwd: string): void {
  let directory;
  try {
    directory = lstatSync(cwd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (process.getuid && directory.uid !== process.getuid()) ||
    (process.platform !== "win32" && (directory.mode & 0o077) !== 0)
  )
    invalid("Image recovery requires the owned job directory");
  for (let i = 1; i <= IMAGE_LIMITS.count; i++)
    for (const extension of ["png", "jpg", "webp"]) {
      const path = join(cwd, `completion-image-${i}.${extension}`);
      let file;
      try {
        file = lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (
        !file.isFile() ||
        file.isSymbolicLink() ||
        file.nlink !== 1 ||
        (process.getuid && file.uid !== process.getuid())
      )
        invalid("Image recovery encountered an unowned or linked file");
      unlinkSync(path);
    }
}
export function stageImages(
  cwd: string,
  images: InputImage[],
): { paths: string[]; cleanup: () => void } {
  const directory = lstatSync(cwd);
  if (
    directory.isSymbolicLink() ||
    !directory.isDirectory() ||
    (process.getuid && directory.uid !== process.getuid()) ||
    (process.platform !== "win32" && (directory.mode & 0o077) !== 0)
  )
    invalid("Image staging requires the owned job directory");
  const paths: string[] = [];
  const cleanup = () => {
    for (const path of paths)
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
  };
  try {
    for (const [index, image] of images.entries()) {
      const extension =
        image.mime === "image/jpeg" ? "jpg" : image.mime.slice(6);
      const path = join(cwd, `completion-image-${index + 1}.${extension}`),
        fd = openSync(
          path,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            constants.O_NOFOLLOW,
          0o600,
        );
      paths.push(path);
      try {
        writeFileSync(fd, image.data);
      } finally {
        closeSync(fd);
      }
    }
  } catch (error) {
    cleanup();
    throw error;
  }
  return { paths, cleanup };
}

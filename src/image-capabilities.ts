/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * Licensed under https://www.apache.org/licenses/LICENSE-2.0
 */
import { randomInt } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { BridgeError, terminal, type Principal } from "./contracts.js";
import type { HttpDependencies } from "./http.js";
import {
  prepareCompletion,
  parseCompletionResult,
} from "./completion-protocol.js";
import { crc32, IMAGE_LIMITS } from "./images.js";
import {
  currentImageExecution,
  freezeImageExecution,
} from "./image-execution.js";
type Probe = {
  job_id: string;
  profile: string;
  revision: string;
  expected: string;
  status: "pending" | "verified" | "failed";
  verified_at?: string;
};
function revision(d: HttpDependencies, profile: string) {
  return currentImageExecution(d.config, profile).revision;
}

function load(d: HttpDependencies, key: string): Probe | undefined {
  const row = d.store.db
    .prepare("SELECT value FROM metadata WHERE key=?")
    .get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as Probe) : undefined;
}
function save(d: HttpDependencies, key: string, probe: Probe) {
  d.store.db
    .prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)")
    .run(key, JSON.stringify(probe));
}
export function imageCapability(d: HttpDependencies, profile: string) {
  const config_revision = revision(d, profile),
    proof = load(d, "image-verified:" + profile);
  return {
    status:
      proof?.revision === config_revision && proof.status === "verified"
        ? "verified"
        : "unverified",
    config_revision,
    mime_types: ["image/png", "image/jpeg", "image/webp"],
    max_images: IMAGE_LIMITS.count,
    max_decoded_bytes: IMAGE_LIMITS.decodedBytes,
    detail: "auto",
    ...(proof?.revision === config_revision && proof.status === "verified"
      ? { verified_at: proof.verified_at, probe_job_id: proof.job_id }
      : {}),
  };
}
const digits = [
  "111101101101111",
  "010110010010111",
  "111001111100111",
  "111001111001111",
  "101101111001001",
  "111100111001111",
  "111100111101111",
  "111001001001001",
  "111101111101111",
  "111101111001111",
];
function chunk(kind: string, payload: Buffer) {
  const name = Buffer.from(kind),
    result = Buffer.alloc(payload.length + 12);
  result.writeUInt32BE(payload.length);
  name.copy(result, 4);
  payload.copy(result, 8);
  result.writeUInt32BE(
    crc32(Buffer.concat([name, payload])),
    payload.length + 8,
  );
  return result;
}
export function challengeImage(code: string): Buffer {
  const scale = 12,
    width = code.length * 4 * scale + scale,
    height = 7 * scale,
    rows = Buffer.alloc(height * (width * 3 + 1), 255);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  for (const [index, char] of [...code].entries())
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 3; x++)
        if (digits[Number(char)]![y * 3 + x] === "1")
          for (let dy = 0; dy < scale; dy++)
            for (let dx = 0; dx < scale; dx++) {
              const p =
                (y * scale + scale + dy) * (width * 3 + 1) +
                1 +
                (index * 4 * scale + scale + x * scale + dx) * 3;
              rows.fill(0, p, p + 3);
            }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
export function registerImageCapabilities(
  app: FastifyInstance,
  d: HttpDependencies,
  identity: (req: FastifyRequest, scope: string) => Principal,
) {
  const owner = (req: FastifyRequest) => {
    const p = identity(req, "read");
    if (!p.owner)
      throw new BridgeError(
        "forbidden",
        "Owner authentication is required",
        403,
      );
    return p;
  };
  app.post("/v1/bridge/image-input/probes", async (req, reply) => {
    const p = owner(req),
      body = z
        .strictObject({
          profile: z.string().min(1).max(100),
          request_id: z.string().uuid(),
        })
        .parse(req.body);
    if (!d.config.profiles[body.profile])
      throw new BridgeError("model_not_found", "Profile is unavailable", 404);
    const config_revision = revision(d, body.profile);
    const job = d.store.idempotent(
      p,
      "image-input/probes",
      body.request_id,
      { profile: body.profile, config_revision },
      () => {
        if (d.scheduler.controlState.paused)
          throw new BridgeError(
            "bridge_paused",
            "Resume the bridge before starting a probe",
            409,
          );
        const expected = String(randomInt(10000000, 100000000));
        const prepared = prepareCompletion({
          model: "bridge/" + body.profile,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Read the eight-digit code in the attached image. Return only the digits as text. Do not use tools or infer a code from any other source.",
                },
                {
                  type: "image_url",
                  image_url: {
                    url:
                      "data:image/png;base64," +
                      challengeImage(expected).toString("base64"),
                    detail: "auto",
                  },
                },
              ],
            },
          ],
        });
        const admitted = d.store.submit(
          { prompt: prepared.prompt, profile: body.profile, mode: "cli" },
          p,
          undefined,
          prepared.request,
        );
        freezeImageExecution(d.store, admitted.id, d.config, body.profile);
        save(d, "image-probe:" + admitted.id, {
          job_id: admitted.id,
          profile: body.profile,
          revision: config_revision,
          expected,
          status: "pending",
        });
        return admitted;
      },
      (id) => d.store.get(id, p),
    );
    d.scheduler.wake();
    return reply
      .code(202)
      .send({ job_id: job.id, status: job.status, config_revision });
  });
  app.get("/v1/bridge/image-input/probes/:id", async (req) => {
    const p = owner(req),
      id = z.strictObject({ id: z.string().uuid() }).parse(req.params).id;
    const proof = load(d, "image-probe:" + id);
    if (!proof)
      throw new BridgeError("not_found", "Image probe was not found", 404);
    const job = d.store.get(id, p);
    if (
      proof.status === "pending" &&
      (terminal.has(job.status) ||
        ["paused", "interrupted"].includes(job.status))
    ) {
      let matches = false;
      try {
        matches =
          job.status === "succeeded" &&
          parseCompletionResult(
            job.result!,
            job.completion!,
          ).content?.trim() === proof.expected;
      } catch {
        /* Invalid or missing structured output does not verify image input. */
      }
      proof.status =
        matches && revision(d, proof.profile) === proof.revision
          ? "verified"
          : "failed";
      if (proof.status === "verified")
        proof.verified_at = new Date().toISOString();
      d.store.atomic(() => {
        save(d, "image-probe:" + id, proof);
        if (proof.status === "verified")
          save(d, "image-verified:" + proof.profile, proof);
      });
    }
    return {
      job_id: id,
      status: proof.status,
      job_status: job.status,
      image_input: imageCapability(d, proof.profile),
    };
  });
}

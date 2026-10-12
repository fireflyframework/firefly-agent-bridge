/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * Licensed under https://www.apache.org/licenses/LICENSE-2.0
 */
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { startService } from "../src/service.js";
import { parseConfig } from "../src/config.js";
const dir = mkdtempSync(resolve("work/live-codex-images-"));
const service = await startService(
  parseConfig({
    dataDir: dir,
    workspace: join(dir, "jobs"),
    worker: "codex",
    codexPath:
      process.env.FORGE_CODEX_PATH ??
      resolve(process.env.HOME!, ".local/bin/codex"),
    port: 0,
    profiles: { default: { timeoutMs: 120000, maxOutputBytes: 2000000 } },
  }),
);
const headers = {
  authorization: "Bearer " + service.ownerToken,
  "content-type": "application/json",
};
async function request(path: string, body?: unknown) {
  const response = await fetch(service.address + path, {
    headers,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  assert(response.ok, JSON.stringify(data));
  return data;
}
try {
  const first = await request("/v1/models");
  assert.equal(first.data[0].image_input.status, "unverified");
  const request_id = randomUUID(),
    admitted = await request("/v1/bridge/image-input/probes", {
      profile: "default",
      request_id,
    });
  let proof;
  const deadline = Date.now() + 130000;
  do {
    await new Promise((r) => setTimeout(r, 500));
    proof = await request("/v1/bridge/image-input/probes/" + admitted.job_id);
  } while (proof.status === "pending" && Date.now() < deadline);
  assert.equal(proof.status, "verified", JSON.stringify(proof));
  const replay = await request("/v1/bridge/image-input/probes", {
    profile: "default",
    request_id,
  });
  assert.equal(replay.job_id, admitted.job_id);
  const model = await request("/v1/models");
  assert.equal(model.data[0].image_input.status, "verified");
  const job = service.store.get(admitted.job_id);
  assert(job.usage);
  assert.equal(
    readdirSync(join(dir, "jobs", job.id)).some((name) =>
      name.startsWith("completion-image-"),
    ),
    false,
  );
  const evidence = {
    tested_at: new Date().toISOString(),
    worker: "codex",
    official_auth: "ChatGPT subscription",
    protocol: "pixel-only eight-digit challenge",
    request_id,
    job_id: job.id,
    image_input: model.data[0].image_input,
    usage: job.usage,
    temporary_images_removed: true,
    idempotent_probe: true,
  };
  const path = join(dir, "evidence.json");
  writeFileSync(path, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, evidence: path, job_id: job.id }));
} finally {
  await service.close();
}

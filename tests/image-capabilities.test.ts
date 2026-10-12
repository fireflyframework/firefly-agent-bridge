/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * Licensed under https://www.apache.org/licenses/LICENSE-2.0
 */
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startService } from "../src/service.js";
import { parseConfig } from "../src/config.js";
import { Tokens } from "../src/auth.js";
let service: Awaited<ReturnType<typeof startService>> | undefined;
let dir: string;
afterEach(async () => {
  await service?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
it("pins image capability to the profile and verifies only an owner-only durable pixel challenge", async () => {
  dir = mkdtempSync(join(tmpdir(), "bridge-image-proof-"));
  service = await startService(
    parseConfig({
      dataDir: dir,
      workspace: join(dir, "jobs"),
      worker: "codex",
      codexPath: process.execPath,
      port: 0,
    }),
    {
      worker: () => ({
        ready: async () => ({ ready: true }),
        run: async () => ({
          status: "succeeded",
          result: JSON.stringify({ content: "00000000", tool_calls: [] }),
        }),
      }),
    },
  );
  const headers = {
    authorization: "Bearer " + service.ownerToken,
    "content-type": "application/json",
  };
  const model = await (
    await fetch(service.address + "/v1/models", { headers })
  ).json();
  expect(model.data[0].image_input).toMatchObject({
    status: "unverified",
    max_images: 5,
    max_decoded_bytes: 6000000,
  });
  const token = new Tokens(service.store).create({
    id: "reader",
    owner: false,
    profiles: ["default"],
    scopes: ["read", "submit"],
  }).token;
  const body = { profile: "default", request_id: randomUUID() };
  const route = service.address + "/v1/bridge/image-input/probes";
  expect(
    (
      await fetch(route, {
        method: "POST",
        headers: { ...headers, authorization: "Bearer " + token },
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(403);
  const a = await (
    await fetch(route, { method: "POST", headers, body: JSON.stringify(body) })
  ).json();
  const b = await (
    await fetch(route, { method: "POST", headers, body: JSON.stringify(body) })
  ).json();
  expect(a.job_id).toBe(b.job_id);
  for (
    let n = 0;
    n < 100 && service.store.get(a.job_id).status !== "succeeded";
    n++
  )
    await new Promise((r) => setTimeout(r, 20));
  const proof = await (await fetch(route + "/" + a.job_id, { headers })).json();
  expect(proof.status).toBe("failed");
  expect(proof.image_input.status).toBe("unverified");
  expect(JSON.stringify(proof)).not.toContain("expected");
});
it("publishes verified proof only for the tested configuration and invalidates changed profiles", async () => {
  dir = mkdtempSync(join(tmpdir(), "bridge-image-verified-"));
  const config = parseConfig({
    dataDir: dir,
    workspace: join(dir, "jobs"),
    worker: "codex",
    codexPath: process.execPath,
    port: 0,
  });
  service = await startService(config, {
    worker: () => ({
      ready: async () => ({ ready: true }),
      run: async (input) => {
        const row = service!.store.db
          .prepare("SELECT value FROM metadata WHERE key=?")
          .get("image-probe:" + input.job.id) as { value: string };
        return {
          status: "succeeded",
          result: JSON.stringify({
            content: JSON.parse(row.value).expected,
            tool_calls: [],
          }),
        };
      },
    }),
  });
  const headers = {
      authorization: "Bearer " + service.ownerToken,
      "content-type": "application/json",
    },
    body = { profile: "default", request_id: randomUUID() },
    route = service.address + "/v1/bridge/image-input/probes";
  const admitted = await (
    await fetch(route, { method: "POST", headers, body: JSON.stringify(body) })
  ).json();
  for (
    let n = 0;
    n < 100 && service.store.get(admitted.job_id).status !== "succeeded";
    n++
  )
    await new Promise((r) => setTimeout(r, 20));
  const proof = await (
    await fetch(route + "/" + admitted.job_id, { headers })
  ).json();
  expect(proof.status).toBe("verified");
  expect(proof.image_input.config_revision).toMatch(/^[a-f0-9]{64}$/);
  config.profiles.default!.model = "changed-model";
  const models = await (
    await fetch(service.address + "/v1/models", { headers })
  ).json();
  expect(models.data[0].image_input.status).toBe("unverified");
  expect(models.data[0].image_input.config_revision).not.toBe(
    proof.image_input.config_revision,
  );
  expect(
    (
      await fetch(route, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(409);
});
it("cleans interrupted images on recovery and rejects retry or resume without a native session", async () => {
  dir = mkdtempSync(join(tmpdir(), "bridge-image-recover-"));
  const { QueueStore } = await import("../src/store.js"),
    { prepareCompletion } = await import("../src/completion-protocol.js"),
    { stageImages } = await import("../src/images.js"),
    { mkdirSync, existsSync } = await import("node:fs");
  const store = new QueueStore(join(dir, "queue.sqlite")),
    principal = { id: "owner", owner: true, profiles: ["default"] };
  const prepared = prepareCompletion({
    model: "bridge/default",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC",
            },
          },
        ],
      },
    ],
  });
  const job = store.submit(
    { prompt: prepared.prompt },
    principal,
    undefined,
    prepared.request,
  );
  store.claim("lost-owner", "cli", job.id);
  const cwd = join(dir, "jobs", job.id);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  stageImages(cwd, prepared.images);
  store.close();
  service = await startService(
    parseConfig({
      dataDir: dir,
      workspace: join(dir, "jobs"),
      worker: "codex",
      codexPath: process.execPath,
      port: 0,
    }),
    {
      worker: () => ({
        ready: async () => ({ ready: false }),
        run: async () => ({ status: "failed" }),
      }),
    },
  );
  expect(service.store.get(job.id).status).toBe("interrupted");
  expect(existsSync(join(cwd, "completion-image-1.png"))).toBe(false);
  expect(() => service!.store.retry(job.id, principal)).toThrow(/new explicit/);
  expect(() => service!.store.resume(job.id, principal)).toThrow(
    /new explicit/,
  );
});
it("binds verified image admission and actual worker selection to the private frozen profile", async () => {
  dir = mkdtempSync(join(tmpdir(), "bridge-image-admission-"));
  const config = parseConfig({
    dataDir: dir,
    workspace: join(dir, "jobs"),
    worker: "codex",
    codexPath: process.execPath,
    port: 0,
    profiles: { default: { model: "original-model" } },
  });
  const executions: unknown[] = [];
  service = await startService(config, {
    worker: (_job, snapshot) => {
      executions.push(snapshot);
      return {
        ready: async () => ({ ready: true }),
        run: async () => ({
          status: "succeeded",
          result: JSON.stringify({ content: "ok", tool_calls: [] }),
        }),
      };
    },
  });
  await service.scheduler.stop();
  const { imageCapability } = await import("../src/image-capabilities.js"),
    { loadImageExecution } = await import("../src/image-execution.js");
  const d = { store: service.store, config } as Parameters<
      typeof imageCapability
    >[0],
    capability = imageCapability(d, "default");
  service.store.db.prepare("INSERT INTO metadata(key,value) VALUES(?,?)").run(
    "image-verified:default",
    JSON.stringify({
      job_id: randomUUID(),
      profile: "default",
      revision: capability.config_revision,
      expected: "fixture",
      status: "verified",
      verified_at: new Date().toISOString(),
    }),
  );
  const headers = {
    authorization: "Bearer " + service.ownerToken,
    "content-type": "application/json",
    "X-Bridge-Image-Revision": capability.config_revision,
    "Idempotency-Key": randomUUID(),
  };
  const body = {
    model: "bridge/default",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC",
            },
          },
        ],
      },
    ],
    bridge: { background: true },
  };
  expect(
    (
      await fetch(service.address + "/v1/chat/completions", {
        method: "POST",
        headers: { ...headers, "X-Bridge-Image-Revision": "f".repeat(64) },
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(409);
  const admitted = await (
    await fetch(service.address + "/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
  ).json();
  config.worker = "claude";
  config.profiles.default!.model = "changed-model";
  service.scheduler.start();
  for (
    let n = 0;
    n < 100 && service.store.get(admitted.id).status !== "succeeded";
    n++
  )
    await new Promise((r) => setTimeout(r, 20));
  expect(service.store.get(admitted.id).status).toBe("succeeded");
  expect(executions).toContainEqual(
    expect.objectContaining({
      worker: "codex",
      options: expect.objectContaining({ model: "original-model" }),
    }),
  );
  expect(loadImageExecution(service.store, admitted.id)?.options.model).toBe(
    "original-model",
  );
  const replay = await (
    await fetch(service.address + "/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
  ).json();
  expect(replay.id).toBe(admitted.id);
  expect(
    (
      await fetch(service.address + "/v1/chat/completions", {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": randomUUID() },
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(409);
  expect(JSON.stringify(service.store.get(admitted.id))).not.toContain(
    "original-model",
  );
});
it("fails a queued image before worker execution if its frozen executable is replaced", async () => {
  dir = mkdtempSync(join(tmpdir(), "bridge-image-executable-"));
  const { writeFileSync } = await import("node:fs"),
    path = join(dir, "codex-fixture");
  writeFileSync(path, "original", { mode: 0o600 });
  let calls = 0;
  service = await startService(
    parseConfig({
      dataDir: dir,
      workspace: join(dir, "jobs"),
      worker: "codex",
      codexPath: path,
      port: 0,
    }),
    {
      worker: () => ({
        ready: async () => ({ ready: true }),
        run: async () => {
          calls++;
          return { status: "succeeded" };
        },
      }),
    },
  );
  await service.scheduler.stop();
  const headers = {
      authorization: "Bearer " + service.ownerToken,
      "content-type": "application/json",
    },
    body = {
      model: "bridge/default",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC",
              },
            },
          ],
        },
      ],
      bridge: { background: true },
    };
  const admitted = await (
    await fetch(service.address + "/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
  ).json();
  writeFileSync(path, "replacement executable");
  service.scheduler.start();
  for (
    let n = 0;
    n < 100 && service.store.get(admitted.id).status !== "failed";
    n++
  )
    await new Promise((r) => setTimeout(r, 20));
  expect(service.store.get(admitted.id).error).toContain(
    "image_configuration_changed",
  );
  expect(calls).toBe(0);
});

/*!
 * Copyright (c) 2026 Signature Management Consultants SLU
 * Author: @ancongui (https://github.com/ancongui)
 * Modified by Firefly Software Foundation for Firefly Agent Bridge (2026).
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ClusterAuth } from "../src/cluster-auth.js";
import {
  generateNodeKeyPair,
  signWorkerRequest,
} from "../src/cluster-crypto.js";
import type { NodeCapacity, NodeResources } from "../src/cluster-types.js";
import { startClusterWorker } from "../src/cluster-worker.js";
import { parseConfig } from "../src/config.js";
import type { Attempt, Job, Outcome } from "../src/contracts.js";
import { startService } from "../src/service.js";
import type { Worker, WorkerEvent } from "../src/worker.js";

function signedHeaders(
  privateKeyPem: string,
  credential: string,
  method: string,
  path: string,
  body: string,
): Record<string, string> {
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString("base64url");
  return {
    authorization: "Bearer " + credential,
    "content-type": "application/json",
    "x-bridge-timestamp": timestamp,
    "x-bridge-nonce": nonce,
    "x-bridge-signature": signWorkerRequest({
      privateKeyPem,
      timestamp,
      nonce,
      method,
      path,
      body,
    }),
  };
}

type FakeClaim = {
  attempt: Attempt;
  job: Job;
  profile: Record<string, unknown>;
  imageExecution?: { worker: "claude" | "codex"; path: string; options: Record<string, unknown>; revision: string };
};

function healthyResources(): NodeResources {
  return {
    platform: "darwin",
    collectedAt: "2026-10-27T00:00:00.000Z",
    cpu: { cores: 4, busyRatio: 0.1, load1: 0.2, load5: 0.2, load15: 0.2 },
    memory: {
      totalBytes: 8 * 1024 * 1024 * 1024,
      freeBytes: 4 * 1024 * 1024 * 1024,
      usedRatio: 0.5,
    },
    disk: {
      path: "/workspace",
      totalBytes: 100 * 1024 * 1024 * 1024,
      freeBytes: 50 * 1024 * 1024 * 1024,
      usedRatio: 0.5,
    },
  };
}

function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs)
        return reject(new Error("timed out waiting for condition"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("cluster worker pull loop", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  it("heartbeats, claims from frozen snapshot, forwards finish", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-worker-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const finished: Array<{ attemptId: string; outcome: Outcome }> = [];
    const heartbeats: NodeCapacity[] = [];
    let claimIssued = false;
    const claim: FakeClaim = {
      attempt: {
        id: "att_1",
        jobId: "job_1",
        owner: "node_a:owner-1",
        fence: "fence-1",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        nodeId: "node_a",
      },
      job: {
        id: "job_1",
        prompt: "do the thing",
        profile: "default",
        mode: "cli",
        principalId: "owner",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
      },
      profile: {
        permissionMode: "bypass",
        tools: ["Read"],
        timeoutMs: 30_000,
        maxOutputBytes: 100_000,
        maxTurns: 5,
        maxSubagents: 0,
        agents: {},
        model: "frozen-model",
      },
    };

    const app = Fastify({ logger: false });
    app.post("/v1/cluster/nodes/:id/heartbeat", async (req) => {
      heartbeats.push(req.body as NodeCapacity);
      return { id: "node_a", status: "online", controls: [] };
    });
    app.post("/v1/cluster/nodes/:id/claim", async () => {
      if (claimIssued) return { claims: [] };
      claimIssued = true;
      return { claims: [claim] };
    });
    app.post("/v1/cluster/attempts/:id/events", async () => ({ ok: true }));
    app.post("/v1/cluster/attempts/:id/finish", async (req) => {
      const body = req.body as { outcome: Outcome };
      finished.push({
        attemptId: String((req.params as { id: string }).id),
        outcome: body.outcome,
      });
      return { ok: true };
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    cleanups.push(() => app.close());

    writeFileSync(
      join(dir, "cluster.json"),
      JSON.stringify({
        coordinatorUrl: address,
        nodeId: "node_a",
        credential: "ffn_test_credential",
        nodePrivateKey: generateNodeKeyPair().privateKeyPem,
        reservePercent: 10,
        allowInsecure: true,
      }),
    );

    const config = parseConfig({
      dataDir: dir,
      workspace: join(dir, "jobs"),
      claudePath: process.execPath,
      concurrency: 1,
      port: 0,
      cluster: {
        mode: "worker",
        reservePercent: 10,
      },
    });

    let usedModel: string | undefined;
    const handle = await startClusterWorker(config, {
      heartbeatIntervalMs: 40,
      workerFactory: (entry) => {
        usedModel = (entry.profile as { model?: string }).model;
        return {
          ready: async () => ({
            ready: true,
            authentication: {
              provider: "claude",
              state: "authenticated",
              source: "official_cli_auth_status",
              observedAt: new Date().toISOString(),
            },
          }),
          run: async (_input, emit: (e: WorkerEvent) => void) => {
            emit({ kind: "progress", text: "working" });
            return { status: "succeeded", result: "from-frozen" };
          },
        } satisfies Worker;
      },
    });
    cleanups.push(() => handle.stop());

    await waitFor(() => finished.length === 1);
    expect(finished[0]).toMatchObject({
      attemptId: "att_1",
      outcome: { status: "succeeded", result: "from-frozen" },
    });
    expect(usedModel).toBe("frozen-model");
    expect(heartbeats.length).toBeGreaterThan(0);
    expect(heartbeats[0]!.resources).toBeTruthy();
    expect(heartbeats[0]!.resources.cpu.cores).toBeGreaterThan(0);
  });

  it("applies pause control by aborting the active attempt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-worker-pause-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const finished: Outcome[] = [];
    let running = false;
    let releaseRun: () => void = () => {};
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });

    const claim: FakeClaim = {
      attempt: {
        id: "att_pause",
        jobId: "job_pause",
        owner: "node_a:owner-pause",
        fence: "fence-pause",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        nodeId: "node_a",
      },
      job: {
        id: "job_pause",
        prompt: "long",
        profile: "default",
        mode: "cli",
        principalId: "owner",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
      },
      profile: {
        permissionMode: "default",
        tools: ["Read"],
        timeoutMs: 60_000,
        maxOutputBytes: 100_000,
        maxTurns: 5,
        maxSubagents: 0,
        agents: {},
      },
    };

    let claimed = false;
    let pauseArmed = false;
    const app = Fastify({ logger: false });
    app.post("/v1/cluster/nodes/:id/heartbeat", async () => {
      const controls =
        pauseArmed && running
          ? [
              {
                attemptId: "att_pause",
                action: "pause" as const,
                fence: "fence-pause",
              },
            ]
          : [];
      return { id: "node_a", status: "online", controls };
    });
    app.post("/v1/cluster/nodes/:id/claim", async () => {
      if (claimed) return { claims: [] };
      claimed = true;
      return { claims: [claim] };
    });
    app.post("/v1/cluster/attempts/:id/events", async () => ({ ok: true }));
    app.post("/v1/cluster/attempts/:id/finish", async (req) => {
      finished.push((req.body as { outcome: Outcome }).outcome);
      return { ok: true };
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    cleanups.push(() => app.close());

    writeFileSync(
      join(dir, "cluster.json"),
      JSON.stringify({
        coordinatorUrl: address,
        nodeId: "node_a",
        credential: "ffn_test_credential",
        nodePrivateKey: generateNodeKeyPair().privateKeyPem,
        reservePercent: null,
        allowInsecure: true,
      }),
    );

    const config = parseConfig({
      dataDir: dir,
      workspace: join(dir, "jobs"),
      claudePath: process.execPath,
      concurrency: 1,
      port: 0,
      cluster: {
        mode: "worker",
        reservePercent: 10,
      },
    });

    const handle = await startClusterWorker(config, {
      heartbeatIntervalMs: 40,
      workerFactory: () => ({
        ready: async () => ({ ready: true }),
        run: async (_input, _emit, signal) => {
          running = true;
          pauseArmed = true;
          await new Promise<void>((resolve) => {
            const onAbort = () => resolve();
            if (signal.aborted) return resolve();
            signal.addEventListener("abort", onAbort, { once: true });
            releaseRun();
          });
          return signal.reason === "pause"
            ? { status: "paused", error: "operator_pause" }
            : { status: "canceled" };
        },
      }),
    });
    cleanups.push(() => handle.stop());

    await waitFor(() => running);
    await runGate;
    await waitFor(() => finished.length === 1);
    expect(finished[0]).toMatchObject({
      status: "paused",
      error: "operator_pause",
    });
  });

  it("caches previousCpuTimes across heartbeats for resource probe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-worker-cpu-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const previousArgs: Array<unknown> = [];
    const app = Fastify({ logger: false });
    app.post("/v1/cluster/nodes/:id/heartbeat", async () => ({
      id: "node_a",
      status: "online",
      controls: [],
    }));
    app.post("/v1/cluster/nodes/:id/claim", async () => ({ claims: [] }));
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    cleanups.push(() => app.close());

    writeFileSync(
      join(dir, "cluster.json"),
      JSON.stringify({
        coordinatorUrl: address,
        nodeId: "node_a",
        credential: "ffn_test_credential",
        nodePrivateKey: generateNodeKeyPair().privateKeyPem,
        allowInsecure: true,
      }),
    );

    const config = parseConfig({
      dataDir: dir,
      workspace: join(dir, "jobs"),
      claudePath: process.execPath,
      concurrency: 1,
      port: 0,
      cluster: {
        mode: "worker",
        reservePercent: 10,
      },
    });

    const sample = [
      { user: 10, nice: 0, sys: 5, idle: 100, irq: 0 },
      { user: 20, nice: 0, sys: 10, idle: 200, irq: 0 },
    ];
    let beat = 0;
    const handle = await startClusterWorker(config, {
      heartbeatIntervalMs: 30,
      collectResources: (_workspace, options) => {
        previousArgs.push(options?.previousCpuTimes ?? null);
        beat += 1;
        return {
          ...healthyResources(),
          collectedAt: new Date().toISOString(),
          cpu: {
            ...healthyResources().cpu,
            busyRatio: options?.previousCpuTimes ? 0.25 : 1,
          },
        };
      },
      sampleCpuTimes: () =>
        sample.map((t) => ({
          ...t,
          user: t.user + beat * 10,
          idle: t.idle + beat * 40,
        })),
    });
    cleanups.push(() => handle.stop());

    await waitFor(() => previousArgs.length >= 2);
    expect(previousArgs[0]).toBeNull();
    expect(previousArgs[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ user: expect.any(Number), idle: expect.any(Number) }),
      ]),
    );
  });

  it("coordinator offline tick interrupts running attempts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-coord-offline-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const config = parseConfig({
      dataDir: dir,
      workspace: join(dir, "jobs"),
      claudePath: process.execPath,
      port: 0,
      cluster: {
        mode: "coordinator",
        bindHost: "127.0.0.1",
        reservePercent: 10,
        heartbeatStaleMs: 1000,
        heartbeatOfflineMs: 1000,
      },
    });
    const service = await startService(config, {
      worker: () => ({
        ready: async () => ({ ready: true }),
        run: async () => {
          throw new Error("coordinator must not run");
        },
      }),
    });
    cleanups.push(() => service.close());

    const { token: joinToken } = new ClusterAuth(service.store).createJoinToken({
      createdBy: "owner",
      ttlMs: 60_000,
    });
    const keys = generateNodeKeyPair();
    const joinRes = await fetch(service.address + "/v1/cluster/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: joinToken,
        name: "gone",
        worker: "claude",
        concurrency: 1,
        publicKey: keys.publicKeyPem,
      }),
    });
    const worker = (await joinRes.json()) as {
      nodeId: string;
      credential: string;
    };

    const capacity: NodeCapacity = {
      worker: "claude",
      concurrency: 1,
      active: 0,
      freeSlots: 1,
      authentication: "authenticated",
      quota: {
        state: "ok",
        resetAt: null,
        windowStartedAt: new Date().toISOString(),
        estimatedUsedUnits: 0,
        estimatedCapacityUnits: 100,
      },
      resources: healthyResources(),
      reservePercent: 10,
      draining: false,
    };
    const hbPath = `/v1/cluster/nodes/${worker.nodeId}/heartbeat`;
    const hbBody = JSON.stringify(capacity);
    await fetch(service.address + hbPath, {
      method: "POST",
      headers: signedHeaders(
        keys.privateKeyPem,
        worker.credential,
        "POST",
        hbPath,
        hbBody,
      ),
      body: hbBody,
    });

    const submit = await fetch(service.address + "/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + service.ownerToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "bridge/default",
        messages: [{ role: "user", content: "offline me" }],
        bridge: { execution: "agent", background: true },
      }),
    });
    const job = (await submit.json()) as { id: string };

    const claimPath = `/v1/cluster/nodes/${worker.nodeId}/claim`;
    const claimBody = JSON.stringify({ freeSlots: 1 });
    const claimed = await fetch(service.address + claimPath, {
      method: "POST",
      headers: signedHeaders(
        keys.privateKeyPem,
        worker.credential,
        "POST",
        claimPath,
        claimBody,
      ),
      body: claimBody,
    });
    const body = (await claimed.json()) as { claims: FakeClaim[] };
    expect(body.claims).toHaveLength(1);

    const evPath = `/v1/cluster/attempts/${body.claims[0]!.attempt.id}/events`;
    const evBody = JSON.stringify({
      owner: body.claims[0]!.attempt.owner,
      fence: body.claims[0]!.attempt.fence,
      events: [
        {
          kind: "session",
          text: "",
          data: { sessionId: "sess_keep" },
        },
      ],
    });
    await fetch(service.address + evPath, {
      method: "POST",
      headers: signedHeaders(
        keys.privateKeyPem,
        worker.credential,
        "POST",
        evPath,
        evBody,
      ),
      body: evBody,
    });

    // Age the heartbeat so the next coordinator tick marks the node offline.
    service.store.db
      .prepare("UPDATE cluster_nodes SET last_heartbeat_at=? WHERE id=?")
      .run(new Date(Date.now() - 5000).toISOString(), worker.nodeId);

    await waitFor(() => service.store.get(job.id).status === "interrupted", 4000);

    const done = service.store.get(job.id);
    expect(done.status).toBe("interrupted");
    expect(done.sessionId).toBe("sess_keep");
    expect(done.sessionNodeId).toBe(worker.nodeId);
  });
});

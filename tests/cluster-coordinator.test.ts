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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ClusterAuth } from "../src/cluster-auth.js";
import {
  generateNodeKeyPair,
  signWorkerRequest,
} from "../src/cluster-crypto.js";
import type { NodeCapacity, NodeResources } from "../src/cluster-types.js";
import { parseConfig } from "../src/config.js";
import { startService } from "../src/service.js";

type Service = Awaited<ReturnType<typeof startService>>;

let dir: string;
let service: Service;

const healthyResources = (): NodeResources => ({
  platform: "darwin",
  collectedAt: "2026-10-27T00:00:00.000Z",
  cpu: { cores: 8, busyRatio: 0.2, load1: 1, load5: 0.8, load15: 0.5 },
  memory: {
    totalBytes: 16 * 1024 * 1024 * 1024,
    freeBytes: 8 * 1024 * 1024 * 1024,
    usedRatio: 0.5,
  },
  disk: {
    path: "/workspace",
    totalBytes: 500 * 1024 * 1024 * 1024,
    freeBytes: 200 * 1024 * 1024 * 1024,
    usedRatio: 0.6,
  },
});

const capacity = (overrides: Partial<NodeCapacity> = {}): NodeCapacity => ({
  worker: "claude",
  concurrency: 2,
  active: 0,
  freeSlots: 2,
  authentication: "authenticated",
  quota: {
    state: "ok",
    resetAt: null,
    windowStartedAt: "2026-10-27T00:00:00.000Z",
    estimatedUsedUnits: 0,
    estimatedCapacityUnits: 100,
  },
  resources: healthyResources(),
  reservePercent: 10,
  draining: false,
  ...overrides,
});

async function startCoordinator() {
  dir = mkdtempSync(join(tmpdir(), "bridge-coord-"));
  const config = parseConfig({
    dataDir: dir,
    workspace: join(dir, "jobs"),
    claudePath: process.execPath,
    port: 0,
    cluster: {
      mode: "coordinator",
      bindHost: "127.0.0.1",
      reservePercent: 10,
    },
  });
  service = await startService(config, {
    worker: () => ({
      ready: async () => ({ ready: true }),
      run: async () => {
        throw new Error("coordinator must not run local CLI jobs");
      },
    }),
  });
  return service;
}

type WorkerCreds = {
  nodeId: string;
  credential: string;
  privateKeyPem: string;
};

function signedHeaders(
  privateKeyPem: string,
  credential: string,
  method: string,
  path: string,
  body: string,
): Record<string, string> {
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString("base64url");
  const headers: Record<string, string> = {
    authorization: "Bearer " + credential,
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
  // Empty DELETE bodies must not advertise JSON or Fastify rejects the request.
  if (body.length > 0) headers["content-type"] = "application/json";
  return headers;
}

async function joinWorker(
  address: string,
  joinToken: string,
  name: string,
  worker: "claude" | "codex" = "claude",
): Promise<WorkerCreds> {
  const keys = generateNodeKeyPair();
  const res = await fetch(address + "/v1/cluster/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: joinToken,
      name,
      worker,
      concurrency: 2,
      publicKey: keys.publicKeyPem,
    }),
  });
  expect(res.status).toBe(200);
  const joined = (await res.json()) as { nodeId: string; credential: string };
  return { ...joined, privateKeyPem: keys.privateKeyPem };
}

async function workerPost(
  address: string,
  worker: WorkerCreds,
  path: string,
  payload: unknown,
) {
  const body = JSON.stringify(payload);
  return fetch(address + path, {
    method: "POST",
    headers: signedHeaders(
      worker.privateKeyPem,
      worker.credential,
      "POST",
      path,
      body,
    ),
    body,
  });
}

async function heartbeat(
  address: string,
  worker: WorkerCreds,
  snap: NodeCapacity = capacity(),
) {
  const path = `/v1/cluster/nodes/${worker.nodeId}/heartbeat`;
  const res = await workerPost(address, worker, path, snap);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    status: string;
    controls: Array<{ attemptId: string; action: string; fence: string }>;
  };
}

async function claim(
  address: string,
  worker: WorkerCreds,
  freeSlots = 1,
  workerType: "claude" | "codex" = "claude",
) {
  const path = `/v1/cluster/nodes/${worker.nodeId}/claim`;
  const res = await workerPost(address, worker, path, {
    freeSlots,
    worker: workerType,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    claims: Array<{
      attempt: {
        id: string;
        jobId: string;
        owner: string;
        fence: string;
        nodeId?: string;
      };
      job: {
        id: string;
        prompt: string;
        profile: string;
        assignedNodeId?: string;
        clusterHandoff?: {
          reason: string;
          fromNodeId: string;
          brief: string;
        };
      };
      profile: Record<string, unknown>;
      imageExecution?: unknown;
    }>;
  };
}

beforeEach(async () => {
  await startCoordinator();
});

afterEach(async () => {
  await service?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ClusterCoordinator protocol", () => {
  it("join → submit → claim → event → finish yields succeeded job", async () => {
    const { token: joinToken } = new ClusterAuth(service.store).createJoinToken(
      {
        createdBy: "owner",
        ttlMs: 60_000,
      },
    );
    const worker = await joinWorker(service.address, joinToken, "desk-a");
    await heartbeat(service.address, worker);

    const submit = await fetch(service.address + "/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + service.ownerToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "bridge/default",
        messages: [{ role: "user", content: "cluster hello" }],
        bridge: { execution: "agent", background: true },
      }),
    });
    expect([200, 202]).toContain(submit.status);
    const job = (await submit.json()) as { id: string };
    expect(job.id).toBeTruthy();

    // Local scheduler must not claim CLI work on a coordinator.
    await new Promise((r) => setTimeout(r, 150));
    const before = await (
      await fetch(service.address + "/v1/bridge/jobs/" + job.id, {
        headers: { authorization: "Bearer " + service.ownerToken },
      })
    ).json();
    expect(before.status).toBe("queued");

    const claimed = await claim(service.address, worker);
    expect(claimed.claims).toHaveLength(1);
    const [entry] = claimed.claims;
    expect(entry!.job.id).toBe(job.id);
    expect(entry!.attempt.nodeId).toBe(worker.nodeId);
    expect(entry!.job.assignedNodeId).toBe(worker.nodeId);
    expect(entry!.profile).toMatchObject({
      permissionMode: expect.any(String),
      tools: expect.any(Array),
    });

    const eventRes = await workerPost(
      service.address,
      worker,
      `/v1/cluster/attempts/${entry!.attempt.id}/events`,
      {
        owner: entry!.attempt.owner,
        fence: entry!.attempt.fence,
        events: [
          {
            kind: "session",
            text: "",
            data: { sessionId: "sess_sticky_1" },
          },
          { kind: "progress", text: "working" },
        ],
      },
    );
    expect(eventRes.status).toBe(200);

    const finishRes = await workerPost(
      service.address,
      worker,
      `/v1/cluster/attempts/${entry!.attempt.id}/finish`,
      {
        owner: entry!.attempt.owner,
        fence: entry!.attempt.fence,
        outcome: {
          status: "succeeded",
          result: "done from worker",
          sessionId: "sess_sticky_1",
        },
      },
    );
    expect(finishRes.status).toBe(200);

    const done = await (
      await fetch(service.address + "/v1/bridge/jobs/" + job.id, {
        headers: { authorization: "Bearer " + service.ownerToken },
      })
    ).json();
    expect(done.status).toBe("succeeded");
    expect(done.result).toBe("done from worker");
    expect(done.sessionId).toBe("sess_sticky_1");
    expect(done.sessionNodeId).toBe(worker.nodeId);

    const status = await (
      await fetch(service.address + "/v1/bridge/status", {
        headers: { authorization: "Bearer " + service.ownerToken },
      })
    ).json();
    expect(status.cluster).toMatchObject({
      mode: "coordinator",
      reservePercent: 10,
    });
    expect(status.cluster.pool).toMatchObject({
      onlineNodes: 1,
      queuedJobs: expect.any(Number),
      runningJobs: expect.any(Number),
    });
    expect(status.cluster.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: worker.nodeId, name: "desk-a" }),
      ]),
    );
  });

  it("does not let another node steal a sticky sessionNodeId job", async () => {
    const auth = new ClusterAuth(service.store);
    const { token: joinToken } = auth.createJoinToken({
      createdBy: "owner",
      ttlMs: 60_000,
    });
    const a = await joinWorker(service.address, joinToken, "node-a");
    await heartbeat(service.address, a);

    const submit = await fetch(service.address + "/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + service.ownerToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "bridge/default",
        messages: [{ role: "user", content: "sticky job" }],
        bridge: { execution: "agent", background: true },
      }),
    });
    const job = (await submit.json()) as { id: string };

    const first = await claim(service.address, a);
    expect(first.claims).toHaveLength(1);
    const attempt = first.claims[0]!.attempt;

    await workerPost(
      service.address,
      a,
      `/v1/cluster/attempts/${attempt.id}/events`,
      {
        owner: attempt.owner,
        fence: attempt.fence,
        events: [
          { kind: "session", text: "", data: { sessionId: "native-sess" } },
        ],
      },
    );
    await workerPost(
      service.address,
      a,
      `/v1/cluster/attempts/${attempt.id}/finish`,
      {
        owner: attempt.owner,
        fence: attempt.fence,
        outcome: {
          status: "paused",
          error: "operator_pause",
          sessionId: "native-sess",
        },
      },
    );

    // Second node joins after sticky is established — must not steal.
    const { token: joinTokenB } = auth.createJoinToken({
      createdBy: "owner",
      ttlMs: 60_000,
    });
    const b = await joinWorker(service.address, joinTokenB, "node-b");
    await heartbeat(service.address, b);

    // Resume keeps sticky binding; only node A may claim.
    await fetch(service.address + "/v1/bridge/jobs/" + job.id + "/resume", {
      method: "POST",
      headers: { authorization: "Bearer " + service.ownerToken },
    });

    const stolen = await claim(service.address, b);
    expect(stolen.claims).toHaveLength(0);

    const sticky = await claim(service.address, a);
    expect(sticky.claims).toHaveLength(1);
    expect(sticky.claims[0]!.job.id).toBe(job.id);
    expect(sticky.claims[0]!.attempt.nodeId).toBe(a.nodeId);
  });

  it("admin pause blocks claims and returns pause controls on heartbeat", async () => {
    const { token: joinToken } = new ClusterAuth(service.store).createJoinToken(
      {
        createdBy: "owner",
        ttlMs: 60_000,
      },
    );
    const worker = await joinWorker(service.address, joinToken, "desk-pause");
    await heartbeat(service.address, worker);

    const submit = await fetch(service.address + "/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + service.ownerToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "bridge/default",
        messages: [{ role: "user", content: "pause me" }],
        bridge: { execution: "agent", background: true },
      }),
    });
    const job = (await submit.json()) as { id: string };
    const claimed = await claim(service.address, worker);
    expect(claimed.claims).toHaveLength(1);
    const attempt = claimed.claims[0]!.attempt;

    const pause = await fetch(service.address + "/v1/bridge/admin/pause", {
      method: "POST",
      headers: { authorization: "Bearer " + service.ownerToken },
    });
    expect(pause.status).toBe(200);

    const hb = await heartbeat(
      service.address,
      worker,
      capacity({ freeSlots: 1, active: 1 }),
    );
    expect(hb.controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attemptId: attempt.id,
          action: "pause",
          fence: attempt.fence,
        }),
      ]),
    );

    const blocked = await claim(service.address, worker, 2);
    expect(blocked.claims).toHaveLength(0);

    const status = await (
      await fetch(service.address + "/v1/bridge/status", {
        headers: { authorization: "Bearer " + service.ownerToken },
      })
    ).json();
    expect(status.cluster.dispatch).toBe("paused");

    // Finish the in-flight attempt so a second job can prove the gate.
    await workerPost(
      service.address,
      worker,
      `/v1/cluster/attempts/${attempt.id}/finish`,
      {
        owner: attempt.owner,
        fence: attempt.fence,
        outcome: { status: "paused", error: "operator_pause" },
      },
    );

    await fetch(service.address + "/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + service.ownerToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "bridge/default",
        messages: [{ role: "user", content: "while paused" }],
        bridge: { execution: "agent", background: true },
      }),
    });
    const stillBlocked = await claim(service.address, worker);
    expect(stillBlocked.claims).toHaveLength(0);
    void job;
  });

  it("hides node inventory from non-admin principals", async () => {
    const { token: joinToken } = new ClusterAuth(service.store).createJoinToken(
      {
        createdBy: "owner",
        ttlMs: 60_000,
      },
    );
    const worker = await joinWorker(service.address, joinToken, "hidden");
    await heartbeat(service.address, worker);

    const { Tokens } = await import("../src/auth.js");
    const scoped = new Tokens(service.store).create({
      id: "reader",
      owner: false,
      profiles: ["default"],
      scopes: ["read"],
    }).token;

    const status = await (
      await fetch(service.address + "/v1/bridge/status", {
        headers: { authorization: "Bearer " + scoped },
      })
    ).json();
    expect(status.cluster.mode).toBe("coordinator");
    expect(status.cluster.pool).toBeTruthy();
    expect(status.cluster.nodes).toEqual([]);
  });

  it("omits sessionNodeId and assignedNodeId from non-admin client job views", async () => {
    const { token: joinToken } = new ClusterAuth(service.store).createJoinToken(
      {
        createdBy: "owner",
        ttlMs: 60_000,
      },
    );
    const worker = await joinWorker(service.address, joinToken, "desk-opaque");
    await heartbeat(service.address, worker);

    const { Tokens } = await import("../src/auth.js");
    const tokens = new Tokens(service.store);
    const reader = tokens.create({
      id: "job-reader",
      owner: false,
      profiles: ["default"],
      scopes: ["read", "submit"],
    }).token;
    // Same principal id as reader, with admin — node fields visible on owned jobs.
    const adminScoped = tokens.create({
      id: "job-reader-admin",
      owner: false,
      profiles: ["default"],
      scopes: ["read", "submit", "admin"],
    }).token;

    const submit = await fetch(service.address + "/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + reader,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "bridge/default",
        messages: [{ role: "user", content: "opaque nodes" }],
        bridge: { execution: "agent", background: true },
      }),
    });
    const job = (await submit.json()) as { id: string };
    const claimed = await claim(service.address, worker);
    expect(claimed.claims).toHaveLength(1);
    const attempt = claimed.claims[0]!.attempt;
    await workerPost(
      service.address,
      worker,
      `/v1/cluster/attempts/${attempt.id}/events`,
      {
        owner: attempt.owner,
        fence: attempt.fence,
        events: [
          { kind: "session", text: "", data: { sessionId: "opaque-sess" } },
        ],
      },
    );

    const clientJob = await (
      await fetch(service.address + "/v1/bridge/jobs/" + job.id, {
        headers: { authorization: "Bearer " + reader },
      })
    ).json();
    expect(clientJob.sessionId).toBe("opaque-sess");
    expect(clientJob).not.toHaveProperty("sessionNodeId");
    expect(clientJob).not.toHaveProperty("assignedNodeId");

    const listed = await (
      await fetch(service.address + "/v1/bridge/jobs", {
        headers: { authorization: "Bearer " + reader },
      })
    ).json();
    const listedJob = listed.jobs.find((j: { id: string }) => j.id === job.id);
    expect(listedJob).toBeTruthy();
    expect(listedJob).not.toHaveProperty("sessionNodeId");
    expect(listedJob).not.toHaveProperty("assignedNodeId");

    const ownerJob = await (
      await fetch(service.address + "/v1/bridge/jobs/" + job.id, {
        headers: { authorization: "Bearer " + service.ownerToken },
      })
    ).json();
    expect(ownerJob.assignedNodeId).toBe(worker.nodeId);
    expect(ownerJob.sessionNodeId).toBe(worker.nodeId);

    // Admin principal submits its own job so get() authorization succeeds.
    const adminSubmit = await fetch(service.address + "/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + adminScoped,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "bridge/default",
        messages: [{ role: "user", content: "admin sees nodes" }],
        bridge: { execution: "agent", background: true },
      }),
    });
    const adminJobId = ((await adminSubmit.json()) as { id: string }).id;
    const adminClaimed = await claim(service.address, worker);
    expect(adminClaimed.claims).toHaveLength(1);
    const adminAttempt = adminClaimed.claims[0]!.attempt;
    await workerPost(
      service.address,
      worker,
      `/v1/cluster/attempts/${adminAttempt.id}/events`,
      {
        owner: adminAttempt.owner,
        fence: adminAttempt.fence,
        events: [
          { kind: "session", text: "", data: { sessionId: "admin-sess" } },
        ],
      },
    );
    const adminJob = await (
      await fetch(service.address + "/v1/bridge/jobs/" + adminJobId, {
        headers: { authorization: "Bearer " + adminScoped },
      })
    ).json();
    expect(adminJob.assignedNodeId).toBe(worker.nodeId);
    expect(adminJob.sessionNodeId).toBe(worker.nodeId);
  });

  it("enqueues pause controls for siblings when heartbeat reports limited", async () => {
    const { token: joinToken } = new ClusterAuth(service.store).createJoinToken(
      {
        createdBy: "owner",
        ttlMs: 60_000,
      },
    );
    const worker = await joinWorker(service.address, joinToken, "desk-limited");
    await heartbeat(service.address, worker);

    const ids: string[] = [];
    for (const prompt of ["sib-a", "sib-b"]) {
      const submit = await fetch(service.address + "/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer " + service.ownerToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "bridge/default",
          messages: [{ role: "user", content: prompt }],
          bridge: { execution: "agent", background: true },
        }),
      });
      ids.push(((await submit.json()) as { id: string }).id);
    }

    const claimed = await claim(service.address, worker, 2);
    expect(claimed.claims).toHaveLength(2);
    const attempts = claimed.claims.map((c) => c.attempt);

    const hb = await heartbeat(
      service.address,
      worker,
      capacity({
        freeSlots: 0,
        active: 2,
        quota: {
          state: "limited",
          resetAt: Date.now() + 60_000,
          windowStartedAt: "2026-10-27T00:00:00.000Z",
          estimatedUsedUnits: 100,
          estimatedCapacityUnits: 100,
        },
      }),
    );
    expect(hb.controls).toHaveLength(2);
    expect(hb.controls).toEqual(
      expect.arrayContaining(
        attempts.map((a) =>
          expect.objectContaining({
            attemptId: a.id,
            action: "pause",
            fence: a.fence,
          }),
        ),
      ),
    );

    for (const id of ids) {
      const job = await (
        await fetch(service.address + "/v1/bridge/jobs/" + id, {
          headers: { authorization: "Bearer " + service.ownerToken },
        })
      ).json();
      expect(job.status).toBe("pause_requested");
    }
  });

  it("validates profile before claim so missing profile does not orphan a running attempt", async () => {
    const { token: joinToken } = new ClusterAuth(service.store).createJoinToken(
      {
        createdBy: "owner",
        ttlMs: 60_000,
      },
    );
    const worker = await joinWorker(service.address, joinToken, "desk-profile");
    await heartbeat(service.address, worker);

    const submit = await fetch(service.address + "/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + service.ownerToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "bridge/default",
        messages: [{ role: "user", content: "gone profile" }],
        bridge: { execution: "agent", background: true },
      }),
    });
    const job = (await submit.json()) as { id: string };

    const row = service.store.db
      .prepare("SELECT data FROM jobs WHERE id=?")
      .get(job.id) as { data: string };
    const data = JSON.parse(row.data) as { profile: string; status: string };
    data.profile = "deleted_profile";
    service.store.db
      .prepare("UPDATE jobs SET data=? WHERE id=?")
      .run(JSON.stringify(data), job.id);

    const claimed = await claim(service.address, worker);
    expect(claimed.claims).toHaveLength(0);

    const attempts = service.store.db
      .prepare("SELECT count(*) AS n FROM attempts WHERE job_id=?")
      .get(job.id) as { n: number };
    expect(attempts.n).toBe(0);

    const done = await (
      await fetch(service.address + "/v1/bridge/jobs/" + job.id, {
        headers: { authorization: "Bearer " + service.ownerToken },
      })
    ).json();
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/profile_unknown/);
  });

  it("failovers sticky work when home is limited so a peer can claim", async () => {
    const auth = new ClusterAuth(service.store);
    const { token: joinToken } = auth.createJoinToken({
      createdBy: "owner",
      ttlMs: 60_000,
    });
    const a = await joinWorker(service.address, joinToken, "home-limited");
    await heartbeat(service.address, a);

    const submit = await fetch(service.address + "/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + service.ownerToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "bridge/default",
        messages: [{ role: "user", content: "sticky failover" }],
        bridge: { execution: "agent", background: true },
      }),
    });
    const job = (await submit.json()) as { id: string };
    const first = await claim(service.address, a);
    const attempt = first.claims[0]!.attempt;
    await workerPost(
      service.address,
      a,
      `/v1/cluster/attempts/${attempt.id}/events`,
      {
        owner: attempt.owner,
        fence: attempt.fence,
        events: [
          { kind: "session", text: "", data: { sessionId: "wait-sess" } },
        ],
      },
    );
    await workerPost(
      service.address,
      a,
      `/v1/cluster/attempts/${attempt.id}/finish`,
      {
        owner: attempt.owner,
        fence: attempt.fence,
        outcome: {
          status: "paused",
          error: "quota_exhausted",
          sessionId: "wait-sess",
        },
      },
    );

    const afterPause = await (
      await fetch(service.address + "/v1/bridge/jobs/" + job.id, {
        headers: { authorization: "Bearer " + service.ownerToken },
      })
    ).json();
    // Finish with quota_exhausted triggers coordinator failover (sticky cleared).
    expect(afterPause.status).toBe("queued");
    expect(afterPause.sessionNodeId).toBeUndefined();
    expect(afterPause.failoverCount).toBe(1);
    expect(afterPause.clusterHandoff?.reason).toBe("quota");

    const { token: joinTokenB } = auth.createJoinToken({
      createdBy: "owner",
      ttlMs: 60_000,
    });
    const b = await joinWorker(service.address, joinTokenB, "other-node");
    await heartbeat(service.address, b);

    const peer = await claim(service.address, b);
    expect(peer.claims).toHaveLength(1);
    expect(peer.claims[0]!.job.id).toBe(job.id);
    expect(peer.claims[0]!.attempt.nodeId).toBe(b.nodeId);
    expect(peer.claims[0]!.job.clusterHandoff?.brief).toContain("failover");
    // Handoff is one-shot on the durable job after claim.
    const durable = service.store.get(job.id);
    expect(durable.clusterHandoff).toBeUndefined();
    expect(durable.assignedNodeId).toBe(b.nodeId);

    const status = (await (
      await fetch(service.address + "/v1/bridge/status", {
        headers: { authorization: "Bearer " + service.ownerToken },
      })
    ).json()) as { cluster?: { pool?: { failovers?: number } } };
    expect(status.cluster?.pool?.failovers).toBeGreaterThanOrEqual(1);
  });

  it("failovers offline node work so a peer can claim", async () => {
    const auth = new ClusterAuth(service.store);
    const { token: joinToken } = auth.createJoinToken({
      createdBy: "owner",
      ttlMs: 60_000,
    });
    const a = await joinWorker(service.address, joinToken, "going-offline");
    await heartbeat(service.address, a);

    const submit = await fetch(service.address + "/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + service.ownerToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "bridge/default",
        messages: [{ role: "user", content: "offline failover" }],
        bridge: { execution: "agent", background: true },
      }),
    });
    const job = (await submit.json()) as { id: string };
    const first = await claim(service.address, a);
    const attempt = first.claims[0]!.attempt;
    await workerPost(
      service.address,
      a,
      `/v1/cluster/attempts/${attempt.id}/events`,
      {
        owner: attempt.owner,
        fence: attempt.fence,
        events: [
          { kind: "session", text: "", data: { sessionId: "off-sess" } },
        ],
      },
    );

    const leavePath = `/v1/cluster/nodes/${a.nodeId}`;
    const leaveBody = "";
    const leave = await fetch(service.address + leavePath, {
      method: "DELETE",
      headers: signedHeaders(
        a.privateKeyPem,
        a.credential,
        "DELETE",
        leavePath,
        leaveBody,
      ),
    });
    expect(leave.status).toBe(200);

    const afterLeave = service.store.get(job.id);
    expect(afterLeave.status).toBe("queued");
    expect(afterLeave.sessionNodeId).toBeUndefined();
    expect(afterLeave.clusterHandoff?.reason).toBe("offline");

    const { token: joinTokenB } = auth.createJoinToken({
      createdBy: "owner",
      ttlMs: 60_000,
    });
    const b = await joinWorker(service.address, joinTokenB, "takeover");
    await heartbeat(service.address, b);
    const peer = await claim(service.address, b);
    expect(peer.claims).toHaveLength(1);
    expect(peer.claims[0]!.job.id).toBe(job.id);
  });

  it("fails a job after maxFailovers is exhausted", async () => {
    const principal = { id: "system", owner: true, profiles: ["default"] };
    const job = service.store.submit(
      { prompt: "exhaust", profile: "default", mode: "cli" },
      principal,
    );
    service.store.pause(job.id, principal);
    for (let i = 0; i < 3; i++) {
      const live = service.store.beginClusterFailover(job.id, {
        reason: "quota",
        fromNodeId: "node_a",
        maxFailovers: 3,
      });
      expect(live.status).toBe("queued");
      service.store.pause(job.id, principal);
    }
    const failed = service.store.beginClusterFailover(job.id, {
      reason: "quota",
      fromNodeId: "node_a",
      maxFailovers: 3,
    });
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/cluster_failover_exhausted/);
  });

  it("accepts Claude and Codex workers and dispatches by capacity", async () => {
    const auth = new ClusterAuth(service.store);
    const { token: tClaude } = auth.createJoinToken({
      createdBy: "owner",
      ttlMs: 60_000,
    });
    const { token: tCodex } = auth.createJoinToken({
      createdBy: "owner",
      ttlMs: 60_000,
    });
    const claude = await joinWorker(
      service.address,
      tClaude,
      "claude-node",
      "claude",
    );
    const codex = await joinWorker(
      service.address,
      tCodex,
      "codex-node",
      "codex",
    );
    await heartbeat(
      service.address,
      claude,
      capacity({ worker: "claude", freeSlots: 0, active: 2 }),
    );
    await heartbeat(
      service.address,
      codex,
      capacity({ worker: "codex", freeSlots: 2 }),
    );

    const status = (await (
      await fetch(service.address + "/v1/bridge/status", {
        headers: { authorization: "Bearer " + service.ownerToken },
      })
    ).json()) as {
      cluster?: {
        pool?: {
          eligibleNodes: number;
          eligibleByProvider?: { claude: number; codex: number };
        };
      };
    };
    expect(status.cluster?.pool?.eligibleByProvider).toEqual({
      claude: 0,
      codex: 1,
    });
    expect(status.cluster?.pool?.eligibleNodes).toBe(1);

    const submit = await fetch(service.address + "/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + service.ownerToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "bridge/default",
        messages: [{ role: "user", content: "mixed pool" }],
        bridge: { execution: "agent", background: true },
      }),
    });
    const job = (await submit.json()) as { id: string };
    const claimed = await claim(service.address, codex, 1, "codex");
    expect(claimed.claims).toHaveLength(1);
    expect(claimed.claims[0]!.job.id).toBe(job.id);
    expect(service.store.get(job.id).worker).toBe("codex");
  });

  it("failovers from Claude sticky home to a Codex peer with handoff", async () => {
    const auth = new ClusterAuth(service.store);
    const { token: tClaude } = auth.createJoinToken({
      createdBy: "owner",
      ttlMs: 60_000,
    });
    const claude = await joinWorker(
      service.address,
      tClaude,
      "home-claude",
      "claude",
    );
    await heartbeat(service.address, claude, capacity({ worker: "claude" }));

    const submit = await fetch(service.address + "/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + service.ownerToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "bridge/default",
        messages: [{ role: "user", content: "cross cli failover" }],
        bridge: { execution: "agent", background: true },
      }),
    });
    const job = (await submit.json()) as { id: string };
    const first = await claim(service.address, claude);
    const attempt = first.claims[0]!.attempt;
    await workerPost(
      service.address,
      claude,
      `/v1/cluster/attempts/${attempt.id}/events`,
      {
        owner: attempt.owner,
        fence: attempt.fence,
        events: [
          { kind: "session", text: "", data: { sessionId: "claude-sess" } },
        ],
      },
    );
    await workerPost(
      service.address,
      claude,
      `/v1/cluster/attempts/${attempt.id}/finish`,
      {
        owner: attempt.owner,
        fence: attempt.fence,
        outcome: {
          status: "paused",
          error: "quota_exhausted",
          sessionId: "claude-sess",
        },
      },
    );

    const after = service.store.get(job.id);
    expect(after.status).toBe("queued");
    expect(after.sessionId).toBeUndefined();
    expect(after.clusterHandoff?.brief).toContain("failover");

    await heartbeat(
      service.address,
      claude,
      capacity({
        worker: "claude",
        quota: {
          state: "limited",
          resetAt: Date.now() + 120_000,
          windowStartedAt: "2026-10-27T00:00:00.000Z",
          estimatedUsedUnits: 100,
          estimatedCapacityUnits: 100,
        },
      }),
    );

    const { token: tCodex } = auth.createJoinToken({
      createdBy: "owner",
      ttlMs: 60_000,
    });
    const codex = await joinWorker(
      service.address,
      tCodex,
      "peer-codex",
      "codex",
    );
    await heartbeat(service.address, codex, capacity({ worker: "codex" }));
    const peer = await claim(service.address, codex, 1, "codex");
    expect(peer.claims).toHaveLength(1);
    expect(peer.claims[0]!.job.id).toBe(job.id);
    expect(peer.claims[0]!.job.clusterHandoff?.brief).toContain("failover");
    expect(service.store.get(job.id).worker).toBe("codex");
    expect(service.store.get(job.id).sessionId).toBeUndefined();
  });
});

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
import { ClusterAuth } from "../src/cluster-auth.js";
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

async function joinWorker(
  address: string,
  joinToken: string,
  name: string,
): Promise<{ nodeId: string; credential: string }> {
  const res = await fetch(address + "/v1/cluster/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: joinToken,
      name,
      worker: "claude",
      concurrency: 2,
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { nodeId: string; credential: string };
}

async function heartbeat(
  address: string,
  nodeId: string,
  credential: string,
  snap: NodeCapacity = capacity(),
) {
  const res = await fetch(address + `/v1/cluster/nodes/${nodeId}/heartbeat`, {
    method: "POST",
    headers: {
      authorization: "Bearer " + credential,
      "content-type": "application/json",
    },
    body: JSON.stringify(snap),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    status: string;
    controls: Array<{ attemptId: string; action: string; fence: string }>;
  };
}

async function claim(
  address: string,
  nodeId: string,
  credential: string,
  freeSlots = 1,
) {
  const res = await fetch(address + `/v1/cluster/nodes/${nodeId}/claim`, {
    method: "POST",
    headers: {
      authorization: "Bearer " + credential,
      "content-type": "application/json",
    },
    body: JSON.stringify({ freeSlots, worker: "claude" }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    claims: Array<{
      attempt: { id: string; jobId: string; owner: string; fence: string; nodeId?: string };
      job: { id: string; prompt: string; profile: string; assignedNodeId?: string };
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
    const { token: joinToken } = new ClusterAuth(service.store).createJoinToken({
      createdBy: "owner",
      ttlMs: 60_000,
    });
    const worker = await joinWorker(service.address, joinToken, "desk-a");
    await heartbeat(service.address, worker.nodeId, worker.credential);

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

    const claimed = await claim(
      service.address,
      worker.nodeId,
      worker.credential,
    );
    expect(claimed.claims).toHaveLength(1);
    const [entry] = claimed.claims;
    expect(entry!.job.id).toBe(job.id);
    expect(entry!.attempt.nodeId).toBe(worker.nodeId);
    expect(entry!.job.assignedNodeId).toBe(worker.nodeId);
    expect(entry!.profile).toMatchObject({
      permissionMode: expect.any(String),
      tools: expect.any(Array),
    });

    const eventRes = await fetch(
      service.address + `/v1/cluster/attempts/${entry!.attempt.id}/events`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + worker.credential,
          "content-type": "application/json",
        },
        body: JSON.stringify({
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
        }),
      },
    );
    expect(eventRes.status).toBe(200);

    const finishRes = await fetch(
      service.address + `/v1/cluster/attempts/${entry!.attempt.id}/finish`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + worker.credential,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          owner: entry!.attempt.owner,
          fence: entry!.attempt.fence,
          outcome: {
            status: "succeeded",
            result: "done from worker",
            sessionId: "sess_sticky_1",
          },
        }),
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
    await heartbeat(service.address, a.nodeId, a.credential);

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

    const first = await claim(service.address, a.nodeId, a.credential);
    expect(first.claims).toHaveLength(1);
    const attempt = first.claims[0]!.attempt;

    await fetch(service.address + `/v1/cluster/attempts/${attempt.id}/events`, {
      method: "POST",
      headers: {
        authorization: "Bearer " + a.credential,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        owner: attempt.owner,
        fence: attempt.fence,
        events: [
          { kind: "session", text: "", data: { sessionId: "native-sess" } },
        ],
      }),
    });
    await fetch(service.address + `/v1/cluster/attempts/${attempt.id}/finish`, {
      method: "POST",
      headers: {
        authorization: "Bearer " + a.credential,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        owner: attempt.owner,
        fence: attempt.fence,
        outcome: {
          status: "paused",
          error: "operator_pause",
          sessionId: "native-sess",
        },
      }),
    });

    // Second node joins after sticky is established — must not steal.
    const { token: joinTokenB } = auth.createJoinToken({
      createdBy: "owner",
      ttlMs: 60_000,
    });
    const b = await joinWorker(service.address, joinTokenB, "node-b");
    await heartbeat(service.address, b.nodeId, b.credential);

    // Resume keeps sticky binding; only node A may claim.
    await fetch(service.address + "/v1/bridge/jobs/" + job.id + "/resume", {
      method: "POST",
      headers: { authorization: "Bearer " + service.ownerToken },
    });

    const stolen = await claim(service.address, b.nodeId, b.credential);
    expect(stolen.claims).toHaveLength(0);

    const sticky = await claim(service.address, a.nodeId, a.credential);
    expect(sticky.claims).toHaveLength(1);
    expect(sticky.claims[0]!.job.id).toBe(job.id);
    expect(sticky.claims[0]!.attempt.nodeId).toBe(a.nodeId);
  });

  it("admin pause blocks claims and returns pause controls on heartbeat", async () => {
    const { token: joinToken } = new ClusterAuth(service.store).createJoinToken({
      createdBy: "owner",
      ttlMs: 60_000,
    });
    const worker = await joinWorker(service.address, joinToken, "desk-pause");
    await heartbeat(service.address, worker.nodeId, worker.credential);

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
    const claimed = await claim(
      service.address,
      worker.nodeId,
      worker.credential,
    );
    expect(claimed.claims).toHaveLength(1);
    const attempt = claimed.claims[0]!.attempt;

    const pause = await fetch(service.address + "/v1/bridge/admin/pause", {
      method: "POST",
      headers: { authorization: "Bearer " + service.ownerToken },
    });
    expect(pause.status).toBe(200);

    const hb = await heartbeat(
      service.address,
      worker.nodeId,
      worker.credential,
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

    const blocked = await claim(
      service.address,
      worker.nodeId,
      worker.credential,
      2,
    );
    expect(blocked.claims).toHaveLength(0);

    const status = await (
      await fetch(service.address + "/v1/bridge/status", {
        headers: { authorization: "Bearer " + service.ownerToken },
      })
    ).json();
    expect(status.cluster.dispatch).toBe("paused");

    // Finish the in-flight attempt so a second job can prove the gate.
    await fetch(service.address + `/v1/cluster/attempts/${attempt.id}/finish`, {
      method: "POST",
      headers: {
        authorization: "Bearer " + worker.credential,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        owner: attempt.owner,
        fence: attempt.fence,
        outcome: { status: "paused", error: "operator_pause" },
      }),
    });

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
    const stillBlocked = await claim(
      service.address,
      worker.nodeId,
      worker.credential,
    );
    expect(stillBlocked.claims).toHaveLength(0);
    void job;
  });

  it("hides node inventory from non-admin principals", async () => {
    const { token: joinToken } = new ClusterAuth(service.store).createJoinToken({
      createdBy: "owner",
      ttlMs: 60_000,
    });
    const worker = await joinWorker(service.address, joinToken, "hidden");
    await heartbeat(service.address, worker.nodeId, worker.credential);

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
});

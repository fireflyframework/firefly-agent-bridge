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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ClusterAuth } from "../src/cluster-auth.js";
import {
  generateNodeKeyPair,
  signWorkerRequest,
} from "../src/cluster-crypto.js";
import { parseConfig } from "../src/config.js";
import { startService } from "../src/service.js";
import {
  assertCoordinatorUrlAllowed,
  startClusterWorker,
} from "../src/cluster-worker.js";
import { QueueStore } from "../src/store.js";
import { privateWrite } from "../src/service.js";

type Service = Awaited<ReturnType<typeof startService>>;

let dir: string;
let service: Service | undefined;

afterEach(async () => {
  if (service) {
    await service.close();
    service = undefined;
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function startPrivateCoordinator(): Promise<Service> {
  dir = mkdtempSync(join(tmpdir(), "bridge-sec-"));
  const config = parseConfig({
    dataDir: dir,
    workspace: join(dir, "jobs"),
    claudePath: process.execPath,
    port: 0,
    cluster: {
      mode: "coordinator",
      bindHost: "127.0.0.1",
      exposure: "private",
      requireTls: false,
      reservePercent: 10,
      joinRateLimitPerMinute: 3,
      requestSkewMs: 60_000,
    },
  });
  service = await startService(config, {
    worker: () => ({
      ready: async () => ({ ready: true }),
      run: async () => {
        throw new Error("no local jobs");
      },
    }),
  });
  return service;
}

function signedHeaders(input: {
  credential: string;
  privateKeyPem: string;
  method: string;
  path: string;
  body: string;
}): Record<string, string> {
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString("base64url");
  const signature = signWorkerRequest({
    privateKeyPem: input.privateKeyPem,
    timestamp,
    nonce,
    method: input.method,
    path: input.path,
    body: input.body,
  });
  const headers: Record<string, string> = {
    authorization: "Bearer " + input.credential,
    "x-bridge-timestamp": timestamp,
    "x-bridge-nonce": nonce,
    "x-bridge-signature": signature,
  };
  if (input.body.length > 0) headers["content-type"] = "application/json";
  return headers;
}

describe("cluster security plane", () => {
  it("refuses internet coordinator start without TLS cert/key", async () => {
    dir = mkdtempSync(join(tmpdir(), "bridge-sec-tls-"));
    const config = parseConfig({
      dataDir: dir,
      workspace: join(dir, "jobs"),
      claudePath: process.execPath,
      port: 0,
      cluster: {
        mode: "coordinator",
        bindHost: "127.0.0.1",
        exposure: "internet",
        requireTls: true,
        reservePercent: 10,
      },
    });
    await expect(
      startService(config, {
        worker: () => ({
          ready: async () => ({ ready: true }),
          run: async () => {
            throw new Error("no");
          },
        }),
      }),
    ).rejects.toThrow(/tls|cert|key/i);
  });

  it("workers refuse http coordinator URLs unless allowInsecure", () => {
    expect(() =>
      assertCoordinatorUrlAllowed("http://127.0.0.1:8787", {
        allowInsecure: false,
      }),
    ).toThrow(/https|insecure/i);
    expect(() =>
      assertCoordinatorUrlAllowed("http://127.0.0.1:8787", {
        allowInsecure: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertCoordinatorUrlAllowed("https://bridge.example:8787", {
        allowInsecure: false,
      }),
    ).not.toThrow();
  });

  it("stolen ffn_ without private key cannot claim", async () => {
    const svc = await startPrivateCoordinator();
    const store = new QueueStore(join(dir, "queue.sqlite"));
    const auth = new ClusterAuth(store);
    const joinToken = auth.createJoinToken({
      createdBy: "owner",
      ttlMs: 60_000,
    }).token;
    store.close();

    const keys = generateNodeKeyPair();
    const joinRes = await fetch(svc.address + "/v1/cluster/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: joinToken,
        name: "desk",
        worker: "claude",
        concurrency: 1,
        publicKey: keys.publicKeyPem,
      }),
    });
    expect(joinRes.status).toBe(200);
    const joined = (await joinRes.json()) as {
      nodeId: string;
      credential: string;
    };

    // Credential alone, no signature headers.
    const bare = await fetch(
      svc.address + `/v1/cluster/nodes/${joined.nodeId}/claim`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + joined.credential,
          "content-type": "application/json",
        },
        body: JSON.stringify({ freeSlots: 1 }),
      },
    );
    expect(bare.status).toBe(401);

    // Wrong private key with valid credential.
    const other = generateNodeKeyPair();
    const path = `/v1/cluster/nodes/${joined.nodeId}/claim`;
    const body = JSON.stringify({ freeSlots: 1 });
    const forged = await fetch(svc.address + path, {
      method: "POST",
      headers: signedHeaders({
        credential: joined.credential,
        privateKeyPem: other.privateKeyPem,
        method: "POST",
        path,
        body,
      }),
      body,
    });
    expect(forged.status).toBe(401);

    // Correct key succeeds (may return empty claims).
    const ok = await fetch(svc.address + path, {
      method: "POST",
      headers: signedHeaders({
        credential: joined.credential,
        privateKeyPem: keys.privateKeyPem,
        method: "POST",
        path,
        body,
      }),
      body,
    });
    expect(ok.status).toBe(200);
  });

  it("rejects replayed signed requests", async () => {
    const svc = await startPrivateCoordinator();
    const store = new QueueStore(join(dir, "queue.sqlite"));
    const joinToken = new ClusterAuth(store).createJoinToken({
      createdBy: "owner",
      ttlMs: 60_000,
    }).token;
    store.close();
    const keys = generateNodeKeyPair();
    const joinRes = await fetch(svc.address + "/v1/cluster/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: joinToken,
        name: "desk",
        worker: "claude",
        concurrency: 1,
        publicKey: keys.publicKeyPem,
      }),
    });
    const joined = (await joinRes.json()) as {
      nodeId: string;
      credential: string;
    };
    const path = `/v1/cluster/nodes/${joined.nodeId}/heartbeat`;
    const body = JSON.stringify({
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
      resources: {
        platform: "darwin",
        collectedAt: new Date().toISOString(),
        cpu: { cores: 2, busyRatio: 0.1, load1: 0, load5: 0, load15: 0 },
        memory: {
          totalBytes: 8e9,
          freeBytes: 4e9,
          usedRatio: 0.5,
        },
        disk: {
          path: "/tmp",
          totalBytes: 1e11,
          freeBytes: 5e10,
          usedRatio: 0.5,
        },
      },
      reservePercent: 10,
      draining: false,
    });
    const headers = signedHeaders({
      credential: joined.credential,
      privateKeyPem: keys.privateKeyPem,
      method: "POST",
      path,
      body,
    });
    const first = await fetch(svc.address + path, {
      method: "POST",
      headers,
      body,
    });
    expect(first.status).toBe(200);
    const replay = await fetch(svc.address + path, {
      method: "POST",
      headers,
      body,
    });
    expect(replay.status).toBe(401);
  });

  it("leave revokes credential so subsequent signed requests fail", async () => {
    const svc = await startPrivateCoordinator();
    const store = new QueueStore(join(dir, "queue.sqlite"));
    const joinToken = new ClusterAuth(store).createJoinToken({
      createdBy: "owner",
      ttlMs: 60_000,
    }).token;
    store.close();
    const keys = generateNodeKeyPair();
    const joinRes = await fetch(svc.address + "/v1/cluster/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: joinToken,
        name: "desk",
        worker: "claude",
        concurrency: 1,
        publicKey: keys.publicKeyPem,
      }),
    });
    const joined = (await joinRes.json()) as {
      nodeId: string;
      credential: string;
    };
    const leavePath = `/v1/cluster/nodes/${joined.nodeId}`;
    const leaveBody = "";
    const leave = await fetch(svc.address + leavePath, {
      method: "DELETE",
      headers: signedHeaders({
        credential: joined.credential,
        privateKeyPem: keys.privateKeyPem,
        method: "DELETE",
        path: leavePath,
        body: leaveBody,
      }),
    });
    expect(leave.status).toBe(200);
    const claimPath = `/v1/cluster/nodes/${joined.nodeId}/claim`;
    const body = JSON.stringify({ freeSlots: 1 });
    const after = await fetch(svc.address + claimPath, {
      method: "POST",
      headers: signedHeaders({
        credential: joined.credential,
        privateKeyPem: keys.privateKeyPem,
        method: "POST",
        path: claimPath,
        body,
      }),
      body,
    });
    expect(after.status).toBe(401);
  });

  it("enforces join rate limit per source address", async () => {
    dir = mkdtempSync(join(tmpdir(), "bridge-sec-rate-"));
    const config = parseConfig({
      dataDir: dir,
      workspace: join(dir, "jobs"),
      claudePath: process.execPath,
      port: 0,
      cluster: {
        mode: "coordinator",
        bindHost: "127.0.0.1",
        exposure: "private",
        requireTls: false,
        reservePercent: 10,
        joinRateLimitPerMinute: 2,
      },
    });
    service = await startService(config, {
      worker: () => ({
        ready: async () => ({ ready: true }),
        run: async () => {
          throw new Error("no local jobs");
        },
      }),
    });
    const store = new QueueStore(join(dir, "queue.sqlite"));
    const auth = new ClusterAuth(store);
    const tokens = [0, 1, 2].map(
      () =>
        auth.createJoinToken({ createdBy: "owner", ttlMs: 60_000 }).token,
    );
    store.close();

    const statuses: number[] = [];
    for (const token of tokens) {
      const keys = generateNodeKeyPair();
      const res = await fetch(service.address + "/v1/cluster/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          name: "desk-" + statuses.length,
          worker: "claude",
          concurrency: 1,
          publicKey: keys.publicKeyPem,
        }),
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 2)).toEqual([200, 200]);
    expect(statuses[2]).toBe(429);
  });

  it("rejects join from addresses outside allowedWorkerCidrs", async () => {
    dir = mkdtempSync(join(tmpdir(), "bridge-sec-cidr-"));
    const config = parseConfig({
      dataDir: dir,
      workspace: join(dir, "jobs"),
      claudePath: process.execPath,
      port: 0,
      cluster: {
        mode: "coordinator",
        bindHost: "127.0.0.1",
        exposure: "private",
        requireTls: false,
        reservePercent: 10,
        // Loopback is never in this RFC1918 /24 — join must 403.
        allowedWorkerCidrs: ["10.255.255.0/24"],
      },
    });
    service = await startService(config, {
      worker: () => ({
        ready: async () => ({ ready: true }),
        run: async () => {
          throw new Error("no local jobs");
        },
      }),
    });
    const store = new QueueStore(join(dir, "queue.sqlite"));
    const token = new ClusterAuth(store).createJoinToken({
      createdBy: "owner",
      ttlMs: 60_000,
    }).token;
    store.close();
    const keys = generateNodeKeyPair();
    const res = await fetch(service.address + "/v1/cluster/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        name: "desk",
        worker: "claude",
        concurrency: 1,
        publicKey: keys.publicKeyPem,
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/cidr|allowed/i);
  });

  it("fails fast when cluster.json lacks nodePrivateKey", async () => {
    dir = mkdtempSync(join(tmpdir(), "bridge-sec-nokey-"));
    privateWrite(
      join(dir, "config.json"),
      JSON.stringify(
        parseConfig({
          dataDir: dir,
          workspace: join(dir, "jobs"),
          claudePath: process.execPath,
          port: 0,
          cluster: { mode: "worker", reservePercent: 10 },
        }),
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      join(dir, "cluster.json"),
      JSON.stringify({
        coordinatorUrl: "https://bridge.example:8787",
        nodeId: "node_stale",
        credential: "ffn_" + "a".repeat(43),
        allowInsecure: false,
      }),
      { mode: 0o600 },
    );
    const config = parseConfig(
      JSON.parse(readFileSync(join(dir, "config.json"), "utf8")),
    );
    await expect(startClusterWorker(config)).rejects.toThrow(
      /nodePrivateKey|re-run.*join/i,
    );
  });
});

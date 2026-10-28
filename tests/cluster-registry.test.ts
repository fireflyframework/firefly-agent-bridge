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
import { ClusterRegistry } from "../src/cluster-registry.js";
import type { NodeCapacity, NodeResources } from "../src/cluster-types.js";
import { BridgeError } from "../src/contracts.js";
import { QueueStore } from "../src/store.js";
import { parseConfig } from "../src/config.js";
import { resolve } from "node:path";

let dir: string;
let store: QueueStore;
let auth: ClusterAuth;
let registry: ClusterRegistry;

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
  concurrency: 1,
  active: 0,
  freeSlots: 1,
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-cluster-"));
  store = new QueueStore(join(dir, "queue.sqlite"));
  auth = new ClusterAuth(store);
  registry = new ClusterRegistry(store, auth, {
    worker: "claude",
    reservePercent: 10,
    heartbeatStaleMs: 10_000,
    heartbeatOfflineMs: 60_000,
  });
});

afterEach(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ClusterAuth", () => {
  it("creates a join token that verifies until expiry", () => {
    const created = auth.createJoinToken({
      createdBy: "owner",
      ttlMs: 60_000,
    });
    expect(created.token.length).toBeGreaterThan(20);
    expect(created.id).toMatch(/^jtok_/);
    expect(Date.parse(created.expiresAt)).toBeGreaterThan(Date.now());
    const verified = auth.verifyJoinToken(created.token);
    expect(verified.id).toBe(created.id);
    expect(verified.createdBy).toBe("owner");
  });

  it("issues ffn_ node credentials", () => {
    const { credential, hash } = auth.issueNodeCredential();
    expect(credential).toMatch(/^ffn_[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toBe(credential);
  });
});

describe("ClusterRegistry", () => {
  it("join returns nodeId and credential after validating join token", () => {
    const { token } = auth.createJoinToken({ createdBy: "owner", ttlMs: 60_000 });
    const joined = registry.join({
      token,
      name: "desk-12",
      worker: "claude",
      concurrency: 2,
    });
    expect(joined.nodeId).toMatch(/^node_/);
    expect(joined.credential).toMatch(/^ffn_/);
    const nodes = registry.list();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.id).toBe(joined.nodeId);
    expect(nodes[0]?.name).toBe("desk-12");
    expect(nodes[0]?.status).toBe("joining");
    expect(nodes[0]?.concurrency).toBe(2);
    expect(nodes[0]?.reservePercent).toBe(10);
  });

  it("heartbeat updates capacity and moves joining to online", () => {
    const { token } = auth.createJoinToken({ createdBy: "owner", ttlMs: 60_000 });
    const { nodeId } = registry.join({
      token,
      name: "desk-12",
      worker: "claude",
      concurrency: 1,
    });
    const snap = capacity({
      freeSlots: 0,
      active: 1,
      quota: {
        state: "ok",
        resetAt: null,
        windowStartedAt: "2026-10-27T00:00:00.000Z",
        estimatedUsedUnits: 12,
        estimatedCapacityUnits: 100,
      },
    });
    registry.heartbeat(nodeId, snap);
    const [node] = registry.list();
    expect(node?.status).toBe("online");
    expect(node?.capacity?.freeSlots).toBe(0);
    expect(node?.capacity?.active).toBe(1);
    expect(node?.capacity?.quota.estimatedUsedUnits).toBe(12);
    expect(node?.lastHeartbeatAt).toBeTruthy();
  });

  it("markStale sets stale after heartbeatStaleMs", () => {
    const { token } = auth.createJoinToken({ createdBy: "owner", ttlMs: 60_000 });
    const { nodeId } = registry.join({
      token,
      name: "desk-12",
      worker: "claude",
      concurrency: 1,
    });
    const t0 = Date.parse("2026-10-27T12:00:00.000Z");
    registry.heartbeat(nodeId, capacity(), new Date(t0));
    expect(registry.list()[0]?.status).toBe("online");

    registry.markStale(new Date(t0 + 9_999));
    expect(registry.list()[0]?.status).toBe("online");

    registry.markStale(new Date(t0 + 10_000));
    expect(registry.list()[0]?.status).toBe("stale");

    registry.markStale(new Date(t0 + 60_000));
    expect(registry.list()[0]?.status).toBe("offline");
  });

  it("rejects join when worker type differs from coordinator worker", () => {
    const { token } = auth.createJoinToken({ createdBy: "owner", ttlMs: 60_000 });
    expect(() =>
      registry.join({
        token,
        name: "codex-box",
        worker: "codex",
        concurrency: 1,
      }),
    ).toThrow(BridgeError);
    try {
      registry.join({
        token,
        name: "codex-box",
        worker: "codex",
        concurrency: 1,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeError);
      expect((error as BridgeError).code).toMatch(/worker|mismatch|invalid/i);
    }
    expect(registry.list()).toHaveLength(0);
  });

  it("drain and remove update node status", () => {
    const { token } = auth.createJoinToken({ createdBy: "owner", ttlMs: 60_000 });
    const { nodeId } = registry.join({
      token,
      name: "desk-12",
      worker: "claude",
      concurrency: 1,
    });
    registry.heartbeat(nodeId, capacity());
    registry.drain(nodeId);
    expect(registry.list()[0]?.status).toBe("draining");
    registry.remove(nodeId);
    expect(registry.list()[0]?.status).toBe("removed");
  });
});

describe("cluster config bounds (cheap T1 follow-ups)", () => {
  const base = {
    dataDir: resolve("work/data"),
    workspace: resolve("work/jobs"),
    claudePath: process.execPath,
  };

  it("accepts reservePercent 0 and 90", () => {
    expect(
      parseConfig({
        ...base,
        cluster: { mode: "coordinator", bindHost: "0.0.0.0", reservePercent: 0 },
      }).cluster?.reservePercent,
    ).toBe(0);
    expect(
      parseConfig({
        ...base,
        cluster: {
          mode: "coordinator",
          bindHost: "0.0.0.0",
          reservePercent: 90,
        },
      }).cluster?.reservePercent,
    ).toBe(90);
  });
});

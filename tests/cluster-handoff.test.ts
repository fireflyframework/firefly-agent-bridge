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
import {
  buildClusterHandoff,
  HANDOFF_MAX_BRIEF_CHARS,
  HANDOFF_MAX_RECENT_TURNS,
  workerRunPrompt,
} from "../src/cluster-handoff.js";
import { QueueStore } from "../src/store.js";

const owner = { id: "owner", owner: true, profiles: ["default"] };
const input = {
  prompt: "Ship the failover feature",
  profile: "default",
  mode: "cli" as const,
};

let dir: string;
let store: QueueStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-handoff-"));
  store = new QueueStore(join(dir, "queue.sqlite"));
});

afterEach(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("buildClusterHandoff", () => {
  it("builds a bounded brief and recent turns", () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `turn-${i}-` + "x".repeat(500),
      createdAt: new Date().toISOString(),
    }));
    const handoff = buildClusterHandoff({
      reason: "quota",
      fromNodeId: "node_a",
      job: {
        prompt: "goal",
        messages,
        result: "last result",
        activity: "running",
      },
      now: () => "2026-10-27T00:00:00.000Z",
    });
    expect(handoff.reason).toBe("quota");
    expect(handoff.fromNodeId).toBe("node_a");
    expect(handoff.brief.length).toBeLessThanOrEqual(HANDOFF_MAX_BRIEF_CHARS);
    expect(handoff.brief).toContain("last result");
    expect(handoff.recentTurns.length).toBeLessThanOrEqual(
      HANDOFF_MAX_RECENT_TURNS,
    );
    expect(handoff.createdAt).toBe("2026-10-27T00:00:00.000Z");
  });

  it("injects handoff into worker prompt without requiring sessionId", () => {
    const handoff = buildClusterHandoff({
      reason: "offline",
      fromNodeId: "node_home",
      job: {
        prompt: "continue",
        messages: [
          {
            id: "1",
            role: "user",
            text: "write the report",
            createdAt: "2026-10-27T00:00:00.000Z",
          },
        ],
        activity: "running",
      },
    });
    const prompt = workerRunPrompt(
      {
        prompt: "continue",
        messages: [
          {
            id: "1",
            role: "user",
            text: "write the report",
            createdAt: "2026-10-27T00:00:00.000Z",
          },
        ],
        clusterHandoff: handoff,
      },
      {
        continuationPrompt: "CONT",
        conversationHeading: "HEAD",
        freshMultiTurn: "conversation",
      },
    );
    expect(prompt).toContain("Cluster failover continuation");
    expect(prompt).toContain("write the report");
  });
});

describe("QueueStore.beginClusterFailover", () => {
  it("clears sticky binding, attaches handoff, and increments count", () => {
    const job = store.submit(input, owner);
    const attempt = store.claim("worker", "cli", job.id, { nodeId: "node_a" })!;
    store.observe(attempt, {
      kind: "session",
      text: "",
      data: { sessionId: "sess-1" },
    });
    store.finish(attempt, {
      status: "paused",
      error: "cluster_failover:quota",
      sessionId: "sess-1",
    });
    expect(store.get(job.id).sessionId).toBe("sess-1");
    expect(store.get(job.id).sessionNodeId).toBe("node_a");

    const next = store.beginClusterFailover(job.id, {
      reason: "quota",
      fromNodeId: "node_a",
      maxFailovers: 3,
    });
    expect(next.status).toBe("queued");
    expect(next.sessionId).toBeUndefined();
    expect(next.sessionNodeId).toBeUndefined();
    expect(next.assignedNodeId).toBeUndefined();
    expect(next.failoverCount).toBe(1);
    expect(next.clusterHandoff?.reason).toBe("quota");
    expect(next.clusterHandoff?.brief).toContain("failover");
    expect(
      store.events(owner, 0).some((e) => e.type === "job.cluster_failover"),
    ).toBe(true);
  });

  it("requests pause for running jobs before requeue", () => {
    const job = store.submit(input, owner);
    store.claim("worker", "cli", job.id, { nodeId: "node_a" });
    const paused = store.beginClusterFailover(job.id, {
      reason: "offline",
      fromNodeId: "node_a",
    });
    expect(paused.status).toBe("pause_requested");
    expect(paused.error).toBe("cluster_failover:offline");
    expect(paused.failoverCount).toBeUndefined();
  });

  it("fails when failovers are exhausted", () => {
    const job = store.submit(input, owner);
    store.pause(job.id, owner);
    for (let i = 0; i < 3; i++) {
      const mid = store.beginClusterFailover(job.id, {
        reason: "quota",
        fromNodeId: "node_a",
        maxFailovers: 3,
      });
      expect(mid.status).toBe("queued");
      expect(mid.failoverCount).toBe(i + 1);
      store.pause(job.id, owner);
    }
    const failed = store.beginClusterFailover(job.id, {
      reason: "quota",
      fromNodeId: "node_a",
      maxFailovers: 3,
    });
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/cluster_failover_exhausted/);
    expect(failed.failoverCount).toBe(4);
  });
});

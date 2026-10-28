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

import { expect, it } from "vitest";
import type { NodeCapacity } from "../src/cluster-types.js";
import {
  markLimited,
  recordUsage,
  usableCapacity,
} from "../src/cluster-quota.js";
import { selectNode, type RouterNode } from "../src/cluster-router.js";

function capacity(
  overrides: Partial<NodeCapacity> & {
    estimatedUsedUnits?: number;
    estimatedCapacityUnits?: number;
    quotaState?: NodeCapacity["quota"]["state"];
    resetAt?: number | null;
  } = {},
): NodeCapacity {
  const {
    estimatedUsedUnits = 0,
    estimatedCapacityUnits = 100,
    quotaState = "ok",
    resetAt = null,
    ...rest
  } = overrides;
  return {
    worker: "claude",
    concurrency: 2,
    active: 0,
    freeSlots: 2,
    authentication: "authenticated",
    quota: {
      state: quotaState,
      resetAt,
      windowStartedAt: "2026-10-27T00:00:00.000Z",
      estimatedUsedUnits,
      estimatedCapacityUnits,
    },
    reservePercent: 10,
    draining: false,
    ...rest,
  };
}

function node(
  id: string,
  cap: NodeCapacity,
  status: RouterNode["status"] = "online",
): RouterNode {
  return { id, status, capacity: cap };
}

it("usableCapacity applies reserve percent", () => {
  expect(usableCapacity(100, 10)).toBe(90);
  expect(usableCapacity(100, 0)).toBe(100);
  expect(usableCapacity(200, 25)).toBe(150);
});

it("recordUsage accumulates turn and token units", () => {
  const base = capacity({ estimatedUsedUnits: 10 });
  const afterTurn = recordUsage(base);
  expect(afterTurn.quota.estimatedUsedUnits).toBe(11);

  const afterTokens = recordUsage(base, { totalTokens: 2500 });
  expect(afterTokens.quota.estimatedUsedUnits).toBe(10 + 1 + 2.5);
});

it("markLimited fills used units to usable capacity", () => {
  const base = capacity({ estimatedUsedUnits: 20, estimatedCapacityUnits: 100 });
  const limited = markLimited(base, 1_700_000_000_000);
  expect(limited.quota.state).toBe("limited");
  expect(limited.quota.resetAt).toBe(1_700_000_000_000);
  expect(limited.quota.estimatedUsedUnits).toBe(usableCapacity(100, 10));
});

it("picks the node with higher headroom when capacities match", () => {
  const nodes = [
    node("node_a", capacity({ estimatedUsedUnits: 40, active: 0 })),
    node("node_b", capacity({ estimatedUsedUnits: 10, active: 0 })),
  ];
  expect(selectNode(nodes, {})).toBe("node_b");
});

it("treats nodes at reserve ceiling as ineligible", () => {
  const usable = usableCapacity(100, 10);
  const nodes = [
    node("node_full", capacity({ estimatedUsedUnits: usable })),
    node("node_ok", capacity({ estimatedUsedUnits: 5 })),
  ];
  expect(selectNode(nodes, {})).toBe("node_ok");
  expect(selectNode([nodes[0]!], {})).toBeNull();
});

it("treats limited nodes as ineligible", () => {
  const limited = markLimited(capacity({ estimatedUsedUnits: 5 }));
  const nodes = [
    node("node_limited", limited),
    node("node_ok", capacity({ estimatedUsedUnits: 20 })),
  ];
  expect(selectNode(nodes, {})).toBe("node_ok");
  expect(selectNode([nodes[0]!], {})).toBeNull();
});

it("sticky sessionNodeId selects only that node or null when ineligible", () => {
  const nodes = [
    node("node_a", capacity({ estimatedUsedUnits: 50 })),
    node("node_b", capacity({ estimatedUsedUnits: 5 })),
  ];
  expect(selectNode(nodes, { sessionNodeId: "node_a" })).toBe("node_a");

  const limitedHome = [
    node("node_a", markLimited(capacity())),
    node("node_b", capacity({ estimatedUsedUnits: 0 })),
  ];
  expect(selectNode(limitedHome, { sessionNodeId: "node_a" })).toBeNull();
});

it("tie-breaks by lower active then nodeId", () => {
  const sameLoad = [
    node("node_z", capacity({ estimatedUsedUnits: 10, active: 1 })),
    node("node_a", capacity({ estimatedUsedUnits: 10, active: 1 })),
    node("node_m", capacity({ estimatedUsedUnits: 10, active: 0 })),
  ];
  expect(selectNode(sameLoad, {})).toBe("node_m");

  const sameActive = [
    node("node_z", capacity({ estimatedUsedUnits: 10, active: 0 })),
    node("node_a", capacity({ estimatedUsedUnits: 10, active: 0 })),
  ];
  expect(selectNode(sameActive, {})).toBe("node_a");
});

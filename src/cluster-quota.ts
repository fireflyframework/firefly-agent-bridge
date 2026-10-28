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

import type { NodeCapacity } from "./cluster-types.js";

/** Usable capacity units after applying the safety reserve. */
export function usableCapacity(
  capacity: number,
  reservePercent: number,
): number {
  const fraction = 1 - reservePercent / 100;
  return Math.max(0, capacity * fraction);
}

/** Headroom above estimated used units, floored at 0. */
export function headroom(capacity: NodeCapacity): number {
  const usable = usableCapacity(
    capacity.quota.estimatedCapacityUnits,
    capacity.reservePercent,
  );
  return Math.max(0, usable - capacity.quota.estimatedUsedUnits);
}

export type UsageRecord = {
  /** Attempt turn buckets to add (default 1). */
  turns?: number;
  /** When reported, adds totalTokens/1000 to estimated used units. */
  totalTokens?: number;
};

/**
 * Accumulate estimated usage for fair-share.
 * Unit = 1 per attempt turn bucket, plus total_tokens/1000 when usage is reported.
 */
export function recordUsage(
  capacity: NodeCapacity,
  usage: UsageRecord = {},
): NodeCapacity {
  const turnUnits = usage.turns ?? 1;
  const tokenUnits =
    usage.totalTokens != null ? usage.totalTokens / 1000 : 0;
  const delta = turnUnits + tokenUnits;
  return {
    ...capacity,
    quota: {
      ...capacity.quota,
      estimatedUsedUnits: capacity.quota.estimatedUsedUnits + delta,
    },
  };
}

/**
 * Latch quota as limited and fill estimated used to the soft (usable) cap.
 */
export function markLimited(
  capacity: NodeCapacity,
  resetAt: number | null = null,
): NodeCapacity {
  const usable = usableCapacity(
    capacity.quota.estimatedCapacityUnits,
    capacity.reservePercent,
  );
  return {
    ...capacity,
    quota: {
      ...capacity.quota,
      state: "limited",
      resetAt,
      estimatedUsedUnits: usable,
    },
  };
}

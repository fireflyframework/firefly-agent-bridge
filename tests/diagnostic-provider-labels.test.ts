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
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
function labels(status: unknown) {
  const source = readFileSync("src/ui/setup.js", "utf8").replaceAll(
    "export function",
    "function",
  );
  return runInNewContext(source + ";providerStateLabels")(status) as Record<
    string,
    string
  >;
}
it("separates compact unknown sign-in and quota values from complete observation details", () => {
  const state = labels({});
  expect(state.diagnosticAuthentication).toBe("Unknown");
  expect(state.diagnosticQuota).toBe("Unknown");
  expect(state.diagnosticDetails).toContain("Authentication not reported");
  expect(state.diagnosticDetails).toContain("Quota not reported");
  expect(state.provider).toBe(
    "Authentication not reported · quota not reported",
  );
});
it.each([
  ["authenticated", "Signed in"],
  ["required", "Required"],
  ["unavailable", "Unavailable"],
])("keeps %s sign-in independent of unknown quota", (authentication, label) => {
  const state = labels({
    providerObservations: {
      authentication: { state: authentication },
      quota: { state: "unknown" },
    },
  });
  expect(state.diagnosticAuthentication).toBe(label);
  expect(state.diagnosticQuota).toBe("Unknown");
  expect(state.diagnosticDetails).toContain("Quota not reported");
});
it("retains the reported provider, observation and reset outside compact quota value", () => {
  const state = labels({
    providerObservations: {
      authentication: { state: "authenticated" },
      quota: {
        state: "limited",
        provider: "claude",
        observedAt: "2026-10-15T10:00:00.000Z",
        resetAt: 1792144800000,
      },
    },
  });
  expect(state.diagnosticAuthentication).toBe("Signed in");
  expect(state.diagnosticQuota).toBe("Limited");
  expect(state.diagnosticDetails).toContain("Last reported Claude quota limit");
  expect(state.diagnosticDetails).toContain("2026-10-15T10:00:00.000Z");
  expect(state.diagnosticDetails).toContain(
    new Date(1792144800000).toLocaleString(),
  );
  expect(state.diagnosticDetails).not.toContain("1792144800000");
});
it("keeps a prior provider quota report separate from the current unknown observation", () => {
  const state = labels({
    providerObservations: {
      authentication: { state: "authenticated", provider: "codex" },
      quota: { state: "unknown", provider: "codex" },
      lastQuotaLimit: {
        state: "limited",
        provider: "claude",
        observedAt: "2026-10-15T10:00:00.000Z",
        resetAt: null,
      },
    },
  });
  expect(state.diagnosticQuota).toBe("Unknown");
  expect(state.diagnosticDetails).toContain("Quota not reported");
  expect(state.diagnosticDetails).toContain("Previous Claude quota limit");
  expect(state.diagnosticDetails).toContain("2026-10-15T10:00:00.000Z");
  expect(state.diagnosticDetails).toContain("Reset not reported");
});

it.each([
  null,
  undefined,
  NaN,
  Infinity,
  -1,
  0,
  1e20,
  "2026-10-16T10:00:00.000Z",
])("does not invent a readable reset from invalid wire value %s", (resetAt) => {
  const state = labels({
    providerObservations: {
      quota: { state: "limited", provider: "claude", resetAt },
    },
  });
  expect(state.diagnosticDetails).toContain("Reset not reported");
  expect(state.diagnosticDetails).not.toContain("Invalid Date");
  expect(state.diagnosticQuota).toBe("Limited");
});
it("keeps a past reported reset as history without clearing the quota observation", () => {
  const quota = {
    state: "limited",
    provider: "claude",
    resetAt: 1577836800000,
  };
  const saved = JSON.stringify(quota);
  const state = labels({ providerObservations: { quota } });
  expect(state.diagnosticDetails).toContain(
    new Date(quota.resetAt).toLocaleString(),
  );
  expect(state.diagnosticDetails).not.toContain(String(quota.resetAt));
  expect(state.diagnosticQuota).toBe("Limited");
  expect(JSON.stringify(quota)).toBe(saved);
});

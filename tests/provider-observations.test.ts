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

import { afterEach, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore } from "../src/store.js";
import { Scheduler } from "../src/scheduler.js";
import { Workflows } from "../src/workflows.js";
import type { WorkerReadiness } from "../src/worker.js";
import { Tokens } from "../src/auth.js";
import { createHttpService } from "../src/http.js";
import { parseConfig } from "../src/config.js";
const stores: QueueStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture(store = new QueueStore(":memory:")) {
  if (!stores.includes(store)) stores.push(store);
  return {
    store,
    scheduler: new Scheduler(
      store,
      new Workflows(store, []),
      () => {
        throw new Error("No real worker in this control");
      },
      "/unused-controlled-workspace",
      1,
    ),
  };
}
const authenticated: WorkerReadiness = {
  ready: true,
  authentication: {
    provider: "claude",
    state: "authenticated",
    source: "official_cli_auth_status",
    observedAt: "2026-10-15T10:00:00.000Z",
  },
};
function observations(scheduler: Scheduler) {
  return (scheduler as unknown as { observations: Record<string, unknown> })
    .observations;
}
function labels(status: unknown) {
  const source = readFileSync("src/ui/setup.js", "utf8").replaceAll(
    "export function",
    "function",
  );
  const render = runInNewContext(
    source +
      "; typeof providerStateLabels === 'function' ? providerStateLabels : undefined",
  ) as ((value: unknown) => Record<string, string>) | undefined;
  expect(
    render,
    "Provider labels must distinguish authenticated from quota available",
  ).toBeTypeOf("function");
  return render!(status);
}
it("reports successful authentication with unknown quota through real HTTP status and UI labels", async () => {
  const { store, scheduler } = fixture();
  scheduler.readiness = authenticated;
  const auth = new Tokens(store),
    token = auth.create({
      id: "reader",
      owner: false,
      profiles: ["default"],
      scopes: ["read"],
    }).token;
  const app = createHttpService({
    store,
    scheduler,
    auth,
    flows: new Workflows(store, []),
    config: parseConfig({
      dataDir: "/unused-controlled-data",
      workspace: "/unused-controlled-workspace",
      claudePath: process.execPath,
    }),
  });
  try {
    const response = await app.inject({
      url: "/v1/bridge/status",
      headers: { authorization: "Bearer " + token },
    });
    expect(response.statusCode).toBe(200);
    const status = response.json();
    expect(status.readiness.ready).toBe(true);
    expect(status.providerObservations).toMatchObject({
      version: 1,
      authentication: authenticated.authentication,
      quota: {
        state: "unknown",
        source: "not_reported",
        observedAt: null,
        resetAt: null,
      },
      dispatch: { state: "enabled", source: "scheduler" },
    });
    expect(labels(status).provider).toBe("Signed in · quota not reported");
    expect(labels(status).health).not.toMatch(/ready/i);
  } finally {
    await app.close();
  }
});
it("retains a quota rejection across auth refresh, scheduler recreation and explicit dispatch resume", () => {
  const { store, scheduler } = fixture();
  scheduler.readiness = authenticated;
  scheduler.pause("quota_exhausted: controlled limit");
  const first = observations(scheduler);
  expect(first).toMatchObject({
    quota: {
      state: "limited",
      source: "worker_quota_rejection",
      resetAt: null,
    },
    dispatch: { state: "paused" },
  });
  scheduler.readiness = authenticated;
  expect(observations(scheduler).quota).toEqual(first.quota);
  const recreated = fixture(store).scheduler;
  recreated.readiness = authenticated;
  expect(observations(recreated).quota).toEqual(first.quota);
  expect(observations(recreated)).toMatchObject({
    dispatch: { state: "paused" },
  });
  recreated.resume();
  expect(observations(recreated).quota).toEqual(first.quota);
  expect(
    labels({
      readiness: authenticated,
      scheduler: recreated.controlState,
      providerObservations: observations(recreated),
    }).provider,
  ).toContain("Last reported quota limit");
});
it.each([undefined, NaN, Infinity, -1, 0, Date.now() - 1000])(
  "never invents a quota reset from invalid or past timestamp %s",
  (reset) => {
    const { scheduler } = fixture();
    scheduler.readiness = authenticated;
    scheduler.pause("quota_exhausted: controlled limit", reset);
    expect(observations(scheduler)).toMatchObject({
      quota: { state: "limited", resetAt: null },
    });
  },
);
it("keeps an expired reported reset as a historical limit rather than successful availability", () => {
  const { store, scheduler } = fixture(),
    reset = Date.now() + 60000;
  scheduler.readiness = authenticated;
  scheduler.pause("quota_exhausted: controlled limit", reset);
  const original = observations(scheduler).quota as Record<string, unknown>;
  expect(original.resetAt).toBe(reset);
  // A restart sees the original observation; the scheduler's separate gate may later probe.
  store.db
    .prepare("UPDATE metadata SET value=? WHERE key='scheduler_control'")
    .run(
      JSON.stringify({
        paused: true,
        reason: "quota_exhausted: controlled limit",
        retryAt: Date.now() - 1000,
      }),
    );
  const restarted = fixture(store).scheduler;
  restarted.readiness = authenticated;
  expect(observations(restarted).quota).toEqual(original);
  expect(observations(restarted)).toMatchObject({
    dispatch: { state: "paused" },
  });
});
it("labels legacy boolean-only workers as unverified authentication, with no quota or context claim", () => {
  const { scheduler } = fixture();
  scheduler.readiness = { ready: true };
  expect(observations(scheduler)).toMatchObject({
    authentication: {
      state: "unknown",
      source: "not_reported",
      observedAt: null,
    },
    quota: { state: "unknown" },
  });
  const rendered = labels({
    readiness: scheduler.readiness,
    scheduler: scheduler.controlState,
    providerObservations: observations(scheduler),
  });
  expect(rendered.provider).toBe(
    "Authentication not reported · quota not reported",
  );
  expect(JSON.stringify(observations(scheduler))).not.toMatch(
    /percent|remaining|contextWindow/,
  );
});
it("does not reinterpret authentication failure or an operator pause as quota exhaustion", () => {
  const { scheduler } = fixture();
  scheduler.readiness = {
    ready: false,
    reason: "authentication_required: controlled sign-in failure",
    authentication: {
      state: "required",
      source: "official_cli_auth_status",
      observedAt: "2026-10-15T10:00:00.000Z",
    },
  } as typeof scheduler.readiness;
  scheduler.pause("operator_pause");
  expect(observations(scheduler)).toMatchObject({
    authentication: { state: "required" },
    quota: { state: "unknown" },
    dispatch: { state: "paused" },
  });
});
it("imports a legacy durable quota gate conservatively without fabricating observation time", () => {
  const { store } = fixture();
  store.db.prepare("INSERT INTO metadata VALUES('scheduler_control',?)").run(
    JSON.stringify({
      paused: true,
      reason: "quota_exhausted: historical limit",
    }),
  );
  const { scheduler } = fixture(store);
  expect(observations(scheduler)).toMatchObject({
    quota: { state: "unknown", provider: null },
    lastQuotaLimit: {
      state: "limited",
      provider: null,
      source: "retained_scheduler_gate",
      observedAt: null,
      resetAt: null,
    },
    dispatch: { state: "paused" },
  });
});
it("does not erase a legacy limited fact when its operator explicitly resumes dispatch", () => {
  const { store } = fixture();
  store.db.prepare("INSERT INTO metadata VALUES('scheduler_control',?)").run(
    JSON.stringify({
      paused: true,
      reason: "quota_exhausted: historical limit",
    }),
  );
  const { scheduler } = fixture(store);
  const limited = observations(scheduler).lastQuotaLimit;
  scheduler.resume();
  expect(observations(scheduler).lastQuotaLimit).toEqual(limited);
  const restarted = fixture(store).scheduler;
  restarted.readiness = authenticated;
  expect(observations(restarted).lastQuotaLimit).toEqual(limited);
});

it("persists an actual controlled worker rejection after closing and reopening the queue database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-quota-"));
  const filename = join(directory, "queue.sqlite");
  let store = new QueueStore(filename),
    calls = 0;
  const owner = { id: "controlled", owner: true, profiles: ["default"] };
  const job = store.submit({ prompt: "Controlled protocol only" }, owner);
  const worker = {
    ready: async () => authenticated,
    run: async () => {
      calls++;
      return {
        status: "paused" as const,
        error: "quota_exhausted: controlled rejection",
        sessionId: "11111111-1111-4111-8111-111111111111",
      };
    },
  };
  const scheduler = new Scheduler(
    store,
    new Workflows(store, []),
    () => worker,
    directory,
    1,
  );
  let stopped = false;
  try {
    scheduler.start();
    await expect.poll(() => store.get(job.id).status).toBe("paused");
    await scheduler.stop();
    stopped = true;
    const retained = observations(scheduler).quota;
    expect(retained).toMatchObject({
      state: "limited",
      source: "worker_quota_rejection",
      observedAt: expect.any(String),
      resetAt: null,
    });
    store.close();
    store = new QueueStore(filename);
    const restored = new Scheduler(
      store,
      new Workflows(store, []),
      () => worker,
      directory,
      1,
    );
    restored.readiness = authenticated;
    expect(observations(restored).quota).toEqual(retained);
    expect(restored.controlState).toMatchObject({ paused: true });
    expect(store.get(job.id).sessionId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(calls).toBe(1);
  } finally {
    if (!stopped) await scheduler.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
it("does not attribute a retained Claude rejection to authenticated Codex after reopening the same data directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-scope-")),
    filename = join(directory, "queue.sqlite");
  let store = new QueueStore(filename);
  try {
    const claude = new Scheduler(
      store,
      new Workflows(store, []),
      () => {
        throw new Error("No provider call");
      },
      directory,
      1,
    );
    claude.readiness = {
      ...authenticated,
      authentication: { ...authenticated.authentication!, provider: "claude" },
    } as WorkerReadiness;
    claude.pause("quota_exhausted: controlled Claude rejection");
    const original = observations(claude).quota;
    expect(original).toMatchObject({ state: "limited", provider: "claude" });
    store.close();
    store = new QueueStore(filename);
    const codex = new Scheduler(
      store,
      new Workflows(store, []),
      () => {
        throw new Error("No provider call");
      },
      directory,
      1,
    );
    codex.readiness = {
      ...authenticated,
      authentication: { ...authenticated.authentication!, provider: "codex" },
    } as WorkerReadiness;
    expect(observations(codex)).toMatchObject({
      quota: { state: "unknown", provider: "codex" },
      lastQuotaLimit: original,
      dispatch: { state: "paused" },
    });
    const rendered = labels({
      readiness: codex.readiness,
      scheduler: codex.controlState,
      providerObservations: observations(codex),
    });
    expect(rendered.provider).toContain("quota not reported");
    expect(rendered.provider).toContain("Claude");
    codex.resume();
    expect(observations(codex)).toMatchObject({
      quota: { state: "unknown", provider: "codex" },
      lastQuotaLimit: original,
    });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

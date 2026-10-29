/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * Licensed under https://www.apache.org/licenses/LICENSE-2.0
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseConfig } from "../src/config.js";
import { startService } from "../src/service.js";
import { Tokens } from "../src/auth.js";

let dir: string,
  service: Awaited<ReturnType<typeof startService>>,
  token: string;
let runs: number, ready: boolean;
const base = {
  model: "bridge/default",
  messages: [{ role: "user", content: "Fictional duration fixture" }],
};
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bridge-duration-http-fictional-"));
  runs = 0;
  ready = true;
  service = await startService(
    parseConfig({
      dataDir: dir,
      workspace: join(dir, "jobs"),
      claudePath: process.execPath,
      port: 0,
      openai: { timeoutMs: 100 },
      profiles: {
        default: {},
        hidden: { workDuration: { version: 1, timeoutMs: 9000 } },
      },
    }),
    {
      worker: () => ({
        ready: async () => ({ ready }),
        run: async (_input, _emit, signal) => {
          runs++;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, 250);
            function done() {
              clearTimeout(timer);
              signal.removeEventListener("abort", done);
              resolve();
            }
            signal.addEventListener("abort", done, { once: true });
          });
          return signal.aborted
            ? { status: "canceled" }
            : {
                status: "succeeded",
                result: JSON.stringify({ content: "finished", tool_calls: [] }),
              };
        },
      }),
    },
  );
  token = new Tokens(service.store).create({
    id: "fixture-client",
    owner: false,
    profiles: ["default"],
    scopes: ["read", "submit", "control"],
  }).token;
});
afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});
function post(bridge = {}, headers = {}) {
  return fetch(service.address + "/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
      ...headers,
    },
    body: JSON.stringify({ ...base, bridge }),
  });
}
it("advertises nullable frozen duration and waits beyond the old completion cap", async () => {
  const status = await (
    await fetch(service.address + "/v1/bridge/status", {
      headers: { Authorization: "Bearer " + token },
    })
  ).json();
  expect(status.workDuration).toMatchObject({
    version: 1,
    nullableTimeout: true,
    frozenAtAdmission: true,
  });
  expect(Object.keys(status.workDurationProfiles)).toEqual(["default"]);
  const owned = await (
    await fetch(service.address + "/v1/bridge/status", {
      headers: { Authorization: "Bearer " + service.ownerToken },
    })
  ).json();
  expect(owned.configuration.profiles.default).not.toHaveProperty(
    "workDuration",
  );
  const response = await post({
    workDuration: { version: 1, timeoutMs: null },
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("finished");
  expect(runs).toBe(1);
});
it("an unmarked next completion preserves the legacy wait and admission policy", async () => {
  const response = await post();
  expect(response.status).toBe(504);
  const id = response.headers.get("x-bridge-job-id")!;
  expect(service.store.get(id)).not.toHaveProperty("workDuration");
  await expect.poll(() => service.store.get(id).status).toBe("canceled");
});
it("an explicitly chosen wait deadline cancels its last ordinary waiter", async () => {
  const response = await post({
    workDuration: { version: 1, timeoutMs: null },
    waitTimeoutMs: 25,
  });
  expect(response.status).toBe(504);
  const id = response.headers.get("x-bridge-job-id")!;
  await expect.poll(() => service.store.get(id).status).toBe("canceled");
});
it("a chosen wait deadline retains original completion recovery without resubmission", async () => {
  const key = "fbr1_" + "a".repeat(32);
  const response = await post(
    { workDuration: { version: 1, timeoutMs: null }, waitTimeoutMs: 25 },
    { "Idempotency-Key": key, "X-Bridge-Completion-Recovery": "1" },
  );
  expect(response.status).toBe(504);
  const id = response.headers.get("x-bridge-job-id")!;
  await expect.poll(() => service.store.get(id).status).toBe("succeeded");
  expect(runs).toBe(1);
  const retained = await (
    await fetch(service.address + "/v1/bridge/completion-requests/" + key, {
      headers: { Authorization: "Bearer " + token },
    })
  ).json();
  expect(retained.admission.job_id).toBe(id);
  expect(retained.terminal.status).toBe("succeeded");
});
it("expires a chosen queue deadline without starting or granting an attempt", async () => {
  ready = false;
  const response = await post({
    execution: "agent",
    background: true,
    workDuration: { version: 1, timeoutMs: 50 },
  });
  expect(response.status).toBe(202);
  const job = await response.json();
  await expect.poll(() => service.store.get(job.id).status).toBe("timed_out");
  expect(runs).toBe(0);
  expect(
    service.store.db
      .prepare("SELECT count(*) AS n FROM attempts WHERE job_id=?")
      .get(job.id),
  ).toEqual({ n: 0 });
});

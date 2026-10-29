/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * Licensed under https://www.apache.org/licenses/LICENSE-2.0
 */
import { afterEach, expect, it, vi } from "vitest";
import { QueueStore } from "../src/store.js";
import { armDeadline, workDurationSchema } from "../src/work-duration.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const owner = { id: "fixture-owner", owner: true, profiles: ["default"] };
afterEach(() => vi.useRealTimers());

it("keeps unversioned admissions and old idempotency fingerprints unchanged", () => {
  const store = new QueueStore(":memory:");
  try {
    const job = store.submit(
      { prompt: "new fictional work" },
      owner,
      "new-key",
    );
    expect(job.workDuration).toBeUndefined();
    const legacy = { ...job };
    delete legacy.workDuration;
    const bytes = JSON.stringify(legacy);
    store.db.prepare("UPDATE jobs SET data=? WHERE id=?").run(bytes, job.id);
    expect(
      store.submit({ prompt: "new fictional work" }, owner, "new-key"),
    ).toEqual(legacy);
    expect(
      store.db.prepare("SELECT data FROM jobs WHERE id=?").get(job.id),
    ).toEqual({ data: bytes });
  } finally {
    store.close();
  }
});

it("the next unversioned old-wire admission stays legacy after upgrade", () => {
  const store = new QueueStore(":memory:");
  try {
    const job = store.submit(
      { prompt: "fictional next inference from a frozen old caller" },
      owner,
    );
    expect(job.workDuration).toBeUndefined();
    expect(
      JSON.parse(
        (
          store.db.prepare("SELECT data FROM jobs WHERE id=?").get(job.id) as {
            data: string;
          }
        ).data,
      ),
    ).not.toHaveProperty("workDuration");
  } finally {
    store.close();
  }
});

it("freezes the smallest explicit profile/request deadline", () => {
  const store = new QueueStore(":memory:", 1000, () => ({
    version: 1,
    timeoutMs: 5000,
  }));
  try {
    expect(
      store.submit({ prompt: "profile" }, owner).workDuration?.timeoutMs,
    ).toBe(5000);
    expect(
      store.submit(
        { prompt: "request", workDuration: { version: 1, timeoutMs: 2000 } },
        owner,
      ).workDuration?.timeoutMs,
    ).toBe(2000);
    expect(
      store.submit(
        {
          prompt: "no extension",
          workDuration: { version: 1, timeoutMs: 9000 },
        },
        owner,
      ).workDuration?.timeoutMs,
    ).toBe(5000);
  } finally {
    store.close();
  }
});

it.each([0, -1, 1.5, true, "300", Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid explicit deadlines %s",
  (timeoutMs) => {
    expect(
      workDurationSchema.safeParse({ version: 1, timeoutMs }).success,
    ).toBe(false);
  },
);

it("allows an explicit forty-day deadline without a one-hour ceiling", () => {
  expect(
    workDurationSchema.parse({ version: 1, timeoutMs: 40 * 86400000 })
      .timeoutMs,
  ).toBe(40 * 86400000);
});

it("creates no timer for uncapped work and rearms long monotonic deadlines in safe slices", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const expired = vi.fn();
  const timer = vi.spyOn(globalThis, "setTimeout");
  armDeadline(null, expired)();
  expect(timer).not.toHaveBeenCalled();
  const duration = 40 * 86400000;
  const cancel = armDeadline(performance.now() + duration, expired);
  expect(timer.mock.calls[0]?.[1]).toBe(2147483647);
  vi.advanceTimersByTime(2147483647);
  expect(expired).not.toHaveBeenCalled();
  vi.advanceTimersByTime(duration - 2147483647 - 1);
  expect(expired).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(expired).toHaveBeenCalledTimes(1);
  cancel();
});

it("restart retains selected policy and attempt history without automatic redispatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-duration-restart-fictional-"));
  const path = join(dir, "fixture.sqlite");
  let store = new QueueStore(path);
  try {
    const input = {
      prompt: "fictional interrupted work",
      workDuration: { version: 1 as const, timeoutMs: null },
    };
    const job = store.submit(input, owner, "retained-key");
    const attempt = store.claim("fictional-stopped-owner", "cli", job.id)!;
    store.close();
    store = new QueueStore(path, 1000, () => ({ version: 1, timeoutMs: 1 }));
    expect(store.recover()).toBe(1);
    const retained = store.submit(input, owner, "retained-key");
    expect(retained.id).toBe(job.id);
    expect(retained.workDuration).toEqual({ version: 1, timeoutMs: null });
    expect(retained.status).toBe("interrupted");
    expect(
      store.db
        .prepare("SELECT count(*) AS n FROM attempts WHERE job_id=?")
        .get(job.id),
    ).toEqual({ n: 1 });
    expect(
      store.db.prepare("SELECT data FROM attempts WHERE id=?").get(attempt.id),
    ).toBeDefined();
    expect(store.pending("cli")).toEqual([]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("a chosen deadline is not extended by queue delay or retry after restart", () => {
  const store = new QueueStore(":memory:");
  try {
    const job = store.submit(
      {
        prompt: "fictional expired work",
        workDuration: { version: 1, timeoutMs: 1 },
      },
      owner,
    );
    store.expireDeadlines(Date.parse(job.createdAt) + 2);
    const bytes = store.db
      .prepare("SELECT data FROM jobs WHERE id=?")
      .get(job.id);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(job.createdAt) + 3);
    expect(() => store.retry(job.id, owner)).toThrow(/deadline/);
    expect(
      store.db.prepare("SELECT data FROM jobs WHERE id=?").get(job.id),
    ).toEqual(bytes);
    expect(store.claim("new-owner", "cli", job.id)).toBeNull();
  } finally {
    store.close();
    vi.restoreAllMocks();
  }
});

it("refuses a connected-host deadline before admission instead of delegating an unenforced cap", () => {
  const store = new QueueStore(":memory:", 1000, () => ({
    version: 1,
    timeoutMs: 5000,
  }));
  try {
    expect(() =>
      store.submit(
        {
          prompt: "fictional host work",
          mode: "channel",
          workDuration: { version: 1, timeoutMs: null },
        },
        owner,
      ),
    ).toThrow(/connected.host/i);
    expect(store.list()).toEqual([]);
    expect(store.db.prepare("SELECT count(*) AS n FROM events").get()).toEqual({
      n: 0,
    });
  } finally {
    store.close();
  }
});

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

import { it, expect, vi } from "vitest";
import { Channels } from "../src/channels.js";
import { QueueStore } from "../src/store.js";
import { migrate } from "../src/migrations.js";
const owner = { id: "owner", owner: true, profiles: ["default"] };
it("fences channel delivery and interrupts orphaned claims without rerunning side effects", () => {
  const s = new QueueStore(":memory:"),
    c = new Channels(s);
  const job = s.submit({ prompt: "channel work", mode: "channel" }, owner);
  c.heartbeat("desktop");
  const claim = c.claim("desktop", job.id);
  expect(claim.job.id).toBe(job.id);
  c.heartbeat("code");
  expect(() => c.claim("code", job.id)).toThrow();
  expect(() =>
    c.complete("code", claim.attempt.id, claim.attempt.fence, "success"),
  ).toThrow();
  c.progress("desktop", claim.attempt.id, claim.attempt.fence, "Working");
  c.reap(Date.now() + 8000);
  expect(s.get(job.id).status).toBe("interrupted");
  expect(() =>
    c.complete("desktop", claim.attempt.id, claim.attempt.fence, "late"),
  ).toThrow();
  expect(s.pending("channel")).toHaveLength(0);
  s.close();
});

it("allows only one outstanding claim per host conversation", () => {
  const s = new QueueStore(":memory:"),
    c = new Channels(s);
  try {
    const first = s.submit({ prompt: "first", mode: "channel" }, owner),
      second = s.submit({ prompt: "second", mode: "channel" }, owner);
    c.heartbeat("host");
    const a = c.claim("host", first.id).attempt;
    expect(() => c.claim("host", second.id)).toThrow(/outstanding/);
    c.complete("host", a.id, a.fence, "done");
    expect(c.claim("host", second.id).job.id).toBe(second.id);
  } finally {
    s.close();
  }
});

it("reaps only indexed active channel attempts regardless of terminal history", () => {
  const s = new QueueStore(":memory:"),
    c = new Channels(s);
  try {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    c.heartbeat("finished");
    const completed = s.submit({ prompt: "finished", mode: "channel" }, owner);
    const terminal = c.claim("finished", completed.id).attempt;
    c.complete("finished", terminal.id, terminal.fence, "done");
    const history = s.db
      .prepare("SELECT data FROM attempts WHERE id=?")
      .get(terminal.id) as { data: string };
    s.atomic(() => {
      const insert = s.db.prepare("INSERT INTO attempts VALUES(?,?,?)");
      for (let i = 0; i < 2000; i++) {
        const id = "history-" + i;
        insert.run(
          id,
          completed.id,
          JSON.stringify({ ...JSON.parse(history.data), id }),
        );
      }
    });
    c.heartbeat("live");
    c.heartbeat("orphan");
    const live = s.submit({ prompt: "live", mode: "channel" }, owner);
    const orphan = s.submit({ prompt: "orphan", mode: "channel" }, owner);
    c.claim("live", live.id);
    c.claim("orphan", orphan.id);
    const cli = s.submit({ prompt: "CLI remains owned" }, owner);
    s.claim("scheduler", "cli", cli.id);
    const now = Date.now();
    c.heartbeat("live");
    // Reapplying the startup migration must preserve existing version-2 history.
    s.db.exec("DROP INDEX IF EXISTS attempts_running_owner");
    migrate(s.db);
    migrate(s.db);
    let materialized = 0,
      query = "";
    const prepare = s.db.prepare.bind(s.db);
    vi.spyOn(s.db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.startsWith("SELECT data FROM attempts")) {
        query = sql;
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...parameters) => {
          const rows = all(...parameters);
          materialized += rows.length;
          return rows;
        });
      }
      return statement;
    });
    c.reap(now + 6999);
    vi.restoreAllMocks();
    expect(materialized).toBe(2);
    expect(s.get(cli.id).status).toBe("running");
    expect(s.get(live.id).status).toBe("running");
    expect(s.get(orphan.id).status).toBe("running");
    c.reap(now + 8000);
    expect(s.get(live.id).status).toBe("interrupted");
    expect(s.get(orphan.id).status).toBe("interrupted");
    expect(s.get(cli.id).status).toBe("running");
    expect(
      (
        s.db.prepare("SELECT COUNT(*) AS count FROM attempts").get() as {
          count: number;
        }
      ).count,
    ).toBe(2004);
    const plan = s.db.prepare("EXPLAIN QUERY PLAN " + query).all() as {
      detail: string;
    }[];
    expect(
      plan.some((row) => row.detail.includes("attempts_running_owner")),
    ).toBe(true);
  } finally {
    vi.restoreAllMocks();
    s.close();
  }
});

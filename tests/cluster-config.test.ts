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

import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { parseClusterWorkerFile } from "../src/cluster-config.js";
import { parseConfig } from "../src/config.js";
import { migrate } from "../src/migrations.js";

const base = {
  dataDir: resolve("work/data"),
  workspace: resolve("work/jobs"),
  claudePath: process.execPath,
};

it("accepts cluster coordinator config with bindHost and reservePercent 10", () => {
  const config = parseConfig({
    ...base,
    cluster: {
      mode: "coordinator",
      bindHost: "0.0.0.0",
      reservePercent: 10,
    },
  });
  expect(config.cluster?.mode).toBe("coordinator");
  expect(config.cluster?.bindHost).toBe("0.0.0.0");
  expect(config.cluster?.reservePercent).toBe(10);
  expect(config.cluster?.heartbeatIntervalMs).toBe(2000);
  expect(config.cluster?.maxFailovers).toBe(3);
});

it("defaults reservePercent to 10 when omitted", () => {
  const config = parseConfig({
    ...base,
    cluster: { mode: "coordinator", bindHost: "0.0.0.0" },
  });
  expect(config.cluster?.reservePercent).toBe(10);
});

it("defaults scheduling floors and weights", () => {
  const config = parseConfig({
    ...base,
    cluster: { mode: "coordinator", bindHost: "0.0.0.0" },
  });
  expect(config.cluster?.scheduling).toEqual({
    minFreeMemoryBytes: 536870912,
    minFreeDiskBytes: 1073741824,
    maxCpuBusyRatio: 0.92,
    weights: { quota: 0.45, memory: 0.2, disk: 0.15, cpu: 0.2 },
  });
});

it("rejects scheduling weights that do not sum to 1", () => {
  expect(() =>
    parseConfig({
      ...base,
      cluster: {
        mode: "coordinator",
        bindHost: "0.0.0.0",
        scheduling: {
          weights: { quota: 0.5, memory: 0.5, disk: 0.5, cpu: 0.5 },
        },
      },
    }),
  ).toThrow();
});

it("rejects reservePercent outside 0–90", () => {
  expect(() =>
    parseConfig({
      ...base,
      cluster: { mode: "coordinator", bindHost: "0.0.0.0", reservePercent: 91 },
    }),
  ).toThrow();
  expect(() =>
    parseConfig({
      ...base,
      cluster: { mode: "coordinator", bindHost: "0.0.0.0", reservePercent: -1 },
    }),
  ).toThrow();
});

it("parses worker cluster.json files", () => {
  const worker = parseClusterWorkerFile({
    coordinatorUrl: "https://bridge.company.internal:8787",
    nodeId: "node_abc",
    credential: "ffn_secret",
    reservePercent: null,
  });
  expect(worker.nodeId).toBe("node_abc");
  expect(worker.reservePercent).toBeNull();
});

it("migrates to user_version 4 with cluster tables and enrollment columns", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const version = (
    db.prepare("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
  expect(version).toBe(4);
  const cols = (
    db.prepare("PRAGMA table_info(cluster_nodes)").all() as { name: string }[]
  ).map((row) => row.name);
  expect(cols).toContain("public_key");
  expect(cols).toContain("enrollment_fingerprint");
  expect(cols).toContain("last_signed_at");
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cluster_nodes','cluster_join_tokens') ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  expect(tables).toEqual(["cluster_join_tokens", "cluster_nodes"]);
  db.prepare(
    "INSERT INTO cluster_nodes(id,name,worker,status,concurrency,reserve_percent,credential_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    "node_1",
    "desk",
    "claude",
    "joining",
    1,
    10,
    "hash",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  );
  db.prepare(
    "INSERT INTO cluster_join_tokens(id,hash,created_by,created_at,expires_at) VALUES(?,?,?,?,?)",
  ).run(
    "tok_1",
    "tokenhash",
    "owner",
    "2026-01-01T00:00:00.000Z",
    "2026-01-02T00:00:00.000Z",
  );
  expect(
    (
      db.prepare("SELECT COUNT(*) AS n FROM cluster_nodes").get() as {
        n: number;
      }
    ).n,
  ).toBe(1);
  expect(
    (
      db.prepare("SELECT COUNT(*) AS n FROM cluster_join_tokens").get() as {
        n: number;
      }
    ).n,
  ).toBe(1);
});

it("rejects databases newer than user_version 4", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA user_version=5");
  expect(() => migrate(db)).toThrow(/newer/);
});

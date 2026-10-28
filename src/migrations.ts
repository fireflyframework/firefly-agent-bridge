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

import type { DatabaseSync } from "node:sqlite";

const LATEST_VERSION = 4;

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return new Set(rows.map((row) => row.name));
}

function ensureColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  ddl: string,
): void {
  if (!tableColumns(db, table).has(column))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function migrate(db: DatabaseSync): void {
  const version = (
    db.prepare("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
  if (version > LATEST_VERSION)
    throw new Error("Database requires a newer bridge version");
  db.exec(`
 PRAGMA journal_mode=WAL;
 PRAGMA synchronous=FULL;
 PRAGMA foreign_keys=ON;
 PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status,mode);
 CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), data TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS attempts_job ON attempts(job_id);
 CREATE INDEX IF NOT EXISTS attempts_running_owner ON attempts(json_extract(data,'$.owner')) WHERE json_extract(data,'$.status')='running';
 CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, principal_id TEXT NOT NULL, job_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS idempotency(principal_id TEXT NOT NULL, route TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, resource_id TEXT NOT NULL, PRIMARY KEY(principal_id,route,key));
 CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY, data TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS workflows(id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS audit_entries(id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id), data TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS audit_entries_job ON audit_entries(job_id,id);
 CREATE TABLE IF NOT EXISTS audit_tools(id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id), attempt_id TEXT NOT NULL REFERENCES attempts(id), tool_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(job_id,attempt_id,tool_id));
 CREATE INDEX IF NOT EXISTS audit_tools_job ON audit_tools(job_id,id);
 CREATE TABLE IF NOT EXISTS cluster_nodes(
   id TEXT PRIMARY KEY,
   name TEXT NOT NULL,
   worker TEXT NOT NULL,
   status TEXT NOT NULL,
   concurrency INTEGER NOT NULL,
   reserve_percent INTEGER NOT NULL,
   credential_hash TEXT NOT NULL,
   public_key TEXT,
   enrollment_fingerprint TEXT,
   last_heartbeat_at TEXT,
   last_signed_at TEXT,
   capacity_json TEXT,
   created_at TEXT NOT NULL,
   updated_at TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS cluster_join_tokens(
   id TEXT PRIMARY KEY,
   hash TEXT NOT NULL UNIQUE,
   created_by TEXT NOT NULL,
   created_at TEXT NOT NULL,
   expires_at TEXT NOT NULL,
   revoked_at TEXT
 );
 `);
  // Additive columns for databases created at user_version<=3.
  ensureColumn(db, "cluster_nodes", "public_key", "public_key TEXT");
  ensureColumn(
    db,
    "cluster_nodes",
    "enrollment_fingerprint",
    "enrollment_fingerprint TEXT",
  );
  ensureColumn(db, "cluster_nodes", "last_signed_at", "last_signed_at TEXT");
  db.exec(`PRAGMA user_version=${LATEST_VERSION};`);
}

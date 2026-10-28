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

import { createHash, randomBytes } from "node:crypto";
import { BridgeError } from "./contracts.js";
import { QueueStore } from "./store.js";

const DEFAULT_JOIN_TTL_MS = 24 * 60 * 60 * 1000;
const JOIN_TOKEN_RE = /^ffj_[A-Za-z0-9_-]{43}$/;
const NODE_CREDENTIAL_RE = /^ffn_[A-Za-z0-9_-]{43}$/;

export type JoinTokenRecord = {
  id: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
};

export class ClusterAuth {
  constructor(private store: QueueStore) {}

  private hash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  createJoinToken(input: {
    createdBy: string;
    ttlMs?: number;
  }): { id: string; token: string; expiresAt: string } {
    const createdBy = input.createdBy.trim();
    if (!createdBy)
      throw new BridgeError("invalid_request", "createdBy is required");
    const ttlMs = input.ttlMs ?? DEFAULT_JOIN_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs < 1_000)
      throw new BridgeError(
        "invalid_request",
        "Join token TTL must be at least 1000ms",
      );
    const now = Date.now();
    const id = "jtok_" + randomBytes(12).toString("base64url");
    const token = "ffj_" + randomBytes(32).toString("base64url");
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + ttlMs).toISOString();
    this.store.db
      .prepare(
        "INSERT INTO cluster_join_tokens(id,hash,created_by,created_at,expires_at) VALUES(?,?,?,?,?)",
      )
      .run(id, this.hash(token), createdBy, createdAt, expiresAt);
    return { id, token, expiresAt };
  }

  verifyJoinToken(token: string): JoinTokenRecord {
    if (!JOIN_TOKEN_RE.test(token))
      throw new BridgeError(
        "unauthorized",
        "Valid join token is required",
        401,
      );
    const row = this.store.db
      .prepare(
        "SELECT id,created_by,created_at,expires_at,revoked_at FROM cluster_join_tokens WHERE hash=?",
      )
      .get(this.hash(token)) as
      | {
          id: string;
          created_by: string;
          created_at: string;
          expires_at: string;
          revoked_at: string | null;
        }
      | undefined;
    if (!row || row.revoked_at)
      throw new BridgeError(
        "unauthorized",
        "Join token is invalid or revoked",
        401,
      );
    if (Date.parse(row.expires_at) <= Date.now())
      throw new BridgeError("unauthorized", "Join token has expired", 401);
    return {
      id: row.id,
      createdBy: row.created_by,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  issueNodeCredential(): { credential: string; hash: string } {
    const credential = "ffn_" + randomBytes(32).toString("base64url");
    return { credential, hash: this.hash(credential) };
  }

  hashCredential(credential: string): string {
    if (!NODE_CREDENTIAL_RE.test(credential))
      throw new BridgeError(
        "unauthorized",
        "Valid node credential is required",
        401,
      );
    return this.hash(credential);
  }
}

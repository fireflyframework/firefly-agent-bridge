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

import { describe, expect, it } from "vitest";
import {
  enrollmentFingerprint,
  generateNodeKeyPair,
  ReplayNonceStore,
  signWorkerRequest,
  verifyWorkerRequest,
} from "../src/cluster-crypto.js";

describe("cluster-crypto", () => {
  it("generates Ed25519 keypair and enrollment fingerprint", () => {
    const keys = generateNodeKeyPair();
    expect(keys.privateKeyPem).toContain("PRIVATE KEY");
    expect(keys.publicKeyPem).toContain("PUBLIC KEY");
    const fp = enrollmentFingerprint(keys.publicKeyPem, "desk-1");
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
    expect(enrollmentFingerprint(keys.publicKeyPem, "desk-1")).toBe(fp);
    expect(enrollmentFingerprint(keys.publicKeyPem, "other")).not.toBe(fp);
  });

  it("signs and verifies worker request canonical payload", () => {
    const keys = generateNodeKeyPair();
    const timestamp = String(Date.now());
    const nonce = "n".repeat(32);
    const body = JSON.stringify({ freeSlots: 1 });
    const signature = signWorkerRequest({
      privateKeyPem: keys.privateKeyPem,
      timestamp,
      nonce,
      method: "POST",
      path: "/v1/cluster/nodes/node_a/claim",
      body,
    });
    expect(signature.length).toBeGreaterThan(40);
    const store = new ReplayNonceStore();
    expect(
      verifyWorkerRequest({
        publicKeyPem: keys.publicKeyPem,
        timestamp,
        nonce,
        method: "POST",
        path: "/v1/cluster/nodes/node_a/claim",
        body,
        signature,
        skewMs: 60_000,
        nonceStore: store,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects reused nonce (replay)", () => {
    const keys = generateNodeKeyPair();
    const timestamp = String(Date.now());
    const nonce = "replay-nonce-aaaaaaaaaaaaaaaa";
    const body = "{}";
    const signature = signWorkerRequest({
      privateKeyPem: keys.privateKeyPem,
      timestamp,
      nonce,
      method: "POST",
      path: "/v1/cluster/nodes/node_a/heartbeat",
      body,
    });
    const store = new ReplayNonceStore();
    const input = {
      publicKeyPem: keys.publicKeyPem,
      timestamp,
      nonce,
      method: "POST",
      path: "/v1/cluster/nodes/node_a/heartbeat",
      body,
      signature,
      skewMs: 60_000,
      nonceStore: store,
    };
    expect(verifyWorkerRequest(input).ok).toBe(true);
    const replay = verifyWorkerRequest(input);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toMatch(/replay|nonce/i);
  });

  it("rejects timestamp outside skew window", () => {
    const keys = generateNodeKeyPair();
    const timestamp = String(Date.now() - 120_000);
    const nonce = "skew-nonce-bbbbbbbbbbbbbbbbbb";
    const body = "{}";
    const signature = signWorkerRequest({
      privateKeyPem: keys.privateKeyPem,
      timestamp,
      nonce,
      method: "POST",
      path: "/v1/cluster/join",
      body,
    });
    const result = verifyWorkerRequest({
      publicKeyPem: keys.publicKeyPem,
      timestamp,
      nonce,
      method: "POST",
      path: "/v1/cluster/join",
      body,
      signature,
      skewMs: 60_000,
      nonceStore: new ReplayNonceStore(),
      now: Date.now(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/skew|timestamp/i);
  });

  it("rejects signature from a different key", () => {
    const a = generateNodeKeyPair();
    const b = generateNodeKeyPair();
    const timestamp = String(Date.now());
    const nonce = "wrong-key-cccccccccccccccc";
    const body = "{}";
    const signature = signWorkerRequest({
      privateKeyPem: a.privateKeyPem,
      timestamp,
      nonce,
      method: "POST",
      path: "/v1/cluster/nodes/x/claim",
      body,
    });
    const result = verifyWorkerRequest({
      publicKeyPem: b.publicKeyPem,
      timestamp,
      nonce,
      method: "POST",
      path: "/v1/cluster/nodes/x/claim",
      body,
      signature,
      skewMs: 60_000,
      nonceStore: new ReplayNonceStore(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/signature/i);
  });
});

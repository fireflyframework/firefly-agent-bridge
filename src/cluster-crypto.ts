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

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";

export type NodeKeyPair = {
  privateKeyPem: string;
  publicKeyPem: string;
};

export type VerifyWorkerRequestResult =
  | { ok: true }
  | { ok: false; reason: string };

export function generateNodeKeyPair(): NodeKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export function enrollmentFingerprint(
  publicKeyPem: string,
  name: string,
): string {
  return createHash("sha256")
    .update(publicKeyPem.trim())
    .update("\n")
    .update(name.trim())
    .digest("hex");
}

export function canonicalWorkerPayload(input: {
  timestamp: string;
  nonce: string;
  method: string;
  path: string;
  body: string;
}): string {
  const bodyHash = createHash("sha256")
    .update(input.body ?? "")
    .digest("hex");
  return [
    input.timestamp,
    input.nonce,
    input.method.toUpperCase(),
    input.path,
    bodyHash,
  ].join("\n");
}

export function signWorkerRequest(input: {
  privateKeyPem: string;
  timestamp: string;
  nonce: string;
  method: string;
  path: string;
  body: string;
}): string {
  const payload = canonicalWorkerPayload(input);
  const key = createPrivateKey(input.privateKeyPem);
  return sign(null, Buffer.from(payload, "utf8"), key).toString("base64url");
}

export function newRequestNonce(): string {
  return randomBytes(16).toString("base64url");
}

/** Remembers nonces until their skew window ends (replay protection). */
export class ReplayNonceStore {
  private entries = new Map<string, number>();

  constructor(private maxEntries = 10_000) {}

  has(nonce: string, now = Date.now()): boolean {
    this.prune(now);
    const existing = this.entries.get(nonce);
    return existing != null && existing > now;
  }

  remember(nonce: string, expiresAtMs: number, now = Date.now()): void {
    this.prune(now);
    if (this.entries.size >= this.maxEntries) this.prune(now, true);
    this.entries.set(nonce, expiresAtMs);
  }

  private prune(now: number, forceHalf = false): void {
    for (const [nonce, expires] of this.entries)
      if (expires <= now) this.entries.delete(nonce);
    if (forceHalf && this.entries.size >= this.maxEntries) {
      const keys = [...this.entries.keys()].slice(
        0,
        Math.floor(this.entries.size / 2),
      );
      for (const key of keys) this.entries.delete(key);
    }
  }
}

export function verifyWorkerRequest(input: {
  publicKeyPem: string;
  timestamp: string;
  nonce: string;
  method: string;
  path: string;
  body: string;
  signature: string;
  skewMs: number;
  nonceStore: ReplayNonceStore;
  now?: number;
}): VerifyWorkerRequestResult {
  const now = input.now ?? Date.now();
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts))
    return { ok: false, reason: "Invalid timestamp" };
  if (Math.abs(now - ts) > input.skewMs)
    return { ok: false, reason: "Request timestamp outside skew window" };
  if (!input.nonce || input.nonce.length < 16)
    return { ok: false, reason: "Nonce is required" };
  if (input.nonceStore.has(input.nonce, now))
    return { ok: false, reason: "Replay rejected: nonce already used" };
  if (!input.signature)
    return { ok: false, reason: "Signature is required" };
  let ok = false;
  try {
    const payload = canonicalWorkerPayload(input);
    const key = createPublicKey(input.publicKeyPem);
    ok = verify(
      null,
      Buffer.from(payload, "utf8"),
      key,
      Buffer.from(input.signature, "base64url"),
    );
  } catch {
    return { ok: false, reason: "Invalid signature material" };
  }
  if (!ok) return { ok: false, reason: "Signature verification failed" };
  input.nonceStore.remember(input.nonce, ts + input.skewMs, now);
  return { ok: true };
}

/** IPv4 CIDR allow-list. Empty list means allow all. */
export function ipAllowedByCidrs(
  ip: string | undefined,
  cidrs: string[],
): boolean {
  if (!cidrs.length) return true;
  if (!ip) return false;
  const normalized = ip.replace(/^::ffff:/i, "");
  for (const cidr of cidrs) {
    if (matchIpv4Cidr(normalized, cidr)) return true;
  }
  return false;
}

function matchIpv4Cidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  if (!base) return false;
  const bits = bitsRaw == null ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const ipNum = ipv4ToInt(ip);
  const baseNum = ipv4ToInt(base);
  if (ipNum == null || baseNum == null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    n = (n << 8) + octet;
  }
  return n >>> 0;
}

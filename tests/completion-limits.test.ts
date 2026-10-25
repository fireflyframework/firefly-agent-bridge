/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * https://www.apache.org/licenses/LICENSE-2.0 */
import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type CompletionInputLimits } from "../src/config.js";
import { prepareCompletion } from "../src/completion-protocol.js";
import { RECOVERY_LIMITS } from "../src/completion-recovery.js";
import { QueueStore } from "../src/store.js";
import { Tokens } from "../src/auth.js";
import { Workflows } from "../src/workflows.js";
import { Scheduler } from "../src/scheduler.js";
import { createHttpService } from "../src/http.js";
const unlimited = {
  maxRequestBytes: null,
  maxExpandedCharacters: null,
  maxMessages: null,
};
const body = (content = "Hello") => ({
  model: "bridge/default",
  messages: [{ role: "user", content }],
  bridge: { background: true },
});
const local = {
  dataDir: "/tmp/bridge-envelope-fixture",
  workspace: "/tmp/bridge-envelope-fixture",
  claudePath: process.execPath,
};

it("preserves complete long and many-message histories without implicit aggregate limits", () => {
  const content = "START:" + '漢\\"\n'.repeat(30000) + ":END";
  const messages = Array.from({ length: 140 }, (_, n) => ({
    role: "user",
    content: n === 139 ? content : `message-${n}`,
  }));
  const prepared = prepareCompletion({ ...body(), messages }, unlimited);
  expect(prepared.prompt.length).toBeGreaterThan(100000);
  expect(prepared.request.messages).toEqual(messages);
  expect(
    JSON.parse(prepared.prompt.slice(prepared.prompt.indexOf("\n") + 1))
      .messages,
  ).toEqual(messages);
});
it("enforces an exact optional expanded-character or message budget without truncation", () => {
  const request = body("x".repeat(100001));
  const prepared = prepareCompletion(request, unlimited);
  expect(
    prepareCompletion(request, {
      ...unlimited,
      maxExpandedCharacters: prepared.prompt.length,
    }).prompt,
  ).toBe(prepared.prompt);
  expect(() =>
    prepareCompletion(request, {
      ...unlimited,
      maxExpandedCharacters: prepared.prompt.length - 1,
    }),
  ).toThrow(/configured/);
  expect(() =>
    prepareCompletion(
      { ...request, messages: [...request.messages, ...request.messages] },
      { ...unlimited, maxMessages: 1 },
    ),
  ).toThrow(/configured/);
});
it("validates positive safe integer or null owner policy and defaults to null", () => {
  expect(parseConfig(local).openai).toMatchObject(unlimited);
  for (const field of Object.keys(unlimited)) {
    expect(
      parseConfig({ ...local, openai: { [field]: null } }).openai,
    ).toMatchObject({ [field]: null });
    for (const value of [0, -1, 1.5, true, "100", Number.MAX_SAFE_INTEGER + 1])
      expect(() =>
        parseConfig({ ...local, openai: { [field]: value } }),
      ).toThrow();
  }
  expect(() =>
    parseConfig({ ...local, openai: { missingLimit: null } }),
  ).toThrow();
});
async function fixture(limits: Partial<CompletionInputLimits> = unlimited) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-envelope-"));
  const store = new QueueStore(":memory:");
  const auth = new Tokens(store),
    flows = new Workflows(store, []);
  let dispatches = 0;
  const scheduler = new Scheduler(
    store,
    flows,
    () => {
      dispatches++;
      throw new Error("No worker is permitted");
    },
    dir,
    1,
  );
  const config = parseConfig({
    dataDir: dir,
    workspace: dir,
    claudePath: process.execPath,
    openai: limits,
  });
  const app = createHttpService({ store, auth, scheduler, flows, config });
  const token = auth.create({
    id: "envelope-client",
    owner: false,
    profiles: ["default"],
    scopes: ["read", "submit"],
  }).token;
  const headers = {
    authorization: "Bearer " + token,
    "content-type": "application/json",
  };
  return {
    app,
    auth,
    store,
    config,
    headers,
    dispatches: () => dispatches,
    close: async () => {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
it("admits and retains the exact long recoverable request once with unchanged custody budgets", async () => {
  const f = await fixture();
  try {
    const raw = JSON.stringify(body("begin:" + "x".repeat(180000) + ":end"));
    const key = "fbr1_" + "1".repeat(32);
    const headers = {
      ...f.headers,
      "x-bridge-completion-recovery": "1",
      "idempotency-key": key,
    };
    const first = await f.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers,
      payload: raw,
    });
    expect(first.statusCode).toBe(202);
    const second = await f.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers,
      payload: raw,
    });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json());
    const job = f.store.get(first.json().id);
    expect(job.prompt).toBe(
      prepareCompletion(JSON.parse(raw), unlimited).prompt,
    );
    expect(job.completion?.messages).toEqual(JSON.parse(raw).messages);
    const receipt = await f.app.inject({
      url: "/v1/bridge/completion-requests/" + key,
      headers: f.headers,
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json().admission.wire_sha256).toBe(
      createHash("sha256").update(raw).digest("hex"),
    );
    expect(receipt.json().admission.wire_bytes).toBe(Buffer.byteLength(raw));
    expect(f.store.list()).toHaveLength(1);
    expect(f.dispatches()).toBe(0);
    expect(RECOVERY_LIMITS).toEqual({
      admissions: 1000,
      admissionBytes: 4096,
      terminalBytes: 262144,
      retainedBytes: 16777216,
    });
    f.config.openai.maxExpandedCharacters = 1;
    expect(
      (
        await f.app.inject({
          url: "/v1/bridge/completion-requests/" + key,
          headers: f.headers,
        })
      ).json().admission.job_id,
    ).toBe(job.id);
    expect(f.store.get(job.id).prompt).toBe(job.prompt);
  } finally {
    await f.close();
  }
});
it.each(["maxRequestBytes", "maxExpandedCharacters", "maxMessages"])(
  "rejects a configured %s budget before any queued effect",
  async (field) => {
    const f = await fixture({ ...unlimited, [field]: 1 });
    try {
      const response = await f.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: f.headers,
        payload: JSON.stringify({
          ...body(),
          messages: [...body().messages, ...body().messages],
        }),
      });
      expect(response.statusCode).toBe(413);
      expect(f.store.list()).toEqual([]);
      expect(f.dispatches()).toBe(0);
    } finally {
      await f.close();
    }
  },
);
it("disables the ordinary request body cap while keeping the recovery-v1 wire bound explicit", async () => {
  const f = await fixture();
  try {
    const request = body("x".repeat(9000100));
    const raw = JSON.stringify(request);
    const rejected = await f.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        ...f.headers,
        "x-bridge-completion-recovery": "1",
        "idempotency-key": "fbr1_" + "2".repeat(32),
      },
      payload: raw,
    });
    expect(rejected.statusCode).toBe(413);
    expect(f.store.list()).toEqual([]);
    const accepted = await f.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: f.headers,
      payload: raw,
    });
    expect(accepted.statusCode).toBe(202);
    expect(f.store.get(accepted.json().id).completion?.messages).toEqual(
      request.messages,
    );
    expect(f.dispatches()).toBe(0);
  } finally {
    await f.close();
  }
});

it.each(["read", "submit"])(
  "rejects insufficient scope before parsing an unbounded request",
  async (scope) => {
    const f = await fixture();
    try {
      const token = f.auth.create({
        id: "limited-client",
        owner: false,
        profiles: ["default"],
        scopes: [scope],
      }).token;
      const response = await f.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { ...f.headers, authorization: "Bearer " + token },
        payload: "{invalid:" + "x".repeat(180000),
      });
      expect(response.statusCode).toBe(403);
      expect(f.store.list()).toEqual([]);
      expect(f.dispatches()).toBe(0);
    } finally {
      await f.close();
    }
  },
);

it.each([
  ["revoke", 401],
  ["scope", 403],
  ["profile", 404],
] as const)(
  "rejects streamed authority drift %s before a queued effect",
  async (change, expected) => {
    const f = await fixture();
    try {
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      f.app.addHook("preParsing", async (_request, _reply, payload) => {
        enter();
        return payload;
      });
      const raw = JSON.stringify(body("x".repeat(180000)));
      let changed = false;
      const payload = Readable.from(
        (async function* () {
          await entered;
          yield raw.slice(0, 90000);
          await new Promise<void>((resolve) => setImmediate(resolve));
          const principal = f.auth.verify(f.headers.authorization.slice(7));
          if (change === "revoke") f.auth.revoke(principal.id);
          else {
            if (change === "scope") principal.scopes = ["read"];
            else principal.profiles = [];
            const rows = f.store.db
              .prepare("SELECT hash,data FROM tokens")
              .all() as { hash: string; data: string }[];
            const row = rows.find(
              (row) => JSON.parse(row.data).id === principal.id,
            )!;
            f.store.db
              .prepare("UPDATE tokens SET data=? WHERE hash=?")
              .run(JSON.stringify(principal), row.hash);
          }
          changed = true;
          yield raw.slice(90000);
        })(),
      );
      const response = await f.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: f.headers,
        payload,
      });
      expect(changed).toBe(true);
      expect(response.statusCode).toBe(expected);
      expect(f.store.list()).toEqual([]);
      expect(f.dispatches()).toBe(0);
    } finally {
      await f.close();
    }
  },
);
it("rechecks authorization inside the final queue transaction", async () => {
  const f = await fixture();
  try {
    const atomic = f.store.atomic;
    let revoked = false;
    f.store.atomic = function <T>(this: QueueStore, fn: () => T): T {
      if (!revoked) {
        revoked = true;
        f.auth.revoke("envelope-client");
      }
      return atomic.call(this, fn) as T;
    };
    const response = await f.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: f.headers,
      payload: JSON.stringify(body()),
    });
    expect(revoked).toBe(true);
    expect(response.statusCode).toBe(401);
    expect(f.store.list()).toEqual([]);
    expect(f.dispatches()).toBe(0);
  } finally {
    await f.close();
  }
});

/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * Licensed under https://www.apache.org/licenses/LICENSE-2.0
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore } from "../src/store.js";
import { Tokens } from "../src/auth.js";
import { Scheduler } from "../src/scheduler.js";
import { Workflows } from "../src/workflows.js";
import { createHttpService } from "../src/http.js";
import { parseConfig, type BridgeConfig } from "../src/config.js";
import { challengeImage, imageCapability } from "../src/image-capabilities.js";
import type { Job, Outcome } from "../src/contracts.js";
let config: BridgeConfig;
let dir: string,
  store: QueueStore,
  auth: Tokens,
  scheduler: Scheduler,
  app: ReturnType<typeof createHttpService>,
  token: string;
const key = (n = 1) => "fbr1_" + n.toString(16).padStart(32, "0");
const body = {
  model: "bridge/default",
  messages: [{ role: "user", content: "Hello 世界" }],
  bridge: { background: true },
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function setup() {
  store = new QueueStore(join(dir, "db.sqlite"));
  auth = new Tokens(store);
  const flows = new Workflows(store, []);
  scheduler = new Scheduler(
    store,
    flows,
    () => {
      throw new Error("No provider worker may start");
    },
    dir,
    1,
  );
  config = parseConfig({
    dataDir: dir,
    workspace: dir,
    claudePath: process.execPath,
    openai: { timeoutMs: 100 },
  });
  app = createHttpService({
    store,
    auth,
    scheduler,
    flows,
    config,
  });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-recovery-"));
  setup();
  token = auth.create({
    id: "alice",
    owner: false,
    profiles: ["default"],
    scopes: ["read", "submit", "control"],
  }).token;
});
afterEach(async () => {
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const headers = () => ({ authorization: "Bearer " + token });
async function post(
  input: unknown = body,
  id = key(),
  extra: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      ...headers(),
      "content-type": "application/json",
      "idempotency-key": id,
      "x-bridge-completion-recovery": "1",
      ...extra,
    },
    payload: typeof input === "string" ? input : JSON.stringify(input),
  });
}
const get = (id = key()) =>
  app.inject({
    url: "/v1/bridge/completion-requests/" + id,
    headers: headers(),
  });
function fakeWorker(
  job: Job,
  outcome: Outcome = {
    status: "succeeded",
    result: JSON.stringify({ content: "Original 世界", tool_calls: [] }),
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  },
) {
  const attempt = store.claim("explicit-fake-worker", "cli", job.id)!;
  expect(attempt).not.toBeNull();
  store.finish(attempt, outcome);
  return attempt;
}
it("advertises authenticated opt-in recovery without starting a worker", async () => {
  const wake = vi.spyOn(scheduler, "wake");
  const r = await app.inject({ url: "/v1/bridge/status", headers: headers() });
  expect(r.json().completionRecovery).toMatchObject({
    version: 1,
    principal_id: "alice",
    header: "X-Bridge-Completion-Recovery",
    value: "1",
  });
  expect(wake).not.toHaveBeenCalled();
});
it("retains exact original response and wire digest across a lost response and SQLite reopen", async () => {
  const raw = JSON.stringify(body, null, 2);
  const admitted = await post(raw);
  expect(admitted.statusCode).toBe(202);
  const job = store.list()[0]!;
  const attempt = fakeWorker(job);
  const r = await get();
  expect(r.statusCode).toBe(200);
  const original = r.json();
  expect(original.state).toBe("terminal");
  expect(original.admission).toMatchObject({
    version: 1,
    request_id: key(),
    principal_id: "alice",
    job_id: job.id,
    wire_sha256: hash(raw),
    wire_bytes: Buffer.byteLength(raw),
    fingerprint_algorithm: "sha256-json-stringify-prepared-v1",
  });
  expect(original.terminal).toMatchObject({
    job_id: job.id,
    attempt_id: attempt.id,
    status: "succeeded",
  });
  expect(hash(original.terminal.result_json)).toBe(
    original.terminal.result_sha256,
  );
  expect(
    JSON.parse(original.terminal.result_json).choices[0].message.content,
  ).toBe("Original 世界");
  await app.close();
  store.close();
  setup();
  const reopened = (await get()).json();
  expect(reopened.admission).toEqual(original.admission);
  expect(reopened.terminal).toEqual(original.terminal);
  expect(store.attempts(job.id, auth.verify(token))).toHaveLength(1);
});
it("keeps native normalized idempotency separate from first wire bytes and rejects changed input", async () => {
  const first = await post(JSON.stringify(body, null, 2));
  expect(first.statusCode).toBe(202);
  const replay = await post(JSON.stringify(body));
  expect(replay.statusCode).toBe(202);
  expect(replay.json().id).toBe(first.json().id);
  expect((await get()).json().admission.wire_sha256).toBe(
    hash(JSON.stringify(body, null, 2)),
  );
  const conflict = await post({
    ...body,
    messages: [{ role: "user", content: "different" }],
  });
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json().error.code).toBe("idempotency_conflict");
  expect(store.list()).toHaveLength(1);
});
it("rolls back job, idempotency, audit and metadata if admission retention fails", async () => {
  store.db.exec(
    "CREATE TRIGGER test_fail_admission BEFORE INSERT ON metadata WHEN NEW.key LIKE 'completion-admission-v1:%' BEGIN SELECT RAISE(ABORT,'controlled storage refusal'); END;",
  );
  expect((await post()).statusCode).toBe(500);
  expect(store.list()).toHaveLength(0);
  for (const table of ["idempotency", "events", "audit_entries"])
    expect(
      store.db.prepare(`SELECT count(*) n FROM ${table}`).get(),
    ).toMatchObject({ n: 0 });
  expect((await get()).statusCode).toBe(404);
});
it.each(["failed", "canceled", "timed_out", "interrupted"] as const)(
  "preserves the first %s terminal despite a later explicit retry",
  async (status) => {
    const job = (await post()).json() as Job;
    fakeWorker(job, { status, error: "original known failure" });
    const original = (await get()).json();
    expect(original.terminal.status).toBe(status);
    store.retry(job.id, auth.verify(token));
    fakeWorker(job);
    const current = (await get()).json();
    expect(current.terminal).toEqual(original.terminal);
    expect(current.current_job_status).toBe("succeeded");
    const replay = await post({ ...body, bridge: { background: true } });
    expect(replay.statusCode).toBe(202);
    expect((await get()).json().terminal).toEqual(original.terminal);
  },
);
it("freezes queued cancel and startup ownership loss, and does not freeze pauses", async () => {
  const canceled = (await post(body, key(1))).json() as Job;
  store.cancel(canceled.id, auth.verify(token));
  expect((await get(key(1))).json().terminal.status).toBe("canceled");
  const interrupted = (await post(body, key(2))).json() as Job;
  store.claim("lost-fake-worker", "cli", interrupted.id);
  store.recover();
  expect((await get(key(2))).json().terminal.status).toBe("interrupted");
  const paused = (await post(body, key(3))).json() as Job;
  fakeWorker(paused, {
    status: "paused",
    error: "context_exhausted",
    sessionId: "session",
  });
  expect((await get(key(3))).json()).toMatchObject({
    state: "paused",
    terminal: null,
    observations: { reason: "context_exhausted" },
  });
  store.resume(paused.id, auth.verify(token));
  fakeWorker(paused);
  expect((await get(key(3))).json().terminal.status).toBe("succeeded");
});
it("retains opt-in work on request timeout while ordinary keyed requests still cancel", async () => {
  const sync = { ...body, bridge: { background: false } };
  const recovery = await post(sync);
  expect(recovery.statusCode).toBe(504);
  const job = store.list()[0]!;
  expect(store.get(job.id).status).toBe("queued");
  const old = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { ...headers(), "idempotency-key": "legacy" },
    payload: sync,
  });
  expect(old.statusCode).toBe(504);
  expect(store.list().find((j) => j.id !== job.id)!.status).toBe("canceled");
});
it("exact GET is current-principal/profile/read scoped and never wakes or writes", async () => {
  const job = (await post()).json() as Job;
  fakeWorker(job);
  const before = store.db.prepare("SELECT * FROM metadata ORDER BY key").all();
  const wake = vi.spyOn(scheduler, "wake");
  expect((await get()).statusCode).toBe(200);
  const alice = token;
  for (const p of [
    { id: "bob", owner: false, profiles: ["default"], scopes: ["read"] },
    { id: "operator", owner: true, profiles: [], scopes: [] },
    { id: "alice", owner: false, profiles: [], scopes: ["read"] },
    { id: "alice", owner: false, profiles: ["default"], scopes: ["submit"] },
  ]) {
    token = auth.create(p).token;
    expect((await get()).statusCode).toBe(
      (p.scopes.includes("read") && p.id !== "alice") || p.owner ? 404 : 403,
    );
  }
  token = alice;
  auth.revoke("alice");
  expect((await get()).statusCode).toBe(401);
  token = auth.create({
    id: "alice",
    owner: false,
    profiles: ["default"],
    scopes: ["read"],
  }).token;
  expect((await get()).statusCode).toBe(200);
  expect((await get(key(999))).statusCode).toBe(404);
  expect(wake).not.toHaveBeenCalled();
  expect(store.db.prepare("SELECT * FROM metadata ORDER BY key").all()).toEqual(
    before,
  );
});
it("refuses opt-in on legacy keys, wrong versions, malformed identities and non-inference before writes", async () => {
  for (const [id, extra, input] of [
    ["label", {}, body],
    [key(), { "x-bridge-completion-recovery": "2" }, body],
    [key(), {}, { ...body, bridge: { execution: "agent", background: true } }],
  ] as const)
    expect((await post(input, id, extra)).statusCode).toBe(400);
  expect(store.list()).toHaveLength(0);
  const legacy = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { ...headers(), "idempotency-key": key() },
    payload: body,
  });
  expect(legacy.statusCode).toBe(202);
  expect((await get()).statusCode).toBe(409);
  expect((await post()).statusCode).toBe(409);
  expect(store.list()).toHaveLength(1);
});
it("reserves pending result capacity atomically before creating more recoverable jobs", async () => {
  for (let n = 1; n <= 64; n++)
    expect((await post(body, key(n))).statusCode).toBe(202);
  expect((await post(body, key(65))).statusCode).toBe(429);
  expect(store.list()).toHaveLength(64);
  fakeWorker(store.list()[0]!);
  expect((await post(body, key(65))).statusCode).toBe(429);
  fakeWorker(store.list().find((j) => j.status === "queued")!);
  expect((await post(body, key(65))).statusCode).toBe(202);
});
it("retains bounded unavailable evidence for oversized output without truncating a success", async () => {
  const job = (await post()).json() as Job;
  const result = JSON.stringify({
    content: "漢".repeat(100000),
    tool_calls: [],
  });
  fakeWorker(job, { status: "succeeded", result });
  const r = (await get()).json();
  expect(r.state).toBe("result_unavailable");
  expect(r.terminal).toMatchObject({
    status: "succeeded",
    reason: "result_too_large",
  });
  expect(r.terminal.result_json).toBeUndefined();
  expect(r.terminal.result_bytes).toBeGreaterThan(262144);
  expect(store.get(job.id).result).toBe(result);
});
it("terminal metadata failure rolls back finish rather than leaving an unreceipted terminal", async () => {
  const job = (await post()).json() as Job;
  const attempt = store.claim("explicit-fake-worker", "cli", job.id)!;
  store.db.exec(
    "CREATE TRIGGER test_fail_terminal BEFORE INSERT ON metadata WHEN NEW.key LIKE 'completion-terminal-v1:%' BEGIN SELECT RAISE(ABORT,'controlled storage refusal'); END;",
  );
  expect(() =>
    store.finish(attempt, {
      status: "succeeded",
      result: '{"content":"ok","tool_calls":[]}',
    }),
  ).toThrow();
  expect(store.get(job.id).status).toBe("running");
  expect((await get()).json().terminal).toBeNull();
});
it("does not reflect corrupt stored terminal data", async () => {
  const job = (await post()).json() as Job;
  fakeWorker(job);
  const row = store.db
    .prepare("SELECT value FROM metadata WHERE key=?")
    .get("completion-terminal-v1:" + job.id) as { value: string };
  const value = JSON.parse(row.value);
  value.result_json = "private corrupt body";
  store.db
    .prepare("UPDATE metadata SET value=? WHERE key=?")
    .run(JSON.stringify(value), "completion-terminal-v1:" + job.id);
  const r = await get();
  expect(r.statusCode).toBe(409);
  expect(r.body).not.toContain("private corrupt body");
});
it("uses the original serialized success for synchronous JSON and buffered SSE", async () => {
  for (const streaming of [false, true]) {
    const id = key(streaming ? 21 : 20);
    const request = {
      ...body,
      stream: streaming,
      stream_options: { include_usage: true },
      bridge: { background: false },
    };
    const pending = post(request, id);
    for (let n = 0; n < 100 && store.list().length < (streaming ? 2 : 1); n++)
      await new Promise((r) => setImmediate(r));
    const job = store.list().find((j) => j.status === "queued")!;
    expect(job).toBeDefined();
    fakeWorker(job);
    const response = await pending;
    expect(response.statusCode).toBe(200);
    const result = (await get(id)).json().terminal.result_json;
    if (!streaming) expect(response.body).toBe(result);
    else {
      const frames = response.body
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6));
      expect(frames.at(-1)).toBe("[DONE]");
      expect(frames.join("\n")).toContain("Original 世界");
      expect(JSON.parse(frames.at(-2)!)).toMatchObject({
        choices: [],
        usage: { total_tokens: 5 },
      });
    }
  }
});
it("has one admission across concurrent HTTP requests and two SQLite connections", async () => {
  const all = await Promise.all([post(), post()]);
  expect(all.map((r) => r.statusCode)).toEqual([202, 202]);
  expect(all[0]!.json().id).toBe(all[1]!.json().id);
  const other = new QueueStore(join(dir, "db.sqlite"));
  try {
    const job = store.get(all[0]!.json().id);
    const attempt = other.claim("second-fake-worker", "cli", job.id)!;
    expect(store.claim("first-fake-worker", "cli", job.id)).toBeNull();
    other.finish(attempt, {
      status: "succeeded",
      result: '{"content":"second connection","tool_calls":[]}',
    });
    expect(
      JSON.parse((await get()).json().terminal.result_json).choices[0].message
        .content,
    ).toBe("second connection");
  } finally {
    other.close();
  }
});
it("keeps 404 read-only and rejects corrupted identity/admission binding without reflection", async () => {
  const missing = await get();
  expect(missing.statusCode).toBe(404);
  expect(store.list()).toHaveLength(0);
  const job = (await post()).json() as Job;
  const row = store.db
    .prepare("SELECT value FROM metadata WHERE key=?")
    .get("completion-admission-v1:" + job.id) as { value: string };
  const value = JSON.parse(row.value);
  value.request_id = key(7);
  delete value.digest;
  value.digest = hash(JSON.stringify(value));
  store.db
    .prepare("UPDATE metadata SET value=? WHERE key=?")
    .run(JSON.stringify(value), "completion-admission-v1:" + job.id);
  expect((await get()).statusCode).toBe(409);
  expect(store.list()).toHaveLength(1);
});
it("refuses unverified image capability and binds a seeded verified configuration", async () => {
  const input = {
    ...body,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Read the image" },
          {
            type: "image_url",
            image_url: {
              url:
                "data:image/png;base64," +
                challengeImage("1234").toString("base64"),
            },
          },
        ],
      },
    ],
  };
  const config = parseConfig({
    dataDir: dir,
    workspace: dir,
    claudePath: process.execPath,
  });
  const revision = imageCapability(
    { config, store } as Parameters<typeof imageCapability>[0],
    "default",
  ).config_revision;
  const refused = await post(input, key(), {
    "x-bridge-image-revision": revision,
  });
  expect(refused.statusCode).toBe(409);
  expect(store.list()).toHaveLength(0);
  // This seeds capability metadata, not a real provider/image qualification.
  store.db.prepare("INSERT INTO metadata VALUES(?,?)").run(
    "image-verified:default",
    JSON.stringify({
      revision,
      status: "verified",
      verified_at: new Date().toISOString(),
    }),
  );
  expect(
    (await post(input, key(), { "x-bridge-image-revision": revision }))
      .statusCode,
  ).toBe(202);
  expect((await get()).json().admission.image_revision).toBe(revision);
  expect(
    (await post(input, key(), { "x-bridge-image-revision": "b".repeat(64) }))
      .statusCode,
  ).toBe(409);
  expect(store.list()).toHaveLength(1);
});
it("keeps admitted recovery retention when a later legacy waiter omits the opt-in header", async () => {
  const input = { ...body, bridge: { background: false } };
  expect((await post(input)).statusCode).toBe(504);
  const job = store.list()[0]!;
  const second = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { ...headers(), "idempotency-key": key() },
    payload: input,
  });
  expect(second.statusCode).toBe(504);
  expect(store.get(job.id).status).toBe("queued");
});
it("applies current configured-profile removal to exact reads without mutating history", async () => {
  const job = (await post()).json() as Job;
  fakeWorker(job);
  const before = store.db.prepare("SELECT * FROM metadata ORDER BY key").all();
  delete config.profiles.default;
  expect((await get()).statusCode).toBe(403);
  expect(store.db.prepare("SELECT * FROM metadata ORDER BY key").all()).toEqual(
    before,
  );
});
it("retains the original tool-call JSON bytes and IDs", async () => {
  const input = {
    ...body,
    tools: [
      {
        type: "function",
        function: {
          name: "sum",
          parameters: {
            type: "object",
            properties: { n: { type: "integer" } },
            required: ["n"],
          },
        },
      },
    ],
    tool_choice: "required",
  };
  const job = (await post(input)).json() as Job;
  fakeWorker(job, {
    status: "succeeded",
    result: JSON.stringify({
      content: null,
      tool_calls: [{ name: "sum", arguments: '{"n":2}' }],
    }),
  });
  const saved = (await get()).json().terminal;
  const expected = {
    id: "chatcmpl-" + job.id,
    object: "chat.completion",
    created: Math.floor(Date.parse(store.get(job.id).createdAt) / 1000),
    model: "bridge/default",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_" + job.id.replaceAll("-", "") + "_0",
              type: "function",
              function: { name: "sum", arguments: '{"n":2}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
  expect(saved.result_json).toBe(JSON.stringify(expected));
  expect(saved.result_sha256).toBe(hash(JSON.stringify(expected)));
});
it("does not admit overlong raw bodies or partial malformed JSON", async () => {
  const tooBig = await post(" ".repeat(9000001));
  expect(tooBig.statusCode).toBe(413);
  expect((await post('{"model":')).statusCode).toBe(400);
  expect(store.list()).toHaveLength(0);
  expect((await get()).statusCode).toBe(404);
});
it("bounds admission count after small terminal results have released byte reservations", async () => {
  const p = auth.verify(token);
  const { prepareCompletion } = await import("../src/completion-protocol.js");
  const prepared = prepareCompletion(body);
  // Populate the count boundary without measuring 2,000 filesystem commits.
  store.atomic(() => {
    for (let n = 1; n <= 1000; n++) {
      const id = key(n);
      const job = store.atomic(() => {
        const job = store.idempotent(
          p,
          "chat/completions",
          id,
          prepared.request,
          () =>
            store.submit(
              { prompt: prepared.prompt, profile: "default" },
              p,
              undefined,
              prepared.request,
            ),
          (id) => store.get(id, p),
        );
        store.completionRecovery.admit(
          job,
          p,
          id,
          {
            sha256: hash(JSON.stringify(body)),
            bytes: Buffer.byteLength(JSON.stringify(body)),
          },
          undefined,
          true,
        );
        return job;
      });
      store.cancel(job.id, p);
    }
  });
  expect((await post(body, key(1001))).statusCode).toBe(429);
  expect(store.db.prepare("SELECT count(*) n FROM jobs").get()).toMatchObject({
    n: 1000,
  });
});

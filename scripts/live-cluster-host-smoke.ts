#!/usr/bin/env tsx
/*!
 * Copyright (c) 2026 Signature Management Consultants SLU
 * Modified by Firefly Software Foundation for Firefly Agent Bridge (2026).
 * Author: @ancongui
 * SPDX-License-Identifier: Apache-2.0
 *
 * Single-host multi-node live smoke:
 * - One coordinator + N workers of the SAME worker type (v1 rule).
 * - Private/lab HTTP with --allow-insecure.
 * - Optional second pool for the other CLI on another port.
 *
 * Usage:
 *   npx tsx scripts/live-cluster-host-smoke.ts --worker codex --workers 2
 *   npx tsx scripts/live-cluster-host-smoke.ts --worker claude --workers 1
 *   npx tsx scripts/live-cluster-host-smoke.ts --both
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "dist/cli.cjs");
const children: ChildProcess[] = [];
const keep = process.argv.includes("--keep");

function log(msg: string, data?: unknown): void {
  console.log(msg + (data === undefined ? "" : " " + JSON.stringify(data)));
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") {
        s.close();
        reject(new Error("no port"));
        return;
      }
      const port = addr.port;
      s.close((err) => (err ? reject(err) : resolvePort(port)));
    });
  });
}

function bridge(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv } = {},
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("node", [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, BRIDGE_NO_BANNER: "1", CI: "1", ...opts.env },
    timeout: 120_000,
  });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function mustOk(
  label: string,
  r: { code: number; stdout: string; stderr: string },
): string {
  if (r.code !== 0) {
    console.error(`FAIL ${label}`, r.stderr || r.stdout);
    throw new Error(`${label} exited ${r.code}`);
  }
  return r.stdout;
}

function parseJson<T>(label: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label}: invalid JSON: ${text.slice(0, 400)}`);
  }
}

async function serve(
  role: "coordinator" | "worker",
  dataDir: string,
  healthPort?: number,
): Promise<ChildProcess> {
  const args = [
    "serve",
    role === "coordinator" ? "--cluster-coordinator" : "--cluster-worker",
    "--data-dir",
    dataDir,
  ];
  if (healthPort != null) args.push("--health-port", String(healthPort));
  const child = spawn("node", [cli, ...args], {
    cwd: root,
    env: { ...process.env, BRIDGE_NO_BANNER: "1", CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  children.push(child);
  let err = "";
  child.stderr?.on("data", (c) => {
    err += String(c);
    process.stderr.write(`[${role}:${dataDir.split("/").pop()}] ${c}`);
  });
  child.stdout?.on("data", (c) => {
    process.stderr.write(`[${role}:out] ${c}`);
  });
  for (let i = 0; i < 50; i++) {
    if (child.exitCode != null)
      throw new Error(`${role} exited early: ${err || child.exitCode}`);
    await sleep(200);
    // coordinator: try status; worker: health or just wait
    if (role === "coordinator") {
      const st = bridge(["status", "--data-dir", dataDir]);
      if (st.code === 0) return child;
    } else if (healthPort != null) {
      try {
        const res = await fetch(`http://127.0.0.1:${healthPort}/health`);
        if (res.ok) return child;
      } catch {
        /* retry */
      }
    } else if (i > 10) return child;
  }
  throw new Error(`${role} failed to become ready: ${err}`);
}

function cleanup(): void {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

async function runPool(opts: {
  worker: "claude" | "codex";
  workers: number;
  rootDir: string;
}): Promise<void> {
  const { worker, workers, rootDir } = opts;
  const basePort = await freePort();
  const coordDir = join(rootDir, `${worker}-coord`);
  log(`\n=== Pool ${worker} @ :${basePort} (${workers} workers) ===`);

  mustOk("init", bridge(["init", "--worker", worker, "--data-dir", coordDir]));
  mustOk(
    "init-coordinator",
    bridge([
      "cluster",
      "init-coordinator",
      "--data-dir",
      coordDir,
      "--exposure",
      "private",
      "--bind",
      "127.0.0.1",
      "--port",
      String(basePort),
      "--reserve-percent",
      "10",
    ]),
  );

  await serve("coordinator", coordDir);
  await sleep(500);

  const tokenOut = mustOk(
    "join-token",
    bridge([
      "cluster",
      "join-token",
      "create",
      "--data-dir",
      coordDir,
      "--ttl",
      "1h",
    ]),
  );
  const { token } = parseJson<{ token: string }>("token", tokenOut);
  log("join token created");

  const owner = readFileSync(join(coordDir, "owner.token"), "utf8").trim();
  const coordUrl = `http://127.0.0.1:${basePort}`;

  for (let i = 0; i < workers; i++) {
    const wDir = join(rootDir, `${worker}-w${i}`);
    mustOk(
      "init-worker",
      bridge(["init", "--worker", worker, "--data-dir", wDir]),
    );
    // Workspace must exist before resource probe (statfs); init only writes config.
    mkdirSync(join(wDir, "jobs"), { recursive: true });
    mustOk(
      `join-w${i}`,
      bridge([
        "cluster",
        "join",
        "--data-dir",
        wDir,
        "--coordinator",
        coordUrl,
        "--token",
        token,
        "--name",
        `${worker}-w${i}`,
        "--allow-insecure",
      ]),
    );
    const health = await freePort();
    await serve("worker", wDir, health);
    log(`worker ${i} joined`, { dir: wDir });
  }

  // Wait until workers have probed CLI auth and become eligible.
  // `bridge cluster status` prints the cluster object (pool/nodes at top level).
  type ClusterStatusView = {
    pool?: { onlineNodes?: number; eligibleNodes?: number };
    nodes?: Array<{
      name?: string;
      authentication?: string;
      memoryFreeBytes?: number | null;
    }>;
    dispatch?: string;
  };
  let status: ClusterStatusView = {};
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const statusOut = mustOk(
      "cluster-status",
      bridge(["cluster", "status", "--data-dir", coordDir]),
    );
    status = parseJson("status", statusOut);
    const pool = status.pool;
    log(`cluster status wait ${i}`, {
      online: pool?.onlineNodes,
      eligible: pool?.eligibleNodes,
      nodes: status.nodes?.map((n) => ({
        name: n.name,
        authentication: n.authentication,
        memoryFreeBytes: n.memoryFreeBytes,
      })),
    });
    if ((pool?.eligibleNodes ?? 0) >= 1) break;
  }
  if ((status.pool?.eligibleNodes ?? 0) < 1) {
    throw new Error(
      `${worker} pool has 0 eligible nodes after join (CLI auth/resources?). ` +
        JSON.stringify(status.pool ?? status),
    );
  }

  const submit = await fetch(`${coordUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${owner}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "bridge/default",
      messages: [
        {
          role: "user",
          content: `Reply with exactly: CLUSTER_SMOKE_OK_${worker.toUpperCase()}`,
        },
      ],
      bridge: { execution: "agent", background: true },
    }),
  });
  const submitBody = await submit.text();
  if (![200, 202].includes(submit.status))
    throw new Error(`submit failed ${submit.status}: ${submitBody}`);
  const job = JSON.parse(submitBody) as { id: string; status?: string };
  log("job submitted", job);

  let final: { id: string; status: string; result?: string; error?: string } = {
    id: job.id,
    status: job.status ?? "queued",
  };
  for (let i = 0; i < 120; i++) {
    await sleep(2000);
    const r = await fetch(`${coordUrl}/v1/bridge/jobs/${job.id}`, {
      headers: { authorization: `Bearer ${owner}` },
    });
    final = (await r.json()) as typeof final;
    log(`job poll ${i}`, { status: final.status });
    if (
      [
        "succeeded",
        "failed",
        "canceled",
        "timed_out",
        "interrupted",
        "paused",
      ].includes(final.status)
    )
      break;
  }

  const nodesOut = mustOk(
    "nodes",
    bridge(["cluster", "nodes", "--data-dir", coordDir]),
  );
  log("nodes", parseJson("nodes", nodesOut));

  const errText = `${final.error ?? ""} ${final.result ?? ""}`;
  const quotaPaused =
    final.status === "paused" &&
    /quota_exhausted|subscription limit/i.test(errText);
  if (final.status === "succeeded") {
    log(`PASS ${worker} pool job succeeded`, {
      result: (final.result ?? "").slice(0, 200),
    });
  } else if (quotaPaused) {
    // Cluster join/auth/claim/run path worked; the subscription itself is limited.
    log(`PASS ${worker} pool cluster path (CLI quota exhausted)`, {
      status: final.status,
      error: (final.error ?? "").slice(0, 200),
    });
  } else {
    throw new Error(
      `job did not succeed: ${final.status} ${final.error ?? ""} ${final.result ?? ""}`,
    );
  }
}

async function main(): Promise<void> {
  if (!existsSync(cli)) throw new Error("Build first: npm run build");

  const both = process.argv.includes("--both");
  const workerArg = process.argv
    .find((a) => a.startsWith("--worker="))
    ?.slice(9) as "claude" | "codex" | undefined;
  const workers = Number(
    process.argv.find((a) => a.startsWith("--workers="))?.slice(10) ?? "2",
  );

  const rootDir = mkdtempSync(join(tmpdir(), "bridge-cluster-smoke-"));
  log("scratch", { rootDir, keep });

  try {
    if (both) {
      log(
        "Note: v1 allows one worker type per coordinator. Running two pools on one host (Claude + Codex).",
      );
      await runPool({
        worker: "codex",
        workers: Math.max(1, workers),
        rootDir,
      });
      await runPool({
        worker: "claude",
        workers: 1,
        rootDir,
      });
    } else {
      const worker = workerArg ?? "codex";
      await runPool({
        worker,
        workers: Math.max(1, workers),
        rootDir,
      });
    }
    log("\nALL LIVE CHECKS PASSED");
  } finally {
    cleanup();
    await sleep(500);
    if (!keep) rmSync(rootDir, { recursive: true, force: true });
    else log("kept scratch dir", { rootDir });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  cleanup();
  process.exitCode = 1;
});

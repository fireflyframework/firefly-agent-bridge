/*!
 * Copyright (c) 2026 Signature Management Consultants SLU
 * Author: @ancongui (https://github.com/ancongui)
 * Modified by Firefly Software Foundation for Firefly Agent Bridge (2026).
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.js";
import { privateWrite, startService } from "../src/service.js";
import { ClusterAuth } from "../src/cluster-auth.js";
import { QueueStore } from "../src/store.js";
import { runCli } from "../src/cli.js";

type Service = Awaited<ReturnType<typeof startService>>;

let dir: string;
let service: Service | undefined;
const savedJoin = process.env.BRIDGE_JOIN_TOKEN;

afterEach(async () => {
  if (savedJoin === undefined) delete process.env.BRIDGE_JOIN_TOKEN;
  else process.env.BRIDGE_JOIN_TOKEN = savedJoin;
  if (service) {
    await service.close();
    service = undefined;
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function captureCli(argv: string[]): Promise<{
  stdout: string;
  stderr: string;
  code: number;
}> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    stdout: {
      isTTY: false,
      write(chunk: string) {
        out.push(chunk);
        return true;
      },
    },
    stderr: {
      isTTY: false,
      write(chunk: string) {
        err.push(chunk);
        return true;
      },
    },
    env: process.env,
  });
  return { stdout: out.join(""), stderr: err.join(""), code };
}

describe("cluster CLI help and banner", () => {
  it("lists cluster commands and prefers bridge binary name", async () => {
    const { stdout, code } = await captureCli(["help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("bridge <command>");
    expect(stdout).toContain("cluster");
    expect(stdout).toContain("init-coordinator");
    expect(stdout).toContain("serve");
    expect(stdout).toContain("--cluster-coordinator");
    expect(stdout).toContain("--cluster-worker");
    expect(stdout).toContain("Quick start");
    expect(stdout).toContain("bridge daemon start --cluster-worker");
    expect(stdout).toMatch(/firefly-bridge.*alias|alias.*firefly-bridge/i);
  });

  it("colors the TTY help banner with amber ANSI", async () => {
    delete process.env.BRIDGE_NO_BANNER;
    delete process.env.NO_COLOR;
    delete process.env.CI;
    const out: string[] = [];
    const code = await runCli(["help"], {
      stdout: {
        isTTY: true,
        write(chunk: string) {
          out.push(chunk);
          return true;
        },
      },
      stderr: {
        isTTY: false,
        write() {
          return true;
        },
      },
      env: process.env,
    });
    expect(code).toBe(0);
    const stdout = out.join("");
    expect(stdout).toContain("\u001b[38;2;255;179;74m");
    expect(stdout).toContain("bridge daemon start --cluster-worker");
  });

  it("does not print banner for JSON cluster status help path when non-TTY", async () => {
    dir = mkdtempSync(join(tmpdir(), "bridge-cli-help-"));
    const { stdout, code } = await captureCli([
      "cluster",
      "status",
      "--data-dir",
      dir,
    ]);
    // status without service should fail, but stdout must stay free of ASCII art
    expect(stdout).not.toContain("Firefly Agent Bridge");
    expect(stdout).not.toContain("=====");
    expect(code).not.toBe(0);
  });
});

describe("cluster init-coordinator and join", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bridge-cli-cluster-"));
  });

  it("init-coordinator writes cluster mode into config.json", async () => {
    const configPath = join(dir, "config.json");
    privateWrite(
      configPath,
      JSON.stringify(
        parseConfig({
          dataDir: dir,
          workspace: join(dir, "jobs"),
          claudePath: process.execPath,
          port: 0,
        }),
        null,
        2,
      ) + "\n",
    );
    const { stdout, code } = await captureCli([
      "cluster",
      "init-coordinator",
      "--data-dir",
      dir,
      "--exposure",
      "private",
      "--bind",
      "127.0.0.1",
      "--port",
      "0",
      "--reserve-percent",
      "10",
    ]);
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as {
      dataDir: string;
      exposure: string;
      addressHint: string;
    };
    expect(result.dataDir).toBe(dir);
    expect(result.exposure).toBe("private");
    const config = parseConfig(JSON.parse(readFileSync(configPath, "utf8")));
    expect(config.cluster?.mode).toBe("coordinator");
    expect(config.cluster?.bindHost).toBe("127.0.0.1");
    expect(config.cluster?.reservePercent).toBe(10);
    expect(config.cluster?.requireTls).toBe(false);
  });

  it("join writes cluster.json using BRIDGE_JOIN_TOKEN when --token omitted", async () => {
    const coordDir = mkdtempSync(join(tmpdir(), "bridge-cli-coord-"));
    const workerDir = dir;
    try {
      const coordConfig = parseConfig({
        dataDir: coordDir,
        workspace: join(coordDir, "jobs"),
        claudePath: process.execPath,
        port: 0,
        cluster: {
          mode: "coordinator",
          bindHost: "127.0.0.1",
          reservePercent: 10,
        },
      });
      privateWrite(
        join(coordDir, "config.json"),
        JSON.stringify(coordConfig, null, 2) + "\n",
      );
      service = await startService(coordConfig, {
        worker: () => ({
          ready: async () => ({ ready: true }),
          run: async () => {
            throw new Error("no local jobs");
          },
        }),
      });
      const store = new QueueStore(join(coordDir, "queue.sqlite"));
      const token = new ClusterAuth(store).createJoinToken({
        createdBy: "owner",
        ttlMs: 60_000,
      }).token;
      store.close();
      process.env.BRIDGE_JOIN_TOKEN = token;

      privateWrite(
        join(workerDir, "config.json"),
        JSON.stringify(
          parseConfig({
            dataDir: workerDir,
            workspace: join(workerDir, "jobs"),
            claudePath: process.execPath,
            port: 0,
          }),
          null,
          2,
        ) + "\n",
      );

      const { stdout, code, stderr } = await captureCli([
        "cluster",
        "join",
        "--data-dir",
        workerDir,
        "--coordinator",
        service.address,
        "--name",
        "cli-worker",
        "--allow-insecure",
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      const result = JSON.parse(stdout) as {
        nodeId: string;
        coordinatorUrl: string;
      };
      expect(result.nodeId).toMatch(/^node_/);
      expect(result.coordinatorUrl).toBe(service.address);
      expect(existsSync(join(workerDir, "cluster.json"))).toBe(true);
      const clusterFile = JSON.parse(
        readFileSync(join(workerDir, "cluster.json"), "utf8"),
      ) as {
        nodeId: string;
        credential: string;
        coordinatorUrl: string;
        nodePrivateKey: string;
        allowInsecure: boolean;
      };
      expect(clusterFile.nodeId).toBe(result.nodeId);
      expect(clusterFile.credential).toMatch(/^ffn_/);
      expect(clusterFile.nodePrivateKey).toContain("PRIVATE KEY");
      expect(clusterFile.allowInsecure).toBe(true);
      const workerConfig = parseConfig(
        JSON.parse(readFileSync(join(workerDir, "config.json"), "utf8")),
      );
      expect(workerConfig.cluster?.mode).toBe("worker");
    } finally {
      rmSync(coordDir, { recursive: true, force: true });
    }
  });

  it("join-token create returns token JSON against a running coordinator", async () => {
    const config = parseConfig({
      dataDir: dir,
      workspace: join(dir, "jobs"),
      claudePath: process.execPath,
      port: 0,
      cluster: {
        mode: "coordinator",
        bindHost: "127.0.0.1",
        reservePercent: 10,
      },
    });
    privateWrite(
      join(dir, "config.json"),
      JSON.stringify(config, null, 2) + "\n",
    );
    service = await startService(config, {
      worker: () => ({
        ready: async () => ({ ready: true }),
        run: async () => {
          throw new Error("no local jobs");
        },
      }),
    });
    const { stdout, code } = await captureCli([
      "cluster",
      "join-token",
      "create",
      "--data-dir",
      dir,
      "--ttl",
      "1h",
    ]);
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as {
      token: string;
      expiresAt: string;
      id: string;
    };
    expect(result.token).toMatch(/^ffj_/);
    expect(result.id).toMatch(/^jtok_/);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
  });
});

describe("serve cluster flags", () => {
  it("rejects mismatched --cluster-worker when config is not worker", async () => {
    dir = mkdtempSync(join(tmpdir(), "bridge-cli-serve-"));
    mkdirSync(dir, { recursive: true });
    privateWrite(
      join(dir, "config.json"),
      JSON.stringify(
        parseConfig({
          dataDir: dir,
          workspace: join(dir, "jobs"),
          claudePath: process.execPath,
          port: 0,
        }),
        null,
        2,
      ) + "\n",
    );
    const { stderr, code } = await captureCli([
      "serve",
      "--cluster-worker",
      "--data-dir",
      dir,
    ]);
    expect(code).not.toBe(0);
    expect(stderr.toLowerCase()).toMatch(/cluster|worker/);
  });
});

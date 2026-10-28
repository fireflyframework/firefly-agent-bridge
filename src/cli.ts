#!/usr/bin/env node
/*!
 * Copyright (c) 2026 Signature Management Consultants SLU
 * Modified by Firefly Software Foundation for Firefly Agent Bridge (2026).
 * Author: @ancongui (https://github.com/ancongui)
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

import { releaseVersion } from "./release-version.js";
import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  defaultDataDir,
  initialize,
  ensureService,
  connect,
  request,
} from "./lifecycle.js";
import { startService } from "./service.js";
import { createAdapter } from "./mcp.js";
import {
  formatBannerHeader,
  formatWelcome,
  QUICK_START_FOOTER,
  shouldShowBanner,
} from "./cli-banner.js";
import {
  runClusterCommand,
  type CliStreams,
} from "./cluster-cli.js";

export type RunCliOptions = {
  stdout?: CliStreams["stdout"];
  stderr?: CliStreams["stderr"];
  env?: NodeJS.ProcessEnv;
};

function helpText(
  version: string,
  options: { banner?: boolean; color?: boolean } = {},
): string {
  const header = options.banner
    ? formatBannerHeader(version, { color: options.color }) + "\n\n"
    : `Firefly Agent Bridge ${version}\n`;
  return `${header}Usage: bridge <command> [--data-dir PATH]
  (firefly-bridge remains a compatibility alias; prefer bridge)

  init        Initialize local configuration (--worker codex|claude)
  serve       Run the service (--managed follows host leases)
              --cluster-coordinator | --cluster-worker
              --health-port N (worker loopback health only)
  mcp         Start the native stdio adapter (--channel enables Code notifications)
  status      Inspect the running service
  panel       Open the diagnostic dashboard
  pause       Pause dispatch and active CLI jobs
  resume      Resume dispatch; resume individual paused jobs in the panel
  stop        Stop the local service gracefully
  token       Create a scoped client token (--id NAME --profiles default --scopes read,submit,control)
  revoke      Revoke a client's tokens (--id NAME)
  cluster     Headless pool ops (JSON stdout): init-coordinator, join-token,
              join, status, nodes, drain, leave, pause, resume, verify-node
  daemon      start|status|stop — coming in a later release; use serve for now
  --version   Print the release version

${QUICK_START_FOOTER}
`;
}

function stripGlobalFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--data-dir") {
      i++;
      continue;
    }
    if (arg.startsWith("--data-dir=")) continue;
    out.push(arg);
  }
  return out;
}

export async function runCli(
  argv: string[],
  options: RunCliOptions = {},
): Promise<number> {
  const streams: CliStreams = {
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    env: options.env ?? process.env,
  };
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: false,
      options: {
        "data-dir": { type: "string" },
        worker: { type: "string" },
        managed: { type: "boolean" },
        channel: { type: "boolean" },
        id: { type: "string" },
        profiles: { type: "string" },
        scopes: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
        "cluster-coordinator": { type: "boolean" },
        "cluster-worker": { type: "boolean" },
        "health-port": { type: "string" },
        banner: { type: "boolean" },
      },
    });
    if (values.version) {
      if (values.banner && shouldShowBanner(streams.stdout, streams.env))
        streams.stdout.write(
          formatWelcome(releaseVersion, { color: true }) + "\n",
        );
      else streams.stdout.write(releaseVersion + "\n");
      return 0;
    }
    const command = positionals[0] ?? "help",
      dataDir = resolve(
        (values["data-dir"] as string | undefined) ?? defaultDataDir(),
      );
    if (command === "help" || values.help || positionals.length === 0) {
      const color = shouldShowBanner(streams.stdout, streams.env);
      const banner = color || Boolean(values.banner);
      streams.stdout.write(
        helpText(releaseVersion, { banner, color }),
      );
      return 0;
    }
    if (command === "cluster") {
      const rest = stripGlobalFlags(argv);
      const at = rest.indexOf("cluster");
      await runClusterCommand(
        dataDir,
        at >= 0 ? rest.slice(at + 1) : positionals.slice(1),
        streams,
      );
      return 0;
    }
    if (command === "daemon") {
      streams.stderr.write(
        JSON.stringify({
          error:
            "daemon start|status|stop is not implemented yet; use bridge serve --cluster-coordinator|--cluster-worker",
        }) + "\n",
      );
      return 1;
    }
    if (command === "init") {
      if (
        values.worker &&
        !["claude", "codex"].includes(values.worker as string)
      )
        throw new Error("Worker must be claude or codex");
      const config = await initialize(
        dataDir,
        ((values.worker as string) ?? "codex") as "claude" | "codex",
      );
      streams.stdout.write(
        JSON.stringify(
          { dataDir: config.dataDir, config: join(dataDir, "config.json") },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }
    if (command === "serve") {
      const asCoordinator = Boolean(values["cluster-coordinator"]);
      const asWorker = Boolean(values["cluster-worker"]);
      if (asCoordinator && asWorker)
        throw new Error(
          "Choose only one of --cluster-coordinator or --cluster-worker",
        );
      const config = await initialize(dataDir);
      if (asCoordinator && config.cluster?.mode !== "coordinator")
        throw new Error(
          "Config cluster.mode is not coordinator; run bridge cluster init-coordinator first",
        );
      if (asWorker && config.cluster?.mode !== "worker")
        throw new Error(
          "Config cluster.mode is not worker; run bridge cluster join first",
        );
      const healthRaw = values["health-port"] as string | undefined;
      const healthPort = healthRaw != null ? Number(healthRaw) : undefined;
      if (
        healthPort != null &&
        (!Number.isInteger(healthPort) || healthPort < 0 || healthPort > 65535)
      )
        throw new Error("--health-port must be an integer 0–65535");
      if (healthPort != null && config.cluster?.mode !== "worker" && !asWorker)
        throw new Error("--health-port is only valid for cluster workers");
      const service = await startService(config, {
        managed: values.managed as boolean | undefined,
        healthPort,
      });
      const role =
        config.cluster?.mode === "coordinator"
          ? "coordinator"
          : config.cluster?.mode === "worker"
            ? "worker"
            : "bridge";
      streams.stderr.write(
        `bridge ${role} listening at ${service.address}\n`,
      );
      const close = () => {
        void service.close().then(() => process.exit(0));
      };
      process.once("SIGTERM", close);
      process.once("SIGINT", close);
      return 0;
    }
    if (command === "mcp") {
      const server = createAdapter(
        await ensureService(dataDir),
        Boolean(values.channel),
      );
      await server.connect(new StdioServerTransport());
      process.stdin.once("end", () => {
        void server.close();
      });
      return 0;
    }
    const connection =
      command === "panel"
        ? await ensureService(dataDir)
        : await connect(dataDir);
    if (command === "panel") {
      streams.stdout.write(
        "Dashboard: " +
          connection.address +
          "\nOwner token file: " +
          join(dataDir, "owner.token") +
          "\n",
      );
      const opener =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "rundll32.exe"
            : "xdg-open";
      const args =
        process.platform === "win32"
          ? ["url.dll,FileProtocolHandler", connection.address]
          : [connection.address];
      const child = spawn(opener, args, { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
      return 0;
    }
    let result: unknown;
    if (command === "status")
      result = await request(connection, "/v1/bridge/status");
    else if (["pause", "resume", "stop"].includes(command))
      result = await request(connection, "/v1/bridge/admin/" + command, {});
    else if (command === "token") {
      if (!values.id) throw new Error("token requires --id NAME");
      result = await request(connection, "/v1/bridge/admin/tokens", {
        id: values.id,
        profiles: ((values.profiles as string) ?? "default").split(","),
        scopes: (
          (values.scopes as string) ?? "read,submit,control,workflows"
        ).split(","),
      });
    } else if (command === "revoke") {
      if (!values.id) throw new Error("revoke requires --id NAME");
      result = await request(connection, "/v1/bridge/admin/tokens/revoke", {
        id: values.id,
      });
    } else throw new Error("Unknown command: " + command);
    streams.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  } catch (error) {
    streams.stderr.write(
      (error instanceof Error ? error.message : "Bridge failed") + "\n",
    );
    return 1;
  }
}

// Vitest imports this module; skip auto-start under the test runner.
if (!process.env.VITEST) {
  void runCli(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}

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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { parseConfig } from "../src/config.js";
const binary = resolve(
  process.argv[2] ??
    "release/firefly-agent-bridge-" +
      JSON.parse(readFileSync("package.json", "utf8")).version +
      "-" +
      process.platform +
      "-" +
      process.arch +
      "/portable/firefly-bridge" +
      (process.platform === "win32" ? ".exe" : ""),
);
const pluginRoot = dirname(binary);
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const executable = readFileSync(binary);
for (const path of new Set([
  resolve("dist/cli.cjs"),
  resolve("dist/cli.cjs").replaceAll("\\", "/"),
]))
  if (executable.includes(Buffer.from(path)))
    throw new Error(
      "Native executable contains its private build-machine filename",
    );
const archive = join(
  "release",
  `firefly-agent-bridge-${version}-${process.platform}-${process.arch}.tar.gz`,
).replaceAll("\\", "/");
const members = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
if (
  members
    .split("\n")
    .some((name) => name.split("/").some((part) => part.startsWith("._")))
)
  throw new Error("Native archive contains macOS filesystem metadata");
const plugin = JSON.parse(
  readFileSync(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"),
);
const mcp = JSON.parse(readFileSync(join(pluginRoot, ".mcp.json"), "utf8"));
const server = mcp.mcpServers["firefly-agent-bridge"];
if (
  plugin.interface.displayName !== "Firefly Agent Bridge" ||
  plugin.version !== version ||
  resolve(server.command.replace("${PLUGIN_ROOT}", pluginRoot)) !== binary ||
  !readFileSync(join(pluginRoot, "skills/bridge/SKILL.md"), "utf8").includes(
    "bridge_status",
  )
)
  throw new Error("Packaged Codex manifest/MCP/skill contract failed");
const directory = mkdtempSync(join(tmpdir(), "bridge-native-"));
const config = parseConfig({
  dataDir: directory,
  workspace: join(directory, "jobs"),
  claudePath: process.execPath,
  port: 0,
});
writeFileSync(join(directory, "config.json"), JSON.stringify(config), {
  mode: 0o600,
});
const clients: Client[] = [];
let address = "",
  token = "";
let daemonPid: number | undefined;
try {
  for (let i = 0; i < 2; i++) {
    const client = new Client({ name: "package-smoke-" + i, version: "1" });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: server.command.replace("${PLUGIN_ROOT}", pluginRoot),
        args: [...server.args, "--data-dir", directory],
        cwd: directory,
        stderr: "pipe",
      }),
    );
    if (client.getServerVersion()?.version !== version)
      throw new Error("Packaged MCP release version mismatch");
    const tools = await client.listTools();
    if (!tools.tools.some((t) => t.name === "bridge_template_save"))
      throw new Error("Packaged MCP tools are missing");
    const status = await client.callTool({
      name: "bridge_status",
      arguments: {},
    });
    if (status.isError) throw new Error("Packaged MCP status failed");
    const current = JSON.parse(
      readFileSync(join(directory, "service.json"), "utf8"),
    );
    if (address && current.address !== address)
      throw new Error("Adapters started duplicate services");
    address = current.address;
    daemonPid = current.pid;
    token = readFileSync(join(directory, "owner.token"), "utf8").trim();
  }
  const status = await fetch(address + "/v1/bridge/status", {
    headers: { Authorization: "Bearer " + token },
  });
  const payload = (await status.json()) as {
    protocolVersion: number;
    version: string;
    access: { owner: boolean; scopes: string[] };
  };
  if (
    !status.ok ||
    payload.protocolVersion !== 2 ||
    payload.version !== version ||
    !payload.access.owner ||
    !payload.access.scopes.includes("submit")
  )
    throw new Error("Packaged API failed");
  const remote = new Client({ name: "package-http-smoke", version: "1" });
  clients.push(remote);
  await remote.connect(
    new StreamableHTTPClientTransport(new URL(address + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + token } },
    }),
  );
  if (remote.getServerVersion()?.version !== version)
    throw new Error("Packaged HTTP MCP release version mismatch");
  const remoteTools = await remote.listTools();
  if (
    !remoteTools.tools.some((tool) => tool.name === "bridge_submit") ||
    remoteTools.tools.some((tool) => tool.name === "bridge_channel_claim")
  )
    throw new Error("Packaged HTTP MCP capability contract failed");
  const models = await fetch(address + "/v1/models", {
    headers: { Authorization: "Bearer " + token },
  });
  if (
    !models.ok ||
    !((await models.json()) as { data: { id: string }[] }).data.some(
      (m) => m.id === "bridge/default",
    )
  )
    throw new Error("Packaged model discovery failed");
  const page = await (await fetch(address)).text();
  if (
    !page.includes("Firefly Agent Bridge") ||
    !page.includes("template-dialog") ||
    !page.includes("export-audit")
  )
    throw new Error("Embedded console is missing");
  for (const path of [
    "/theme.js",
    "/setup.js",
    "/brand-dark.svg",
    "/brand-light.svg",
    "/bridge-mark-light.svg",
    "/fonts/manrope.woff2",
  ])
    if (!(await fetch(address + path)).ok)
      throw new Error("Native embedded asset missing: " + path);
  for (const theme of ["dark", "light"]) {
    const response = await fetch(address + `/brand-${theme}.svg`);
    const expected = readFileSync(
      `assets/brand/bridge-lockup-small-${theme}.svg`,
      "utf8",
    );
    if (!response.ok || (await response.text()) !== expected)
      throw new Error(
        "Native navigation artwork differs from its source: " + theme,
      );
  }
  for (const [path, marker] of [
    ["/navigation.js", "createMobileNavigation"],
    ["/job-wizard.js", "createJobWizard"],
    ["/image-input.js", "createImageInput"],
    ["/bridge-emblem-dark.svg", "<svg"],
    ["/bridge-emblem-light.svg", "<svg"],
  ]) {
    const response = await fetch(address + path);
    if (!response.ok || !(await response.text()).includes(marker!))
      throw new Error("Native console module missing: " + path);
  }
  const auditModule = await fetch(address + "/audit.js");
  if (
    !auditModule.ok ||
    !(await auditModule.text()).includes("Shared message result")
  )
    throw new Error("Embedded audit inspector is missing");
  if ((await fetch(address + "/v1/bridge/jobs")).status !== 401)
    throw new Error("Packaged API lost authentication");
  console.log(
    "Native package: two stdio hosts and HTTP MCP share one authenticated service; release versions, capabilities, embedded console and template tools passed.",
  );
} finally {
  if (address && token)
    await fetch(address + "/v1/bridge/admin/stop", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: "{}",
    }).catch(() => {});
  await Promise.allSettled(clients.map((c) => c.close()));
  // Windows retains a process's current directory until the daemon actually exits.
  // An HTTP listener disappearing alone does not mean its process has finished.
  if (daemonPid)
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(daemonPid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
        throw error;
      }
      if (i === 99)
        throw new Error("Native daemon did not exit after shutdown");
      await new Promise((r) => setTimeout(r, 100));
    }
  // The shutdown endpoint replies before it closes SQLite and releases its lock.
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(address + "/v1/bridge/status", {
        signal: AbortSignal.timeout(200),
      });
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      break;
    }
  }
  rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}

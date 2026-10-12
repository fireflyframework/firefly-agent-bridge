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

import { it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Tokens } from "../src/auth.js";
import { createAdapter } from "../src/mcp.js";
import { startService } from "../src/service.js";
import { parseConfig } from "../src/config.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
it("negotiates native MCP, exposes channel capabilities, and routes tools to the shared service", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-mcp-"));
  const service = await startService(
    parseConfig({
      dataDir: dir,
      workspace: join(dir, "jobs"),
      claudePath: process.execPath,
      port: 0,
    }),
    {
      worker: () => ({
        ready: async () => ({ ready: true }),
        run: async () => ({ status: "succeeded", result: "done" }),
      }),
    },
  );
  const server = createAdapter(
      { address: service.address, token: service.ownerToken },
      true,
    ),
    client = new Client({ name: "test-host", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(left);
    await client.connect(right);
    expect(client.getServerCapabilities()?.experimental).toHaveProperty(
      "claude/channel",
    );
    const tools = await client.listTools();
    expect(
      tools.tools.find((t) => t.name === "bridge_submit")!.description,
    ).not.toContain("bypass permissions");
    expect(tools.tools.some((t) => t.name === "bridge_channel_claim")).toBe(
      true,
    );
    const result = await client.callTool({
      name: "bridge_submit",
      arguments: { prompt: "hello" },
    });
    expect(result.isError).not.toBe(true);
    const content = result.content as { text: string }[];
    const job = JSON.parse(content[0]!.text);
    await expect.poll(() => service.store.get(job.id).status).toBe("succeeded");
  } finally {
    await client.close();
    await server.close();
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("authenticates Streamable HTTP MCP and preserves the caller's resource and operation scopes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-remote-mcp-"));
  const service = await startService(
    parseConfig({
      dataDir: dir,
      workspace: join(dir, "jobs"),
      claudePath: process.execPath,
      port: 0,
    }),
    {
      worker: () => ({
        ready: async () => ({ ready: true }),
        run: async () => ({ status: "succeeded", result: "done" }),
      }),
    },
  );
  const tokens = new Tokens(service.store);
  const bearer = tokens.create({
    id: "remote-reader",
    owner: false,
    profiles: ["default"],
    scopes: ["read"],
  }).token;
  const client = new Client({ name: "remote-review", version: "1" });
  try {
    expect(
      (
        await fetch(service.address + "/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    const transport = new StreamableHTTPClientTransport(
      new URL(service.address + "/mcp"),
      { requestInit: { headers: { Authorization: "Bearer " + bearer } } },
    );
    await client.connect(transport);
    const remoteTools = await client.listTools();
    expect(
      remoteTools.tools.some((tool) => tool.name === "bridge_submit"),
    ).toBe(true);
    expect(
      remoteTools.tools.some((tool) => tool.name === "bridge_channel_claim"),
    ).toBe(false);
    const status = await client.callTool({
      name: "bridge_status",
      arguments: {},
    });
    expect(status.isError).not.toBe(true);
    expect(
      JSON.parse((status.content as { text: string }[])[0]!.text),
    ).not.toHaveProperty("configuration");
    expect(
      (
        await client.callTool({
          name: "bridge_submit",
          arguments: { prompt: "forbidden edit" },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: "bridge_scheduler",
          arguments: { action: "pause" },
        })
      ).isError,
    ).toBe(true);
    const hidden = service.store.submit(
      { prompt: "other principal" },
      { id: "other", owner: false, profiles: ["default"] },
    );
    expect(
      (
        await client.callTool({
          name: "bridge_job",
          arguments: { id: hidden.id },
        })
      ).isError,
    ).toBe(true);
    tokens.revoke("remote-reader");
    await expect(
      client.callTool({ name: "bridge_status", arguments: {} }),
    ).rejects.toThrow();
    expect(service.store.list().length).toBe(1);
  } finally {
    await client.close();
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("preserves approved browser origin headers on raw MCP responses and permits the protocol version preflight", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-mcp-origin-")),
    origin = "https://mcp-client.example";
  const service = await startService(
    parseConfig({
      dataDir: directory,
      workspace: join(directory, "jobs"),
      claudePath: process.execPath,
      port: 0,
      allowedOrigins: [origin],
    }),
    {
      worker: () => ({
        ready: async () => ({ ready: true }),
        run: async () => ({ status: "succeeded", result: "done" }),
      }),
    },
  );
  try {
    const preflight = await fetch(service.address + "/mcp", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "authorization,content-type,mcp-protocol-version",
      },
    });
    expect(preflight.status).toBe(204);
    expect(
      preflight.headers.get("Access-Control-Allow-Headers")?.toLowerCase(),
    ).toContain("mcp-protocol-version");
    const response = await fetch(service.address + "/mcp", {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: "Bearer " + service.ownerToken,
        Accept: "application/json,text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "browser-proof", version: "1" },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Vary")).toBe("Origin");
    expect((await response.json()).result.serverInfo.version).toBe(
      JSON.parse(readFileSync("package.json", "utf8")).version,
    );
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

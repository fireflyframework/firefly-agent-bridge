---
description: Connect supported applications, Codex and Claude hosts through bridge plugins, MCP tools and scoped local API access.
---

<!-- Copyright (c) 2026 Signature Management Consultants SLU; Author: @ancongui. Modified by Firefly Software Foundation for Firefly Agent Bridge (2026). SPDX-License-Identifier: Apache-2.0. -->

# Connect hosts and applications

The native executable has a stdio MCP adapter. Its management tools submit work to the same local service used by the console and HTTP clients. Each adapter starts or discovers the service, verifies its identity, and renews a host lease.

## Claude Desktop

Download the `.mcpb` for your platform from the repository's release page. Verify its checksum, open Claude Desktop's extension settings, and install the bundle. The package includes the native server and local artwork; it does not need a separate Node installation.

Approve the integration according to the host's policy, then restart or reload the extension. Ask the host to call `bridge_status` and `bridge_panel`. The panel response includes the local console URL and authentication instructions. Run the CLI's panel command to locate the token file; neither command displays the token.

An extension can manage a Codex-backed bridge. Its host identity does not choose the worker: saved bridge configuration does. See [provider configuration](configuration.md).

## Claude Code plugin

From a local source checkout:

```sh
claude plugin marketplace add /absolute/path/to/firefly-agent-bridge
claude plugin install firefly-agent-bridge@fireflyframework
```

The marketplace entry points at `integrations/claude-code`. Its bootstrap downloads the pinned native release, verifies the archive checksum, and caches the executable.

The plugin includes [operation and workflow skills](subagents.md#host-skills). Its MCP adapter handles durable jobs, workflow administration, diagnostics, and host claims. Installing a skill does not give a worker extra tools or change the profile's permissions.

For a local development session you can also load the integration directly:

```sh
claude --plugin-dir /absolute/path/to/firefly-agent-bridge/integrations/claude-code
```

## Codex plugin and stdio MCP

The native archive includes a Codex plugin manifest, operation skill, MCP configuration, and local artwork beside the executable. Register it in a trusted local marketplace and install it through your supported Codex surface. The manifest uses the documented compatibility layout. See [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins) and [local marketplaces](https://learn.chatgpt.com/docs/changelog).

Register the extracted native archive as a local marketplace, then install its plugin. The following identifier matches the 0.2.10 package metadata:

```sh
codex plugin marketplace add /absolute/path/to/firefly-bridge-local
codex plugin add firefly-agent-bridge@fireflyframework
```

The archive includes `.agents/plugins/marketplace.json` with a local source at the archive root. Installation keeps its bundled executable, skills, and artwork together. Review and enable the integration through your host's policy before running work. Do not point this marketplace at the source template under `integrations/codex`; use the complete built native archive.

The 0.2.7 archive retains `firefly-agent-bridge@firefly-internal`. Source templates can change before a new native release is published. Use the marketplace name shipped in the downloaded archive; replacing its metadata with files from a newer source checkout does not update its executable or qualify that combination.

For a direct stdio connection, register the installed executable using the official Codex CLI:

```sh
codex mcp add firefly-agent-bridge -- /absolute/path/to/firefly-bridge mcp
```

For a source checkout:

```sh
codex mcp add firefly-agent-bridge -- node /absolute/path/to/firefly-agent-bridge/dist/cli.cjs mcp
```

Use `--data-dir /absolute/path/to/state` after `mcp` for a custom bridge instance. The adapter uses stdio. Applications can also use authenticated Streamable HTTP MCP at `/mcp`; see [ChatGPT remote MCP](#chatgpt-remote-mcp) for gateway and host requirements.

A host can submit native agent jobs or manage workflow steps. Host conversation mode is an explicit claim/acknowledgment protocol: a host claims one job, sends progress, then completes or acknowledges a stop. A notification alone does not claim work. See [CLI and MCP reference](reference.md).

## ChatGPT remote MCP

The bridge implements authenticated Streamable HTTP MCP at `/mcp`, using the shared job/workflow tools and token scopes. It requires `read` to establish the connection. Tool calls retain the caller's principal; a scoped token does not become an owner token.

ChatGPT remote connectors need an HTTPS MCP endpoint reachable from that service. The local stdio archive and `http://127.0.0.1` address cannot provide that remote connection. Your organization must publish a private access-controlled gateway with supported authentication, then connect its HTTPS `/mcp` URL through the host's custom MCP setup. See [OpenAI MCP setup](https://developers.openai.com/plugins/build/app-quickstart).

Where the host cannot send a fixed bridge bearer token, use an organization-owned OAuth gateway that maps each authenticated user to a scoped bridge principal and sends the bridge token upstream. The bridge does not implement OAuth discovery or authorization endpoints. Do not configure an unauthenticated connector or expose an owner token to a remote host. Follow [remote access and proxy requirements](tunnels.md).

The local SDK handshake and scoped tool authorization are testable without exposing the service. Account eligibility, gateway OAuth, and the final ChatGPT connection require the organization's actual host setup; native stdio verification does not establish those remote acceptance steps.

## firefly forge and SDKs

Give each trusted application its own [scoped token](tokens.md). For firefly forge:

```sh
export FORGE_BRIDGE_URL=http://127.0.0.1:8766
# Load FORGE_BRIDGE_TOKEN from your private application configuration.
```

forge can use its own supported providers independently of the bridge. When the bridge provider is selected, it uses `bridge/default` or another configured profile through Chat Completions. FireflyAgent executes the declared factory tools in the application's workspace; the bridge's inference worker returns function requests and validated answers. Those functions run in the caller process.

An OpenAI SDK uses `base_url=BRIDGE_URL + "/v1"` and the bridge token as `api_key`. It needs no OpenAI API key. See [SDK examples and supported fields](openai-compatible.md).

A hosted forge instance needs the reachable gateway URL, not its server's loopback address. The bridge does not automatically connect to a developer host. Each bridge process uses one configured worker; profiles can choose different native models supported by that worker, not switch between providers per task. Model discovery reports those aliases and image verification, not an account-wide provider model catalog.

Keep the bridge port distinct from your application's port. forge defaults to 8787; the bridge defaults to 8766. A saved bridge configuration may choose another free loopback port.

## Verify and disconnect

Check selected-worker readiness through `bridge_status`, then submit a small job. Inspect its terminal result and reported tools. Check a real function exchange separately if your application uses functions; native execution and caller functions have different ownership.

Close the stdio host or disable its integration to release its lease. Use `firefly-bridge stop` to stop the service deliberately. A managed service exits after its idle timeout once hosts and active work no longer need it; plain `serve` remains available until stopped.

Stateless remote MCP does not expose lease-bound `bridge_channel_*` tools. Host-conversation claims and acknowledgments remain on the local stdio adapter; a remote caller can still submit work for that local host to claim.

---
description: Install the native Firefly Agent Bridge package, configure an official coding CLI and start a scoped local development service.
---

<!-- Copyright (c) 2026 Signature Management Consultants SLU; Author: @ancongui. Modified by Firefly Software Foundation for Firefly Agent Bridge (2026). SPDX-License-Identifier: Apache-2.0. -->

# Install Firefly Agent Bridge

!!! warning "For local development and testing"

    Firefly Agent Bridge is intended for local development and testing. It uses your signed-in coding CLI subscription rather than a separately billed model API; subscription quotas still apply. We advise against using it for production workloads: provider license and usage restrictions, local security boundaries, and performance limits may make it unsuitable. Check the terms of your plan and provider before connecting an application. See [OpenAI's terms](https://openai.com/policies/terms-of-use/) and [Anthropic's consumer terms](https://www.anthropic.com/legal/consumer-terms).

Get the source or native packages from the [Firefly Agent Bridge repository](https://github.com/fireflyframework/firefly-agent-bridge). The software is licensed under Apache-2.0. You need an official Codex or Claude Code subscription login on the machine that runs the service, plus a separate bridge token for local access.

## Choose an installation

| Installation      | Use it for                                                               | Prerequisites                                                |
| ----------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Native archive    | A local service or stdio MCP server without a separate Node installation | HTTPS download; official coding-agent CLI                    |
| Desktop extension | Claude Desktop management tools                                          | Matching macOS or Windows `.mcpb`; Desktop extension consent |
| Source            | Development, debugging, or custom packaging                              | Node.js 24+, npm, Git, official coding-agent CLI             |

Native release targets are macOS arm64, Linux x64, and Windows x64. Download an archive for your machine's architecture. Desktop extensions are built for macOS and Windows.

## Sign in to the provider

For ChatGPT subscription access through official Codex:

```sh
codex login
codex login status
```

For official Claude subscription access:

```sh
claude auth login
claude auth status
```

The bridge uses that CLI's existing login. Do not copy its credentials into the bridge. API-key and third-party provider environment overrides fail the subscription readiness check. Your provider's account policy and model access still apply.

## Install a native archive

Download the platform archive and its checksum list over HTTPS. These examples select version 0.2.23; confirm it is available on the [release page](https://github.com/fireflyframework/firefly-agent-bridge/releases) before downloading:

```sh
curl --fail --location --remote-name \
  https://github.com/fireflyframework/firefly-agent-bridge/releases/download/v0.2.23/firefly-agent-bridge-0.2.23-darwin-arm64.tar.gz
curl --fail --location --remote-name \
  https://github.com/fireflyframework/firefly-agent-bridge/releases/download/v0.2.23/SHA256SUMS
shasum -a 256 firefly-agent-bridge-0.2.23-darwin-arm64.tar.gz
```

Compare the digest with that archive's entry in `SHA256SUMS` before extracting. On Linux, choose the `linux-x64` archive and use `sha256sum`. On Windows, choose `win32-x64` and use PowerShell:

```powershell
Get-FileHash .\firefly-agent-bridge-0.2.23-win32-x64.tar.gz -Algorithm SHA256
```

Extract the complete archive into a new directory. Keep all included license and runtime files together. For macOS or Linux:

```sh
mkdir firefly-bridge-local
tar -xzf firefly-agent-bridge-0.2.23-darwin-arm64.tar.gz -C firefly-bridge-local
cd firefly-bridge-local
./bridge init --worker codex
./bridge serve
```

On Windows, run the matching executable:

```powershell
New-Item -ItemType Directory firefly-bridge-local
tar -xzf .\firefly-agent-bridge-0.2.23-win32-x64.tar.gz -C firefly-bridge-local
Set-Location firefly-bridge-local
.\bridge.exe init --worker codex
.\bridge.exe serve
```

Use `init --worker claude` to select Claude before first startup. If configuration already exists, initialization preserves it; change the saved `worker` and executable path using the [configuration procedure](configuration.md).

If macOS or Windows prompts for installation approval, follow your organization's normal verification and host consent process. Desktop extensions do not bypass that process.

## Install from source

```sh
git clone https://github.com/fireflyframework/firefly-agent-bridge.git
cd firefly-agent-bridge
npm ci
npm run build
node dist/cli.cjs init --worker codex
node dist/cli.cjs serve
```

The source entry point and the native `bridge` executable (`firefly-bridge` remains a compatibility alias) expose the same commands. A terminal running `serve` keeps the service available; MCP adapters can also start a managed service when they connect.

## Optional: company pool (cluster mode)

Single-node `bridge serve` is enough for one developer machine. To share several Claude or Codex logins behind one URL, initialize a **coordinator** and join **workers** of either CLI type into the same pool; jobs dispatch by capacity. On the coordinator host, use a separate worker data-dir (`bridge cluster init-local-worker`). Walkthrough with real CLI JSON: [Cluster quota pool](cluster.md).

```sh
bridge init --worker codex --data-dir /var/lib/bridge-coordinator
bridge cluster init-coordinator --data-dir /var/lib/bridge-coordinator \
  --exposure private --bind 127.0.0.1 --port 8787 --reserve-percent 10
bridge serve --cluster-coordinator --data-dir /var/lib/bridge-coordinator
```

## Optional diagnostic console

CLI, HTTP API, MCP, and `bridge cluster` cover day-to-day ops. The browser console is optional diagnostics: open [http://127.0.0.1:8766](http://127.0.0.1:8766), or run `bridge panel` to locate the address and owner token file. Paste the local owner token into the console. The console clears the input after connection and retains the token only in tab memory. For API-only listeners set `"serveUi": false` in `config.json` or pass `bridge serve --no-ui`.

| Platform | Default data directory                                    |
| -------- | --------------------------------------------------------- |
| macOS    | `~/Library/Application Support/Firefly Agent Bridge/`     |
| Windows  | `%LOCALAPPDATA%\Firefly Agent Bridge\`                    |
| Linux    | `${XDG_STATE_HOME:-~/.local/state}/Firefly Agent Bridge/` |

The default job workspace is the data directory's `jobs` folder. A custom instance needs the same `--data-dir` on every CLI invocation. `init` creates configuration; the first successful service start creates `owner.token`.

Open Providers & setup and confirm the selected worker, subscription readiness, profile model, and permission mode. Create a job that writes a disposable file in its own job directory, then inspect its result and audit. A successful setup check alone does not verify a particular coding task.

Create a scoped application token under Diagnostics before connecting an SDK or firefly forge. Follow [host integrations](integrations.md), [tokens](tokens.md), or [troubleshooting](troubleshooting.md) for the next step.

<!-- Copyright (c) 2026 Signature Management Consultants SLU; Author: @ancongui. Modified by Firefly Software Foundation for Firefly Agent Bridge (2026). SPDX-License-Identifier: Apache-2.0. -->

# Install Firefly Agent Bridge

Private developer infrastructure. The GitHub repository and all release assets require access to `fireflyframework/firefly-agent-bridge`.

## Source installation

Install Node.js 24 or later and the official coding-agent CLI. Sign in using `codex login` for ChatGPT subscription access or `claude auth login` for Claude subscription access. Check `codex login status` or `claude auth status`; no credentials need to be copied into this service.

```sh
gh auth login
gh repo clone fireflyframework/firefly-agent-bridge
cd firefly-agent-bridge
npm ci
npm run build
node dist/cli.cjs init --worker codex
node dist/cli.cjs serve
```

Use `init --worker claude` before first startup for Claude Code 2.1.260+. The saved configuration chooses the worker after initialization. Read [configuration](configuration.md) before changing an existing service. API-key or third-party provider environment overrides fail the subscription preflight.

## Native internal release

Use authenticated GitHub CLI to download the platform archive and `SHA256SUMS` from the private repository. Verify the matching checksum, unpack the archive intact and run `firefly-bridge init --worker codex`, then `firefly-bridge serve`. The portable package includes the runtime.

Claude Desktop users may install their internal platform `.mcpb` in Extensions. Claude Code developers may install the private repository's marketplace or use the local integration directory. The native bootstrap requires `gh` with access to the private release. Host consent and organizational policies stay with that host.

## Verify the connection

Open [http://127.0.0.1:8766](http://127.0.0.1:8766). Use `owner.token` from the selected data directory. `GET /v1/bridge/status` reports protocol version 2, selected `worker`, `execution: local-codex` or `local-claude-code`, default profile permissions, and readiness.

On macOS state lives in `~/Library/Application Support/Firefly Agent Bridge/`. Windows uses `%LOCALAPPDATA%\Firefly Agent Bridge\`; Linux uses `${XDG_STATE_HOME:-~/.local/state}/Firefly Agent Bridge/`. The default job workspace is its `jobs` directory. Specify `--data-dir` on every CLI invocation when using a custom directory.

Create a scoped application token in Diagnostics. Set Firefly Forge's `FORGE_BRIDGE_URL` and `FORGE_BRIDGE_TOKEN` using that token; do not share the owner token across application callers.

[Tokens](tokens.md) · [Troubleshooting and recovery](operations.md) · [Compatibility](compatibility.md)

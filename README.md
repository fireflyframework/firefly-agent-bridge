<!-- Copyright (c) 2026 Signature Management Consultants SLU; Author: @ancongui. Modified by Firefly Software Foundation for Firefly Agent Bridge (2026). SPDX-License-Identifier: Apache-2.0. -->

<p align="center"><img src="assets/banner.png" width="920" alt="Firefly Agent Bridge"></p>

# Firefly Agent Bridge

**Private infrastructure for Firefly developers.** One local execution service connects Firefly Forge, application SDKs and coding-agent hosts to the developer's own official Codex or Claude Code subscription.

The bridge owns durable admission, jobs, attempts, pause/resume, workflow checkpoints and audit. The official coding agent owns its login, model access, native transcript and context. Credentials stay with that official client.

![Developer console](assets/screenshots/dashboard-desktop.png)

## Run locally

Install and sign in to the official agent you intend to use:

```sh
codex login
codex login status
# Alternatively: claude auth login && claude auth status
npm ci
npm run build
node dist/cli.cjs init --worker codex
node dist/cli.cjs serve
```

The published executable is `firefly-bridge`; source commands above run the same CLI. `init --worker claude` selects Claude Code instead. The default data directory is `~/Library/Application Support/Firefly Agent Bridge/` on macOS, the matching Local AppData directory on Windows, and XDG state on Linux. Protect `owner.token` and `queue.sqlite` there.

Open [the local console](http://127.0.0.1:8766), then enter the owner token. For application callers create a token scoped to their profiles and operations. Never put a bearer token in a URL.

## Connect Firefly Forge

Set `FORGE_BRIDGE_URL` to the local service URL and `FORGE_BRIDGE_TOKEN` to a scoped token. Firefly Forge uses `bridge/default` through the OpenAI-compatible Chat Completions API. Its FireflyAgent executes the declared application tools inside the selected factory workspace.

The bridge also accepts native agent work:

```json
{
  "model": "bridge/default",
  "messages": [{ "role": "user", "content": "Write a release checklist" }],
  "bridge": { "execution": "agent", "background": true }
}
```

Send this to `POST /v1/chat/completions` with a bearer header and an idempotency key. The 202 response is a durable job. Poll `GET /v1/bridge/jobs/{id}/result` or subscribe to `GET /v1/bridge/events`. Native jobs use their own directories under the configured workspace; HTTP callers cannot select arbitrary executables, environments or working directories.

## Execution profiles

Configuration chooses `worker: "codex"` plus an absolute `codexPath`, or `worker: "claude"` plus an absolute `claudePath`. Profiles set model, tools, timeout, output bounds and permission mode. `/v1/bridge/status` and `/v1/models` expose the selected worker and actual configured model.

Default Codex jobs use `workspace-write` sandboxing and never request interactive approval. Default Claude jobs use `acceptEdits` with noninteractive permission prompts denied. An owner may explicitly choose `permissionMode: "bypass"` for a trusted execution host. CLI credentials and OS permissions remain local developer responsibilities.

Codex inference disables native command, patch, browser, app and agent tools, uses a read-only sandbox and validates a structured completion envelope. Any observed native action makes the inference fail. Claude inference grants no native tools. Both expose client function calls for FireflyAgent, OpenAI SDK and Pydantic AI.

Claude profile-defined subagents remain available with `Agent`; Codex does not translate those Claude definitions. Bridge workflows provide durable sequential stages with either worker. Subscription rejection pauses dispatch without switching billing or guessing reset times.

## Documentation

[Installation](docs/installation.md) · [Configuration](docs/configuration.md) · [Architecture](docs/architecture.md) · [API](docs/api.md) · [SDKs](docs/openai-compatible.md) · [Console](docs/dashboard.md) · [Workflows](docs/workflows.md) · [Audit](docs/audit.md) · [Operations](docs/operations.md) · [Verification](docs/verification.md)

## Development and internal packaging

Node.js 24+ runs the source; official Node.js 26.3.0 builds native packages. `npm run check` runs types, lint, formatting, the full test suite, Python SDK interoperability, browser interaction, build, documentation/contracts, native packaging and packaged MCP smoke tests. Desktop manifests use the official MCPB 0.3 JSON Schema; the internal builder emits unsigned deterministic ZIP bundles. `npm run test:live:codex` consumes the signed-in developer's subscription and records private local evidence.

The repository and release assets remain private under `fireflyframework/firefly-agent-bridge`. Native plugin bootstrap uses authenticated GitHub CLI downloads. Public Firefly Forge distributions include only the HTTP client integration, never this bridge's source or assets.

Software is Apache-2.0; required attribution is retained in source notices and [NOTICE](NOTICE). [Brand ownership](assets/BRAND-NOTICE.md) is separate. Firefly Agent Bridge is independently operated; provider access follows the official client's capabilities and account permissions.

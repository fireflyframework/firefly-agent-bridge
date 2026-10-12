<!-- Copyright (c) 2026 Signature Management Consultants SLU; Author: @ancongui. Modified by Firefly Software Foundation for Firefly Agent Bridge (2026). SPDX-License-Identifier: Apache-2.0. -->

# Configure Firefly Agent Bridge

The private service reads `config.json` from its data directory. Stop the service before editing its owner-managed configuration. All data/workspace/executable paths must be absolute. The service listens on loopback; remote developer access requires an explicitly configured tunnel and host/origin allowlists.

```json
{
  "dataDir": "/absolute/firefly-bridge-state",
  "workspace": "/absolute/firefly-bridge-jobs",
  "worker": "codex",
  "codexPath": "/absolute/path/to/codex",
  "host": "127.0.0.1",
  "port": 8766,
  "concurrency": 1,
  "profiles": {
    "default": {
      "permissionMode": "default",
      "timeoutMs": 300000,
      "maxOutputBytes": 2000000,
      "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
    }
  }
}
```

Choose `worker: "claude"` with `claudePath` for official Claude Code instead. The selected worker's executable path is mandatory. Profiles may choose a native `model`; when omitted the official CLI chooses its default. API model aliases are `bridge/<profile>`; discovery reports the configured native model and selected worker.

`permissionMode: "default"` preserves Codex workspace-write sandboxing and uses Claude acceptEdits with unapproved interactive prompts denied. `bypass` explicitly enables Codex danger-full-access or Claude bypassPermissions and must only be used on a trusted host. Neither a queue directory nor a tool profile is an operating-system isolation boundary for bypass mode.

Claude `tools`, `agents`, `maxTurns` and `maxSubagents` map to its native controls. Codex CLI does not expose the same tool allowlist or Claude-defined agent profiles; the native Codex adapter uses its sandbox, timeout and output limit. Inference disables native command/patch/browser/app/agent features and uses read-only sandboxing. Use FireflyAgent client functions when exact application tool authority is required.

Other bounds: concurrency 1–8; queueCapacity 1–10000; profile timeout 100–3600000 milliseconds; output 1000–16000000 bytes; workflow 1–32 sequential steps. `openai.timeoutMs` bounds a waiting Chat Completions request; `openai.maxConnections` bounds its concurrent waiters. `allowedHosts` and `allowedOrigins` restrict HTTP host and browser origin; authorization is still required.

[API](api.md) · [Workflow templates](workflows.md) · [Tunnels](tunnels.md)

---
description: Run a headless company pool of Claude or Codex subscription workers behind one coordinator with fair-share quotas and a safety reserve.
---

<!-- Copyright (c) 2026 Signature Management Consultants SLU; Author: @ancongui. Modified by Firefly Software Foundation for Firefly Agent Bridge (2026). SPDX-License-Identifier: Apache-2.0. -->

# Cluster quota pool

!!! warning "Subscriptions and terms"

    Each worker uses its own signed-in coding CLI subscription. Pooling does not create extra provider capacity beyond those subscriptions. Confirm your plan and company policy before joining company machines to a shared coordinator. The diagnostic dashboard is optional and never required for cluster operations.

Cluster mode turns many headless bridge **workers** (each with one Claude Code or Codex login) into one logical bridge behind a **coordinator**. Clients keep using the same HTTP, MCP, and OpenAI-compatible APIs. The coordinator fair-shares new work, keeps a configurable **reserve** of each node’s estimated quota unused (default 10%), and sticks native sessions to the node that created them.

The coordinator is intended to run on an **internet-reachable host** (or private network). Workers call the coordinator over **HTTPS** (usually TLS at a reverse proxy) and stay headless with **`bridge serve --cluster-*`** — no UI required. See [Architecture — Cluster mode](architecture.md#cluster-mode-optional) for how this fits the single-node model; [Service lifecycle](operations.md) covers graceful stop and backups for any data directory.

!!! note "Supported run path today"

    **`bridge serve --cluster-coordinator`** and **`bridge serve --cluster-worker`** are the supported way to run pool processes. **`bridge daemon start|status|stop`**, **listener TLS certificate CLI flags**, and **Ed25519-signed** worker heartbeats/claims are part of the intended internet-hardening model but are **not fully available yet** — workers enroll with a node **credential** today. Use **`serve`** under systemd, Docker, or a process supervisor until daemon support ships.

## Headless first

| You need | Use |
|----------|-----|
| Run coordinator / worker | `bridge serve --cluster-coordinator` / `--cluster-worker` (foreground or under a supervisor) |
| Join, drain, leave, tokens, status, verify | `bridge cluster …` (JSON on stdout) |
| Automate / CI | Same CLI + HTTP; set tokens via flags or env |
| Watch capacity | `cluster status` or `GET /v1/bridge/status` → `cluster` |
| Browser dashboard | Optional only; **not** part of the worker contract |

The CLI binary is **`bridge`** (`firefly-bridge` remains a compatibility alias). `bridge` / `bridge help` shows a short ASCII span banner on a TTY; JSON commands never print it.

Workers do not serve the public client API. They only talk **out** to the coordinator. No display, no `panel`, no UI assets required on agent hosts.

## Topology

- **One worker type per coordinator** — set by coordinator `config.worker` (`claude` or `codex`). Other worker kinds are rejected at join.
- **Coordinator** — durable SQLite queue, public API, router, registry, telemetry.
- **Workers** — local official CLI, pull claims, execute, forward events; local workspace per `jobId`.

Native `sessionId` values stay on the worker that created them. Follow-ups stick to that node. `retry` clears the session and sticky binding so fair-share can pick again.

## Bootstrap (internet coordinator)

`cluster init-coordinator --exposure internet` sets **`requireTls: true`** in configuration so operators treat the public URL as HTTPS. Terminate TLS at a reverse proxy (or use `--exposure private` on a trusted network) — **built-in `--tls-cert` / `--tls-key` on the bridge listener are not available yet.**

```bash
bridge init --worker claude --data-dir /var/lib/bridge-coordinator
bridge cluster init-coordinator \
  --data-dir /var/lib/bridge-coordinator \
  --exposure internet \
  --bind 0.0.0.0 --port 8787 \
  --reserve-percent 10
bridge serve --cluster-coordinator --data-dir /var/lib/bridge-coordinator
```

Create a short-lived join token (printed once); revoke after the fleet enrolls:

```bash
bridge cluster join-token create --data-dir /var/lib/bridge-coordinator --ttl 2h
# → { "token": "…", "expiresAt": "…" }
```

Private lab alternative: `--exposure private`, terminate TLS at a reverse proxy, bind coordinator to localhost. Single-node loopback-only binding does not apply to cluster coordinators that intentionally expose a port.

## Join a worker (headless)

On each agent host, after `claude auth login` (or Codex equivalent):

```bash
bridge init --worker claude --data-dir /var/lib/bridge-worker
bridge cluster join \
  --data-dir /var/lib/bridge-worker \
  --coordinator https://bridge.company.example:8787 \
  --token "$BRIDGE_JOIN_TOKEN" \
  --name "$(hostname -s)"
bridge serve --cluster-worker --data-dir /var/lib/bridge-worker
```

Join writes **`cluster.json`** with the coordinator URL, **`nodeId`**, and a node **credential** (`ffn_…`). Workers send that credential on coordinator requests today. **Ed25519 enrollment and signed heartbeats/claims** are planned hardening on top of the credential and are not active yet.

Inspect a node from the coordinator:

```bash
bridge cluster verify-node --data-dir /var/lib/bridge-coordinator --id node_…
```

### systemd example (supervised `serve`)

```ini
[Unit]
Description=Firefly Agent Bridge cluster worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bridge
WorkingDirectory=/var/lib/bridge-worker
ExecStart=/usr/local/bin/bridge serve --cluster-worker --data-dir /var/lib/bridge-worker
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Docker example

```dockerfile
CMD ["bridge", "serve", "--cluster-worker", "--data-dir", "/data"]
```

Mount `/data` with `config.json` + `cluster.json`. Run `cluster join` as an init step or bake credentials carefully. The container needs **HTTPS egress** to the coordinator and a Claude/Codex CLI login inside the image or mounted home.

## Secure communication (summary)

| Plane | Auth (today) |
|-------|----------------|
| Clients → coordinator | Bridge bearer tokens (`ffb_…`); use HTTPS to the public URL |
| Workers → coordinator | Node credential (`ffn_…`) on worker API requests |
| Join | Short-lived join token → node credential enrollment |

**Planned hardening:** Ed25519 signature headers on worker requests (credential plus enrolled key), stricter replay windows, optional **`bridge daemon`**, and listener TLS flags. Until then, protect join tokens, restrict network paths, and terminate TLS in front of the coordinator. See [Security boundaries](security.md).

## Reserve, resources, and fair-share

- Coordinator default `reservePercent: 10` — that slice is not used for pool claims.
- A node may set a **higher** reserve; it cannot go below the coordinator floor.
- Each heartbeat includes **RAM, disk (workspace volume), and CPU** pressure. Collection uses portable Node APIs so the same worker binary works on **macOS, Linux, and Windows** (load averages are zero on Windows; CPU busy uses processor time samples).
- A node is skipped if free memory/disk fall below configured floors or CPU busy exceeds the max — even if quota remains.
- New jobs go to the eligible node with the best **weighted** score (quota headroom + memory + disk + CPU slack). Defaults: quota 0.45, memory 0.2, disk 0.15, cpu 0.2.
- When a node is provider-`limited`, it stops taking new work; other nodes continue. The pool does **not** global-pause for one node.
- Sticky jobs wait for their node (or interrupt after offline timeout). They are never moved to another machine.

Estimation is used because CLIs do not expose exact remaining allowance. Operators tune `capacityUnits`, `scheduling` floors/weights, and windows in config when needed.

## Day-2 commands

```bash
# Pool JSON (coordinator data dir or worker data dir)
bridge cluster status --data-dir …

# List nodes (coordinator)
bridge cluster nodes --data-dir …

# Drain this worker (finish in-flight, stop claiming)
bridge cluster drain --data-dir …

# Leave the pool
bridge cluster leave --data-dir …

# Pool-wide pause / resume (coordinator)
bridge cluster pause --data-dir …
bridge cluster resume --data-dir …
```

Owner token for admin HTTP remains in the coordinator `owner.token` file (same as single-node).

## Client transparency

Submit jobs, watch SSE, use MCP, and call OpenAI-compatible completions against the **coordinator** exactly as against a single bridge. Callers do not select nodes. Per-node inventory in status requires owner or `cluster:admin` scope; pool summary is visible to authenticated principals.

## Workspace constraint

Job files live under the **worker’s** configured workspace, namespaced by job id. The coordinator does not sync arbitrary host directories. Shared git checkouts or networked volumes are an operator concern; put clone URLs or mount paths in prompts/profiles as needed.

## Health

- Coordinator: `GET /v1/bridge/status` (includes `cluster.pool` and dispatch state).
- Worker: optional `--health-port` serving `{"ok":true,"nodeId":"…"}` on `127.0.0.1` only for local supervisors.
- Stale heartbeat (default 10s) → `stale`; offline (default 60s) → running attempts interrupted.

## Security checklist

- Join tokens: short TTL, revoke after provisioning.
- Node credentials in `cluster.json` with restrictive file modes.
- Prefer TLS to the coordinator; restrict worker source CIDRs when possible.
- Do not expose worker health ports beyond localhost.
- Keep rejecting Anthropic/OpenAI API-key env overrides on workers (subscription posture unchanged).

## Non-goals reminder

No multi-account login in one OS user, no live session migration between nodes, no UI-required ops path, no mixed Claude+Codex workers on one coordinator in v1.

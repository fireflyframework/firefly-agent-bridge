---
description: Introduce headless cluster mode - one coordinator, many Claude or Codex workers, fair-share quotas, and the bridge cluster CLI with real command output.
---

<!-- Copyright (c) 2026 Signature Management Consultants SLU; Author: @ancongui. Modified by Firefly Software Foundation for Firefly Agent Bridge (2026). SPDX-License-Identifier: Apache-2.0. -->

# Cluster quota pool

!!! warning "Subscriptions and terms"

    Each worker uses its own signed-in coding CLI subscription. Pooling does not create extra provider capacity beyond those logins. Confirm your plan and company policy before joining company machines to a shared coordinator. The diagnostic dashboard is optional and never required for cluster operations.

## What cluster mode is

By default Firefly Agent Bridge is **one process on one machine** with one Claude Code or Codex login. **Cluster mode** is opt-in: you run a **coordinator** that owns the durable queue and public APIs, and one or more **workers** that join the pool, each with its own official CLI login.

Clients keep calling the same HTTP, MCP, and OpenAI-compatible endpoints - they talk to the **coordinator** only. They never choose a node. Workers never serve the public client API; they only call **out** to the coordinator.

```text
  Clients / SDKs / MCP
            |
            v
     Coordinator (queue + public API)
        /         |         \
   Worker A   Worker B   Worker C
  (CLI login) (CLI login) (CLI login)
```

| Piece           | Responsibility                                                              |
| --------------- | --------------------------------------------------------------------------- |
| **Coordinator** | SQLite queue, client auth, fair-share router, node registry, pool telemetry |
| **Worker**      | Official CLI, heartbeat + claim loop, job workspace under its own data dir  |
| **Clients**     | Same tokens and APIs as single-node; point them at the coordinator URL      |

See [Architecture - Cluster mode](architecture.md#cluster-mode-optional) for how this sits next to the single-node model, and [Service lifecycle](operations.md) for stop/backup habits that still apply to every data directory.

## Rules you should know first

1. **Provider-agnostic jobs.** Clients do not pick Claude vs Codex. Each worker process still runs one CLI; Claude and Codex workers may join the **same** coordinator. Fresh work is fair-shared by quota and capacity across eligible nodes of either type.
2. **Reserve (default 10%).** That slice of each node's estimated quota is kept unused for spikes and sticky follow-ups.
3. **Sticky while healthy.** Native `sessionId` values prefer the worker that created them. When that home is limited, unhealthy, draining, or offline, the coordinator **failovers** the bridge job: pause in-flight work, clear sticky binding, attach a bounded handoff brief from durable coordinator memory, and requeue for any eligible peer (including the other CLI). There is no native CLI session transfer: the next claim starts a new CLI session with the handoff as context. After `maxFailovers` (default 3) without a successful reassignment path, the job fails with `cluster_failover_exhausted`.
4. **Headless first.** Ops use `bridge serve`, `bridge daemon`, and `bridge cluster …` (JSON on stdout). The panel is optional diagnostics only. On the coordinator host, run a **separate** worker process (`bridge cluster init-local-worker`) so the coordinator does not claim CLI work in-process.
5. **Workers authenticate twice.** Bearer node credential (`ffn_…`) **plus** Ed25519 signatures on mutating requests. A stolen credential without the private key cannot claim work.

## The `bridge` CLI surface

The product binary is **`bridge`** (`firefly-bridge` remains a compatibility alias). On a TTY, `bridge` / `bridge help` may show a short ASCII welcome; set `BRIDGE_NO_BANNER=1` in scripts. Cluster commands print **JSON only** (no banner).

```text
$ bridge help
Firefly Agent Bridge 0.2.23
Usage: bridge <command> [--data-dir PATH]
  (firefly-bridge remains a compatibility alias; prefer bridge)

  init        Initialize local configuration (--worker codex|claude)
  serve       Run the service (--managed follows host leases)
              --cluster-coordinator | --cluster-worker
              --health-port N (worker loopback health only)
  …
  cluster     Headless pool ops (JSON stdout): init-coordinator, join-token,
              join, status, nodes, drain, leave, pause, resume, verify-node
  daemon      start|status|stop (--cluster-coordinator|--cluster-worker)
  --version   Print the release version

Quick start
  bridge init --worker claude
  bridge serve
  bridge cluster init-coordinator --exposure internet …
  bridge daemon start --cluster-worker
```

```text
$ bridge cluster
cluster commands (JSON on stdout):
  init-coordinator [--exposure internet|private] [--bind HOST] [--port N]
                   [--tls-cert PATH] [--tls-key PATH] [--reserve-percent N]
  join-token create [--ttl DURATION]
  join-token revoke --id ID
  join --coordinator URL [--token TOKEN] [--name LABEL] [--reserve-percent N]
       [--allow-insecure]
  status | nodes | verify-node --id NODE
  drain | leave | pause | resume
  nodes drain --id NODE | nodes remove --id NODE
Token may also come from BRIDGE_JOIN_TOKEN.
```

```text
$ bridge daemon
daemon commands (JSON on stdout):
  start --cluster-coordinator|--cluster-worker
  status [--cluster-coordinator|--cluster-worker]
  stop [--cluster-coordinator|--cluster-worker]
```

| You need                                 | Command                                                    |
| ---------------------------------------- | ---------------------------------------------------------- |
| Create data dir + `config.json`          | `bridge init --worker claude\|codex --data-dir PATH`       |
| Mark this data dir as coordinator        | `bridge cluster init-coordinator …`                        |
| Run in the foreground                    | `bridge serve --cluster-coordinator` or `--cluster-worker` |
| Run as a background process              | `bridge daemon start --cluster-…`                          |
| Enroll / inspect / drain                 | `bridge cluster …` (JSON)                                  |
| Optional loopback health for supervisors | `bridge serve --cluster-worker --health-port N`            |

Full command tables also live in the [CLI and MCP reference](reference.md#cluster-and-daemon).

## Private lab walkthrough (real outputs)

This section is a **single-host lab**: one coordinator and two Codex workers on loopback HTTP. Use it to learn the CLI. For production, prefer HTTPS (`--exposure internet` with TLS, or a TLS-terminating proxy).

Paths below use a scratch directory. Substitute your own absolute `--data-dir` values.

### 1. Initialize the coordinator data dir

```bash
bridge init --worker codex --data-dir /tmp/bridge-lab/coord
```

```json
{
  "dataDir": "/tmp/bridge-lab/coord",
  "config": "/tmp/bridge-lab/coord/config.json"
}
```

### 2. Enable cluster coordinator mode

```bash
bridge cluster init-coordinator \
  --data-dir /tmp/bridge-lab/coord \
  --exposure private \
  --bind 127.0.0.1 \
  --port 8787 \
  --reserve-percent 10
```

```json
{
  "dataDir": "/tmp/bridge-lab/coord",
  "exposure": "private",
  "addressHint": "http://127.0.0.1:8787"
}
```

`--exposure private` is for labs and reverse-proxied installs. `--exposure internet` forces in-process TLS and requires `--tls-cert` / `--tls-key`.

### 3. Start the coordinator

```bash
bridge serve --cluster-coordinator --data-dir /tmp/bridge-lab/coord
```

Typical log line:

```text
bridge coordinator listening at http://127.0.0.1:8787
```

Or, for a pidfile + logfile under the data dir:

```bash
bridge daemon start --cluster-coordinator --data-dir /tmp/bridge-lab/coord
```

### 4. Create a join token

```bash
bridge cluster join-token create --data-dir /tmp/bridge-lab/coord --ttl 1h
```

```json
{
  "id": "jtok_qvkuCAr95fvDI7vK",
  "token": "ffj_…",
  "expiresAt": "2026-10-28T04:19:31.120Z"
}
```

The token value is shown **once**. Store it as `BRIDGE_JOIN_TOKEN` or pass `--token`. Revoke after the fleet enrolls:

```bash
bridge cluster join-token revoke --data-dir /tmp/bridge-lab/coord --id jtok_qvkuCAr95fvDI7vK
```

### 5. Join workers

On each worker host (here, two directories on the same machine), after `codex login` (or `claude auth login` for a Claude pool):

```bash
bridge init --worker codex --data-dir /tmp/bridge-lab/w0
mkdir -p /tmp/bridge-lab/w0/jobs

bridge cluster join \
  --data-dir /tmp/bridge-lab/w0 \
  --coordinator http://127.0.0.1:8787 \
  --token "$BRIDGE_JOIN_TOKEN" \
  --name docs-w0 \
  --allow-insecure
```

```json
{
  "nodeId": "node_Zs6tvtqDidyqmQtj",
  "coordinatorUrl": "http://127.0.0.1:8787"
}
```

`--allow-insecure` is required for `http://` coordinator URLs (lab only). Production workers use `https://` and omit that flag.

Join writes **`cluster.json`** (mode `0600`) with coordinator URL, `nodeId`, credential (`ffn_…`), and **`nodePrivateKey`**. Missing `nodePrivateKey` fails fast at worker start - re-run `cluster join`.

To mix Claude and Codex in one pool, init each worker data-dir with the matching `--worker` and join both to the same coordinator URL. Jobs do not name a provider; fair-share picks any eligible node.

### Coordinator host worker (separate process)

The coordinator process never claims CLI work. On the same machine, provision a second data-dir and join it while the coordinator is serving:

```bash
bridge cluster init-local-worker \
  --data-dir /tmp/bridge-lab/coord \
  --worker-data-dir /tmp/bridge-lab/host-worker \
  --worker claude \
  --name host-claude \
  --allow-insecure
bridge daemon start --cluster-worker --data-dir /tmp/bridge-lab/host-worker
```

The JSON reply includes `next.workerDaemon` / `next.coordinatorDaemon` command lines.

Repeat for a second remote worker (`w1`, `--name docs-w1`), then start both:

```bash
bridge serve --cluster-worker --data-dir /tmp/bridge-lab/w0 --health-port 19001
bridge serve --cluster-worker --data-dir /tmp/bridge-lab/w1 --health-port 19002
```

Typical log line:

```text
bridge worker listening at http://127.0.0.1:19001
```

### 6. Inspect the pool

```bash
bridge cluster status --data-dir /tmp/bridge-lab/coord
```

Abbreviated real shape from a lab run (two online, authenticated, eligible Codex workers):

```json
{
  "mode": "coordinator",
  "reservePercent": 10,
  "dispatch": "ready",
  "nodes": [
    {
      "id": "node_Zs6tvtqDidyqmQtj",
      "name": "docs-w0",
      "worker": "codex",
      "status": "online",
      "freeSlots": 1,
      "headroom": 90,
      "usablePercent": 90,
      "usedPercentOfUsable": 0,
      "reservedPercent": 10,
      "quotaState": "unknown",
      "authentication": "authenticated",
      "memoryFreeBytes": 26257620992,
      "diskFreeBytes": 104970702848,
      "cpuBusyRatio": 0.227
    },
    {
      "id": "node_H7N8vJfVxB7h1L-X",
      "name": "docs-w1",
      "worker": "codex",
      "status": "online",
      "freeSlots": 1,
      "headroom": 90,
      "authentication": "authenticated"
    }
  ],
  "pool": {
    "onlineNodes": 2,
    "eligibleNodes": 2,
    "eligibleByProvider": { "claude": 0, "codex": 2 },
    "totalHeadroom": 180,
    "fairnessSkew": 0,
    "queuedJobs": 0,
    "runningJobs": 0
  }
}
```

Read the pool block first:

| Field           | Meaning                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------- |
| `dispatch`      | `ready`, `paused`, or `waiting_for_capacity`                                                 |
| `onlineNodes`   | Heartbeating workers                                                                         |
| `eligibleNodes` | Online, authenticated, not draining, under resource floors, with free slots and usable quota |
| `fairnessSkew`  | Spread of used% across non-limited nodes (0 is even)                                         |

If `onlineNodes > 0` but `eligibleNodes` is `0`, check **authentication** (CLI login), **memory/disk/CPU floors**, and **quotaState** (`limited` pauses that node only).

List nodes only:

```bash
bridge cluster nodes --data-dir /tmp/bridge-lab/coord
```

```json
{
  "nodes": [
    {
      "id": "node_Zs6tvtqDidyqmQtj",
      "name": "docs-w0",
      "worker": "codex",
      "status": "online",
      "authentication": "authenticated",
      "freeSlots": 1,
      "headroom": 90
    }
  ]
}
```

Verify enrollment crypto for one node:

```bash
bridge cluster verify-node --data-dir /tmp/bridge-lab/coord --id node_Zs6tvtqDidyqmQtj
```

```json
{
  "id": "node_Zs6tvtqDidyqmQtj",
  "name": "docs-w0",
  "worker": "codex",
  "status": "online",
  "enrollmentFingerprint": "0252b5ee06ab18654ebe62f7a769b44e1025efff2ab5e0a7b5986de9bbc743dd",
  "lastSignedAt": "2026-10-28T03:19:36.118Z",
  "lastHeartbeatAt": "2026-10-28T03:19:36.116Z",
  "capacity": {
    "authentication": "authenticated",
    "freeSlots": 1,
    "quota": {
      "state": "unknown",
      "estimatedUsedUnits": 0,
      "estimatedCapacityUnits": 100
    },
    "draining": false
  }
}
```

### 7. Submit work through the coordinator

Clients use the coordinator owner token (file `owner.token` under the coordinator data dir) exactly as in single-node mode:

```bash
OWNER=$(tr -d '\n' < /tmp/bridge-lab/coord/owner.token)
curl -sS http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $OWNER" \
  -H "content-type: application/json" \
  -d '{
    "model": "bridge/default",
    "messages": [{"role": "user", "content": "Reply with exactly: CLUSTER_OK"}],
    "bridge": { "execution": "agent", "background": true }
  }'
```

Poll `GET /v1/bridge/jobs/{id}` with the same bearer token. The job is claimed by an eligible worker; you do not pick the node.

Automated single-host check (after `npm run build`):

```bash
npx tsx scripts/live-cluster-host-smoke.ts --worker=codex --workers=2
# Claude pool as well (separate coordinator):
npx tsx scripts/live-cluster-host-smoke.ts --both --workers=2
```

A job that pauses with `quota_exhausted` still proves join → auth → claim → run; the CLI subscription limit is separate from cluster plumbing.

## Internet coordinator (production shape)

```bash
bridge init --worker claude --data-dir /var/lib/bridge-coordinator
bridge cluster init-coordinator \
  --data-dir /var/lib/bridge-coordinator \
  --exposure internet \
  --bind 0.0.0.0 \
  --port 8787 \
  --tls-cert /etc/ffb/fullchain.pem \
  --tls-key /etc/ffb/privkey.pem \
  --reserve-percent 10
bridge daemon start --cluster-coordinator --data-dir /var/lib/bridge-coordinator
```

Workers join with `https://…` and **without** `--allow-insecure`. Behind a TLS-terminating reverse proxy, use `--exposure private`, bind localhost, and terminate TLS at the proxy.

### systemd (supervised `serve`)

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

### Docker sketch

```dockerfile
CMD ["bridge", "serve", "--cluster-worker", "--data-dir", "/data"]
```

Mount `/data` with `config.json` + `cluster.json`. Run `cluster join` as an init step (or bake credentials carefully). The container needs HTTPS egress to the coordinator and a Claude/Codex login in the image or a mounted home directory.

## Day-2 operations

```bash
# Pool JSON (use the coordinator data dir; workers can also call status for a local view)
bridge cluster status --data-dir /var/lib/bridge-coordinator

# Drain this worker (finish in-flight, stop claiming)
bridge cluster drain --data-dir /var/lib/bridge-worker

# Leave the pool (revokes credential + enrolled key on the coordinator)
bridge cluster leave --data-dir /var/lib/bridge-worker

# Pool-wide pause / resume (coordinator)
bridge cluster pause --data-dir /var/lib/bridge-coordinator
bridge cluster resume --data-dir /var/lib/bridge-coordinator

# Operator drain / remove by node id (coordinator)
bridge cluster nodes drain --data-dir /var/lib/bridge-coordinator --id node_…
bridge cluster nodes remove --data-dir /var/lib/bridge-coordinator --id node_…
```

Owner admin HTTP still uses the coordinator `owner.token` file, same as single-node.

## Reserve, resources, and fair-share

- Coordinator default `reservePercent: 10` - that slice is not used for new pool claims.
- A node may set a **higher** reserve; it cannot go below the coordinator floor.
- Each heartbeat includes **RAM, disk (workspace volume), and CPU** pressure (portable across macOS, Linux, and Windows).
- On macOS, free memory prefers reclaimable pages from `vm_stat` so eligibility is not starved by Node's conservative `os.freemem()`.
- A node is skipped when free memory/disk fall below configured floors or CPU busy exceeds the max - even if quota remains.
- New jobs go to the eligible node with the best weighted score (defaults: quota 0.45, memory 0.2, disk 0.15, cpu 0.2).
- When a node is provider-`limited`, it stops taking new work; in-flight and sticky-home jobs on that node failover to eligible peers. The pool does **not** global-pause for one node.
- Sticky preference holds only while the home node is eligible. Quota, health floors, drain, leave, and offline triggers clear sticky and requeue with a coordinator-owned handoff brief (`job.cluster_failover` / `job.cluster_reassigned` audit events). Clients keep the same `job.id` through `running → pause_requested → paused → queued → running`.

Estimation is used because CLIs do not expose exact remaining allowance. Tune `capacityUnits`, `scheduling` floors/weights, `maxFailovers`, and windows in config when needed.

## Job failover and auto-rebalance

| Trigger                         | Coordinator action                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| Home `quotaState: limited`      | Pause reason `cluster_failover:quota`; clear sticky; requeue with handoff            |
| Home fails resource/auth floors | Pause reason `cluster_failover:health`; same requeue path                            |
| Node offline / leave            | Interrupt running attempts; failover sticky-queued work (`cluster_failover:offline`) |
| Drain                           | Pause in-flight + sticky-queued with `cluster_failover:drain`                        |
| Peer joins                      | No push; pull claims absorb capacity once sticky is cleared                          |
| `failoverCount > maxFailovers`  | Job `failed` with `cluster_failover_exhausted: …`                                    |

Pool telemetry on `GET /v1/bridge/status` includes `cluster.pool.failovers` (cumulative) and `waitingForFailover` (queued jobs awaiting a peer claim after handoff). Workspace files still live on the worker that last ran the job; shared storage is an operator concern when side effects must survive host moves.

## Client transparency

Submit jobs, watch SSE, use MCP, and call OpenAI-compatible completions against the **coordinator** exactly as against a single bridge. Per-node inventory in status requires owner or `admin` scope; pool summary is visible to authenticated principals. Internal fields `sessionNodeId` / `assignedNodeId` / `clusterHandoff` / `failoverCount` stay out of ordinary client job views unless the principal is owner or has `admin` scope.

## Workspace constraint

Job files live under the **worker's** configured workspace, namespaced by job id. The coordinator does not sync arbitrary host directories. Shared git checkouts or networked volumes are an operator concern; put clone URLs or mount paths in prompts/profiles as needed.

## Health and failure signals

| Signal                               | Meaning                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------- |
| Coordinator `GET /v1/bridge/status`  | Includes `cluster.pool` and `dispatch`                                  |
| Worker `--health-port`               | Loopback-only `{"ok":true,"nodeId":"…"}` for local supervisors          |
| Stale heartbeat (default 10s)        | Node marked `stale`                                                     |
| Offline (default 60s)                | Running attempts interrupted and fail over to peers                     |
| `authentication` not `authenticated` | Worker has not proven CLI login; not eligible; sticky home may failover |
| `quotaState: limited`                | That node pauses/failovers its work; siblings continue                  |

## Security checklist

| Plane                 | Auth                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| Clients → coordinator | Bridge bearer tokens (`ffb_…`) over HTTPS                                                                 |
| Workers → coordinator | Node credential (`ffn_…`) **plus** Ed25519 request signatures (timestamp + nonce)                         |
| Join                  | Short-lived join token → credential + public-key enrollment (rate-limited; optional `allowedWorkerCidrs`) |

- Keep join tokens short-lived; revoke after provisioning.
- Protect `cluster.json` (`0600`) - it holds the node private key.
- Internet coordinators: readable TLS cert/key; workers use `https://` only.
- Do not expose worker health ports beyond localhost.
- Keep rejecting Anthropic/OpenAI API-key env overrides on workers (subscription posture unchanged).

More context: [Security boundaries](security.md).

## Non-goals (v1)

No multi-account login in one OS user, no native CLI session transfer between hosts (bridge-job failover with a coordinator handoff brief is supported, including Claude to Codex and the reverse), no UI-required ops path, and no dual CLI inside one worker process.

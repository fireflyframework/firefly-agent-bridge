---
description: Configure Codex or Claude Code profiles, worker access, concurrency and local service settings without entering provider logins in the console.
---

<!-- Copyright (c) 2026 Signature Management Consultants SLU; Author: @ancongui. Modified by Firefly Software Foundation for Firefly Agent Bridge (2026). SPDX-License-Identifier: Apache-2.0. -->

# Configure providers and profiles

The service reads owner-managed `config.json` from its data directory at startup. Stop it before editing the file, then restart. Console workflow changes also persist this file; avoid editing it concurrently with console updates.

All data, workspace, and executable paths are absolute. The selected provider path is mandatory. HTTP callers cannot override these paths or supply worker arguments or environment settings.

## Use the setup wizard

Open **Providers & setup** after connecting to the console. Follow Provider, Login, Profile and Tools in order to inspect the running configuration. Edit the saved file separately when you need to change it; run the official login command on the host yourself.

Choose the setup guide matching your intended subscription. If it differs from the current worker, stop the bridge and update its worker and executable path before restarting. Refresh readiness after the official login. Use the profile step to confirm the effective model and limits, then create a separate scoped token for each application from the final step.

See the [console tour](dashboard.md#appearance-and-provider-setup) for the four steps and [integration instructions](integrations.md) for actual client setup.

## Codex subscription configuration

```json
{
  "dataDir": "/absolute/bridge-state",
  "workspace": "/absolute/bridge-jobs",
  "worker": "codex",
  "codexPath": "/absolute/path/to/codex",
  "host": "127.0.0.1",
  "port": 8766,
  "concurrency": 1,
  "profiles": {
    "default": {
      "permissionMode": "default",
      "timeoutMs": 300000,
      "maxOutputBytes": 2000000
    }
  }
}
```

Sign in using official `codex login`, then check readiness in Providers & setup. The bridge ignores personal Codex configuration while keeping its official login. An explicit profile model takes precedence; otherwise the CLI uses its default. Claude tool lists and native agent definitions do not configure this worker.

## Claude subscription configuration

Set `worker` to `claude` and provide an absolute `claudePath`. Sign in with official `claude auth login`. Profiles can allow tools and named Claude native agents. The default tool list is Read, Write, Edit, Bash, Glob, and Grep. Agent and web tools need an explicit profile assignment.

Keep a `default` profile. Workflow steps must reference existing profiles. Model aliases are `bridge/<profile>`, such as `bridge/default`; they are bridge profile names rather than OpenAI model names. `/v1/models` reports the selected worker and configured native model. Owner status includes effective limits and capability flags without executable paths or agent prompts.

## Permission policy

| Worker and mode | Native behavior                                                                      |
| --------------- | ------------------------------------------------------------------------------------ |
| Codex default   | Workspace-write sandbox; noninteractive approval                                     |
| Claude default  | acceptEdits; unapproved interactive permission prompts denied                        |
| Codex bypass    | Explicit danger-full-access execution                                                |
| Claude bypass   | Explicit bypassPermissions execution                                                 |
| Inference       | Native actions disabled; Codex read-only sandbox; caller executes declared functions |

Default permissions stay enabled. Bypass needs a trusted host and workspace. A job directory is not a general operating-system isolation guarantee for shell tools or bypass work. Review [security boundaries](security.md) before giving an application an execution-capable token.

## Service settings

| Setting                        | Default                    | Constraint or effect                                                                                                                                                                 |
| ------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `worker`                       | Codex on initial CLI setup | `codex` or `claude` for **this** data directory’s CLI. Cluster coordinators accept both worker types in one pool; each worker process still picks one ([cluster guide](cluster.md)). |
| `host`                         | `127.0.0.1`                | Loopback only                                                                                                                                                                        |
| `port`                         | 8766                       | 0 to 65535; 0 requests a free port                                                                                                                                                   |
| `concurrency`                  | 1                          | 1 to 8 owned jobs                                                                                                                                                                    |
| `queueCapacity`                | 1000                       | 1 to 10000 admitted queue entries                                                                                                                                                    |
| `idleMs`                       | 30000                      | 1000 to 3600000 milliseconds; managed lifecycle only                                                                                                                                 |
| `allowedHosts`                 | localhost, 127.0.0.1       | Exact accepted request hostnames                                                                                                                                                     |
| `allowedOrigins`               | Empty                      | Additional browser origins; authentication still required                                                                                                                            |
| `serveUi`                      | `true`                     | When `false`, HTTP serves API and cluster routes only (no diagnostic console). Same effect as `bridge serve --no-ui` for that process.                                               |
| `openai.timeoutMs`             | 300000                     | 100 to 3600000 milliseconds including queue wait                                                                                                                                     |
| `openai.maxConnections`        | 16                         | 1 to 64 service-wide waiting connections                                                                                                                                             |
| `openai.maxRequestBytes`       | `null`                     | Optional positive safe integer; complete Chat Completions HTTP body in bytes                                                                                                         |
| `openai.maxExpandedCharacters` | `null`                     | Optional positive safe integer; expanded completion prompt in JavaScript UTF-16 code units                                                                                           |
| `openai.maxMessages`           | `null`                     | Optional positive safe integer; complete Chat Completions message count                                                                                                              |

Keep `127.0.0.1` in the host allowlist when using Streamable HTTP MCP: management tools call the same service over its loopback listener. A remote gateway needs its exact hostname and browser origin configured as applicable.

## Completion input policy

Set the optional input policy in the local owner's saved configuration. Client requests cannot override it:

```json
{
  "openai": {
    "timeoutMs": 300000,
    "maxConnections": 16,
    "maxRequestBytes": null,
    "maxExpandedCharacters": null,
    "maxMessages": null
  }
}
```

A positive safe integer enables that limit; `null` disables that configured aggregate limit. The expanded count includes the protocol instructions and serialized conversation, function definitions and output schema. Admission and persisted completion prompts use the same policy. Read and submit authorization are checked before the HTTP body is parsed, including when its limit is disabled. A declared or streamed oversized request returns HTTP 413 before a job is queued. Token, read/submit scope and profile authority are revalidated inside the queue transaction after the body has arrived; revocation during a streamed request cannot queue work.

The bridge retains complete input and original wire hashes. It does not shorten history or invent context to fit a limit. Existing admitted jobs and recovery receipts remain readable when a later policy becomes smaller; a new admission still uses current settings. `null` does not remove the runtime or model's context/resource constraints. Image validation, JSON Schema/tool contracts, profile duration/output budgets, and [recovery-v1 custody](openai-compatible.md#read-an-original-completion-after-delivery-loss) remain separate. In particular, recovery-v1 requests keep their 9,000,000-byte wire bound and existing retained-result budgets. Direct job/MCP submissions keep their separate 100,000-character prompt contract.

## Profile settings

| Setting          | Default                             | Applies to                                                                |
| ---------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| `model`          | Official CLI default                | Both workers; native model name, 1 to 100 supported identifier characters |
| `permissionMode` | `default`                           | Both; `bypass` is explicit                                                |
| `timeoutMs`      | 300000                              | Both; 100 to 3600000 milliseconds                                         |
| `maxOutputBytes` | 2000000                             | Both; 1000 to 16000000 bytes of native output                             |
| `tools`          | Read, Write, Edit, Bash, Glob, Grep | Claude tool allowlist; not enforced as a Codex tool allowlist             |
| `maxTurns`       | 100                                 | Claude; 1 to 1000                                                         |
| `maxSubagents`   | 8                                   | Claude reported child tasks; 0 to 64                                      |
| `agents`         | Empty                               | Named Claude description, prompt, and tool subset                         |

Codex uses sandbox, deadline, and output bounds. Inference disables native command, mutation, browser, app, media, and agent features and rejects unexpected action items. Choose caller-owned functions when the application needs a specific function authority boundary.

## Workflows and startup changes

`workflows` contains up to 100 validated templates, each with 1 to 32 sequential steps. The console's template editor validates references and persists future definitions immediately. Existing runs retain their snapshot.

Worker, path, model, permission, and service changes take effect on restart. Pause dispatch, inspect active work, stop the service, edit configuration, and restart it. Confirm Providers & setup shows the intended worker and effective profiles before resuming work.

Use [workflow examples](workflows.md), [Claude native agent setup](subagents.md), [remote access](tunnels.md), and [troubleshooting](troubleshooting.md) for specific changes.

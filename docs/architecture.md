---
description: Understand the local bridge API, durable job queue, CLI workers, scoped tokens, workflows and provider execution boundaries.
---

<!-- Copyright (c) 2026 Signature Management Consultants SLU; Author: @ancongui. Modified by Firefly Software Foundation for Firefly Agent Bridge (2026). SPDX-License-Identifier: Apache-2.0. -->

# Architecture

!!! warning "For local development and testing"

    Firefly Agent Bridge is intended for local development and testing. It uses your signed-in coding CLI subscription rather than a separately billed model API; subscription quotas still apply. We advise against using it for production workloads: provider license and usage restrictions, local security boundaries, and performance limits may make it unsuitable. Check the terms of your plan and provider before connecting an application. See [OpenAI's terms](https://openai.com/policies/terms-of-use/) and [Anthropic's consumer terms](https://www.anthropic.com/legal/consumer-terms).

The local bridge stores the queue, workflows and audit, runs the scheduler, and serves HTTP requests. Stdio MCP hosts, the console, SDKs and remote MCP clients connect to that service. The selected official Codex or Claude Code CLI manages provider login, native sessions, model access and context.

![Local bridge architecture](../assets/diagrams/architecture.svg)

## Request lifecycle

| Stage    | Caller                                                                  | Bridge                                                         | Official CLI                                                 |
| -------- | ----------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| Submit   | Send messages, profile alias, bearer token and optional idempotency key | Authorize and validate; commit job and admission event         | Not running yet                                              |
| Claim    | Wait for response or retain background job receipt                      | Claim an exclusive fenced attempt                              | Start or resume the selected worker                          |
| Execute  | Inference caller waits; host conversation claims its own work           | Bound attempt time and output; persist observations            | Produce a structured answer or perform permitted native work |
| Return   | Receive completion JSON, buffered SSE, or terminal job result           | Validate envelope, function names, arguments and output schema | Report result, native session and observed usage             |
| Continue | Inference sends full history; native job sends a follow-up              | New inference job or continuation of existing native job       | Resume the job's saved native session when available         |

`bridge.execution` selects inference, native agent, or host conversation work. The `/v1/bridge` routes provide durable job state, execution controls, workflow checkpoints, scoped access, and replayable events. `/mcp` is a stateless Streamable HTTP view of the same management tools; it preserves its caller's authorization.

## One state owner

MCP adapters discover or start a shared local service. A renewable filesystem lock gives one process ownership of the database and worker processes. Service identity and protocol checks prevent a different listener from being accepted as the bridge. A port collision is detected before crash recovery changes attempts.

This lets several hosts share one queue while configuration and history remain outside plugin cache directories. A host lease keeps managed services available. Plain `serve` stays available independently of host lifecycle.

## Identities and transactions

| Identity             | Purpose                                   | Lifetime                                            |
| -------------------- | ----------------------------------------- | --------------------------------------------------- |
| Principal            | Application ownership and scopes          | Until token revocation or replacement               |
| Job ID               | Durable work and conversation             | Retained in local state                             |
| Attempt ID and fence | Authority to finish one exclusive attempt | Ends when the attempt finishes or ownership is lost |
| Native session ID    | Coding-agent context and continuation     | Managed by the official CLI                         |

SQLite uses WAL, foreign keys, prepared statements, full synchronous commits, and immediate transactions. Job transitions, admission keys, and event records commit together. A fence rejects completion messages from attempts that have lost ownership.

An idempotency key belongs to a principal, operation, and exact request body. Repeating that request returns its existing resource; changing the body under the same key fails with a conflict. A resume continues an available native session. Retry starts a new session and retains the job's history and workspace; it does not roll back prior effects.

## Tool authority

Inference disables native actions and returns requests for declared application functions. The caller executes those functions and sends their results in its next model turn. Structured validation prevents an undeclared function name from becoming an accepted call. The bridge does not execute function code.

Native Codex jobs use its workspace sandbox by default. Native Claude jobs use acceptEdits and the profile tool list. Claude profile-defined agents and native turn controls do not translate to Codex. Explicit bypass is a trusted-host owner choice. A job directory organizes files; the operating system and worker permission policy determine access.

![Inference and native execution boundaries](../assets/diagrams/openai-compatible.svg)

## Worker and process ownership

Internal instructions are maintained as native Agentic YAML resources and rendered into a versioned catalog during the build. The Node executable embeds that catalog; no Python service or template interpreter is needed at runtime. User messages and workflow values stay opaque data. [Internal prompt maintenance](prompts.md) explains resource ownership, exact versions and digest checks.

Prompts go to the owned CLI over stdin without a shell. Worker setup rejects alternate billing environment settings and preserves official subscription authentication. Codex ignores personal configuration while applying deliberate bridge profile options. Claude suppresses host customizations; arbitrary host plugins and skills are not automatically inherited.

The bridge observes the provider's structured protocol. It retains session IDs and reported compaction boundaries without rewriting provider transcripts or inventing replacement summaries. Missing or unavailable sessions remain explicit errors.

An owned POSIX process group, or Windows process tree, supports cancellation and shutdown. Graceful termination is followed by bounded escalation. Descendants are reconciled even if the leader exits first. Claude retains the final group kill after the leader closes. If a POSIX signal returns `EPERM`, the bridge observes the group for up to 250 milliseconds and accepts cleanup only after a read-only signal probe returns `ESRCH` (group absent). A live group, a persistent permission error, or any other signal failure reports a cleanup error instead of acknowledging successful execution or cancellation. An existing pause request keeps its paused status. Cleanup errors expose only a fixed phase and an allowlisted error code, never the operating system’s raw message. Host conversation jobs have a different boundary: the bridge requests a stop and waits for an explicit claim receipt acknowledgment because it does not own that host process.

## Streaming and retention

Chat Completions sends keepalives while work runs, then releases validated final chunks and optional observed usage. It is buffered completion streaming. Job notifications use a separate durable SSE sequence with replay cursors.

![Request and event contracts](../assets/diagrams/communication.svg)

Ordinary synchronous disconnects and deadlines cancel work when the last waiter leaves. Background jobs and explicitly admitted [original completion recovery](openai-compatible.md#read-an-original-completion-after-delivery-loss) requests remain retained after their submitting connection is lost. A recovery read never submits work or resumes the caller's agent graph. Operator and quota pauses retain state for explicit recovery. A reported future reset can permit bounded automatic continuation; an unknown reset stays paused.

The service retains approximately 10,000 recent notification IDs. Expired cursors require a state refresh, preventing silent replay gaps. Jobs and full audit remain durable beyond that event window.

## Audit and workflows

Native observations commit complete emitted tool payloads and correlation metadata before publishing lightweight tool notifications. A current projection supplies outcomes and reported file targets; immutable entries support a fixed-cursor export. Missing results remain unknown. Client function requests and reports retain caller provenance rather than being classified as native actions.

![Execution audit](../assets/diagrams/execution-audit.svg)

A workflow snapshots its template and inputs. A successful current job creates its next sequential step. Failed steps require an explicit retry; an operator pause blocks advancement. Editing a reusable template changes future runs and preserves existing snapshots.

External effects are outside database atomicity. A command can write a file or call a remote service before its result is lost. Crash recovery marks lost attempts interrupted and retains their evidence; the operator reconciles effects before retrying.

## Documentation illustration

The documentation home shows an original Bridge span and two-way packet motion. It is a local Three.js illustration: it does not read queue state, connect to a worker or make model calls. The pause control, reduced-motion preference and static fallback change only that illustration. Provider readiness and job state come from the authenticated console and API described above.

<!-- Copyright (c) 2026 Signature Management Consultants SLU; Author: @ancongui. Modified by Firefly Software Foundation for Firefly Agent Bridge (2026). SPDX-License-Identifier: Apache-2.0. -->

# Security boundaries

Firefly Agent Bridge runs on a trusted developer machine. An execution-capable token can cause actions with that developer's permissions. Restrict service access to trusted callers, including when you install it from the open-source repository.

## Authentication

Every `/v1/` request needs a bearer token, except an approved browser preflight. Host and origin allowlists also apply. The console's static shell is public on loopback; job data, execution controls, profiles, and token administration require authentication.

The owner token administers every principal and job. Application tokens restrict profiles, operations, and resource ownership. A client can inspect its own jobs; the owner can inspect all jobs. The database keeps token hashes, while the owner token file remains on the local filesystem. Revocation invalidates future requests and closes the client's event streams.

Tokens never belong in URLs. Console authentication stays in tab memory; reloading requires authentication again. The appearance preference is the only value the console writes to local storage.

## Provider login and billing

The selected official CLI owns its Codex ChatGPT or Claude subscription login. The bridge does not harvest credentials, rewrite provider transcripts, or fall back to API-key billing. Conflicting API or third-party provider environment settings fail readiness.

Provider requests leave the local machine according to that CLI's operation. The queue, audit, and configuration stay local. Prompts and files passed to the provider remain subject to the developer's account and organizational policy.

## Native execution

Default Codex jobs use `workspace-write` and noninteractive approval. Default Claude jobs use `acceptEdits` with unapproved interactive prompts denied. Claude tool allowlists and native agent definitions apply to Claude profiles. They do not restrict the Codex adapter; Codex uses its own sandbox and thread protocol.

Explicit `permissionMode: "bypass"` removes those default permission controls for that profile. Use it only on a host and workspace you trust. A job directory organizes files. Shell tools and bypass execution can reach beyond it under the operating-system user's permissions.

HTTP callers cannot supply executable paths, environment overrides, CLI arguments, or a custom working directory. Those choices are owner configuration. Cancellation stops the owned process tree, but cannot undo files or remote actions already performed.

## Inference and application functions

Inference disables native command, filesystem mutation, browser, app, media, and delegation actions. Codex additionally uses a read-only sandbox and rejects unexpected native action items. Claude inference has no native tools. Both workers must return a validated completion envelope. Bounded image attachments are model inputs; native image tools remain disabled. Attachments accept data URLs only, so the service never fetches arbitrary image URLs or opens caller-selected host paths. Codex staging uses exclusive owner-only files and removes them after execution or interrupted-job recovery. Image jobs freeze worker/profile configuration in private database metadata. These snapshots may include owner-configured environment values; they are never included in public job records. A verified-revision request header binds admission to the model capability that the caller inspected.

The application declares its functions and executes returned calls. The bridge validates names and arguments but does not execute function code. Grant application tools only the authority they need. Treat prompt and tool output as untrusted input to that application.

## Data and audit

The database can contain prompts, original image attachments, complete file contents, commands, tool outputs, and remote responses. Audit export preserves these payloads. Protect the data directory, exports, logs, backups, and job workspaces as developer data. Local audit history is an operational record; the operating-system user can modify the database.

Back up a stopped service and its SQLite sidecars. The bridge retains jobs and audit until the operator deliberately archives them. Monitor disk usage and restrict backup access.

## Remote access

The listener stays bound to `127.0.0.1`. A [tunnel](tunnels.md) can provide an HTTPS edge with exact host/origin allowlists and an additional access policy. Bridge bearer authentication still applies. Keep the owner token local and issue a scoped token to each trusted remote client.

Report security problems privately through the channel in [SECURITY.md](../SECURITY.md). Keep private prompts, tokens and provider login material out of public issues.

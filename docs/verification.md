---
description: Verify bridge source, SDK contracts, browser flows and native packages, with separate acceptance for actual provider execution.
---

<!-- Copyright (c) 2026 Signature Management Consultants SLU; Author: @ancongui. Modified by Firefly Software Foundation for Firefly Agent Bridge (2026). SPDX-License-Identifier: Apache-2.0. -->

# Verification

`npm run check` runs the complete local release gate: TypeScript, ESLint, formatting, unit/integration tests, Python OpenAI/Pydantic AI clients, browser interactions, bundled build, notice/documentation/OpenAPI checks, scoped prose checks, strict MkDocs build, platform packaging and clean-directory native MCP smoke test.

The gate also verifies the native Agentic prompt catalog. Use `BRIDGE_PROMPT_PYTHON` for the separate compiler environment containing `scripts/prompts-requirements.txt`. Keep the existing SDK client and documentation environment selected by `BRIDGE_PYTHON`; its pinned requirements do not change. CI creates the compiler environment under `RUNNER_TEMP` without installing Agentic into the SDK environment. `npm run prompts:check` renders the maintained YAML with the pinned framework, checks the generated catalog and tests malformed authoring. Protocol tests compare the retained instruction bytes and keep Jinja-looking caller text opaque. See [prompt maintenance](prompts.md) for the authoring workflow.

Deterministic tests cover transactional admission, principal isolation, idempotency, fenced attempts, restart recovery, pause/resume, cancellation, quota gates, workflow checkpoints, channel claims, audit retention and native subprocess bounds. Codex tests specifically cover ChatGPT readiness, alternate-billing rejection, native session continuity, explicit terminal success, audit provenance, default sandbox and unknown quota reset times.

Browser tests verify both theme palettes, system preference changes, theme-only storage, exact shared shell geometry, and mobile overflow. They also cover job conversations, workflows, token access, command/file inspections, event replay, keyboard use and 320 to 1440 pixel layouts. Screenshots are produced from the actual running console with deterministic fixtures.

The opt-in `npm run test:live:codex` records local evidence for a real official signed-in Codex worker. It creates and reads only a file in its job directory, resumes that same native thread, and verifies a standard Chat Completion. Evidence stays under ignored `work/` and contains no printed bearer credentials.

Provider login, CLI availability, managed policy, rate limits and host extension consent must be checked on the actual developer host. Deterministic workers test the protocol. Live provider acceptance requires a signed-in host and a completed, validated turn; process exit alone does not establish job success. Native external actions still require reconciliation after uncertain outcomes.

<a id="private-documentation"></a>

## Build documentation

Install `docs/requirements.txt` into the Python environment selected by `BRIDGE_PYTHON`, then run `npm run docs:build`. The strict build writes `work/docs-site`. Serve that directory on loopback to review it before deployment. The builder includes Markdown pages, local assets, theme variants, fonts and example files; brand-kit source stays outside the site.

The home-page illustration is an original Bridge span mesh rendered with pinned Three.js 0.186.1. Moving packets demonstrate two-way requests and responses; they do not connect to a bridge, run jobs or call a model. The strict builder bundles the first-party scene source into ignored staging, includes the Three.js MIT and artwork notices, and versions local CSS and scene script URLs by content. No CDN is needed.

`npm run docs:test` checks the motion gates and generated assets. After building the site, `npm run docs:test:browser` checks real WebGL rendering, play/pause, reduced motion, both themes, phone resizing, viewport suspension, GPU cleanup and the static fallback. The renderer caps motion at 30 frames per second and pauses in background tabs. These checks do not replace direct visual review.

The prose check catches a small set of editorial regressions outside code and links. It does not automate the Humanizer's contextual judgment. Manual review preserves technical claims, API labels, commands, and limitations while removing repetitive or promotional wording.

## 0.2.18 diagram readability

The documentation browser checks measure the smallest rendered SVG label at 320, 390, 768, 1024 and 1440 pixels in both themes. Labels stay at least 12 CSS pixels high, the selected theme and narrow variant match the viewport, and the page stays within its viewport. A separate check loads all 36 generated SVGs, verifies the embedded Manrope face and checks every label against its canvas and card bounds. The source build tests preserve escaped alternative text and relative asset paths on the landing page and guide pages.

The maintained diagram content generates both SVG and PNG variants. Browser geometry checks accompany direct visual review of the reading view; they do not establish actual provider execution.

## 0.2.17 readiness regression

The completion regressions hold a readiness check open while the previous snapshot reports an authentication failure. Buffered and streaming requests wait for the fresh successful result, execute one controlled worker attempt and return the retained completion. A separate unavailable case reuses the same readiness object and proves that the fresh check returns HTTP 503 without executing a worker.

These tests exercise actual local HTTP admission and scheduler behavior with controlled workers. The release gate separately checks the Python clients, console, strict documentation and native package. Actual provider sign-in, subscription execution and forge delivery remain separate acceptance steps.

## 0.2.4 console checks

The console checks cover anonymous destination gating, 120-pixel phone chrome, native modal navigation, Escape and focus restoration, three-step job validation and Back behavior, masked token creation, explicit permission choices, expired access cleanup, job admission replay, and image-probe failure without a false vision claim. Named workflow inputs replace the primary JSON box; JSON remains an explicit advanced option. Diagnostic values are tested against their card width so worker names and states remain readable. Existing conversation, workflow, file/audit and footer checks remain in the release gate.

An isolated official-Codex preview is reviewed directly in light and dark at 1280×720, 390×844 and 320×568. Phone token fields and Connect remain above the footer; the old first-entry layout placed the token below the screen. Provider setup and Diagnostics use natural page flow; complete data and fields remain readable, and actions follow the content without covering it. Fixture examples are labeled separately from actual subscription execution.

A fresh console journey used the authenticated official Codex worker to create a small file inside its job workspace and continue the same native session. The first image challenge misread one digit and remained unverified; a second explicit owner check passed. Both outcomes are retained, with no automatic probe retry.

Version 0.2.4 passed 123 unit/integration tests, seven Python SDK cases, 36 browser journeys, and the complete Linux, macOS and Windows native matrix. All five product downloads matched SHA256SUMS; all six downloaded files matched GitHub asset digests. Downloaded macOS portable and MCP bundle servers passed authenticated stdio/HTTP MCP, console-module and font checks. The MCP bundle also passed a direct browser review and official Codex readiness check without another model call. See the [0.2.4 release](https://github.com/fireflyframework/firefly-agent-bridge/releases/tag/v0.2.4). These checks do not establish a Claude subscription session or ChatGPT web connection.

## 0.2.3 image checks

The attachment tests cover canonical data URLs, real PNG/JPEG/WebP frames, aggregate decoded limits, invalid checksums, pixel bounds, PNG expansion bombs, role restrictions, and the Chat Completions body limit. Worker checks inspect exclusive image files and verify cleanup on success, cancellation, and setup failure. Recovery checks remove interrupted image files and reject in-place resume or retry even when no native session ID was observed.

The capability checks cover owner authorization, durable probe replay, failed recognition, successful proof recording, and configuration invalidation. Deterministic workers exercise protocol and persistence; they do not establish provider vision support.

A separate real Codex ChatGPT-subscription check returned eight random digits that existed only as PNG pixels. The expected code was absent from the text prompt, schema, and filename. The same probe request reused its durable job, and staged files were absent after completion. Claude image subscription acceptance remains unverified. Run `npm run test:live:codex:images` to repeat this bounded check on an authenticated host; its private evidence stays under ignored `work/`.

Version 0.2.3 passed the complete local gate and all three native CI targets. All five product assets were downloaded and checked against SHA256SUMS and GitHub asset digests. Downloaded macOS native and MCP bundle servers passed authenticated HTTP/MCP checks; the MCP bundle server also passed the image-only Codex challenge. These checks do not claim a ChatGPT web connector installation.

## 0.2.2 patch checks

The 0.2.1 release attempt stopped when repeated browser logins exhausted a shared test principal's request budget. That tag remains unpublished. Version 0.2.2 creates a separate owner principal for each default test login, with a regression proving distinct identities; production limits are unchanged.

The patch gate covers 103 unit/integration tests, seven real Python SDK compatibility cases against a deterministic worker, and 20 browser journeys. The new mobile navigation regression proves that switching views returns to the destination heading rather than keeping the previous panel's scroll position.

A separate isolated Chromium review covers all four provider-wizard steps and Diagnostics in light and dark at 320, 390, 1024, 1440, 1920 and 2560 pixels. The native local preview uses the official signed-in Codex worker for actual readiness checks; it submits no model jobs. Updated screenshots show the current wizard and Diagnostics. Existing subscription execution evidence below belongs to 0.2.0 and is not relabeled as a new patch acceptance.

Version and packaging checks include the CLI, HTTP, MCP, desktop/plugin manifests, installation examples, generated OpenAPI and embedded setup module. Release publication still depends on the complete three-platform native matrix and verified downloaded assets.

## 0.2.0 release checks

The local release checks cover 103 unit and integration tests, seven OpenAI/Pydantic AI SDK cases, and 13 browser journeys. Types, lint, formatting, generated API/version contracts, license notices, and the strict documentation build also run before packaging. Native smoke checks compare CLI, HTTP, MCP, and Codex plugin release versions, then connect two stdio hosts to one authenticated service and inspect its embedded theme assets.

Browser screenshots use the running fixture service in light and dark at desktop and mobile widths. The shell keeps content in a scroll row and aligns desktop status and legal footer rows without covering forms. The footer regression compares connected and disconnected states in both themes at 1440, 1280, and 1024 pixels, plus a scaled 960-pixel viewport; borders, heights, and text positions match within one pixel. Fixture screenshots demonstrate console behavior; they do not claim that sample tasks ran against a provider.

Fresh official Codex subscription checks for this change verified file creation and reading inside a job directory, continuation of the same native session, a native packaged MCP submission, and a caller-owned `add(2,5)` function exchange returning `7`. The caller executed the function once, with no native inference actions. Claude subscription acceptance remains dependent on an authenticated developer host. ChatGPT remote MCP still requires the organization's reachable HTTPS gateway and supported authentication; no remote account connection is claimed.

The release workflow must pass the complete native matrix on macOS arm64, Linux x64, and Windows x64 before publishing those assets. A local macOS package check does not establish the other two platforms.

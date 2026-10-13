/*!
 * Copyright (c) 2026 Signature Management Consultants SLU
 * Author: @ancongui (https://github.com/ancongui)
 * Modified by Firefly Software Foundation for Firefly Agent Bridge (2026).
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { test, expect } from "@playwright/test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { startService } from "../../src/service.js";
import { parseConfig } from "../../src/config.js";
import { Tokens } from "../../src/auth.js";

test("provider setup keeps one focused step and preserves profile selection", async ({
  page,
}) => {
  await login(page);
  await navigate(page, "providers");
  await expect(
    page.getByRole("heading", { name: "Provider setup guide", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".toolbar")).toBeHidden();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Subscription login",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByLabel("Execution profile", { exact: true })
    .selectOption("default");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Development tools",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(
    page.getByLabel("Execution profile", { exact: true }),
  ).toHaveValue("default");
  if (process.env.UPDATE_SCREENSHOTS === "1") {
    const original = page.viewportSize()!;
    for (const [width, height, size] of [
      [1440, 1050, "desktop"],
      [390, 844, "mobile"],
    ] as const) {
      await page.setViewportSize({ width, height });
      for (const [step, label] of [
        "provider",
        "login",
        "profile",
        "tools",
      ].entries()) {
        await page.locator(`[data-setup-step="${step}"]`).click();
        await captureAction(
          page,
          `setup-${label}-${size}`,
          step === 3 ? "#setup-start-job" : "#setup-next",
        );
        if (step === 2) await capture(page, `providers-${size}`);
      }
    }
    await page.setViewportSize(original);
  }
});
let service: Awaited<ReturnType<typeof startService>>, directory: string;
const owner = { id: "owner", owner: true, profiles: ["default"] };
test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "bridge-dashboard-"));
  service = await startService(
    parseConfig({
      dataDir: directory,
      workspace: join(directory, "jobs"),
      claudePath: process.execPath,
      port: 0,
      workflows: [
        {
          id: "research-and-review",
          inputs: ["topic"],
          steps: [
            { id: "research", prompt: "Research {{input.topic}}" },
            { id: "review", prompt: "Review {{steps.research}}" },
          ],
        },
      ],
    }),
    {
      worker: () => ({
        ready: async () => ({ ready: true }),
        run: async ({ job }, emit) => {
          emit({ kind: "output", text: "Working on your request" });
          if (job.completion)
            return {
              status: "succeeded",
              result: JSON.stringify({
                content:
                  "Your bridge is ready for OpenAI-compatible applications.",
                tool_calls: [],
              }),
              usage: {
                prompt_tokens: 12,
                completion_tokens: 8,
                total_tokens: 20,
              },
            };
          return {
            status: "succeeded",
            result:
              "Completed: " +
              job.messages.filter((m) => m.role === "user").at(-1)!.text,
          };
        },
      }),
    },
  );
  const first = service.store.submit(
    { prompt: "Prepare the weekly operations summary" },
    owner,
  );
  const attempt = service.store.claim("fixture", "cli", first.id)!;
  for (const tool of [
    {
      toolId: "read-notes",
      name: "Read",
      phase: "requested" as const,
      file: { path: "notes/operations.md", operation: "read" as const },
      input: { file_path: "notes/operations.md" },
    },
    {
      toolId: "read-notes",
      phase: "succeeded" as const,
      output: {
        content:
          "# Operations\nLaunch checklist: pending\nOwner: Platform team",
      },
    },
    {
      toolId: "edit-notes",
      name: "Edit",
      phase: "requested" as const,
      file: { path: "notes/operations.md", operation: "edit" as const },
      input: {
        file_path: "notes/operations.md",
        old_string: "Launch checklist: pending",
        new_string: "Launch checklist: ready for review",
      },
    },
    {
      toolId: "edit-notes",
      phase: "succeeded" as const,
      output: { content: "The file has been updated successfully." },
    },
    {
      toolId: "check-tests",
      name: "Bash",
      phase: "requested" as const,
      input: {
        command: "npm run test:integration",
        description: "Check the integration suite",
      },
    },
    {
      toolId: "check-tests",
      phase: "succeeded" as const,
      output: {
        content: "12 tests passed",
        result: {
          stdout:
            "PASS tests/integration/bridge.test.ts\nTests: 12 passed, 12 total\nTime: 1.84 s",
          stderr: "",
          interrupted: false,
        },
      },
    },
  ])
    service.store.observe(attempt, {
      kind: "tool",
      text: "Tool activity observed",
      tool,
    });
  service.store.observe(attempt, {
    kind: "compaction",
    text: "Conversation compacted",
    data: { trigger: "auto", pre_tokens: 124000 },
  });
  service.store.observe(attempt, {
    kind: "subagent",
    text: "Review complete",
    data: {
      taskId: "reviewer",
      status: "completed",
      description: "Check findings against source notes",
    },
  });
  service.store.finish(attempt, {
    status: "succeeded",
    result:
      "The operations summary is ready. Three priorities need attention: review the onboarding queue, confirm the launch checklist, and close the remaining documentation gaps.",
    sessionId: "11111111-1111-4111-8111-111111111111",
  });
  const second = service.store.submit(
    { prompt: "Review the integration test results" },
    owner,
  );
  service.store.pause(second.id, owner);
  service.store.submit(
    {
      prompt: "Await a design review in the current conversation",
      mode: "channel",
    },
    owner,
  );
});
test.afterAll(async () => {
  await service.close();
  rmSync(directory, { recursive: true, force: true });
});
async function login(page: import("@playwright/test").Page, bearer?: string) {
  bearer ??= new Tokens(service.store).create({
    id: "browser-login-" + randomUUID(),
    owner: true,
    profiles: ["default"],
  }).token;
  await page.goto(service.address);
  await page.getByLabel("Bridge token", { exact: true }).fill(bearer);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#workspace")).toBeVisible();
  await expect(page.locator("#stream-state")).toContainText("Live");
}
async function navigate(page: import("@playwright/test").Page, view: string) {
  if (
    (await page.locator("#mobile-menu-button").isVisible()) &&
    !(await page
      .locator("#mobile-menu")
      .evaluate((node) => (node as HTMLDialogElement).open))
  )
    await page.locator("#mobile-menu-button").click();
  await page.locator('[data-view="' + view + '"]').click();
}
async function reviewJob(page: import("@playwright/test").Page) {
  await page.locator("#job-next").click();
  await page.locator("#job-next").click();
}
async function captureAction(
  page: import("@playwright/test").Page,
  name: string,
  selector: string,
) {
  if (process.env.UPDATE_SCREENSHOTS !== "1") return;
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const action = page.locator(selector);
  const probe = () =>
    action.evaluate((node) => {
      const button = node.getBoundingClientRect(),
        footer = document
          .querySelector("main > footer")!
          .getBoundingClientRect();
      const x = button.x + button.width / 2;
      return {
        button: {
          top: button.top,
          bottom: button.bottom,
          left: button.left,
          right: button.right,
        },
        footer: { top: footer.top, bottom: footer.bottom },
        workspaceScroll: document.getElementById("content")!.scrollTop,
        hitCenter:
          document
            .elementFromPoint(x, button.y + button.height / 2)
            ?.closest("button") === node,
        hitBottom:
          document.elementFromPoint(x, button.bottom - 2)?.closest("button") ===
          node,
      };
    });
  const before = await probe();
  await action.scrollIntoViewIfNeeded();
  await page.locator("#content").evaluate((content) => {
    const heading = document
      .getElementById("view-title")
      ?.getBoundingClientRect();
    const frame = content.getBoundingClientRect();
    if (heading && heading.top < frame.top && heading.bottom > frame.top)
      content.scrollTop += heading.bottom - frame.top + 8;
  });
  await expect(action).toBeInViewport({ ratio: 0.99 });
  const after = await probe();
  expect(after.button.bottom).toBeLessThanOrEqual(after.footer.top);
  expect(after.hitCenter).toBe(true);
  expect(after.hitBottom).toBe(true);
  await capture(page, name);
  const captured = await probe();
  expect(captured.button.bottom).toBeLessThanOrEqual(captured.footer.top);
  expect(captured.hitBottom).toBe(true);
  if (process.env.SCREENSHOT_METADATA) {
    const path = process.env.SCREENSHOT_METADATA + ".controls.json";
    const rows = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
    rows.push({
      name,
      selector,
      viewport: page.viewportSize(),
      before,
      after,
      captured,
    });
    writeFileSync(path, JSON.stringify(rows, null, 2) + "\n");
  }
}
async function capture(page: import("@playwright/test").Page, name: string) {
  if (process.env.UPDATE_SCREENSHOTS !== "1") return;
  mkdirSync("assets/screenshots", { recursive: true });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const viewport = page.viewportSize()!;
  const preference = await page.locator("#appearance").inputValue();
  const release = JSON.parse(readFileSync("package.json", "utf8")).version;
  const version = await page.locator(".version").first().textContent();
  expect(version?.trim()).toBe("v" + release);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  async function save(filename: string) {
    const path = "assets/screenshots/" + filename + ".png";
    // The application scrolls its workspace independently of the shell. Keep that real viewport.
    await page.screenshot({ animations: "disabled", path, fullPage: false });
    expect(page.viewportSize()).toEqual(viewport);
    const metadataPath = process.env.SCREENSHOT_METADATA;
    if (!metadataPath) return;
    const entries = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<
      string,
      unknown
    >[];
    entries.push({
      path,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      viewport,
      theme: await page.locator("html").getAttribute("data-theme"),
      version: version?.trim(),
      fixture: true,
      openDialogs: await page.locator("dialog[open]").count(),
      workspaceScroll: await page
        .locator("#content")
        .evaluate((node) => node.scrollTop),
      capturedAt: new Date().toISOString(),
    });
    writeFileSync(metadataPath, JSON.stringify(entries, null, 2) + "\n");
  }
  await save(name);
  if (!/-(?:light|dark)(?:-|$)/.test(name)) {
    for (const theme of ["light", "dark"]) {
      await page.locator("#appearance").selectOption(theme);
      await save(name + "-" + theme);
    }
    await page.locator("#appearance").selectOption(preference);
  }
}

test("shared shell honors system appearance, preserves only theme, and stays aligned in both palettes", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(service.address);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(
    await page
      .locator(".shell-header")
      .evaluate((n) => n.getBoundingClientRect().height),
  ).toBe(76);
  expect(
    await page
      .locator(".wordmark")
      .evaluate((n) => n.getBoundingClientRect().height),
  ).toBe(76);
  expect(
    await page
      .locator(".rail")
      .evaluate((n) => n.getBoundingClientRect().width),
  ).toBe(248);
  await page.getByLabel("Appearance", { exact: true }).selectOption("light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const appearanceOwner = new Tokens(service.store).create({
    id: "appearance-review",
    owner: true,
    profiles: ["default"],
  }).token;
  await login(page, appearanceOwner);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([
    "firefly-bridge-theme",
  ]);
  for (const theme of ["light", "dark"]) {
    await page.getByLabel("Appearance", { exact: true }).selectOption(theme);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      for (const view of ["jobs", "workflows", "providers", "diagnostics"]) {
        await navigate(page, view);
        await expect(page.locator("#" + view + "-view")).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        if (width !== 320)
          await capture(
            page,
            view + "-" + theme + "-" + (width === 1440 ? "desktop" : "mobile"),
          );
      }
    }
  }
  await page.getByLabel("Appearance", { exact: true }).selectOption("system");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
test("connection explains loading and authentication errors while keeping credentials out of browser storage", async ({
  page,
}) => {
  await page.route("**/v1/bridge/status", async (route) => {
    await new Promise((r) => setTimeout(r, 250));
    await route.continue();
  });
  await page.goto(service.address);
  await page.getByLabel("Bridge token", { exact: true }).fill("ffb_invalid");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Connecting…", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("#notice")).toContainText("authentication", {
    ignoreCase: true,
  });
  await expect(page.locator("#token")).toBeFocused();
  await expect(page.locator("#workspace")).toBeHidden();
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((k) => k !== "firefly-bridge-theme"),
    ),
  ).toEqual([]);
});
test("desktop renders branded state, safely displays output, and supports bidirectional follow-up", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(service.address);
  await capture(page, "connect-desktop");
  await login(page);
  await page
    .getByRole("button", {
      name: "Prepare the weekly operations summary",
      exact: true,
    })
    .click();
  await expect(page.locator("#job-meta")).toContainText("1 compactions");
  await expect(page.locator("#subagents")).toContainText("completed");
  await expect(page.locator("#summary")).toContainText("Permissions enabled");
  await capture(page, "dashboard-desktop");
  await page
    .getByLabel("Continue this conversation")
    .fill("Summarize the next action <img src=x onerror=alert(1)>");
  await page
    .getByRole("button", { name: "Send follow-up", exact: true })
    .click();
  await expect(page.locator("#messages")).toContainText(
    "Completed: Summarize the next action",
  );
  expect(await page.locator("#messages img").count()).toBe(0);
  await navigate(page, "diagnostics");
  await expect(page.locator("#diagnostics")).toContainText(
    '"permissionMode": "default"',
  );
  await expect(page.locator("#tokens")).toContainText("owner");
  await capture(page, "diagnostics-desktop");
  expect(errors).toEqual([]);
});
test("activity and files expose full tool payloads, diffs, audit export, and responsive keyboard tabs", async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole("button", {
      name: "Prepare the weekly operations summary",
      exact: true,
    })
    .click();
  await page.getByRole("tab", { name: "Activity", exact: false }).click();
  await expect(page.locator("#audit-summary")).toContainText("3 tool calls");
  await page
    .locator("#tool-list .tool-card")
    .filter({ hasText: "Bash" })
    .locator("summary")
    .first()
    .click();
  await expect(page.locator("#tool-list")).toContainText(
    "npm run test:integration",
  );
  await expect(page.locator("#tool-list")).toContainText("12 passed, 12 total");
  await page
    .locator("#tool-list .tool-card[open]")
    .first()
    .scrollIntoViewIfNeeded();
  await capture(page, "activity-desktop");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "Activity", exact: false }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#tool-list details[open]")).toHaveCount(1);
  await page.getByRole("tab", { name: "Activity", exact: false }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Files", exact: false }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#file-coverage")).toContainText(
    "targets reported by the coding agent",
  );
  await page
    .locator("#file-list .tool-card")
    .filter({ hasText: "Edit" })
    .locator("summary")
    .first()
    .click();
  await expect(page.locator("#file-list")).toContainText(
    "Launch checklist: pending",
  );
  await expect(page.locator("#file-list")).toContainText(
    "Launch checklist: ready for review",
  );
  await page
    .locator("#file-list .tool-card[open]")
    .first()
    .scrollIntoViewIfNeeded();
  await capture(page, "files-desktop");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export audit", exact: true }).click();
  const saved = await download;
  const data = JSON.parse(
    await (
      await import("node:fs/promises")
    ).readFile((await saved.path())!, "utf8"),
  );
  expect(
    data.entries.some(
      (e: { data: { input?: { command?: string } } }) =>
        e.data.input?.command === "npm run test:integration",
    ),
  ).toBe(true);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const tab of ["Activity", "Files"]) {
      await page.getByRole("tab", { name: tab, exact: false }).click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      if (width === 390) {
        await page
          .locator(
            tab === "Activity"
              ? "#tool-list .tool-card[open]"
              : "#file-list .tool-card[open]",
          )
          .first()
          .scrollIntoViewIfNeeded();
        await capture(page, tab.toLowerCase() + "-mobile");
      }
    }
  }
});
test("mobile has no horizontal overflow and exposes job and workflow controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  if (process.env.UPDATE_SCREENSHOTS === "1") {
    await page.goto(service.address);
    await capture(page, "connect-mobile");
  }
  await login(page);
  await page
    .getByRole("button", {
      name: "Review the integration test results",
      exact: true,
    })
    .click();
  await expect(page.locator("#detail-state")).toContainText("paused");
  await capture(page, "dashboard-mobile");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .locator("#job-actions")
    .getByRole("button", { name: "Resume", exact: true })
    .click();
  await expect(page.locator("#detail-state")).toContainText("succeeded");
  await navigate(page, "workflows");
  await page.getByLabel("Topic", { exact: true }).fill("local orchestration");
  await page
    .getByRole("button", { name: "Start workflow", exact: true })
    .click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#workflow-runs")).toContainText("succeeded", {
    timeout: 15000,
  });
  await capture(page, "workflows-mobile");
});
test("owner can create and revoke a scoped application token", async ({
  page,
}) => {
  await login(page);
  await navigate(page, "diagnostics");
  await page.getByLabel("Client name").fill("test-client");
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  await expect(page.locator("#created-token")).toHaveValue(/^ffb_/);
  await expect(page.locator("#created-token")).toHaveAttribute(
    "type",
    "password",
  );
  const token = await page.locator("#created-token").inputValue();
  expect(
    (
      await fetch(service.address + "/v1/bridge/status", {
        headers: { Authorization: "Bearer " + token },
      })
    ).status,
  ).toBe(200);
  await page
    .locator(".token-row")
    .filter({ hasText: "test-client" })
    .getByRole("button", { name: "Revoke" })
    .click();
  await expect(page.locator("#tokens")).toContainText("test-client (revoked)");
  expect(
    (
      await fetch(service.address + "/v1/bridge/status", {
        headers: { Authorization: "Bearer " + token },
      })
    ).status,
  ).toBe(401);
});
test("all console views render across the layout breakpoints and the new-job dialog executes work", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "New job", exact: false }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByLabel("What should the coding agent work on?")
    .fill("Verify the installation checklist");
  await capture(page, "new-job-desktop");
  await page.locator("#job-next").click();
  await capture(page, "new-job-execution-desktop");
  await page.locator("#job-next").click();
  await capture(page, "new-job-review-desktop");
  if (process.env.UPDATE_SCREENSHOTS === "1") {
    const original = page.viewportSize()!;
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, "new-job-review-mobile");
    await page.locator("#job-back").click();
    await capture(page, "new-job-execution-mobile");
    await page.locator("#job-back").click();
    await capture(page, "new-job-mobile");
    await reviewJob(page);
    await page.setViewportSize(original);
  }
  await page.getByRole("button", { name: "Queue job", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator("#messages")).toContainText(
    "Completed: Verify the installation checklist",
  );
  await navigate(page, "workflows");
  await expect(page.locator("#workflow-runs")).toContainText(
    "research-and-review",
  );
  await capture(page, "workflows-desktop");
  await page
    .getByRole("button", { name: "Open step 1", exact: true })
    .first()
    .click();
  await expect(page.locator("#jobs-view")).toBeVisible();
  await expect(page.locator("#messages")).toContainText(
    "Research local orchestration",
  );
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    for (const view of ["jobs", "workflows", "diagnostics"]) {
      await navigate(page, view);
      await expect(page.locator("#" + view + "-view")).toBeVisible();
      const overflow = await page.evaluate(() =>
        [...document.querySelectorAll("*")]
          .filter(
            (n) =>
              n.getBoundingClientRect().right > innerWidth + 1 &&
              getComputedStyle(n).display !== "none",
          )
          .map((n) => n.tagName + "#" + n.id + "." + n.className),
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        width + " / " + view + " / " + overflow.join(", "),
      ).toBe(true);
      expect(
        Math.round(
          await page
            .locator("footer")
            .evaluate((n) => n.getBoundingClientRect().bottom),
        ),
      ).toBe(960);
      if (width === 768) await capture(page, view + "-tablet");
      if (width === 320 && view === "diagnostics")
        await capture(page, "diagnostics-mobile");
    }
  }
});
test("template editor validates references, saves reusable steps, and runs the new definition", async ({
  page,
}) => {
  await login(page);
  await navigate(page, "workflows");
  await page.getByRole("button", { name: "New template", exact: true }).click();
  await page.getByLabel("Template ID", { exact: true }).fill("draft-and-check");
  await page
    .getByLabel("Purpose", { exact: true })
    .fill("Draft a response and check it against the requested topic.");
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  const second = page.locator(".step-editor").nth(1);
  await second.getByLabel("Step ID", { exact: true }).fill("review");
  await second
    .getByLabel("Step instructions", { exact: true })
    .fill("Review {{steps.missing}}");
  await page
    .getByRole("button", { name: "Save template", exact: true })
    .click();
  await expect(page.locator("#template-error")).toContainText(
    "Invalid workflow reference",
  );
  await second
    .getByLabel("Step instructions", { exact: true })
    .fill("Review {{steps.research}} for accuracy.");
  await capture(page, "template-editor-desktop");
  if (process.env.UPDATE_SCREENSHOTS === "1") {
    await second
      .getByLabel("Step instructions", { exact: true })
      .scrollIntoViewIfNeeded();
    await capture(page, "template-editor-steps-desktop");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capture(page, "template-editor-mobile");
  if (process.env.UPDATE_SCREENSHOTS === "1") {
    await second
      .getByLabel("Step instructions", { exact: true })
      .scrollIntoViewIfNeeded();
    await capture(page, "template-editor-steps-mobile");
  }
  await page
    .getByRole("button", { name: "Save template", exact: true })
    .click();
  await expect(page.locator("#template-dialog")).not.toBeVisible();
  await expect(page.locator("#templates-list")).toContainText(
    "draft-and-check",
  );
  await page.locator("#template").selectOption("draft-and-check");
  await page.getByLabel("Topic", { exact: true }).fill("template validation");
  await page
    .getByRole("button", { name: "Start workflow", exact: true })
    .click();
  await expect(
    page.locator(".run").filter({ hasText: "draft-and-check" }),
  ).toContainText("succeeded", { timeout: 15000 });
});

test("completion jobs share the queue, show readable output and usage, and expose client connection details", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "New job", exact: false }).click();
  await page
    .getByLabel("What should the coding agent work on?")
    .fill("Confirm the bridge is ready for my application");
  await page.locator("#job-next").click();
  await page.locator("#mode").selectOption("inference");
  const submission = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/v1/chat/completions"),
  );
  await page.locator("#job-next").click();
  await page.getByRole("button", { name: "Queue job", exact: true }).click();
  expect((await submission).postDataJSON().bridge).toEqual({
    execution: "inference",
    background: true,
  });
  await expect(page.locator("#messages")).toContainText("Your bridge is ready");
  await expect(page.locator("#messages")).not.toContainText('"tool_calls"');
  await expect(page.locator("#job-meta")).toContainText("20 tokens");
  await expect(page.locator("#message-form")).toBeHidden();
  await capture(page, "completion-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, "completion-mobile");
  await navigate(page, "diagnostics");
  await expect(page.locator("#diagnostics-view")).toContainText(
    "bridge/default",
  );
  await expect(page.locator("#diagnostics-view")).toContainText(
    service.address + "/v1",
  );
});

test("keeps recent jobs visible and preserves loaded history across refreshes", async ({
  page,
}) => {
  for (let i = 0; i < 205; i++)
    service.store.submit(
      { prompt: "History entry " + i, mode: "channel" },
      owner,
    );
  await login(page);
  await expect(
    page.getByRole("button", { name: "History entry 204", exact: true }),
  ).toBeVisible();
  await page.locator("#more").click();
  await expect(
    page.getByRole("button", { name: "History entry 0", exact: true }),
  ).toBeAttached();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "History entry 0", exact: true }),
  ).toBeAttached();
  await expect(
    page.getByRole("button", { name: "History entry 204", exact: true }),
  ).toBeAttached();
});

test("audit pagination survives refresh and renders untrusted payloads as text", async ({
  page,
}) => {
  const job = service.store.submit(
      { prompt: "Inspect tool payload safety" },
      owner,
    ),
    attempt = service.store.claim("fixture", "cli", job.id)!;
  for (let index = 0; index < 27; index++) {
    const toolId = "safe-" + index;
    service.store.observe(attempt, {
      kind: "tool",
      text: "tool",
      tool: {
        toolId,
        name: "Write",
        phase: "requested",
        file: { path: `files/item-${index}.txt`, operation: "write" },
        input: {
          file_path: `files/item-${index}.txt`,
          content: '<img src=x onerror="window.auditInjected=true">',
        },
      },
    });
    service.store.observe(attempt, {
      kind: "tool",
      text: "tool",
      tool: { toolId, phase: "succeeded", output: { content: "Written" } },
    });
  }
  service.store.finish(attempt, {
    status: "succeeded",
    result: "Fixture ready",
  });
  let releaseAttempts!: () => void;
  const attemptsGate = new Promise<void>((resolve) => {
    releaseAttempts = resolve;
  });
  await page.route(`**/jobs/${job.id}/attempts`, async (route) => {
    await attemptsGate;
    await route.continue();
  });
  await login(page);
  await page
    .getByRole("button", { name: "Inspect tool payload safety", exact: true })
    .click();
  await page.getByRole("tab", { name: "Files", exact: false }).click();
  releaseAttempts();
  await expect(
    page.getByRole("tab", { name: "Files", exact: false }),
  ).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(async () => ({
      count: await page.locator("#file-list .tool-card").count(),
      notice: await page.locator("#notice").textContent(),
      tab: await page.locator("#tab-files").getAttribute("aria-selected"),
    }))
    .toMatchObject({ count: 25 })
    .catch(async (error) => {
      throw new Error(
        error.message +
          "\nPanel state: " +
          JSON.stringify({
            notice: await page.locator("#notice").textContent(),
            tab: await page.locator("#tab-files").getAttribute("aria-selected"),
          }),
      );
    });
  await page
    .getByRole("button", { name: "Load more file actions", exact: true })
    .click();
  await expect(page.locator("#file-list .tool-card")).toHaveCount(27);
  await page
    .locator("#file-list .tool-card")
    .last()
    .locator("summary")
    .first()
    .click();
  await expect(page.locator("#file-list")).toContainText(
    "window.auditInjected=true",
  );
  expect(await page.locator("#file-list img").count()).toBe(0);
  expect(
    await page.evaluate(() => Object.hasOwn(window, "auditInjected")),
  ).toBe(false);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#file-list .tool-card")).toHaveCount(27);
  await expect(page.locator("#file-list .tool-card[open]")).toHaveCount(1);
});

test("creating a job clears previous audit evidence before a failed attempts request", async ({
  page,
}) => {
  const previous = service.store.submit(
      { prompt: "Previous audit selection" },
      owner,
    ),
    attempt = service.store.claim("fixture", "cli", previous.id)!;
  service.store.observe(attempt, {
    kind: "tool",
    text: "tool",
    tool: {
      toolId: "previous-file",
      name: "Write",
      phase: "requested",
      file: { path: "previous.txt", operation: "write" },
      input: { content: "Previous evidence" },
    },
  });
  service.store.finish(attempt, {
    status: "succeeded",
    result: "Fixture ready",
  });
  await login(page);
  await page
    .getByRole("button", {
      name: "Previous audit selection",
      exact: true,
    })
    .click();
  await page.getByRole("tab", { name: "Files", exact: false }).click();
  await expect(page.locator("#file-list .tool-card").first()).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/attempts", async (route) => {
    await gate;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "Fixture attempts failure" } }),
    });
  });
  await page.getByRole("button", { name: "New job", exact: false }).click();
  await page
    .getByLabel("What should the coding agent work on?")
    .fill("New selection without stale evidence");
  const attempts = page.waitForRequest((r) => r.url().endsWith("/attempts"));
  await reviewJob(page);
  await page.getByRole("button", { name: "Queue job", exact: true }).click();
  const request = await attempts;
  try {
    await expect(page.locator("#messages")).toContainText(
      "New selection without stale evidence",
    );
    await expect(page.locator("#file-list .tool-card")).toHaveCount(0);
  } finally {
    release();
  }
  await expect(page.locator("#notice")).toContainText(
    "Fixture attempts failure",
  );
  await page.getByRole("tab", { name: "Files", exact: false }).click();
  await expect(page.locator("#file-list")).toContainText(
    "No file targets observed",
  );
  const exportRequest = page.waitForRequest((r) =>
    r.url().includes("includePayloads=true"),
  );
  await page.getByRole("button", { name: "Export audit", exact: true }).click();
  expect((await exportRequest).url()).toContain(
    request.url().replace("/attempts", "/audit"),
  );
});

test("desktop footer borders and text baselines match the rail in both themes", async ({
  page,
  browser,
}) => {
  async function aligned(target: import("@playwright/test").Page) {
    const result = await target.evaluate(() => {
      const rail = document.querySelector(".rail-footer")!,
        footer = document.querySelector("main > footer")!;
      const left = rail.getBoundingClientRect(),
        right = footer.getBoundingClientRect();
      const leftLine = rail
          .querySelector(".connection-row")!
          .getBoundingClientRect(),
        rightLine = footer.querySelector("span")!.getBoundingClientRect();
      return {
        top: Math.abs(left.top - right.top),
        height: Math.abs(left.height - right.height),
        baseline: Math.abs(leftLine.top - rightLine.top),
        footerHeight: right.height,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(result.top).toBeLessThanOrEqual(1);
    expect(result.height).toBeLessThanOrEqual(1);
    expect(result.baseline).toBeLessThanOrEqual(1);
    expect(result.footerHeight).toBe(64);
    expect(result.overflow).toBe(false);
  }
  for (const connected of [false, true]) {
    if (connected) await login(page);
    else await page.goto(service.address);
    for (const theme of ["light", "dark"]) {
      await page.getByLabel("Appearance", { exact: true }).selectOption(theme);
      for (const width of [1440, 1280, 1024]) {
        await page.setViewportSize({ width, height: 1100 });
        await aligned(page);
      }
    }
  }
  await expect(page.locator(".rail-footer")).not.toContainText(
    /Built around your workspace/i,
  );
  await expect(page.locator(".rail-note")).toHaveCount(0);
  await expect(page.locator("main > footer")).not.toContainText(
    /Made for local work/i,
  );
  const context = await browser.newContext({
    viewport: { width: 960, height: 550 },
    deviceScaleFactor: 2,
  });
  const scaled = await context.newPage();
  await login(scaled);
  for (const theme of ["light", "dark"]) {
    await scaled.getByLabel("Appearance", { exact: true }).selectOption(theme);
    await aligned(scaled);
  }
  await context.close();
});

test("switching workspace views returns to the new heading on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const navigationOwner = new Tokens(service.store).create({
    id: "navigation-review",
    owner: true,
    profiles: ["default"],
  }).token;
  await login(page, navigationOwner);
  await navigate(page, "providers");
  await page.locator("#content").evaluate((node) => {
    node.scrollTop = 500;
  });
  await navigate(page, "diagnostics");
  await expect(page.locator("#view-title")).toBeInViewport();
  await expect
    .poll(() => page.locator("#content").evaluate((node) => node.scrollTop))
    .toBe(0);
  await expect(page.locator('[data-view="diagnostics"]')).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("provider guide details follow selection without changing the actual worker", async ({
  page,
}) => {
  const reviewer = new Tokens(service.store).create({
    id: "provider-detail-review",
    owner: true,
    profiles: ["default"],
  }).token;
  await login(page, reviewer);
  await navigate(page, "providers");
  const running = await page
    .locator("#setup-provider-detail-running")
    .innerText();
  const current = running === "Codex" ? "codex" : "claude";
  const other = current === "codex" ? "claude" : "codex";
  await page.locator(`[data-setup-provider="${other}"]`).click();
  await expect(page.locator("#setup-provider-detail-name")).toHaveText(
    other === "claude" ? "Claude Code" : "Codex",
  );
  await expect(page.locator("#setup-provider-detail-badge")).toHaveText(
    "Setup guide",
  );
  await expect(page.locator("#setup-provider-detail-running")).toHaveText(
    running,
  );
  await page.locator(`[data-setup-provider="${current}"]`).click();
  await expect(page.locator("#setup-provider-detail-name")).toHaveText(running);
  await expect(page.locator("#setup-provider-detail-badge")).toHaveText(
    "Current worker",
  );
  await expect(page.locator(".setup-flow")).toHaveCount(0);
});

test("wizard navigation and card edge remain reachable above the footer on short desktops", async ({
  page,
}) => {
  const reviewer = new Tokens(service.store).create({
    id: "short-wizard-review",
    owner: true,
    profiles: ["default"],
  }).token;
  await login(page, reviewer);
  await navigate(page, "providers");
  for (const [width, height] of [
    [1440, 900],
    [1440, 768],
    [1920, 1080],
    [2560, 1440],
    [390, 844],
    [320, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"]) {
      await page.getByLabel("Appearance", { exact: true }).selectOption(theme);
      for (let step = 0; step < 4; step++) {
        await page.locator(`[data-setup-step="${step}"]`).click();
        const next = page.locator(
          step === 3 ? "#setup-start-job" : "#setup-next",
        );

        await next.scrollIntoViewIfNeeded();
        await expect(next).toBeInViewport({ ratio: 0.99 });
        const geometry = await page.evaluate(() => ({
          body: document.querySelector(".setup-body")!.getBoundingClientRect(),
          actions: document
            .querySelector(".setup-footer")!
            .getBoundingClientRect(),
          button: document
            .querySelector(
              "#setup-next:not([hidden]),#setup-start-job:not([hidden])",
            )!
            .getBoundingClientRect(),
          globalFooter: document
            .querySelector("main > footer")!
            .getBoundingClientRect(),
          clipped: getComputedStyle(document.querySelector(".setup-body")!)
            .overflowY,
        }));
        expect(geometry.actions.top).toBeGreaterThanOrEqual(
          geometry.body.bottom,
        );
        expect(geometry.button.bottom).toBeLessThanOrEqual(
          geometry.globalFooter.top,
        );
        expect(geometry.clipped).toBe("visible");
        if (step < 3) await next.click();
      }
    }
  }
});

test("diagnostic cards keep their borders and actions with the visible form", async ({
  page,
}) => {
  const reviewer = new Tokens(service.store).create({
    id: "diagnostic-frame-review",
    owner: true,
    profiles: ["default"],
  }).token;
  await login(page, reviewer);
  await navigate(page, "diagnostics");
  for (const [width, height] of [
    [1440, 768],
    [1920, 1080],
    [2560, 1440],
    [390, 844],
    [320, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"]) {
      await page.getByLabel("Appearance", { exact: true }).selectOption(theme);
      for (const section of ["service", "access"]) {
        if (width <= 900) {
          await page.locator(`[data-diagnostic-tab="${section}"]`).click();
          if (section === "access")
            await expect(
              page.locator("#diagnostic-access-panel"),
            ).toBeVisible();
          else
            await expect(page.locator("#diagnostic-access-panel")).toBeHidden();
        }
        const panel = page.locator(
          section === "service"
            ? "#diagnostic-status-panel"
            : "#diagnostic-access-panel",
        );
        if (width === 390 && section === "access")
          await captureAction(
            page,
            `diagnostics-access-mobile-${theme}`,
            "#diagnostic-access-panel .diagnostic-card-actions button",
          );
        const action = panel.locator(".diagnostic-card-actions button");
        await action.scrollIntoViewIfNeeded();
        await expect(action).toBeInViewport({ ratio: 0.99 });
        const geometry = await panel.evaluate((node) => ({
          body: node
            .querySelector(".diagnostic-card-body")!
            .getBoundingClientRect(),
          action: node
            .querySelector(".diagnostic-card-actions")!
            .getBoundingClientRect(),
          footer: document
            .querySelector("main > footer")!
            .getBoundingClientRect(),
          clipped: getComputedStyle(
            node.querySelector(".diagnostic-card-body")!,
          ).overflowY,
        }));
        expect(geometry.action.top).toBeGreaterThanOrEqual(
          geometry.body.bottom,
        );
        expect(geometry.action.bottom).toBeLessThanOrEqual(geometry.footer.top);
        expect(geometry.clipped).toBe("visible");
        if (section === "access") {
          for (const field of [
            "Client name",
            "Profiles",
            "Application permissions",
          ]) {
            const input = page.getByLabel(field, { exact: true });
            await input.scrollIntoViewIfNeeded();
            await expect(input).toBeInViewport({ ratio: 0.99 });
          }
        }
      }
      if (width <= 900) {
        await page.getByRole("tab", { name: "Service", exact: true }).focus();
        await page.keyboard.press("ArrowRight");
        await expect(
          page.getByRole("tab", { name: "Application access", exact: true }),
        ).toBeFocused();
        await expect(
          page.getByRole("tab", { name: "Application access", exact: true }),
        ).toHaveAttribute("aria-selected", "true");
      }
    }
  }
});

test("wizard headings, labels and selected profile retain readable text bounds", async ({
  page,
}) => {
  const reviewer = new Tokens(service.store).create({
    id: "type-bounds-review",
    owner: true,
    profiles: ["default"],
  }).token;
  await login(page, reviewer);
  await navigate(page, "providers");
  for (const width of [320, 390, 1440, 1920, 2560]) {
    await page.setViewportSize({ width, height: 844 });
    for (let step = 0; step < 4; step++) {
      await page.locator(`[data-setup-step="${step}"]`).click();
      const bounds = await page.evaluate(() => {
        const selectors = [
          "#view-title",
          ".setup-footer button:not([hidden])",
          ".setup-navigation button",
          ".provider-detail-badge",
          "#setup-profile-alias",
          "[data-setup-panel]:not([hidden]) h2",
        ];
        if (innerWidth > 900) selectors.push(".workspace-label strong");
        return selectors.flatMap((selector) =>
          [...document.querySelectorAll(selector)]
            .filter((node) => node.getClientRects().length > 0)
            .map((node) => {
              const range = document.createRange();
              range.selectNodeContents(node);
              const style = getComputedStyle(node);
              return {
                text: node.textContent,
                clipped: node.scrollWidth > node.clientWidth + 1,
                singleLine: node.matches(
                  ".workspace-label strong, .provider-detail-badge",
                ),
                lines: range.getClientRects().length,
                heading: node.tagName.startsWith("H"),
                height: node.getBoundingClientRect().height,
                lineHeight: parseFloat(style.lineHeight),
              };
            }),
        );
      });
      for (const value of bounds) {
        expect(value.clipped, value.text ?? "").toBe(false);
        if (value.singleLine) expect(value.lines, value.text ?? "").toBe(1);
        if (value.heading)
          expect(value.height, value.text ?? "").toBeLessThanOrEqual(
            value.lineHeight + 1,
          );
      }
      if (step < 3) await page.locator("#setup-next").click();
    }
  }
});

test("default browser logins have distinct principals without changing owner access", async ({
  page,
}) => {
  const tokens = new Tokens(service.store);
  const before = new Set(tokens.list().map((principal) => principal.id));
  await login(page);
  await page
    .getByRole("button", { name: "Disconnect session", exact: true })
    .click();
  await login(page);
  const created = tokens
    .list()
    .filter((principal) => !before.has(principal.id));
  expect(created).toHaveLength(2);
  expect(new Set(created.map((principal) => principal.id)).size).toBe(2);
  expect(
    created.every((principal) => principal.owner && !principal.revoked),
  ).toBe(true);
  expect(tokens.verify(service.ownerToken).owner).toBe(true);
});

test("anonymous navigation explains its gate and continues to the chosen destination after connection", async ({
  page,
}) => {
  await page.goto(service.address);
  await expect(page.locator("#view-title")).toHaveText("Connect");
  await expect(page.locator("#job-count")).toBeHidden();
  await navigate(page, "providers");
  await expect(page.locator("#view-title")).toHaveText("Connect");
  await expect(page.locator("#connection-destination")).toContainText(
    "Providers & setup",
  );
  await expect(page.locator('[data-view="providers"]')).not.toHaveAttribute(
    "aria-current",
    "page",
  );
  const bearer = new Tokens(service.store).create({
    id: "gated-" + randomUUID(),
    owner: true,
    profiles: ["default"],
  }).token;
  await page.getByLabel("Bridge token", { exact: true }).fill(bearer);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#providers-view")).toBeVisible();
  await expect(page.locator("#view-title")).toHaveText("Providers & setup");
});
test("phone shell uses 120 pixels of chrome and a keyboard-safe native navigation dialog", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(service.address);
  const chrome = await page.evaluate(
    () =>
      document.querySelector(".rail")!.getBoundingClientRect().height +
      document.querySelector(".shell-header")!.getBoundingClientRect().height,
  );
  expect(chrome).toBe(120);
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  await menu.click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  await menu.click();
  await navigate(page, "diagnostics");
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeHidden();
  await expect(page.locator("#connection-destination")).toContainText(
    "Diagnostics",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});
test("job wizard validates the task and preserves execution choices when moving back", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "New job", exact: false }).click();
  await expect(page.locator("#job-step-count")).toHaveText("Step 1 of 3");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator("#job-step-count")).toHaveText("Step 1 of 3");
  await page.locator("#prompt").fill("Return exactly seven without tools.");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.locator("#mode").selectOption("inference");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator("#job-review")).toContainText(
    "Return exactly seven",
  );
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator("#mode")).toHaveValue("inference");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator("#prompt")).toHaveValue(
    "Return exactly seven without tools.",
  );
});

test("read-only application access exposes inspection without job, token, or image-probe actions", async ({
  page,
}) => {
  const principal = {
    id: "read-only-view",
    owner: false,
    profiles: ["default"],
    scopes: ["read"],
  };
  const bearer = new Tokens(service.store).create({
    ...principal,
    scopes: [...principal.scopes],
  }).token;
  const job = service.store.submit(
    { prompt: "Read-only conversation" },
    principal,
  );
  const attempt = service.store.claim("reader-fixture", "cli", job.id)!;
  service.store.finish(attempt, {
    status: "succeeded",
    result: "Inspection available",
    sessionId: "11111111-1111-4111-8111-111111111112",
  });
  await login(page, bearer);
  await expect(page.locator("#session-kind")).toHaveText("Read-only access");
  await expect(page.locator("#new-job")).toBeHidden();
  await page
    .getByRole("button", { name: "Read-only conversation", exact: true })
    .click();
  await expect(page.locator("#messages")).toContainText("Inspection available");
  await expect(page.locator("#message-form")).toBeHidden();
  await expect(page.locator("#job-actions button")).toHaveCount(0);
  await navigate(page, "providers");
  await page.locator("#setup-next").click();
  await page.locator("#setup-next").click();
  await expect(page.locator("#verify-image")).toBeHidden();
  await expect(page.locator("#image-owner-help")).toContainText(
    "Ask the bridge owner",
  );
  await page.locator("#setup-next").click();
  await expect(page.locator("#setup-start-job")).toBeHidden();
  await expect(page.locator("#setup-submit-help")).toContainText(
    "Ask the bridge owner",
  );
  await expect(page.locator("#setup-back")).toBeEnabled();
  await navigate(page, "diagnostics");
  await expect(page.locator("#token-form")).toBeHidden();
  expect(service.store.get(job.id).status).toBe("succeeded");
});

test("phone Back to jobs survives polling and browser Back restores the selected destination", async ({
  page,
}) => {
  const prompt = "Back-to-queue " + randomUUID();
  const job = service.store.submit({ prompt }, owner),
    attempt = service.store.claim("back-fixture", "cli", job.id)!;
  service.store.finish(attempt, {
    status: "succeeded",
    result: "Navigation fixture complete",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole("button", { name: prompt, exact: true }).click();
  await expect(page.locator(".detail")).toBeVisible();
  await page.locator("#back-to-jobs").click();
  await page.locator("#refresh").click();
  await expect(page.locator(".queue")).toBeVisible();
  await expect(page.locator(".detail")).toBeHidden();
  await navigate(page, "providers");
  await navigate(page, "diagnostics");
  await page.goBack();
  await expect(page.locator("#view-title")).toHaveText("Providers & setup");
});

test("expired access returns to its connection gate and clears private job details", async ({
  page,
}) => {
  const tokens = new Tokens(service.store),
    id = "expire-" + randomUUID(),
    bearer = tokens.create({ id, owner: true, profiles: ["default"] }).token;
  const prompt = "Expired-access fixture " + randomUUID();
  const job = service.store.submit({ prompt }, owner),
    attempt = service.store.claim("expiry-fixture", "cli", job.id)!;
  service.store.finish(attempt, {
    status: "succeeded",
    result: "Private inspection data",
  });
  await login(page, bearer);
  await page.getByRole("button", { name: prompt, exact: true }).click();
  tokens.revoke(id);
  await expect(page.locator("#view-title")).toHaveText("Connect");
  await expect(page.locator("#workspace")).toBeHidden();
  await expect(page.locator("#messages")).toBeEmpty();
  await expect(page.locator("#token")).toHaveValue("");
});

test("image verification is an explicit owner action and a failed check never claims vision support", async ({
  page,
}) => {
  await login(page);
  await navigate(page, "providers");
  await page.locator("#setup-next").click();
  await page.locator("#setup-next").click();
  await expect(page.locator("#image-state")).toHaveText("Not verified");
  await page.locator("#verify-image").click();
  await expect(page.locator("#image-feedback")).toContainText(
    "Image check failed",
    { timeout: 15000 },
  );
  await expect(page.locator("#image-state")).not.toHaveText("Verified");
  await expect(page.locator("#verify-image")).toBeEnabled();
  await navigate(page, "jobs");
  await expect(page.locator("#new-job")).toBeEnabled();
});

test("owner chooses read-only application permissions and sees a masked token", async ({
  page,
}) => {
  await login(page);
  await navigate(page, "diagnostics");
  await page.locator("#client-name").fill("inspect-ui-" + randomUUID());
  await page
    .getByLabel("Application permissions", { exact: true })
    .selectOption("read");
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  await expect(page.locator("#created-token")).toHaveAttribute(
    "type",
    "password",
  );
  await expect(page.locator("#created-token")).toHaveValue(/^ffb_/);
  const bearer = await page.locator("#created-token").inputValue();
  const response = await fetch(service.address + "/v1/bridge/status", {
    headers: { Authorization: "Bearer " + bearer },
  });
  expect((await response.json()).access).toEqual({
    owner: false,
    scopes: ["read"],
  });
  expect(
    (
      await fetch(service.address + "/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + bearer,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "bridge/default",
          messages: [{ role: "user", content: "Forbidden task" }],
          bridge: { execution: "inference", background: true },
        }),
      })
    ).status,
  ).toBe(403);
  await page.locator("#show-token").click();
  await expect(page.locator("#created-token")).toHaveAttribute("type", "text");
  await page.locator("#show-token").click();
  await expect(page.locator("#created-token")).toHaveAttribute(
    "type",
    "password",
  );
});

test("unknown job admission reuses its request and creates only one durable job", async ({
  page,
}) => {
  await login(page);
  let responses = 0;
  const keys: string[] = [];
  await page.route("**/v1/chat/completions", async (route) => {
    keys.push(route.request().headers()["idempotency-key"] ?? "");
    if (responses++ === 0) {
      await route.fetch();
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { message: "Admission outcome could not be delivered" },
        }),
      });
    } else await route.continue();
  });
  const prompt = "Admission replay " + randomUUID();
  await page.locator("#new-job").click();
  await page.locator("#prompt").fill(prompt);
  await reviewJob(page);
  await page.locator("#queue-job").click();
  await expect(page.locator("#job-form-error")).toContainText(
    "reuses this request",
  );
  await page.locator("#queue-job").click();
  await expect(page.locator("#job-dialog")).toBeHidden();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(
    service.store
      .list(owner, 200, "", "desc")
      .filter(
        (job) =>
          job.prompt === prompt ||
          job.completion?.messages.some((m) => m.content === prompt),
      ),
  ).toHaveLength(1);
});

test("short phone diagnostics exposes real data and setup content scrolls without an internal action overlay", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await login(page);
  await navigate(page, "diagnostics");
  await expect(page.locator("#diagnostic-worker")).toBeInViewport({
    ratio: 1,
  });
  await page.locator("#refresh-diagnostics").scrollIntoViewIfNeeded();
  await expect(page.locator("#refresh-diagnostics")).toBeInViewport({
    ratio: 1,
  });
  await navigate(page, "providers");
  await page.locator("#setup-next").click();
  await page.locator("#setup-worker-instructions").scrollIntoViewIfNeeded();
  const clear = await page
    .locator("#setup-worker-instructions")
    .evaluate((node) => {
      const body = node.closest(".setup-body")!,
        footer = document.querySelector(".setup-footer")!;
      return {
        instruction: node.getBoundingClientRect(),
        body: body.getBoundingClientRect(),
        footer: footer.getBoundingClientRect(),
      };
    });
  expect(clear.instruction.bottom).toBeLessThanOrEqual(clear.body.bottom);
  expect(clear.footer.top).toBeGreaterThanOrEqual(clear.body.bottom);
});

test("disconnect discards a late authenticated status response instead of repopulating private data", async ({
  page,
}) => {
  await login(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const received = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route("**/v1/bridge/status", async (route) => {
    const response = await route.fetch();
    requested();
    await gate;
    await route.fulfill({ response });
  });
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/v1/bridge/status"),
  );
  await page.locator("#refresh").click();
  await received;
  await page.locator("#logout").click();
  release();
  await (await response).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.locator("#view-title")).toHaveText("Connect");
  await expect(page.locator("#diagnostics")).toBeEmpty();
  await expect(page.locator("#health-facts")).toBeEmpty();
  await expect(page.locator("#messages")).toBeEmpty();
});

test("interrupted image jobs show their attachment and fresh-request guidance without unsafe retry", async ({
  page,
}) => {
  const { prepareCompletion } =
      await import("../../src/completion-protocol.js"),
    { challengeImage } = await import("../../src/image-capabilities.js");
  const prepared = prepareCompletion({
    model: "bridge/default",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Interrupted image review" },
          {
            type: "image_url",
            image_url: {
              url:
                "data:image/png;base64," +
                challengeImage("12345678").toString("base64"),
              detail: "auto",
            },
          },
        ],
      },
    ],
  });
  const job = service.store.submit(
      { prompt: prepared.prompt, profile: "default", mode: "cli" },
      owner,
      undefined,
      prepared.request,
    ),
    attempt = service.store.claim("image-recovery-fixture", "cli", job.id)!;
  service.store.finish(attempt, {
    status: "interrupted",
    error: "Fixture worker interruption",
  });
  await login(page);
  await page
    .getByRole("button", { name: "Chat completion", exact: true })
    .first()
    .click();
  await expect(page.locator("#messages .message-attachment")).toBeVisible();
  await expect(
    page
      .locator("#job-actions")
      .getByRole("button", { name: "Retry", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("#image-job-recovery")).toContainText(
    "fresh request",
  );
});

test("workflow inputs use named plain fields and retain JSON as an explicit advanced option", async ({
  page,
}) => {
  await login(page);
  await navigate(page, "workflows");
  await page.locator("#template").selectOption("research-and-review");
  await expect(page.getByLabel("Topic", { exact: true })).toBeVisible();
  await expect(page.locator("#workflow-inputs")).toBeHidden();
  await page
    .getByLabel("Topic", { exact: true })
    .fill("A readable workflow brief");
  const request = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/workflow-runs"),
  );
  await page.locator("#workflow-form button").click();
  expect((await request).postDataJSON().inputs).toEqual({
    topic: "A readable workflow brief",
  });
  await page.locator("#workflow-advanced summary").click();
  await page.getByLabel("Use JSON values", { exact: true }).check();
  await expect(page.locator("#workflow-inputs")).toBeVisible();
  await expect(page.locator("#workflow-inputs")).toHaveValue(
    /A readable workflow brief/,
  );
});

test("diagnostic worker and state values remain complete single lines inside their card width", async ({
  page,
}) => {
  await login(page);
  await navigate(page, "diagnostics");
  for (const width of [960, 1280, 1440, 1920, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ["light", "dark"]) {
      await page.locator("#appearance").selectOption(theme);
      const lines = await page
        .locator(".diagnostic-signals dd")
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            return {
              text: node.textContent,
              lines: range.getClientRects().length,
              overflow: node.scrollWidth > node.clientWidth + 1,
              measuredWidth: node.clientWidth,
              font: getComputedStyle(node).fontSize,
            };
          }),
        );
      for (const value of lines) {
        expect(value.lines, value.text ?? "").toBe(1);
        expect(
          value.overflow,
          JSON.stringify({ viewport: width, ...value }),
        ).toBe(false);
      }
    }
  }
});

test("uncertain workflow admission returns the existing run when unchanged inputs are submitted again", async ({
  page,
}) => {
  await login(page);
  await navigate(page, "workflows");
  await page.locator("#template").selectOption("research-and-review");
  const topic = "Workflow admission " + randomUUID();
  await page.getByLabel("Topic", { exact: true }).fill(topic);
  let count = 0;
  const ids: string[] = [];
  await page.route("**/v1/bridge/workflow-runs", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    ids.push((await response.json()).id);
    if (count++ === 0)
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { message: "Workflow admission reply was lost" },
        }),
      });
    else await route.fulfill({ response });
  });
  await page.locator("#workflow-form button").click();
  await expect(page.locator("#notice")).toContainText(
    "Workflow admission reply was lost",
  );
  await page.locator("#workflow-form button").click();
  await expect.poll(() => ids.length).toBe(2);
  expect(ids[0]).toBe(ids[1]);
});

test("changing profile discards a late image-check admission from the previous profile", async ({
  page,
}) => {
  const data = mkdtempSync(join(tmpdir(), "bridge-image-profile-"));
  const isolated = await startService(
    parseConfig({
      dataDir: data,
      workspace: join(data, "jobs"),
      claudePath: process.execPath,
      port: 0,
      profiles: { default: {}, review: {} },
    }),
    {
      worker: () => ({
        ready: async () => ({ ready: true }),
        run: async () => ({
          status: "succeeded",
          result: JSON.stringify({ content: "No image proof", tool_calls: [] }),
        }),
      }),
    },
  );
  let release!: () => void, admitted!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (admitted = resolve));
  try {
    await page.goto(isolated.address);
    await page
      .getByLabel("Bridge token", { exact: true })
      .fill(isolated.ownerToken);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.locator("#workspace")).toBeVisible();
    await navigate(page, "providers");
    await page.locator("#setup-next").click();
    await page.locator("#setup-next").click();
    await page.route("**/v1/bridge/image-input/probes", async (route) => {
      const response = await route.fetch();
      admitted();
      await held;
      await route.fulfill({ response });
    });
    await page.locator("#verify-image").click();
    await started;
    await page.locator("#setup-profile").selectOption("review");
    const finished = page.waitForEvent("requestfinished", {
      predicate: (request) => request.url().endsWith("/image-input/probes"),
    });
    release();
    await finished;
    await page.waitForTimeout(100);
    await expect(page.locator("#setup-profile")).toHaveValue("review");
    await expect(page.locator("#open-image-job")).toBeHidden();
    await expect(page.locator("#image-feedback")).toBeEmpty();
    await expect(page.locator("#verify-image")).toBeEnabled();
  } finally {
    release();
    await isolated.close();
    rmSync(data, { recursive: true, force: true });
  }
});

test("paused image guidance leads to the actual Jobs resume control", async ({
  page,
}) => {
  await login(page);
  try {
    await page.locator("#pause-all").click();
    await navigate(page, "providers");
    await page.locator("#setup-next").click();
    await page.locator("#setup-next").click();
    await expect(page.locator("#verify-image")).toBeDisabled();
    await expect(page.locator("#image-owner-help")).toContainText(
      "Resume dispatch in Jobs",
    );
    await navigate(page, "jobs");
    await page.locator("#resume-all").click();
    await navigate(page, "providers");
    await expect(page.locator("#verify-image")).toBeEnabled();
  } finally {
    await fetch(service.address + "/v1/bridge/admin/resume", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + service.ownerToken,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
  }
});

test("short phones show a continuation shortcut when setup and workflow actions are below the fold", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await login(page);
  for (const theme of ["light", "dark"]) {
    await page.locator("#appearance").selectOption(theme);
    await navigate(page, "providers");
    await page.locator('[data-setup-step="0"]').click();
    await page.locator("#setup-next").click();
    await expect(page.locator("#setup-scroll-control")).toBeVisible();
    await capture(page, `guidance-setup-mobile-${theme}`);
    await page.locator("#setup-scroll-control").click();
    await expect(page.locator("#setup-next")).toBeFocused();
    await expect(page.locator("#setup-step-count")).toHaveText("Step 2 of 4");
    const next = await page.locator("#setup-next").boundingBox();
    const footer = await page.locator("main>footer").boundingBox();
    expect(next!.y + next!.height).toBeLessThanOrEqual(footer!.y);
    await expect(page.locator("#setup-scroll-control")).toBeHidden();
    await page.keyboard.press("Enter");
    await expect(page.locator("#setup-step-count")).toHaveText("Step 3 of 4");
    await navigate(page, "workflows");
    await expect(page.locator("#workflow-scroll-control")).toBeVisible();
    await capture(page, `guidance-workflows-mobile-${theme}`);
    await page.locator("#workflow-scroll-control").click();
    await expect(page.locator("#workflow-form button.primary")).toBeFocused();
    const start = await page
      .locator("#workflow-form button.primary")
      .boundingBox();
    expect(start!.y + start!.height).toBeLessThanOrEqual(footer!.y);
    await expect(page.locator("#workflow-scroll-control")).toBeHidden();
  }
});

test("short desktops expose off-screen setup actions without advancing the guide", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  await login(page);
  for (const theme of ["light", "dark"]) {
    await page.locator("#appearance").selectOption(theme);
    await navigate(page, "providers");
    await page.locator('[data-setup-step="0"]').click();
    await page.locator("#setup-next").click();
    await page.locator("#setup-next").click();
    await expect(page.locator("#setup-scroll-control")).toBeVisible();
    await page.locator("#setup-scroll-control").click();
    await expect(page.locator("#setup-next")).toBeFocused();
    await expect(page.locator("#setup-step-count")).toHaveText("Step 3 of 4");
    const next = await page.locator("#setup-next").boundingBox();
    const footer = await page.locator("main>footer").boundingBox();
    expect(next!.y + next!.height).toBeLessThanOrEqual(footer!.y);
    await expect(page.locator("#setup-scroll-control")).toBeHidden();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.locator('[data-setup-step="0"]').click();
    await expect(page.locator("#setup-scroll-control")).toBeHidden();
    await page.setViewportSize({ width: 1440, height: 600 });
  }
});

test("short-window conversations scroll with the page to the latest response and reply", async ({
  page,
}) => {
  const job = service.store.submit(
    {
      prompt:
        "Long conversation layout\n" +
        Array.from(
          { length: 160 },
          (_, i) => `Conversation line ${i + 1}`,
        ).join("\n"),
    },
    owner,
  );
  const attempt = service.store.claim("fixture", "cli", job.id)!;
  const latest = "Latest response reachable by page scrolling.";
  service.store.finish(attempt, {
    status: "succeeded",
    result: latest,
    sessionId: randomUUID(),
  });
  await login(page);
  for (const [width, height] of [
    [320, 568],
    [1440, 600],
  ] as const) {
    await page.setViewportSize({ width, height });
    await navigate(page, "jobs");
    await page
      .getByRole("button", { name: /^Long conversation layout/ })
      .click();
    await page.locator("#messages").scrollIntoViewIfNeeded();
    const content = page.locator("#content");
    const before = await content.evaluate((node) => node.scrollTop);
    const messages = await page.locator("#messages").boundingBox();
    const frame = await content.boundingBox();
    await page.mouse.move(
      messages!.x + 24,
      Math.max(
        frame!.y + 24,
        Math.min(messages!.y + 80, frame!.y + frame!.height - 24),
      ),
    );
    await page.mouse.wheel(0, 500);
    await expect
      .poll(() => content.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(before);
    await expect
      .poll(() => page.locator("#messages").evaluate((node) => node.scrollTop))
      .toBe(0);
    await page.getByText(latest, { exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByText(latest, { exact: true })).toBeInViewport();
    await page
      .getByLabel("Continue this conversation")
      .scrollIntoViewIfNeeded();
    await page.getByLabel("Continue this conversation").focus();
    await expect(page.getByLabel("Continue this conversation")).toBeFocused();
    await expect(
      page.getByLabel("Continue this conversation"),
    ).toBeInViewport();
  }
});

test("diagnostic activity expands recorded events with keyboard control and retains compact state", async ({
  page,
}) => {
  const job = service.store.submit(
    { prompt: "Diagnostics history layout" },
    owner,
  );
  const attempt = service.store.claim("fixture", "cli", job.id)!;
  for (let i = 0; i < 8; i++)
    service.store.observe(attempt, {
      kind: "output",
      text: `Recorded layout event ${i + 1}`,
    });
  service.store.finish(attempt, {
    status: "succeeded",
    result: "Recorded events available.",
  });
  await login(page);
  await page.evaluate(() => {
    const stylesheet = document.styleSheets[0]!;
    stylesheet.insertRule("#events { scrollbar-gutter: stable; }");
    stylesheet.insertRule("#events::-webkit-scrollbar { width: 17px; }");
  });
  for (const [width, height] of [
    [1920, 1080],
    [1440, 600],
    [320, 568],
  ] as const) {
    await page.setViewportSize({ width, height });
    await navigate(page, "diagnostics");
    const toggle = page.getByRole("button", {
      name: "View activity",
      exact: true,
    });
    await toggle.scrollIntoViewIfNeeded();
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "Hide activity", exact: true }),
    ).toHaveAttribute("aria-expanded", "true");
    await page.locator("#events").scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        page.locator("#events").evaluate((node) => {
          const bounds = node.getBoundingClientRect();
          return Array.from(node.children).filter((child) => {
            const row = child.getBoundingClientRect();
            return row.top >= bounds.top && row.bottom <= bounds.bottom;
          }).length;
        }),
      )
      .toBeGreaterThanOrEqual(3);
    await expect(page.locator("#events")).toContainText(
      "Recorded layout event",
    );
    await page
      .getByRole("button", { name: "Hide activity", exact: true })
      .focus();
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await navigate(page, "jobs");
    await expect(toggle).toBeHidden();
  }
});

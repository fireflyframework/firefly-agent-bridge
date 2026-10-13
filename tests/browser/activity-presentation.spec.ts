/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * https://www.apache.org/licenses/LICENSE-2.0 */
import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { startService } from "../../src/service.js";
import { parseConfig } from "../../src/config.js";
import { Tokens } from "../../src/auth.js";

// Native observations below are controlled fixtures, not live provider evidence.
let service: Awaited<ReturnType<typeof startService>>, directory: string;
const output = "Fixture command rejected\n" + "log line\n".repeat(30000);
const owner = { id: "fixture-owner", owner: true, profiles: ["default"] };
test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "bridge-activity-fixture-"));
  service = await startService(
    parseConfig({
      dataDir: directory,
      workspace: join(directory, "jobs"),
      claudePath: process.execPath,
      port: 0,
    }),
    {
      worker: () => ({
        ready: async () => ({ ready: true }),
        run: async () => ({
          status: "succeeded",
          result: "Controlled fixture",
        }),
      }),
    },
  );
  const job = service.store.submit(
      { prompt: "Fixture native activity presentation" },
      owner,
    ),
    attempt = service.store.claim("fixture", "cli", job.id)!;
  for (const tool of [
    {
      toolId: "fixture-bash",
      name: "Bash",
      phase: "requested" as const,
      input: { command: "npm test", description: "Fixture command" },
    },
    {
      toolId: "fixture-bash",
      phase: "failed" as const,
      output: {
        content: [{ type: "text", text: "Fixture command failure" }],
        result: {
          stdout: output,
          stderr: '<img src=x onerror="window.injected=true">',
          exit_code: 2,
        },
      },
    },
    {
      toolId: "fixture-edit",
      name: "Edit",
      phase: "requested" as const,
      file: { path: "src/example.ts", operation: "edit" as const },
      input: {
        file_path: "src/example.ts",
        old_string: "const ready = false;",
        new_string: "const ready = true;",
      },
    },
    {
      toolId: "fixture-edit",
      phase: "succeeded" as const,
      output: {
        content: "Fixture edit reported",
        result: {
          structuredPatch: [
            {
              oldStart: 20,
              newStart: 22,
              lines: ["-const ready = false;", "+const ready = true;"],
            },
          ],
        },
      },
    },
    {
      toolId: "fixture-unknown",
      name: "Write",
      phase: "requested" as const,
      file: { path: "src/unknown.ts", operation: "write" as const },
      input: {
        file_path: "src/unknown.ts",
        content: "const unresolved = true;",
        extension: { unknown: true },
      },
    },
  ])
    service.store.observe(attempt, {
      kind: "tool",
      text: "Fixture observation",
      tool,
    });
  service.store.finish(attempt, {
    status: "failed",
    result: "Fixture observations retained",
  });
});
test.afterAll(async () => {
  await service.close();
  rmSync(directory, { recursive: true, force: true });
});
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 375, height: 667 },
  { width: 812, height: 375 },
]) {
  for (const theme of ["light", "dark"]) {
    test(`native activity is bounded and truthful at ${viewport.width}x${viewport.height} ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const token = new Tokens(service.store).create({
        ...owner,
        id: randomUUID(),
      }).token;
      await page.goto(service.address);
      await page.getByLabel("Bridge token", { exact: true }).fill(token);
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await page
        .getByRole("button", {
          name: "Fixture native activity presentation",
          exact: true,
        })
        .click();
      await page.evaluate(
        (value) => (document.documentElement.dataset.theme = value),
        theme,
      );
      await page.getByRole("tab", { name: "Activity", exact: false }).click();
      const command = page
        .locator("#tool-list .tool-card")
        .filter({ hasText: "Bash" });
      await command.locator(":scope > summary").click();
      await expect(command).toContainText("Reported failure");
      await expect(command).toContainText("Fixture command rejected");
      await expect(command).toContainText("Exit code");
      const pre = command
        .locator(".payload-section")
        .filter({
          has: page.getByRole("heading", {
            name: "Standard output",
            exact: true,
          }),
        })
        .locator("pre");
      expect((await pre.textContent())!.length).toBeLessThanOrEqual(10000);
      await expect(command.locator(".raw-payload")).not.toHaveAttribute(
        "open",
        "",
      );
      await expect(command.locator("img")).toHaveCount(0);
      await command
        .getByRole("button", { name: "Show more", exact: true })
        .first()
        .click();
      expect((await pre.textContent())!.length).toBeLessThanOrEqual(100000);
      await page.evaluate(() =>
        Object.defineProperty(navigator, "clipboard", {
          value: {
            writeText: async (text: string) => {
              (window as Window & { copied?: string }).copied = text;
            },
          },
          configurable: true,
        }),
      );
      await command
        .locator(".payload-section")
        .filter({
          has: page.getByRole("heading", {
            name: "Standard output",
            exact: true,
          }),
        })
        .getByRole("button", { name: "Copy full output", exact: true })
        .click();
      await expect
        .poll(() =>
          page.evaluate(() => (window as Window & { copied?: string }).copied),
        )
        .toBe(output);
      await command.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: test.info().outputPath(`command-${theme}.png`),
      });
      await page.getByRole("tab", { name: "Activity", exact: false }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(
        page.getByRole("tab", { name: "Files", exact: false }),
      ).toBeFocused();
      const edit = page
        .locator("#file-list .tool-card")
        .filter({ hasText: "src/example.ts" });
      await edit.locator(":scope > summary").click();
      await expect(edit.locator(".audit-line-number")).toHaveCount(2);
      await expect(
        edit.locator(".audit-token-keyword").filter({ hasText: "const" }),
      ).toHaveCount(4);
      await expect(
        edit.getByRole("columnheader", { name: "Old line", exact: true }),
      ).toBeVisible();
      await expect(
        edit.getByRole("cell", { name: "20", exact: true }),
      ).toBeVisible();
      await expect(
        edit.getByRole("cell", { name: "22", exact: true }),
      ).toBeVisible();
      await edit.locator(".audit-patch-scroll").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: test.info().outputPath(`patch-${theme}.png`),
      });
      const unknown = page
        .locator("#file-list .tool-card")
        .filter({ hasText: "src/unknown.ts" });
      await unknown.locator(":scope > summary").click();
      await expect(unknown).toContainText("Outcome unknown");
      await expect(unknown).toContainText("Requested content");
      await expect(unknown).toContainText(
        "No terminal tool result was observed",
      );
      await expect(unknown).not.toContainText("Written content");
      await unknown.locator(".raw-payload > summary").scrollIntoViewIfNeeded();
      const summaryBox = await unknown
        .locator(".raw-payload > summary")
        .boundingBox();
      const footerBox = await page.locator("main > footer").boundingBox();
      expect(
        summaryBox &&
          footerBox &&
          summaryBox.y + summaryBox.height <= footerBox.y,
      ).toBe(true);
      await expect(unknown.locator(".raw-payload")).not.toHaveAttribute(
        "open",
        "",
      );
      expect(await page.evaluate(() => Object.hasOwn(window, "injected"))).toBe(
        false,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(page.locator("#file-list .tool-card[open]")).toHaveCount(2);
      await page.getByRole("tab", { name: "Activity", exact: false }).click();
      await page.locator("#audit-journal > summary").click();
      const observation = page
        .locator("#audit-entries .audit-entry")
        .filter({ hasText: "tool / requested" })
        .first();
      await observation.locator(":scope > summary").click();
      await expect(observation.locator(".audit-fields").first()).toBeVisible();
      await expect(
        observation.locator(":scope > .raw-payload"),
      ).not.toHaveAttribute("open", "");
    });
  }
}

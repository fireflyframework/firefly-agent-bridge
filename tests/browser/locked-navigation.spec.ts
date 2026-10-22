/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * https://www.apache.org/licenses/LICENSE-2.0 */
import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startService } from "../../src/service.js";
import { parseConfig } from "../../src/config.js";

let service: Awaited<ReturnType<typeof startService>>, directory: string;
test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "bridge-locked-nav-"));
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
        run: async () => {
          throw new Error("No jobs in navigation fixture");
        },
      }),
    },
  );
});
test.afterAll(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`locked destinations fit and explain access at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 1440 ? 960 : 844 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.goto(service.address);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      if (width === 390)
        await page.getByRole("button", { name: "Menu", exact: true }).click();
      const nav = page.getByRole("navigation", { name: "Main navigation" });
      await expect(nav).toBeVisible();
      await expect(
        nav.getByText("Connect required", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("locked-navigation.png"),
        animations: "disabled",
      });
      for (const label of [
        "Providers & setup",
        "Jobs",
        "Workflows",
        "Diagnostics",
      ]) {
        const button = nav.getByRole("button", { name: label, exact: true });
        await expect(button).toHaveAccessibleDescription("Connect required");
        const shape = await button.evaluate((element) => {
          const label = element.querySelector("span")!;
          const range = document.createRange();
          range.selectNodeContents(label);
          const box = element.getBoundingClientRect(),
            text = label.getBoundingClientRect();
          const marker = getComputedStyle(element, "::after");
          return {
            lines: range.getClientRects().length,
            left: text.left,
            right: text.right,
            buttonLeft: box.left,
            buttonRight: box.right,
            marker: marker.content,
            mask: marker.maskImage,
            width: parseFloat(marker.width),
          };
        });
        expect(shape.lines, label).toBe(1);
        expect(shape.left).toBeGreaterThan(shape.buttonLeft);
        expect(shape.right).toBeLessThan(shape.buttonRight);
        expect(shape.marker).not.toContain("Connect");
        expect(shape.mask).not.toBe("none");
        expect(shape.width).toBeGreaterThan(0);
        expect(shape.width).toBeLessThanOrEqual(16);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await nav
        .getByRole("button", { name: "Providers & setup", exact: true })
        .click();
      await expect(page.locator("#view-title")).toHaveText("Connect");
      await expect(page.locator("#connection-destination")).toContainText(
        "Providers & setup",
      );
      await expect(page.locator("#job-count")).toBeHidden();
      if (width === 390)
        await expect(page.locator("#mobile-menu")).not.toBeVisible();
      await page
        .getByLabel("Bridge token", { exact: true })
        .fill(service.ownerToken);
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await expect(page.locator("#view-title")).toHaveText("Providers & setup");
      await expect(page.locator('[data-view="providers"]')).not.toHaveAttribute(
        "aria-describedby",
        "nav-access-state",
      );
      await expect(page.locator("main > footer")).toHaveCount(1);
      expect(
        service.store.list({
          id: "fixture",
          owner: true,
          profiles: ["default"],
        }),
      ).toHaveLength(0);
    });
  }

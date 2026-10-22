/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * https://www.apache.org/licenses/LICENSE-2.0 */
import { test, expect } from "@playwright/test";
import { readyStylesheets } from "./stylesheet-readiness.mjs";
import { readyImages } from "./image-readiness.mjs";

for (const width of [1440, 390])
  for (const theme of ["light", "dark"]) {
    test(`Connect lead uses its actual ${width}px ${theme} capture`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 1440 ? 960 : 844 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.goto("/dashboard/");
      await readyStylesheets(page);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator("body")).toHaveAttribute(
        "data-md-color-scheme",
        theme === "dark" ? "slate" : "default",
      );
      const figure = page.locator("article .bridge-shot").first();
      const links = figure.locator(".bridge-shot__link:visible");
      await expect(links).toHaveCount(1);
      const image = links.locator("img");
      await readyImages(image);
      await figure.evaluate((el) =>
        scrollTo(0, el.getBoundingClientRect().top + scrollY - 110),
      );
      await page.screenshot({
        path: testInfo.outputPath("connect-lead.png"),
        animations: "disabled",
      });
      const size = width === 1440 ? "desktop" : "mobile";
      await expect(image).toHaveAttribute(
        "src",
        new RegExp(`connect-${size}-${theme}\\.png$`),
      );
      await expect(links).toHaveAccessibleName(/Open full screenshot:/);
      const shape = await image.evaluate((el) => ({
        width: el.getBoundingClientRect().width,
        figureWidth: el.closest("figure").getBoundingClientRect().width,
        natural: el.naturalWidth,
        src: el.getAttribute("src"),
        href: el.closest("a").getAttribute("href"),
      }));
      expect(shape.natural).toBe(width);
      expect(shape.width).toBeGreaterThanOrEqual(shape.figureWidth * 0.95);
      expect(shape.width).toBeLessThanOrEqual(shape.natural);
      expect(shape.href).toBe(shape.src);
      await expect(figure.locator("figcaption")).toHaveCount(1);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await links.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(
        new RegExp(`connect-${size}-${theme}\\.png$`),
      );
    });
  }

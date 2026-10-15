/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * https://www.apache.org/licenses/LICENSE-2.0 */
import { test, expect } from "@playwright/test";

for (const [width, height] of [
  [1440, 1000],
  [1024, 768],
  [768, 1024],
  [390, 844],
]) {
  for (const theme of ["light", "dark"]) {
    test(`Compact documentation brand fits at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.goto("/");
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const logo = page.locator(".md-header .md-logo");
      const image = logo.locator("img");
      const geometry = await image.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        const header = node.closest(".md-header").getBoundingClientRect();
        return {
          source: getComputedStyle(node).content,
          width: bounds.width,
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          bottom: bounds.bottom,
          headerTop: header.top,
          headerBottom: header.bottom,
          overflow: document.documentElement.scrollWidth > innerWidth,
          fontLoaded: document.fonts.check("14px Manrope"),
        };
      });
      expect(geometry.source).toContain(`bridge-lockup-small-${theme}.svg`);
      // The pinned parent occupies 619.4 of the combined lockup's 1940.095 units.
      expect((geometry.width * 619.4) / 1940.095).toBeGreaterThanOrEqual(48);
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(width);
      expect(geometry.top).toBeGreaterThanOrEqual(geometry.headerTop);
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.headerBottom);
      expect(geometry.overflow).toBe(false);
      expect(geometry.fontLoaded).toBe(true);
      await logo.focus();
      await expect(logo).toBeFocused();
    });
  }
}

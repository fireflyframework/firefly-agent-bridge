/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * https://www.apache.org/licenses/LICENSE-2.0 */
import { test, expect } from "@playwright/test";

for (const width of [1440, 390, 375]) {
  for (const theme of ["light", "dark"]) {
    test(`Work screenshots fit at ${width}px in ${theme} appearance`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      for (const guide of [
        "dashboard",
        "workflows",
        "audit",
        "advanced-workflows",
        "subagents",
        "openai-compatible",
      ]) {
        await page.goto(`/${guide}/`);
        await expect(page.locator("body")).toHaveAttribute(
          "data-md-color-scheme",
          theme === "dark" ? "slate" : "default",
        );
        const article = page.locator("article");
        await expect(article.locator("h1")).toBeVisible();
        expect(
          await article
            .locator("p")
            .evaluateAll((nodes) =>
              nodes.some((node) => /^\s*\|/.test(node.textContent)),
            ),
        ).toBe(false);
        for (const summary of await article
          .locator(".bridge-gallery > summary")
          .all()) {
          await summary.focus();
          await page.keyboard.press("Enter");
          await expect(summary.locator("..")).toHaveAttribute("open", "");
        }
        await article
          .locator(".bridge-shot__link img")
          .evaluateAll(async (images) => {
            await Promise.all(
              images.map(async (image) => {
                image.loading = "eager";
                await image.decode();
              }),
            );
          });
        const links = article.locator(".bridge-shot__link:visible");
        for (const link of await links.all()) {
          const image = link.locator("img");
          const measure = await image.evaluate((element) => ({
            width: element.getBoundingClientRect().width,
            natural: element.naturalWidth,
            right: element.getBoundingClientRect().right,
            left: element.getBoundingClientRect().left,
            pairCount: [
              ...element.closest("p, td").querySelectorAll("a"),
            ].filter((node) => getComputedStyle(node).display !== "none")
              .length,
            href: element.parentElement.getAttribute("href"),
            src: element.getAttribute("src"),
          }));
          expect(measure.natural).toBeGreaterThan(0);
          expect(measure.width).toBeLessThanOrEqual(measure.natural + 1);
          if (measure.phone) expect(measure.width).toBeLessThanOrEqual(321);
          expect(measure.left).toBeGreaterThanOrEqual(0);
          expect(measure.right).toBeLessThanOrEqual(width + 1);
          expect(measure.href).toBe(measure.src);
          expect(measure.pairCount).toBe(1);
          await expect(link).toHaveAccessibleName(/Open full screenshot:/);
        }
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      }
      await page.goto("/dashboard/");
      const imageLink = page
        .locator(".bridge-shot--phone .bridge-shot__link:visible")
        .first();
      await imageLink.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/connect-mobile-(light|dark)\.png$/);
    });
  }
}

test("the gallery remains readable with text enlarged to 200 percent", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto("/dashboard/");
  await page.addStyleTag({
    content:
      ".md-typeset { font-size: 32px; } .bridge-shot figcaption, .md-typeset details, .bridge-gallery > summary { font-size: 28px; }",
  });
  const summary = page.locator(".bridge-gallery > summary").first();
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(summary.locator("..")).toHaveAttribute("open", "");
  await expect(summary).toHaveCSS("font-size", "28px");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const grid = summary.locator("..").locator(".bridge-shot-grid");
  const box = await grid.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(720);
});

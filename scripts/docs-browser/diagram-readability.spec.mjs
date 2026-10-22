/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * https://www.apache.org/licenses/LICENSE-2.0 */
import { test, expect } from "@playwright/test";
import { readyStylesheets } from "./stylesheet-readiness.mjs";
import { readdirSync } from "node:fs";

for (const width of [320, 390, 768, 1024, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`Architecture labels remain readable at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto("architecture/");
      await readyStylesheets(page);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator("body")).toHaveAttribute(
        "data-md-color-scheme",
        theme === "dark" ? "slate" : "default",
      );
      const diagrams = page.locator(
        '.md-content__inner img[src*="/diagrams/"]:visible',
      );
      await expect(diagrams).toHaveCount(4);
      for (const diagram of await diagrams.all()) {
        await diagram.scrollIntoViewIfNeeded();
        await expect
          .poll(() =>
            diagram.evaluate(
              (image) => image.complete && image.naturalWidth > 0,
            ),
          )
          .toBe(true);
        await expect(diagram).toBeVisible();
        const metrics = await diagram.evaluate(async (image) => {
          await image.decode();
          const source = new DOMParser().parseFromString(
            await (await fetch(image.currentSrc)).text(),
            "image/svg+xml",
          );
          const svg = source.documentElement;
          const scale =
            image.getBoundingClientRect().width /
            Number(svg.getAttribute("width"));
          return {
            source: image.currentSrc,
            labels: [...source.querySelectorAll("text")].map(
              (text) => Number(text.getAttribute("font-size")) * scale,
            ),
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        const suffix = `${theme === "dark" ? "-dark" : ""}${width <= 760 ? "-narrow" : ""}.svg`;
        expect(new URL(metrics.source).pathname.endsWith(suffix)).toBe(true);
        expect(new URL(metrics.source).pathname.includes("-narrow")).toBe(
          width <= 760,
        );
        expect(new URL(metrics.source).pathname.includes("-dark")).toBe(
          theme === "dark",
        );
        expect(metrics.labels.length).toBeGreaterThan(10);
        expect(Math.min(...metrics.labels)).toBeGreaterThanOrEqual(12);
        expect(metrics.overflow).toBe(false);
      }
      await diagrams.first().screenshot({
        path: testInfo.outputPath("architecture.png"),
        style: ".md-header, .md-tabs { visibility: hidden !important; }",
      });
      await diagrams.first().evaluate((image) =>
        window.scrollTo({
          top: image.getBoundingClientRect().top + scrollY - 80,
          behavior: "instant",
        }),
      );
      await page.screenshot({
        path: testInfo.outputPath("architecture-context.png"),
      });
    });
  }
}

test("Every generated diagram keeps its text within the canvas and its own card", async ({
  page,
}) => {
  for (const name of readdirSync("assets/diagrams").filter((name) =>
    name.endsWith(".svg"),
  )) {
    await page.goto(`assets/diagrams/${name}`);
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(() =>
        [...document.fonts].some(
          (font) => font.family === "Manrope" && font.status === "loaded",
        ),
      ),
      name + " embeds and loads Manrope",
    ).toBe(true);
    const faults = await page.evaluate(() => {
      const svg = document.querySelector("svg");
      const { width, height } = svg.viewBox.baseVal;
      const outside = (box, bounds) =>
        box.x < bounds.x - 1 ||
        box.y < bounds.y - 1 ||
        box.x + box.width > bounds.x + bounds.width + 1 ||
        box.y + box.height > bounds.y + bounds.height + 1;
      return [...svg.querySelectorAll("text")]
        .filter((text) => {
          const box = text.getBBox();
          const card = text.closest(".diagram-card")?.querySelector("rect");
          return (
            outside(box, { x: 0, y: 0, width, height }) ||
            (card && outside(box, card.getBBox()))
          );
        })
        .map((text) => text.textContent);
    });
    expect(faults, name).toEqual([]);
  }
});

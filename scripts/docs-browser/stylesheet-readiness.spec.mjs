/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * https://www.apache.org/licenses/LICENSE-2.0 */
import { test, expect } from "@playwright/test";
import { readyStylesheets } from "./stylesheet-readiness.mjs";

test("native documentation stylesheets load without an admission re-fetch", async ({
  page,
}) => {
  const requests = [];
  page.on("request", (request) => {
    if (request.resourceType() === "stylesheet") requests.push(request.url());
  });
  await page.goto("/dashboard/");
  const before = [...requests];
  await readyStylesheets(page);
  expect(requests).toEqual(before);
  expect(
    before.some((url) =>
      /assets\/stylesheets\/main\.[^/]+\.min\.css/.test(url),
    ),
  ).toBe(true);
  expect(
    before.some((url) => new URL(url).pathname.endsWith("/assets/docs.css")),
  ).toBe(true);
});

for (const [name, pattern] of [
  ["Material", /assets\/stylesheets\/main\.[^/]+\.min\.css/],
  ["Bridge", /assets\/docs\.css/],
]) {
  test(`failed ${name} stylesheet is rejected without retry or layout admission`, async ({
    page,
  }) => {
    let attempts = 0;
    await page.route(pattern, async (route) => {
      attempts += 1;
      await route.abort("failed");
    });
    await page.goto("/dashboard/");
    expect(attempts).toBe(1);
    await expect(readyStylesheets(page)).rejects.toThrow(
      /Required documentation stylesheet failed to load:/,
    );
    expect(attempts).toBe(1);
    expect(
      await page.locator('link[rel="stylesheet"]').evaluateAll(
        (links) =>
          links.filter((link) => {
            try {
              return !link.sheet || link.sheet.cssRules.length === 0;
            } catch {
              return true;
            }
          }).length,
      ),
    ).toBe(1);
  });
}

test("missing required stylesheet declarations are not admitted", async ({
  page,
}) => {
  await page.goto("/dashboard/");
  await page.locator('link[rel="stylesheet"]').evaluateAll((links) => {
    for (const link of links)
      if (new URL(link.href).pathname.endsWith("/assets/docs.css"))
        link.remove();
  });
  await expect(readyStylesheets(page)).rejects.toThrow(
    "Required documentation stylesheet is missing: Bridge",
  );
});

/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * https://www.apache.org/licenses/LICENSE-2.0 */
export async function readyStylesheets(page) {
  const stylesheets = await page
    .locator('link[rel="stylesheet"]')
    .evaluateAll((links) =>
      links.map((link) => {
        let loaded = false;
        try {
          loaded = !link.disabled && link.sheet?.cssRules.length > 0;
        } catch {
          // Failed same-origin loads can expose sheets with inaccessible rules.
        }
        return { path: new URL(link.href, document.baseURI).pathname, loaded };
      }),
    );
  for (const [name, pattern] of [
    ["Material", /\/assets\/stylesheets\/main\.[^/]+\.min\.css$/],
    ["Bridge", /\/assets\/docs\.css$/],
  ]) {
    const required = stylesheets.filter((stylesheet) =>
      pattern.test(stylesheet.path),
    );
    if (required.length === 0)
      throw new Error(`Required documentation stylesheet is missing: ${name}`);
    for (const stylesheet of required) {
      if (!stylesheet.loaded)
        throw new Error(
          `Required documentation stylesheet failed to load: ${stylesheet.path}`,
        );
    }
  }
}

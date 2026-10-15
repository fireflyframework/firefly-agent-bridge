/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * https://www.apache.org/licenses/LICENSE-2.0 */
import { expect } from "@playwright/test";

export async function readyImages(images) {
  for (const image of await images.all()) {
    await image.scrollIntoViewIfNeeded();
    const expected = await image.evaluate(
      (element) => new URL(element.getAttribute("src"), document.baseURI).href,
    );
    await expect
      .poll(() =>
        image.evaluate((element) => ({
          source: element.currentSrc,
          complete: element.complete,
          width: element.naturalWidth > 0,
          height: element.naturalHeight > 0,
        })),
      )
      .toEqual({ source: expected, complete: true, width: true, height: true });
    await image.evaluate((element) => element.decode());
  }
}

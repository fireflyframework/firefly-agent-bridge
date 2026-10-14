/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * https://www.apache.org/licenses/LICENSE-2.0 */
import { test, expect } from "@playwright/test";
import { readyImages } from "./image-readiness.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

async function sources(page) {
  await page.goto("/dashboard/");
  return page
    .locator(".bridge-shot")
    .first()
    .locator("img")
    .evaluateAll((images) =>
      images.map(
        (image) => new URL(image.getAttribute("src"), document.baseURI).href,
      ),
    );
}

async function observeDecode(page) {
  await page.evaluate(() => {
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      this.dataset.decodes = String(Number(this.dataset.decodes || 0) + 1);
      return decode.call(this);
    };
  });
}

test("loaded lazy images keep their source and loading policy with one decode", async ({
  page,
}) => {
  const [source] = await sources(page);
  await page.setContent(
    `<img src="${source}" loading="lazy" width="320" height="200">`,
  );
  const image = page.locator("img");
  await expect
    .poll(() =>
      image.evaluate((element) => element.complete && element.naturalWidth > 0),
    )
    .toBe(true);
  await observeDecode(page);
  await readyImages(image);
  await expect(image).toHaveAttribute("loading", "lazy");
  await expect(image).toHaveAttribute("data-decodes", "1");
  expect(await image.evaluate((element) => element.currentSrc)).toBe(source);
});

test("bulk readiness visits offscreen lazy images without eager loading", async ({
  page,
}) => {
  const [source] = await sources(page);
  await page.setContent(`<img src="${source}" loading="lazy" width="320" height="200">
    <div style="height:20000px"></div>
    <img src="${source}" loading="lazy" width="320" height="200">`);
  await observeDecode(page);
  const images = page.locator("img");
  expect((await images.last().boundingBox()).y).toBeGreaterThan(10000);
  await readyImages(images);
  for (const image of await images.all()) {
    await expect(image).toHaveAttribute("loading", "lazy");
    await expect(image).toHaveAttribute("data-decodes", "1");
  }
  await expect(images.last()).toBeInViewport();
});

test("a source switch completes the exact new request before decoding", async ({
  page,
}) => {
  const [light, dark] = await sources(page);
  await page.setContent(
    `<img src="${light}" loading="lazy" width="320" height="200">`,
  );
  const image = page.locator("img");
  await expect
    .poll(() =>
      image.evaluate((element) => element.complete && element.naturalWidth > 0),
    )
    .toBe(true);
  const requested = deferred();
  const release = deferred();
  const observed = deferred();
  const selected = dark + "?controlled-source-switch";
  await page.route(selected, async (route) => {
    requested.resolve();
    await release.promise;
    await route.continue();
  });
  await image.evaluate((element, source) => (element.src = source), selected);
  await requested.promise;
  await page.exposeFunction("nativeSourceObserved", () => observed.resolve());
  await image.evaluate((element) => {
    const source = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      "currentSrc",
    ).get;
    const decode = HTMLImageElement.prototype.decode;
    element.decodeObservations = [];
    Object.defineProperty(element, "currentSrc", {
      get() {
        const value = source.call(this);
        window.nativeSourceObserved();
        return value;
      },
    });
    element.decode = function () {
      this.decodeObservations.push({
        source: this.currentSrc,
        complete: this.complete,
        width: this.naturalWidth > 0,
      });
      return decode.call(this);
    };
  });
  const admission = readyImages(image).then(
    () => null,
    (error) => error,
  );
  try {
    await observed.promise;
  } finally {
    release.resolve();
  }
  const error = await admission;
  if (error) throw error;
  expect(await image.evaluate((element) => element.decodeObservations)).toEqual(
    [{ source: selected, complete: true, width: true }],
  );
  await expect(image).toHaveAttribute("loading", "lazy");
});

test("a broken image request fails readiness without claiming a decode", async ({
  page,
}) => {
  const [source] = await sources(page);
  const broken = source + "?controlled-broken-image";
  await page.route(broken, (route) => route.abort("connectionrefused"));
  await page.setContent(
    `<img src="${broken}" loading="lazy" width="320" height="200">`,
  );
  const image = page.locator("img");
  await observeDecode(page);
  await expect(readyImages(image)).rejects.toThrow();
  expect(
    await image.evaluate((element) => ({
      complete: element.complete,
      width: element.naturalWidth,
    })),
  ).toEqual({
    complete: true,
    width: 0,
  });
  expect(await image.getAttribute("data-decodes")).toBeNull();
});

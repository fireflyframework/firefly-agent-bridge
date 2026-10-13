/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * https://www.apache.org/licenses/LICENSE-2.0 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../package.json", import.meta.url));
const { defineConfig } = require("@playwright/test");
export default defineConfig({
  testDir: "./docs-browser",
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:8796",
    headless: true,
    viewport: { width: 1440, height: 1050 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `"${process.env.BRIDGE_PYTHON ?? "python3"}" -m http.server 8796 --bind 127.0.0.1 --directory work/docs-site`,
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    url: "http://127.0.0.1:8796",
    reuseExistingServer: false,
  },
});

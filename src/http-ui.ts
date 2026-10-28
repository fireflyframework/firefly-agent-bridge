/*!
 * Copyright (c) 2026 Signature Management Consultants SLU
 * Author: @ancongui (https://github.com/ancongui)
 * Modified by Firefly Software Foundation for Firefly Agent Bridge (2026).
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { FastifyInstance } from "fastify";
import { uiAssets } from "./ui-assets.js";

/** Optional diagnostic console routes. API and cluster paths live in http.ts. */
export function registerUiRoutes(app: FastifyInstance): void {
  app.get("/", async (_req, reply) =>
    reply.type("text/html; charset=utf-8").send(uiAssets.html),
  );
  for (const [path, asset, type] of [
    ["/brand-dark.svg", uiAssets.brandDark, "image/svg+xml"],
    ["/brand-light.svg", uiAssets.brandLight, "image/svg+xml"],
    ["/bridge-mark.svg", uiAssets.mark, "image/svg+xml"],
    ["/bridge-mark-light.svg", uiAssets.markLight, "image/svg+xml"],
    ["/fonts/manrope.woff2", uiAssets.font, "font/woff2"],
  ])
    app.get(path!, async (_req, reply) =>
      reply.type(type!).send(Buffer.from(asset!, "base64")),
    );
  app.get("/theme.js", async (_req, reply) =>
    reply.type("text/javascript; charset=utf-8").send(uiAssets.themeJs),
  );
  app.get("/brand.png", async (_req, reply) =>
    reply.type("image/png").send(Buffer.from(uiAssets.brand, "base64")),
  );
  app.get("/app.css", async (_req, reply) =>
    reply.type("text/css; charset=utf-8").send(uiAssets.css),
  );
  app.get("/audit.js", async (_req, reply) =>
    reply.type("text/javascript; charset=utf-8").send(uiAssets.auditJs),
  );
  app.get("/setup.js", async (_req, reply) =>
    reply.type("text/javascript; charset=utf-8").send(uiAssets.setupJs),
  );
  app.get("/navigation.js", async (_req, reply) =>
    reply.type("application/javascript").send(uiAssets.navigationJs),
  );
  app.get("/job-wizard.js", async (_req, reply) =>
    reply.type("application/javascript").send(uiAssets.jobWizardJs),
  );
  app.get("/image-input.js", async (_req, reply) =>
    reply.type("application/javascript").send(uiAssets.imageInputJs),
  );
  app.get("/bridge-emblem-dark.svg", async (_req, reply) =>
    reply
      .type("image/svg+xml")
      .send(Buffer.from(uiAssets.emblemDark, "base64")),
  );
  app.get("/bridge-emblem-light.svg", async (_req, reply) =>
    reply
      .type("image/svg+xml")
      .send(Buffer.from(uiAssets.emblemLight, "base64")),
  );
  app.get("/app.js", async (_req, reply) =>
    reply.type("text/javascript; charset=utf-8").send(uiAssets.js),
  );
}

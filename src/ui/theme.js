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

const preferenceKey = "firefly-bridge-theme";
const media = matchMedia("(prefers-color-scheme: dark)");
let preference = "system";
try {
  const saved = localStorage.getItem(preferenceKey);
  if (["system", "light", "dark"].includes(saved)) preference = saved;
} catch {
  /* Appearance also works when browser storage is disabled. */
}
function applyAppearance() {
  document.documentElement.dataset.theme =
    preference === "system" ? (media.matches ? "dark" : "light") : preference;
  document.documentElement.dataset.themePreference = preference;
}
applyAppearance();
media.addEventListener("change", applyAppearance);
document.addEventListener("DOMContentLoaded", () => {
  const select = document.getElementById("appearance");
  select.value = preference;
  select.addEventListener("change", () => {
    preference = select.value;
    try {
      localStorage.setItem(preferenceKey, preference);
    } catch {
      /* Optional appearance preference. */
    }
    applyAppearance();
  });
});

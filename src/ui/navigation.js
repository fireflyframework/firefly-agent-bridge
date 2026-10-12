/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * Licensed under https://www.apache.org/licenses/LICENSE-2.0
 */
export function createMobileNavigation() {
  const menu = document.getElementById("mobile-menu"),
    trigger = document.getElementById("mobile-menu-button"),
    nav = document.querySelector(".rail nav"),
    rail = document.querySelector(".rail"),
    slot = document.getElementById("mobile-nav-slot"),
    media = matchMedia("(max-width: 900px)");
  const move = () => {
    if (!media.matches && menu.open) menu.close();
    if (media.matches) slot.append(nav);
    else rail.insertBefore(nav, trigger);
  };
  trigger.onclick = () => {
    menu.returnValue = "";
    menu.showModal();
  };
  document.getElementById("close-mobile-menu").onclick = () => menu.close();
  menu.addEventListener("close", () => {
    if (menu.returnValue === "navigation")
      document.getElementById("view-title").focus({ preventScroll: true });
    else if (media.matches) trigger.focus({ preventScroll: true });
    else
      (
        nav.querySelector('[aria-current="page"]') ??
        nav.querySelector("button")
      )?.focus({ preventScroll: true });
  });
  menu.addEventListener("click", (event) => {
    if (event.target === menu) {
      const box = menu.getBoundingClientRect();
      if (
        event.clientX < box.left ||
        event.clientX > box.right ||
        event.clientY < box.top ||
        event.clientY > box.bottom
      )
        menu.close();
    }
  });
  media.addEventListener("change", move);
  move();
  return {
    close: () => {
      if (menu.open) menu.close("navigation");
    },
  };
}

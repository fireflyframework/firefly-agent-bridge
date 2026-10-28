/*!
 * Copyright (c) 2026 Signature Management Consultants SLU
 * Author: @ancongui (https://github.com/ancongui)
 * Modified by Firefly Software Foundation for Firefly Agent Bridge (2026).
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  BRIDGE_BANNER,
  shouldShowBanner,
  formatWelcome,
} from "../src/cli-banner.js";

const saved = {
  BRIDGE_NO_BANNER: process.env.BRIDGE_NO_BANNER,
  NO_COLOR: process.env.NO_COLOR,
  CI: process.env.CI,
  FORCE_COLOR: process.env.FORCE_COLOR,
};

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("cli-banner", () => {
  it("exports a hand-authored ASCII span with BRIDGE branding", () => {
    expect(BRIDGE_BANNER).toContain("BRIDGE");
    expect(BRIDGE_BANNER).toContain("Firefly Agent Bridge");
    expect(BRIDGE_BANNER.split("\n").length).toBeLessThanOrEqual(12);
    for (const line of BRIDGE_BANNER.split("\n"))
      expect(line.length).toBeLessThanOrEqual(72);
  });

  it("shows banner only on TTY without suppressors", () => {
    delete process.env.BRIDGE_NO_BANNER;
    delete process.env.NO_COLOR;
    delete process.env.CI;
    expect(shouldShowBanner({ isTTY: true })).toBe(true);
    expect(shouldShowBanner({ isTTY: false })).toBe(false);
  });

  it("never shows when BRIDGE_NO_BANNER, NO_COLOR, or CI is set", () => {
    delete process.env.NO_COLOR;
    delete process.env.CI;
    process.env.BRIDGE_NO_BANNER = "1";
    expect(shouldShowBanner({ isTTY: true })).toBe(false);

    delete process.env.BRIDGE_NO_BANNER;
    process.env.NO_COLOR = "1";
    expect(shouldShowBanner({ isTTY: true })).toBe(false);

    delete process.env.NO_COLOR;
    process.env.CI = "true";
    expect(shouldShowBanner({ isTTY: true })).toBe(false);
  });

  it("formatWelcome includes version and locked quick-start with bridge name", () => {
    const text = formatWelcome("0.2.21");
    expect(text).toContain("BRIDGE");
    expect(text).toContain("0.2.21");
    expect(text).toContain("Quick start");
    expect(text).toContain("bridge init --worker claude");
    expect(text).toContain("bridge serve");
    expect(text).toContain("bridge cluster init-coordinator --exposure internet");
    expect(text).toContain("bridge daemon start --cluster-worker");
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it("applies amber ANSI when color is requested", () => {
    const colored = formatWelcome("0.2.21", { color: true });
    expect(colored).toContain("\u001b[38;2;255;179;74m");
    expect(colored).toContain("\u001b[0m");
    expect(formatWelcome("0.2.21", { color: false })).not.toContain("\u001b[");
  });
});

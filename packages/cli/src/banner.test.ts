import { describe, it, expect } from "vitest";
import { BANNER_LINES, TAGLINE } from "./banner.js";

describe("banner", () => {
  it("has exactly 5 art lines", () => {
    expect(BANNER_LINES).toHaveLength(5);
  });

  it("all lines have equal width", () => {
    const widths = new Set(BANNER_LINES.map((l) => l.length));
    expect(widths.size).toBe(1);
  });

  it("fits narrow terminals (<= 60 columns)", () => {
    for (const line of BANNER_LINES) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  it("is pure ASCII (codepoints <= 127)", () => {
    for (const line of BANNER_LINES) {
      for (const ch of line) {
        expect(ch.charCodeAt(0)).toBeLessThanOrEqual(127);
      }
    }
  });

  it("tagline is non-empty", () => {
    expect(TAGLINE.length).toBeGreaterThan(0);
  });
});

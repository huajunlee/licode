import { describe, it, expect } from "vitest";
import { COLORS, ICONS } from "./theme.js";

const REMOVED_EMOJI = ["⏳", "🤔", "🆕", "📖", "🔍", "✏", "⚙"];

describe("theme tokens", () => {
  describe("COLORS", () => {
    it("matches the minimal-modern palette", () => {
      expect(COLORS).toMatchObject({
        accent: "#E5A567",
        text: "#C8CCD8",
        muted: "#8A8F9E",
        faint: "#565B68",
        success: "#9ECE6A",
        warning: "#E0AF68",
        error: "#F7768E",
      });
    });

    it("all color values are hex truecolor strings", () => {
      for (const [key, value] of Object.entries(COLORS)) {
        expect(value, `COLORS.${key}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    });

    it("diaryAccent is a hex truecolor", () => {
      expect(COLORS.diaryAccent).toMatch(/^#[0-9A-Fa-f]{6}$/);
    });

    it("exposes only the minimal-modern palette keys (incl. diaryAccent)", () => {
      expect(Object.keys(COLORS).sort()).toEqual([
        "accent", "diaryAccent", "error", "faint", "muted", "success", "text", "warning",
      ]);
    });
  });

  describe("ICONS", () => {
    it("spinnerFrames has exactly 10 unique frames", () => {
      expect(ICONS.spinnerFrames).toHaveLength(10);
      expect(new Set(ICONS.spinnerFrames).size).toBe(10);
    });

    it("no icon contains removed emoji", () => {
      for (const [key, value] of Object.entries(ICONS)) {
        if (typeof value !== "string") continue;
        for (const emoji of REMOVED_EMOJI) {
          expect(value.includes(emoji), `ICONS.${key} contains ${emoji}`).toBe(false);
        }
      }
    });

    it("no icon contains emoji-range codepoints or variation selectors", () => {
      for (const [key, value] of Object.entries(ICONS)) {
        if (typeof value !== "string") continue;
        expect(
          /[\u{1F000}-\u{1FAFF}\u{FE0F}]/u.test(value),
          `ICONS.${key} has emoji-range codepoint`
        ).toBe(false);
      }
    });
  });
});

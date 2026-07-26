import { describe, it, expect } from "vitest";
import { COLORS, BORDERS, SPACING, ICONS } from "./theme.js";

describe("theme tokens", () => {
  describe("COLORS", () => {
    it("all color values are non-empty strings", () => {
      for (const [key, value] of Object.entries(COLORS)) {
        expect(value, `COLORS.${key} should be a non-empty string`).toBeTruthy();
        expect(typeof value, `COLORS.${key} should be a string`).toBe("string");
      }
    });

    it("semantic groups use their designated base colors", () => {
      expect(COLORS.primary).toBe("green");
      expect(COLORS.success).toBe("green");
      expect(COLORS.toolDone).toBe("green");

      expect(COLORS.warning).toBe("yellow");
      expect(COLORS.toolPending).toBe("yellow");

      expect(COLORS.error).toBe("red");
      expect(COLORS.toolError).toBe("red");
      expect(COLORS.toolCardBorderError).toBe("red");

      expect(COLORS.info).toBe("cyan");
      expect(COLORS.toolRunning).toBe("cyan");

      expect(COLORS.accent).toBe("blue");
      expect(COLORS.toolCardBorder).toBe("blue");
    });

    it("all color values are valid Ink v5 named colors", () => {
      const validColors = new Set([
        "green", "yellow", "red", "cyan", "blue",
      ]);
      for (const [key, value] of Object.entries(COLORS)) {
        expect(
          validColors.has(value),
          `COLORS.${key} = "${value}" is not a valid Ink named color`
        ).toBe(true);
      }
    });
  });

  describe("BORDERS", () => {
    it("popup and card have distinct styles", () => {
      expect(BORDERS.popup).toBe("single");
      expect(BORDERS.card).toBe("round");
      expect(BORDERS.popup).not.toBe(BORDERS.card);
    });
  });

  describe("SPACING", () => {
    it("all spacing values are positive integers", () => {
      for (const [key, value] of Object.entries(SPACING)) {
        expect(Number.isInteger(value), `SPACING.${key} should be an integer`).toBe(true);
        expect(value, `SPACING.${key} should be positive`).toBeGreaterThan(0);
      }
    });

    it("spacing values are in ascending order", () => {
      const values = Object.values(SPACING);
      for (let i = 1; i < values.length; i++) {
        expect(values[i], `${i} should be >= ${i - 1}`).toBeGreaterThanOrEqual(values[i - 1]);
      }
    });
  });

  describe("ICONS", () => {
    it("spinnerFrames has exactly 10 frames", () => {
      expect(ICONS.spinnerFrames).toHaveLength(10);
    });

    it("spinnerFrames contains unique characters", () => {
      const unique = new Set(ICONS.spinnerFrames);
      expect(unique.size).toBe(ICONS.spinnerFrames.length);
    });

    it("all string icon fields are non-empty", () => {
      const stringFields: Array<keyof typeof ICONS> = [
        "prompt", "selected", "expand", "success", "error",
        "pending", "running", "newSession", "spinner", "thinking",
      ];
      for (const field of stringFields) {
        const value = ICONS[field];
        expect(typeof value, `ICONS.${field} should be a string`).toBe("string");
        expect(value, `ICONS.${field} should be non-empty`).toBeTruthy();
      }
    });
  });
});

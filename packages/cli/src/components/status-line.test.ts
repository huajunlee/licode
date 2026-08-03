import { describe, it, expect } from "vitest";
import { formatTokens, formatStatusWide, formatStatusNarrow } from "./status-line.js";

describe("formatTokens", () => {
  it("uses thousands separators", () => {
    expect(formatTokens(1234)).toBe("1,234");
    expect(formatTokens(0)).toBe("0");
  });
});

describe("formatStatusWide", () => {
  it("joins model, tokens and 8-char session id", () => {
    expect(formatStatusWide("deepseek-v4-pro", 1234, "a3f9c21e-9999")).toBe(
      "deepseek-v4-pro · 1,234 tok · a3f9c21e"
    );
  });

  it("includes compact token/context percentage when contextWindow > 0", () => {
    expect(formatStatusWide("deepseek-v4-pro", 24600, "a3f9c21e-9999", 200000)).toBe(
      "deepseek-v4-pro · 24,600 tok (12%) · a3f9c21e"
    );
  });
});

describe("formatStatusNarrow", () => {
  it("drops session id", () => {
    expect(formatStatusNarrow("deepseek-v4-pro", 1234)).toBe(
      "deepseek-v4-pro · 1,234 tok"
    );
  });
});

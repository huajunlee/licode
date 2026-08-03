import { describe, it, expect } from "vitest";
import { shouldSelectSuggestion } from "./should-select-suggestion.js";

describe("shouldSelectSuggestion", () => {
  it("true when input starts with / and suggestions exist", () => {
    expect(shouldSelectSuggestion("/di", [{ name: "/diary" }])).toBe(true);
  });
  it("false when no suggestions (Enter should send)", () => {
    expect(shouldSelectSuggestion("/zzz", [])).toBe(false);
  });
  it("false when input does not start with /", () => {
    expect(shouldSelectSuggestion("hello", [{ name: "/diary" }])).toBe(false);
  });
});

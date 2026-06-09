import { describe, it, expect } from "vitest";
import { navigateHistory, pushHistory } from "./history-navigator.js";

describe("navigateHistory", () => {
  const history = ["first", "second", "third"];

  it("↑ from end of history returns most recent entry", () => {
    const result = navigateHistory(history, 3, "up");
    expect(result.text).toBe("third");
    expect(result.newIndex).toBe(2);
  });

  it("↑ twice returns second-most-recent entry", () => {
    const afterFirstUp = navigateHistory(history, 3, "up");
    const afterSecondUp = navigateHistory(history, afterFirstUp.newIndex, "up");
    expect(afterSecondUp.text).toBe("second");
    expect(afterSecondUp.newIndex).toBe(1);
  });

  it("↑ at oldest entry stays at oldest entry", () => {
    const result = navigateHistory(history, 0, "up");
    expect(result.text).toBe("first");
    expect(result.newIndex).toBe(0);
  });

  it("↓ from newest entry returns empty string (clear input)", () => {
    const result = navigateHistory(history, 2, "down");
    expect(result.newIndex).toBe(3);
    expect(result.text).toBe("");
  });

  it("↓ past end of history stays at end with empty string", () => {
    const result = navigateHistory(history, 3, "down");
    expect(result.newIndex).toBe(3);
    expect(result.text).toBe("");
  });

  it("empty history always returns empty string", () => {
    expect(navigateHistory([], 0, "up")).toEqual({ newIndex: 0, text: "" });
    expect(navigateHistory([], 0, "down")).toEqual({ newIndex: 0, text: "" });
  });

  it("full round-trip: ↑ up, ↓ back down restores empty input", () => {
    const up = navigateHistory(history, 3, "up");
    expect(up.text).toBe("third");
    const down = navigateHistory(history, up.newIndex, "down");
    expect(down.text).toBe("");
    expect(down.newIndex).toBe(3);
  });

  it("partial up then down returns correct entry", () => {
    const up1 = navigateHistory(history, 3, "up"); // third
    const up2 = navigateHistory(history, up1.newIndex, "up"); // second
    const down = navigateHistory(history, up2.newIndex, "down"); // third
    expect(down.text).toBe("third");
    expect(down.newIndex).toBe(2);
  });
});

describe("pushHistory", () => {
  it("appends new input to history", () => {
    const result = pushHistory([], "hello");
    expect(result).toEqual(["hello"]);
  });

  it("deduplicates consecutive identical entries", () => {
    const result = pushHistory(["hello"], "hello");
    expect(result).toEqual(["hello"]);
  });

  it("allows the same entry again after a different one", () => {
    const result = pushHistory(["hello", "world"], "hello");
    expect(result).toEqual(["hello", "world", "hello"]);
  });

  it("ignores empty/whitespace input", () => {
    expect(pushHistory(["a"], "  ")).toEqual(["a"]);
    expect(pushHistory([], "")).toEqual([]);
  });
});

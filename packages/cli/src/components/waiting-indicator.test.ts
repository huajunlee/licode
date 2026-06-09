import { describe, it, expect } from "vitest";
import { formatElapsed } from "./waiting-indicator.js";

describe("formatElapsed", () => {
  it("returns seconds only when under 60s", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(1)).toBe("1s");
    expect(formatElapsed(30)).toBe("30s");
    expect(formatElapsed(59)).toBe("59s");
  });

  it("returns minutes and seconds when 60s or above", () => {
    expect(formatElapsed(60)).toBe("1m 0s");
    expect(formatElapsed(65)).toBe("1m 5s");
    expect(formatElapsed(125)).toBe("2m 5s");
    expect(formatElapsed(3600)).toBe("60m 0s");
  });
});

import { describe, it, expect } from "vitest";
import { TokenCalibrator } from "./token-calibrator.js";

describe("TokenCalibrator", () => {
  it("starts with ratio 1 when no observations have been made", () => {
    const calibrator = new TokenCalibrator();
    expect(calibrator.ratio).toBe(1);
  });

  it("sets ratio to real/base on the first observation", () => {
    const calibrator = new TokenCalibrator();
    calibrator.observe(100, 150);
    expect(calibrator.ratio).toBe(1.5);
  });

  it("smooths subsequent observations with an EMA (0.7 old + 0.3 new)", () => {
    const calibrator = new TokenCalibrator();
    calibrator.observe(100, 150); // ratio -> 1.5
    calibrator.observe(100, 120); // ratio -> 0.7*1.5 + 0.3*1.2 = 1.41
    expect(calibrator.ratio).toBeCloseTo(1.41, 10);
  });

  it("clamps ratio to the upper bound of 4 on a huge sample", () => {
    const calibrator = new TokenCalibrator();
    calibrator.observe(100, 1000); // sample 10 -> clamped to 4
    expect(calibrator.ratio).toBe(4);
  });

  it("clamps ratio to the lower bound of 0.5 on a tiny sample", () => {
    const calibrator = new TokenCalibrator();
    calibrator.observe(100, 10); // sample 0.1 -> clamped to 0.5
    expect(calibrator.ratio).toBe(0.5);
  });
});

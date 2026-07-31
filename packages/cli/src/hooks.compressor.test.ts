import { describe, expect, it } from "vitest";

// Extract the flag-reading into a pure helper so it is testable.
import { readContextFlags } from "./hooks.js";

describe("readContextFlags", () => {
  it("defaults all flags on", () => {
    const prev = { ...process.env };
    delete process.env.LICODE_CONTEXT_ROLLING;
    delete process.env.LICODE_CONTEXT_SELECTIVE;
    delete process.env.LICODE_CONTEXT_FILECHANGE;
    const f = readContextFlags();
    expect(f).toEqual({ rollingSummary: true, selectiveRetention: true, fileChangeCompaction: true, summaryMaxTokens: 2048 });
    process.env = prev;
  });

  it("turns a flag off when set to 'off'", () => {
    const prev = { ...process.env };
    process.env.LICODE_CONTEXT_ROLLING = "off";
    const f = readContextFlags();
    expect(f.rollingSummary).toBe(false);
    expect(f.selectiveRetention).toBe(true);
    process.env = prev;
  });

  it("honors a custom summary max tokens", () => {
    const prev = { ...process.env };
    process.env.LICODE_CONTEXT_SUMMARY_MAX_TOKENS = "1024";
    expect(readContextFlags().summaryMaxTokens).toBe(1024);
    process.env = prev;
  });
});

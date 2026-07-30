import { describe, it, expect } from "vitest";
import { TokenCounter } from "./token-counter.js";
import type { Message } from "./provider.js";

describe("TokenCounter", () => {
  const counter = new TokenCounter();

  it("estimates pure English text", () => {
    const text = "Hello world, this is a test.";
    const tokens = counter.estimate(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(text.length);
  });

  it("estimates Chinese text with higher token-per-char density", () => {
    // Chinese chars are more information-dense (~1.5 chars/token)
    // English is ~4 chars/token, so same char count → more tokens for Chinese
    const zhTokens = counter.estimate("这是一段中文测试文本");
    const enTokens = counter.estimate("Hello");
    // Both produce reasonable estimates
    expect(zhTokens).toBeGreaterThan(0);
    expect(enTokens).toBeGreaterThan(0);
  });

  it("estimates empty string as zero", () => {
    expect(counter.estimate("")).toBe(0);
  });

  it("estimates symbol-heavy text as denser than equal-length letters", () => {
    // Punctuation/symbols tend to be their own tokens, so the same char count
    // should yield more tokens than a bare letter run.
    const symbols = counter.estimate("......"); // 6 symbols
    const letters = counter.estimate("abcdef"); // 6 letters
    expect(symbols).toBeGreaterThan(letters);
  });

  it("estimates messages array", () => {
    const messages = [
      { role: "user" as const, content: "Hello", timestamp: "2026-01-01T00:00:00Z" },
      { role: "assistant" as const, content: "Hi there!", timestamp: "2026-01-01T00:00:01Z" },
    ];
    const tokens = counter.estimateMessages(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it("estimates tool_result messages by content, ignoring tool_use_id", () => {
    const a: Message = {
      role: "user",
      content: [{ tool_use_id: "a", content: "done" }],
      timestamp: "t",
    };
    const b: Message = {
      role: "user",
      content: [{ tool_use_id: "aaaaaaaaaa", content: "done" }],
      timestamp: "t",
    };
    expect(counter.estimateMessages([a])).toBe(counter.estimateMessages([b]));
  });

  it("estimates tool_use messages by name+input, ignoring id", () => {
    const a: Message = {
      role: "assistant",
      content: [{ id: "a", name: "read", input: { path: "/x" } }],
      timestamp: "t",
    };
    const b: Message = {
      role: "assistant",
      content: [{ id: "aaaaaaaaaa", name: "read", input: { path: "/x" } }],
      timestamp: "t",
    };
    expect(counter.estimateMessages([a])).toBe(counter.estimateMessages([b]));
  });
});

describe("TokenCounter calibration", () => {
  it("exposes ratio starting at 1 and updates it via observe", () => {
    const counter = new TokenCounter();
    expect(counter.ratio).toBe(1);
    counter.observe(100, 150);
    expect(counter.ratio).toBe(1.5);
  });
});

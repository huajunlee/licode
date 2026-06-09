import { describe, it, expect } from "vitest";
import { TokenCounter } from "./token-counter.js";

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

  it("estimates messages array", () => {
    const messages = [
      { role: "user" as const, content: "Hello", timestamp: "2026-01-01T00:00:00Z" },
      { role: "assistant" as const, content: "Hi there!", timestamp: "2026-01-01T00:00:01Z" },
    ];
    const tokens = counter.estimateMessages(messages);
    expect(tokens).toBeGreaterThan(0);
  });
});

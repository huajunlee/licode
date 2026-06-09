import { describe, it, expect } from "vitest";
import { AnthropicProvider } from "./anthropic.js";
import type { Message, ChatRequest } from "./provider.js";
import { TokenCounter } from "./token-counter.js";

describe("AnthropicProvider", () => {
  const provider = new AnthropicProvider({
    apiKey: "sk-ant-test",
  });

  it("has correct name and context limit", () => {
    expect(provider.name).toBe("anthropic");
    expect(provider.maxContextTokens).toBe(200_000);
  });

  it("countTokens delegates to TokenCounter", () => {
    const messages: Message[] = [
      { role: "user", content: "Hello world test text", timestamp: "2026-01-01T00:00:00Z" },
    ];
    const tokens = provider.countTokens(messages);
    const counter = new TokenCounter();
    expect(tokens).toBe(counter.estimateMessages(messages));
  });

  it("can be constructed with custom baseUrl", () => {
    const p = new AnthropicProvider({
      apiKey: "sk-ant-test",
      baseUrl: "https://custom.api.example.com",
    });
    expect(p.name).toBe("anthropic");
  });
});

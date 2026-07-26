import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { MemoryExtractor } from "./extractor.js";
import { MemoryStore } from "./store.js";
import type { Message } from "../llm/provider.js";
import { AnthropicProvider } from "../llm/anthropic.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

// Mock AnthropicProvider to avoid real API calls
vi.mock("../llm/anthropic.js", () => {
  return {
    AnthropicProvider: vi.fn().mockImplementation(() => ({
      name: "mock-anthropic",
      maxContextTokens: 200000,
      chat: vi.fn(),
      stream: vi.fn(),
      countTokens: vi.fn(() => 100),
    })),
  };
});

function makeUserMsg(content: string): Message {
  return { role: "user", content, timestamp: new Date().toISOString() };
}

function makeAsstMsg(content: string): Message {
  return { role: "assistant", content, timestamp: new Date().toISOString() };
}

describe("MemoryExtractor (LLM-based)", () => {
  let dir: string | null = null;

  beforeEach(() => {
    // Ensure env vars are set for constructor
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-123");
  });

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
    vi.unstubAllEnvs();
  });

  // ── shouldExtract ────────────────────────────────────────────────

  describe("shouldExtract", () => {
    it("returns true when message starts with '记住'", () => {
      const extractor = new MemoryExtractor();
      const result = extractor.shouldExtract([makeUserMsg("记住我喜欢吃辣的东西")]);
      expect(result).toBe(true);
    });

    it("returns true for '我叫' (name statement)", () => {
      const extractor = new MemoryExtractor();
      const result = extractor.shouldExtract([makeUserMsg("我叫小明，请多关照")]);
      expect(result).toBe(true);
    });

    it("returns true for '我是' (identity statement)", () => {
      const extractor = new MemoryExtractor();
      const result = extractor.shouldExtract([makeUserMsg("我是全栈工程师")]);
      expect(result).toBe(true);
    });

    it("returns true for '我喜欢' (preference statement)", () => {
      const extractor = new MemoryExtractor();
      const result = extractor.shouldExtract([makeUserMsg("我喜欢用 Rust 写后端")]);
      expect(result).toBe(true);
    });

    it("returns true for 'remember' pattern (English)", () => {
      const extractor = new MemoryExtractor();
      const result = extractor.shouldExtract([
        makeUserMsg("Please remember that I use vim as my editor"),
      ]);
      expect(result).toBe(true);
    });

    it("returns true for 'I prefer' pattern (English)", () => {
      const extractor = new MemoryExtractor();
      const result = extractor.shouldExtract([
        makeUserMsg("I prefer dark mode in my IDE"),
      ]);
      expect(result).toBe(true);
    });

    it("returns false for plain conversation", () => {
      const extractor = new MemoryExtractor();
      const result = extractor.shouldExtract([
        makeUserMsg("今天天气真不错啊"),
        makeAsstMsg("是的，阳光很好！"),
      ]);
      expect(result).toBe(false);
    });

    it("returns false for question '我叫什么名字？'", () => {
      const extractor = new MemoryExtractor();
      const result = extractor.shouldExtract([makeUserMsg("我叫什么名字？")]);
      expect(result).toBe(false);
    });

    it("returns false for '你是谁' (asking about the AI)", () => {
      const extractor = new MemoryExtractor();
      const result = extractor.shouldExtract([makeUserMsg("你是谁？")]);
      expect(result).toBe(false);
    });

    it("returns false for empty messages array", () => {
      const extractor = new MemoryExtractor();
      const result = extractor.shouldExtract([]);
      expect(result).toBe(false);
    });

    it("returns true when keywords are in any user message, not just the last", () => {
      const extractor = new MemoryExtractor();
      const result = extractor.shouldExtract([
        makeUserMsg("hello"),
        makeAsstMsg("hi there"),
        makeUserMsg("哦对了，我想起来一件事"),
      ]);
      expect(result).toBe(true);
    });
  });

  // ── extract ──────────────────────────────────────────────────────

  describe("extract", () => {
    it("calls LLM with conversation messages and saves extracted memories", async () => {
      dir = mkdtempSync(path.join(tmpdir(), "licode-llm-mem-"));
      const store = new MemoryStore(path.join(dir, ".licode", "memory"));

      const extractor = new MemoryExtractor();
      // Mock the internal LLM's chat method
      const mockChat = vi.fn().mockResolvedValue({
        content: JSON.stringify([
          {
            action: "create",
            slug: "user/food-preferences",
            type: "user",
            name: "Food Preferences",
            description: "The user likes spicy food.",
            content: "The user likes spicy food, especially Sichuan cuisine.",
          },
        ]),
        usage: { input: 100, output: 50 },
      });
      (extractor as any).llm.chat = mockChat;

      const messages: Message[] = [
        makeUserMsg("我爱吃辣的东西，特别是川菜"),
        makeAsstMsg("川菜确实很美味！"),
      ];

      await extractor.extract(messages, store);

      // Verify LLM was called
      expect(mockChat).toHaveBeenCalledTimes(1);

      // Verify memory was saved
      const all = await store.listAll();
      expect(all).toHaveLength(1);
      expect(all[0].slug).toBe("user/food-preferences");
      expect(all[0].content).toContain("spicy food");
    });

    it("saves nothing when LLM returns empty array", async () => {
      dir = mkdtempSync(path.join(tmpdir(), "licode-llm-mem-"));
      const store = new MemoryStore(path.join(dir, ".licode", "memory"));

      const extractor = new MemoryExtractor();
      const mockChat = vi.fn().mockResolvedValue({
        content: "[]",
        usage: { input: 50, output: 5 },
      });
      (extractor as any).llm.chat = mockChat;

      await extractor.extract(
        [makeUserMsg("今天天气怎么样？")],
        store
      );

      const all = await store.listAll();
      expect(all).toHaveLength(0);
    });

    it("saves multiple memories when LLM returns multiple items", async () => {
      dir = mkdtempSync(path.join(tmpdir(), "licode-llm-mem-"));
      const store = new MemoryStore(path.join(dir, ".licode", "memory"));

      const extractor = new MemoryExtractor();
      const mockChat = vi.fn().mockResolvedValue({
        content: JSON.stringify([
          {
            action: "create",
            slug: "user/identity",
            type: "user",
            name: "User Identity",
            description: "User is a full-stack dev",
            content: "The user is a full-stack developer.",
          },
          {
            action: "create",
            slug: "user/editor-preference",
            type: "user",
            name: "Editor Preference",
            description: "Uses VSCode",
            content: "The user prefers VSCode.",
          },
        ]),
        usage: { input: 100, output: 80 },
      });
      (extractor as any).llm.chat = mockChat;

      await extractor.extract(
        [makeUserMsg("我是全栈开发，平时用 VSCode")],
        store
      );

      const all = await store.listAll();
      expect(all).toHaveLength(2);
    });

    it("does not throw when LLM call fails", async () => {
      dir = mkdtempSync(path.join(tmpdir(), "licode-llm-mem-"));
      const store = new MemoryStore(path.join(dir, ".licode", "memory"));

      const extractor = new MemoryExtractor();
      const mockChat = vi.fn().mockRejectedValue(new Error("Network error"));
      (extractor as any).llm.chat = mockChat;

      // Should not throw
      await expect(
        extractor.extract([makeUserMsg("hello")], store)
      ).resolves.toBeUndefined();
    });

    it("does not throw when LLM returns invalid JSON", async () => {
      dir = mkdtempSync(path.join(tmpdir(), "licode-llm-mem-"));
      const store = new MemoryStore(path.join(dir, ".licode", "memory"));

      const extractor = new MemoryExtractor();
      const mockChat = vi.fn().mockResolvedValue({
        content: "not valid json {{{",
        usage: { input: 50, output: 10 },
      });
      (extractor as any).llm.chat = mockChat;

      // Should not throw, just skip
      await expect(
        extractor.extract([makeUserMsg("hello")], store)
      ).resolves.toBeUndefined();
    });
  });

  // ── constructor ──────────────────────────────────────────────────

  describe("constructor", () => {
    it("reads apiKey from ANTHROPIC_API_KEY env var", () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "env-api-key");
      vi.stubEnv("ANTHROPIC_BASE_URL", "");
      new MemoryExtractor(); // should not throw
      expect(AnthropicProvider).toHaveBeenCalled();
    });

    it("uses config apiKey over env var", () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "env-key");
      new MemoryExtractor({ apiKey: "config-key" });
      // The mock should have been called with the config key
      const calls = vi.mocked(AnthropicProvider).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[0].apiKey).toBe("config-key");
    });
  });
});

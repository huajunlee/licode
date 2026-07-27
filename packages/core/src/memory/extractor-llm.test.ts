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
    const NOW = Date.parse("2026-07-27T12:00:00.000Z");

    function userMsgAt(content: string, offsetMs: number): Message {
      return { role: "user", content, timestamp: new Date(NOW + offsetMs).toISOString() };
    }

    it("returns true for correction-style message without any trigger keyword", () => {
      const extractor = new MemoryExtractor();
      const result = extractor.shouldExtract(
        [userMsgAt("不对，我以后都用 pnpm 装依赖", -1000)],
        { lastExtractedAt: 0, now: NOW }
      );
      expect(result).toBe(true);
    });

    it("explicit instruction bypasses the cooldown", () => {
      const extractor = new MemoryExtractor();
      const result = extractor.shouldExtract(
        [userMsgAt("记住：我的编辑器是 Neovim", -500)],
        { lastExtractedAt: NOW - 1000, now: NOW } // inside cooldown
      );
      expect(result).toBe(true);
    });

    it("returns false when all new user messages look like questions", () => {
      const extractor = new MemoryExtractor();
      const result = extractor.shouldExtract(
        [userMsgAt("现在几点了？", -500)],
        { lastExtractedAt: 0, now: NOW }
      );
      expect(result).toBe(false);
    });

    it("returns false when there are no new user messages since lastExtractedAt", () => {
      const extractor = new MemoryExtractor();
      const result = extractor.shouldExtract(
        [userMsgAt("我喜欢红烧排骨", -60_000)],
        { lastExtractedAt: NOW - 1000, now: NOW }
      );
      expect(result).toBe(false);
    });

    it("returns false inside the cooldown window", () => {
      const extractor = new MemoryExtractor();
      const result = extractor.shouldExtract(
        [userMsgAt("今天加班到很晚", -500)],
        { lastExtractedAt: NOW - 60_000, now: NOW } // 1 min ago, cooldown is 5 min
      );
      expect(result).toBe(false);
    });

    it("returns true for a plain statement outside the cooldown (semantic reversal)", () => {
      const extractor = new MemoryExtractor();
      const result = extractor.shouldExtract(
        [
          userMsgAt("今天天气真不错啊", -500),
          { role: "assistant", content: "是的，阳光很好！", timestamp: new Date(NOW - 400).toISOString() },
        ],
        { lastExtractedAt: 0, now: NOW }
      );
      expect(result).toBe(true);
    });

    it("returns true when new messages mix a question and a statement", () => {
      const extractor = new MemoryExtractor();
      const result = extractor.shouldExtract(
        [
          userMsgAt("你是谁？", -500),
          userMsgAt("我决定以后用 pnpm", -400),
        ],
        { lastExtractedAt: 0, now: NOW }
      );
      expect(result).toBe(true);
    });

    it("an old message containing '记住' does not bypass anything", () => {
      const extractor = new MemoryExtractor();
      const result = extractor.shouldExtract(
        [userMsgAt("记住我喜欢红烧排骨", -60_000)],
        { lastExtractedAt: NOW - 1000, now: NOW }
      );
      expect(result).toBe(false);
    });

    it("returns false for empty messages array", () => {
      const extractor = new MemoryExtractor();
      const result = extractor.shouldExtract([], { lastExtractedAt: 0, now: NOW });
      expect(result).toBe(false);
    });

    it("honours a custom cooldownMs", () => {
      const extractor = new MemoryExtractor({ cooldownMs: 1000 });
      const result = extractor.shouldExtract(
        [userMsgAt("随便聊聊", -100)],
        { lastExtractedAt: NOW - 5000, now: NOW } // 5s ago > 1s cooldown
      );
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

    it("includes full existing memory content in the prompt", async () => {
      dir = mkdtempSync(path.join(tmpdir(), "licode-llm-mem-"));
      const store = new MemoryStore(path.join(dir, ".licode", "memory"));
      const now = new Date().toISOString();
      await store.save({
        slug: "user/food-preferences",
        type: "user",
        name: "食物偏好",
        description: "用户喜欢红烧排骨",
        content: "用户喜欢红烧排骨，尤其是家常做法。",
        createdAt: now,
        updatedAt: now,
      });

      const extractor = new MemoryExtractor();
      const mockChat = vi.fn().mockResolvedValue({
        content: "[]",
        usage: { input: 50, output: 5 },
      });
      (extractor as any).llm.chat = mockChat;

      await extractor.extract([makeUserMsg("随便聊聊")], store);

      const prompt = mockChat.mock.calls[0][0].messages[0].content as string;
      expect(prompt).toContain("用户喜欢红烧排骨，尤其是家常做法。");
    });

    it("update action replaces the existing memory file content (contradiction handling)", async () => {
      dir = mkdtempSync(path.join(tmpdir(), "licode-llm-mem-"));
      const store = new MemoryStore(path.join(dir, ".licode", "memory"));
      const now = new Date().toISOString();
      await store.save({
        slug: "user/food-preferences",
        type: "user",
        name: "食物偏好",
        description: "用户喜欢红烧排骨",
        content: "用户喜欢红烧排骨。",
        createdAt: now,
        updatedAt: now,
      });

      const extractor = new MemoryExtractor();
      const mockChat = vi.fn().mockResolvedValue({
        content: JSON.stringify([
          {
            action: "update",
            slug: "user/food-preferences",
            type: "user",
            name: "食物偏好",
            description: "用户不再吃红烧排骨",
            content: "用户曾经喜欢红烧排骨，2026-07 起不再吃了。",
          },
        ]),
        usage: { input: 100, output: 50 },
      });
      (extractor as any).llm.chat = mockChat;

      await extractor.extract([makeUserMsg("我其实不喜欢吃红烧排骨了")], store);

      const loaded = await store.load("user/food-preferences");
      expect(loaded?.content).toBe("用户曾经喜欢红烧排骨，2026-07 起不再吃了。");
      expect(loaded?.content).not.toContain("用户喜欢红烧排骨。");
    });

    it("calls the LLM with maxTokens 2048", async () => {
      dir = mkdtempSync(path.join(tmpdir(), "licode-llm-mem-"));
      const store = new MemoryStore(path.join(dir, ".licode", "memory"));

      const extractor = new MemoryExtractor();
      const mockChat = vi.fn().mockResolvedValue({
        content: "[]",
        usage: { input: 50, output: 5 },
      });
      (extractor as any).llm.chat = mockChat;

      await extractor.extract([makeUserMsg("hello")], store);

      expect(mockChat.mock.calls[0][0].maxTokens).toBe(2048);
    });

    it("drops invalid items and persists the valid ones", async () => {
      dir = mkdtempSync(path.join(tmpdir(), "licode-llm-mem-"));
      const store = new MemoryStore(path.join(dir, ".licode", "memory"));

      const extractor = new MemoryExtractor();
      const mockChat = vi.fn().mockResolvedValue({
        content: JSON.stringify([
          {
            action: "create",
            slug: "user/valid",
            type: "user",
            name: "Valid",
            description: "a valid memory",
            content: "valid content",
          },
          // invalid action
          { action: "delete", slug: "user/x", type: "user", name: "X", description: "x", content: "x" },
          // invalid type
          { action: "create", slug: "user/bad-type", type: "invalid", name: "X", description: "x", content: "x" },
          // slug does not start with "<type>/"
          { action: "create", slug: "wrong/prefix", type: "user", name: "X", description: "x", content: "x" },
        ]),
        usage: { input: 100, output: 80 },
      });
      (extractor as any).llm.chat = mockChat;

      await extractor.extract([makeUserMsg("一些对话")], store);

      const all = await store.listAll();
      expect(all).toHaveLength(1);
      expect(all[0].slug).toBe("user/valid");
    });

    it("only includes messages newer than sinceMs in the prompt", async () => {
      dir = mkdtempSync(path.join(tmpdir(), "licode-llm-mem-"));
      const store = new MemoryStore(path.join(dir, ".licode", "memory"));

      const extractor = new MemoryExtractor();
      const mockChat = vi.fn().mockResolvedValue({
        content: "[]",
        usage: { input: 50, output: 5 },
      });
      (extractor as any).llm.chat = mockChat;

      const messages: Message[] = [
        { role: "user", content: "旧消息：我喜欢红烧排骨", timestamp: "2026-07-27T10:00:00.000Z" },
        { role: "assistant", content: "好的，记住了", timestamp: "2026-07-27T10:00:05.000Z" },
        { role: "user", content: "新消息：我以后都用 pnpm", timestamp: "2026-07-27T12:00:00.000Z" },
      ];

      await extractor.extract(messages, store, {
        sinceMs: Date.parse("2026-07-27T11:00:00.000Z"),
      });

      const prompt = mockChat.mock.calls[0][0].messages[0].content as string;
      expect(prompt).toContain("新消息：我以后都用 pnpm");
      expect(prompt).not.toContain("旧消息：我喜欢红烧排骨");
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

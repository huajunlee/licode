import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { MemoryExtractor } from "./extractor.js";
import { MemoryStore } from "./store.js";
import { RegexMemoryExtractor } from "./extractor-regex.js";

// 与 dream.test.ts 同款 mock，使 new MemoryExtractor() 不走真实 API：
vi.mock("../llm/anthropic.js", () => ({
  AnthropicProvider: vi.fn().mockImplementation(() => ({
    name: "mock",
    maxContextTokens: 200000,
    chat: vi.fn(),
    stream: vi.fn(),
    countTokens: vi.fn(() => 0),
  })),
}));

describe("RegexMemoryExtractor (deprecated, regex-based)", () => {
  const extractor = new RegexMemoryExtractor();

  it("extracts explicit preference statements as Memory with type 'user'", () => {
    const entries = extractor.extract(
      "Remember that I prefer pnpm for this project."
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        type: "user",
        name: "Preference",
        description: expect.stringContaining("prefer pnpm"),
      })
    );
    expect(entries[0].slug).toMatch(/^user\//);
  });

  it("extracts name from 'my name is' pattern → slug user/identity", () => {
    const entries = extractor.extract("My name is John Smith.");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        slug: "user/identity",
        type: "user",
        name: "User Name",
        description: "The user's name is John Smith.",
      })
    );
  });

  it("extracts name from Chinese '我叫' pattern → slug user/identity", () => {
    const entries = extractor.extract("我叫小明。");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        slug: "user/identity",
        type: "user",
        name: "User Name",
        description: "The user's name is 小明.",
      })
    );
  });

  it("extracts 'call me' pattern → slug user/identity", () => {
    const entries = extractor.extract("Call me Xiao Ming please.");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        slug: "user/identity",
        type: "user",
        name: "Preferred Name",
        description: "The user prefers to be called Xiao Ming please.",
      })
    );
  });

  it("extracts identity from 'I am a' pattern → slug user/identity", () => {
    const entries = extractor.extract("I am a software developer.");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        slug: "user/identity",
        type: "user",
        name: "User Identity",
        description: "The user is a software developer.",
      })
    );
  });

  it("extracts Chinese '记住我喜欢' as user type Memory", () => {
    const entries = extractor.extract("记住我喜欢用pnpm管理项目。");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        type: "user",
        name: "Preference",
        description: "The user likes 用pnpm管理项目.",
      })
    );
    expect(entries[0].slug).toMatch(/^user\//);
  });

  it("extracts general 'remember that' as catch-all user Memory", () => {
    const entries = extractor.extract(
      "Remember that the database password is xyz123."
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        type: "user",
        name: "Memory",
        description: "the database password is xyz123",
      })
    );
    expect(entries[0].slug).toMatch(/^user\//);
  });

  it("extracts Chinese general '记住' as catch-all user Memory", () => {
    const entries = extractor.extract("记住数据库密码是xyz123");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        type: "user",
        name: "Memory",
        description: "数据库密码是xyz123",
      })
    );
  });

  it("prefers specific patterns over general catch-all", () => {
    const entries = extractor.extract("记住我的名字是李四");
    expect(entries).toHaveLength(1);
    expect(entries[0].slug).toBe("user/identity");
    expect(entries[0].name).toBe("User Name");
  });

  it("returns empty for non-memory text", () => {
    const entries = extractor.extract("What is the weather today?");
    expect(entries).toHaveLength(0);
  });

  it("returns empty for empty string", () => {
    const entries = extractor.extract("");
    expect(entries).toHaveLength(0);
  });

  it("has createdAt and updatedAt timestamps", () => {
    const entries = extractor.extract("My name is John Smith.");
    expect(entries[0].createdAt).toBeDefined();
    expect(entries[0].updatedAt).toBeDefined();
  });

  // ── question / invalid-input rejection ──────────────────────────

  it("rejects '我叫什么名字？' as a question, not a name statement", () => {
    const entries = extractor.extract("我叫什么名字？");
    expect(entries).toHaveLength(0);
  });

  it("rejects '我的名字是什么' as a question", () => {
    const entries = extractor.extract("我的名字是什么");
    expect(entries).toHaveLength(0);
  });

  it("rejects '我是谁' as a question", () => {
    const entries = extractor.extract("我是谁");
    expect(entries).toHaveLength(0);
  });

  it("rejects '你是谁' as a question", () => {
    const entries = extractor.extract("你是谁？");
    expect(entries).toHaveLength(0);
  });

  it("rejects '我怎么称呼你' as a question", () => {
    const entries = extractor.extract("我怎么称呼你？");
    expect(entries).toHaveLength(0);
  });

  it("rejects 'what is my name' as a question", () => {
    const entries = extractor.extract("what is my name?");
    expect(entries).toHaveLength(0);
  });

  it("rejects 'who am I' as a question", () => {
    const entries = extractor.extract("who am I");
    expect(entries).toHaveLength(0);
  });

  it("still extracts real names like '我叫小明'", () => {
    const entries = extractor.extract("我叫小明");
    expect(entries).toHaveLength(1);
    expect(entries[0].slug).toBe("user/identity");
  });

  it("still extracts real preferences like '记住我喜欢吃辣'", () => {
    const entries = extractor.extract("记住我喜欢吃辣");
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("user");
  });
});

describe("MemoryExtractor prompt date injection", () => {
  it("buildPrompt includes today's date and the field-explicit absolute-date rule", async () => {
    vi.useFakeTimers({ now: new Date(2026, 7, 1) });
    const dir = mkdtempSync(path.join(tmpdir(), "licode-extr-"));
    try {
      const store = new MemoryStore(dir);
      const ex = new MemoryExtractor();
      let captured = "";
      (ex as unknown as { llm: { chat: (req: { messages: Array<{ content: string }> }) => Promise<unknown> } })
        .llm.chat = vi.fn(async (req) => {
          captured = req.messages[0].content;
          return { content: "[]", usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn" };
        });
      await ex.extract([
        { role: "user", content: "记住我喜欢深色主题", timestamp: new Date().toISOString() },
      ] as any, store);
      expect(captured).toContain("2026-08-01");
      expect(captured).toMatch(/相对日期/);
      expect(captured).toContain("description");
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

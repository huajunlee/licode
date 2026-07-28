import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  MEMORY_RECALL_TOOL_NAME,
  buildRecallPair,
  pruneRecallMessages,
  MemoryRecall,
} from "./recall.js";
import { MemoryStore } from "./store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Message, ToolUseBlock, ToolResultBlock } from "../llm/provider.js";
import type { Memory } from "./types.js";

vi.mock("../llm/anthropic.js", () => ({
  AnthropicProvider: vi.fn().mockImplementation(() => ({
    name: "mock-anthropic",
    maxContextTokens: 200000,
    chat: vi.fn(),
    stream: vi.fn(),
    countTokens: vi.fn(() => 100),
  })),
}));

function makeMemory(slug: string, name = slug, content = `${slug} 正文`): Memory {
  return {
    slug,
    type: slug.split("/")[0] as Memory["type"],
    name,
    description: `${name} 描述`,
    content,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

function userText(text: string): Message {
  return { role: "user", content: text, timestamp: "2026-07-28T01:00:00.000Z" };
}

describe("buildRecallPair", () => {
  it("returns assistant tool_use + user tool_result with linked ids", () => {
    const [tu, tr] = buildRecallPair("今晚吃什么好？", [makeMemory("user/food", "食物偏好")]);
    expect(tu.role).toBe("assistant");
    expect(tr.role).toBe("user");
    const useBlock = (tu.content as ToolUseBlock[])[0];
    const resultBlock = (tr.content as ToolResultBlock[])[0];
    expect(useBlock.name).toBe(MEMORY_RECALL_TOOL_NAME);
    expect(resultBlock.tool_use_id).toBe(useBlock.id);
    expect(useBlock.input).toEqual({ query: "今晚吃什么好？" });
    expect(resultBlock.content).toContain("## 食物偏好 (user/food)");
    expect(resultBlock.content).toContain("user/food 正文");
    expect(resultBlock.content).toContain("# Recalled Memories");
  });

  it("truncates query preview to 200 chars", () => {
    const long = "x".repeat(250);
    const [tu] = buildRecallPair(long, [makeMemory("user/a")]);
    const block = (tu.content as ToolUseBlock[])[0];
    expect((block.input as { query: string }).query.length).toBe(201); // 200 + "…"
  });
});

describe("pruneRecallMessages", () => {
  it("removes a recall pair from the middle of history (restored session)", () => {
    const [tu, tr] = buildRecallPair("q", [makeMemory("user/a")]);
    const messages: Message[] = [userText("第一问"), tu, tr, userText("第二问")];
    const pruned = pruneRecallMessages(messages);
    expect(pruned).toHaveLength(2);
    expect(pruned.every((m) => typeof m.content === "string")).toBe(true);
  });

  it("preserves normal tool call pairs", () => {
    const normalUse: Message = {
      role: "assistant",
      content: [{ id: "t1", name: "Read", input: { path: "x" } }],
      timestamp: "2026-07-28T01:00:00.000Z",
    };
    const normalResult: Message = {
      role: "user",
      content: [{ tool_use_id: "t1", content: "file content" }],
      timestamp: "2026-07-28T01:00:01.000Z",
    };
    const [tu, tr] = buildRecallPair("q", [makeMemory("user/a")]);
    const pruned = pruneRecallMessages([normalUse, normalResult, tu, tr]);
    expect(pruned).toEqual([normalUse, normalResult]);
  });

  it("returns the same array reference when there is nothing to prune", () => {
    const messages: Message[] = [userText("hello")];
    expect(pruneRecallMessages(messages)).toBe(messages);
  });
});

describe("MemoryRecall.select", () => {
  let dir: string | null = null;
  let store: MemoryStore;

  beforeEach(async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-123");
    dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
    store = new MemoryStore(dir);
    await store.save(makeMemory("user/food", "食物偏好"));
    await store.save(makeMemory("user/editor", "编辑器"));
  });

  afterEach(() => {
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; }
    vi.unstubAllEnvs();
  });

  function mockChatReturning(content: string) {
    const recall = new MemoryRecall();
    const mockChat = vi.fn().mockResolvedValue({
      content,
      usage: { input: 1, output: 1 },
      model: "mock",
      stopReason: "end_turn",
    });
    (recall as any).llm.chat = mockChat;
    return { recall, mockChat };
  }

  it("returns selected memories and puts index + query in the prompt", async () => {
    const { recall, mockChat } = mockChatReturning('["user/food"]');
    const result = await recall.select("今晚吃什么好？", store);
    expect(result.map((m) => m.slug)).toEqual(["user/food"]);
    const prompt = mockChat.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain("食物偏好");
    expect(prompt).toContain("今晚吃什么好？");
  });

  it("filters hallucinated slugs and tolerates code fences", async () => {
    const { recall } = mockChatReturning('```json\n["user/food", "user/ghost"]\n```');
    const result = await recall.select("q", store);
    expect(result.map((m) => m.slug)).toEqual(["user/food"]);
  });

  it("caps results at maxResults", async () => {
    const { recall } = mockChatReturning('["user/food","user/editor"]');
    const limited = new MemoryRecall({ maxResults: 1 });
    (limited as any).llm.chat = (recall as any).llm.chat;
    const result = await limited.select("q", store);
    expect(result).toHaveLength(1);
  });

  it("returns [] on LLM error", async () => {
    const recall = new MemoryRecall();
    (recall as any).llm.chat = vi.fn().mockRejectedValue(new Error("boom"));
    expect(await recall.select("q", store)).toEqual([]);
  });

  it("returns [] on timeout", async () => {
    const recall = new MemoryRecall({ timeoutMs: 50 });
    (recall as any).llm.chat = vi.fn().mockReturnValue(new Promise(() => {}));
    expect(await recall.select("q", store)).toEqual([]);
  });

  it("returns [] for non-array JSON", async () => {
    const { recall } = mockChatReturning('{"slug":"user/food"}');
    expect(await recall.select("q", store)).toEqual([]);
  });

  it("skips the LLM call entirely when the index is empty", async () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "recall-empty-"));
    try {
      const emptyStore = new MemoryStore(emptyDir);
      const recall = new MemoryRecall();
      const mockChat = vi.fn();
      (recall as any).llm.chat = mockChat;
      expect(await recall.select("q", emptyStore)).toEqual([]);
      expect(mockChat).not.toHaveBeenCalled();
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

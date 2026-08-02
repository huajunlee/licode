import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  MEMORY_RECALL_TOOL_NAME,
  buildRecallPair,
  pruneRecallMessages,
  MemoryRecall,
  createMemoryRecallHandler,
} from "./recall.js";
import { MemoryStore } from "./store.js";
import { createMemoryDreamState } from "./dream.js";
import { ConversationManager } from "../conversation/manager.js";
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

  it("prompt encodes explicit relevance criteria and exclusion cases", async () => {
    const { recall, mockChat } = mockChatReturning("[]");
    await recall.select("q", store);
    const prompt = mockChat.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain("满足以下任意一条");    // positive criteria header
    expect(prompt).toContain("不算相关");             // exclusion header
    expect(prompt).toContain("仅关键词或主题相似");   // a concrete exclusion
    expect(prompt).toContain("默认");                 // default-empty bias
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

  // Contract: select() never rejects - every failure mode degrades to [].
  // loadIndex()/listAll() read the filesystem and can throw on a race or
  // EACCES; they must be covered by the never-rejects guard, not just the
  // LLM/timeout path. (Phase 4 usage-counting will hang off this return.)
  it("never rejects when store.loadIndex() throws (file race / EACCES)", async () => {
    const failingStore = {
      loadIndex: vi.fn().mockRejectedValue(new Error("EACCES")),
      listAll: vi.fn().mockResolvedValue([]),
    } as unknown as MemoryStore;
    const recall = new MemoryRecall();
    await expect(recall.select("q", failingStore)).resolves.toEqual([]);
  });

  it("never rejects when store.listAll() throws (file race / EACCES)", async () => {
    const failingStore = {
      loadIndex: vi.fn().mockResolvedValue("# index"),
      listAll: vi.fn().mockRejectedValue(new Error("EACCES")),
    } as unknown as MemoryStore;
    const recall = new MemoryRecall();
    await expect(recall.select("q", failingStore)).resolves.toEqual([]);
  });
});

describe("createMemoryRecallHandler", () => {
  let dir: string | null = null;
  let store: MemoryStore;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "recall-handler-"));
    store = new MemoryStore(dir);
    await store.save(makeMemory("user/food", "食物偏好"));
  });

  afterEach(() => {
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; }
  });

  function makeManager(): ConversationManager {
    return new ConversationManager({ model: "test-model" });
  }

  function fakeRecall(slugs: string[]) {
    return {
      select: vi.fn(async (_q: string, s: MemoryStore) => {
        const all = await s.listAll();
        return all.filter((m) => slugs.includes(m.slug));
      }),
    } as unknown as MemoryRecall;
  }

  it("appends the pair after the current user message", async () => {
    const mgr = makeManager();
    mgr.addUserMessage("今晚吃什么好？");
    const handler = createMemoryRecallHandler({ recall: fakeRecall(["user/food"]), store });
    await handler(mgr);
    const msgs = mgr.getMessages();
    expect(msgs).toHaveLength(3);
    expect(msgs[1].role).toBe("assistant");
    expect(Array.isArray(msgs[1].content)).toBe(true);
    expect(msgs[2].role).toBe("user");
    expect(Array.isArray(msgs[2].content)).toBe(true);
  });

  it("prunes the previous pair and injects the new one (at most one pair)", async () => {
    const mgr = makeManager();
    const handler = createMemoryRecallHandler({ recall: fakeRecall(["user/food"]), store });
    mgr.addUserMessage("第一问");
    await handler(mgr);                       // [U1, A1, R1]
    mgr.addUserMessage("第二问");             // [U1, A1, R1, U2]
    await handler(mgr);                       // prune -> [U1, U2] -> inject -> [U1, U2, A2, R2]
    const msgs = mgr.getMessages();
    expect(msgs).toHaveLength(4);
    expect(msgs[0].content).toBe("第一问");
    expect(msgs[1].content).toBe("第二问");
    // exactly one recall pair remains: one assistant array + one user array
    const arrayMsgs = msgs.filter((m) => Array.isArray(m.content));
    expect(arrayMsgs).toHaveLength(2);
    expect(arrayMsgs[0].role).toBe("assistant");
    expect(arrayMsgs[1].role).toBe("user");
  });

  it("only prunes when selection is empty", async () => {
    const mgr = makeManager();
    const seeded = buildRecallPair("old", [makeMemory("user/food")]);
    mgr.replaceMessages([...seeded]);
    mgr.addUserMessage("无关问题");
    const handler = createMemoryRecallHandler({ recall: fakeRecall([]), store });
    await handler(mgr);
    const msgs = mgr.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("无关问题");
  });

  it("refreshes the memory index layer only when content changed", async () => {
    const mgr = makeManager();
    const addLayerSpy = vi.spyOn(mgr.systemPrompt, "addLayer");
    const handler = createMemoryRecallHandler({ recall: fakeRecall([]), store });
    mgr.addUserMessage("q1");
    await handler(mgr);
    expect(addLayerSpy).toHaveBeenCalledTimes(1);
    expect(addLayerSpy.mock.calls[0][0]).toMatchObject({ name: "memory", priority: 5 });
    mgr.addUserMessage("q2");
    await handler(mgr);
    expect(addLayerSpy).toHaveBeenCalledTimes(1); // unchanged -> not called again
  });

  it("never throws even when select rejects", async () => {
    const mgr = makeManager();
    mgr.addUserMessage("q");
    const broken = { select: vi.fn().mockRejectedValue(new Error("boom")) } as unknown as MemoryRecall;
    const handler = createMemoryRecallHandler({ recall: broken, store });
    await expect(handler(mgr)).resolves.toBeUndefined();
  });

  it("records usage for each recalled memory (not dreaming)", async () => {
    const mgr = makeManager();
    mgr.addUserMessage("今晚吃什么好？");
    const spy = vi.spyOn(store, "recordUsage");
    const handler = createMemoryRecallHandler({ recall: fakeRecall(["user/food"]), store });
    await handler(mgr);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("user/food");
    expect((await store.load("user/food"))?.usageCount).toBe(1);
  });

  it("yields recordUsage while dreaming (but still injects)", async () => {
    const mgr = makeManager();
    mgr.addUserMessage("今晚吃什么好？");
    const spy = vi.spyOn(store, "recordUsage");
    const dreamState = createMemoryDreamState();
    dreamState.running = true;
    const handler = createMemoryRecallHandler({ recall: fakeRecall(["user/food"]), store, dreamState });
    await handler(mgr);
    expect(spy).not.toHaveBeenCalled(); // 让位：不计数
    // 但合成对仍注入（recall 读路径不让位）
    expect(mgr.getMessages().some((m) => Array.isArray(m.content))).toBe(true);
    expect((await store.load("user/food"))?.usageCount).toBe(0); // 未计数
  });

  it("does not record usage when select returns empty", async () => {
    const mgr = makeManager();
    mgr.addUserMessage("无关问题");
    const spy = vi.spyOn(store, "recordUsage");
    const handler = createMemoryRecallHandler({ recall: fakeRecall([]), store });
    await handler(mgr);
    expect(spy).not.toHaveBeenCalled();
  });

  it("recordUsage failure does not break recall", async () => {
    const mgr = makeManager();
    mgr.addUserMessage("今晚吃什么好？");
    vi.spyOn(store, "recordUsage").mockRejectedValue(new Error("io"));
    const handler = createMemoryRecallHandler({ recall: fakeRecall(["user/food"]), store });
    await expect(handler(mgr)).resolves.toBeUndefined();
    expect(mgr.getMessages().some((m) => Array.isArray(m.content))).toBe(true); // 仍注入
  });
});

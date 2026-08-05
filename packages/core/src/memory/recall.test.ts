import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  MEMORY_RECALL_TOOL_NAME,
  buildRecallPair,
  pruneRecallMessages,
  pruneIrrelevantRecallMessages,
  MemoryRecall,
  createMemoryRecallHandler,
} from "./recall.js";
import { MemoryStore } from "./store.js";
import { createMemoryDreamState } from "./dream.js";
import { createLoadedMemoryRegistry } from "./loaded-memory-registry.js";
import { ConversationManager } from "../conversation/manager.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Message, ToolUseBlock, ToolResultBlock } from "../llm/provider.js";
import type { Memory } from "./types.js";
import type { LoadedMemoryEntry } from "./loaded-memory-registry.js";

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

describe("pruneIrrelevantRecallMessages", () => {
  it("prunes only sidequery pairs whose slug is in pruneSlugs", () => {
    const [tu1, tr1] = buildRecallPair("q", [makeMemory("user/a")]);
    const [tu2, tr2] = buildRecallPair("q", [makeMemory("user/b")]);
    const messages: Message[] = [userText("问"), tu1, tr1, tu2, tr2, userText("再问")];
    const pruned = pruneIrrelevantRecallMessages(messages, new Set(["user/a"]));
    // user/a pair pruned, user/b pair kept
    const slugsKept = pruned
      .filter((m) => m.role === "user" && Array.isArray(m.content))
      .flatMap((m) => (m.content as ToolResultBlock[]).map((b) => b.content as string));
    expect(slugsKept.some((c) => c.includes("user/a"))).toBe(false);
    expect(slugsKept.some((c) => c.includes("user/b"))).toBe(true);
  });

  it("returns same array reference when pruneSlugs is empty", () => {
    const messages: Message[] = [userText("hello")];
    expect(pruneIrrelevantRecallMessages(messages, new Set())).toBe(messages);
  });

  it("preserves normal (non-memory_recall) tool pairs", () => {
    const normalUse: Message = { role: "assistant", content: [{ id: "t1", name: "Read", input: {} }], timestamp: "" };
    const normalResult: Message = { role: "user", content: [{ tool_use_id: "t1", content: "file" }], timestamp: "" };
    const pruned = pruneIrrelevantRecallMessages([normalUse, normalResult], new Set(["user/a"]));
    expect(pruned).toEqual([normalUse, normalResult]);
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

  it("returns selected memories in add and puts index + query in prompt", async () => {
    const { recall, mockChat } = mockChatReturning(JSON.stringify({ add: ["user/food"], prune: [] }));
    const result = await recall.select("今晚吃什么好？", store);
    expect(result.add.map((m) => m.slug)).toEqual(["user/food"]);
    expect(result.prune).toEqual([]);
    const prompt = mockChat.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain("食物偏好");
    expect(prompt).toContain("今晚吃什么好？");
  });

  it("prompt encodes relevance criteria and {add,prune} output contract", async () => {
    const { recall, mockChat } = mockChatReturning(JSON.stringify({ add: [], prune: [] }));
    await recall.select("q", store);
    const prompt = mockChat.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain("满足以下任意一条");
    expect(prompt).toContain("不算相关");
    expect(prompt).toContain("默认");
    expect(prompt).toContain("add");
    expect(prompt).toContain("prune");
  });

  it("filters hallucinated slugs and tolerates code fences", async () => {
    const { recall } = mockChatReturning('```json\n{"add":["user/food","user/ghost"],"prune":[]}\n```');
    const result = await recall.select("q", store);
    expect(result.add.map((m) => m.slug)).toEqual(["user/food"]);
  });

  it("caps add at maxResults", async () => {
    const { recall } = mockChatReturning(JSON.stringify({ add: ["user/food", "user/editor"], prune: [] }));
    const limited = new MemoryRecall({ maxResults: 1 });
    (limited as any).llm.chat = (recall as any).llm.chat;
    const result = await limited.select("q", store);
    expect(result.add).toHaveLength(1);
  });

  it("returns {add:[],prune:[]} on LLM error", async () => {
    const recall = new MemoryRecall();
    (recall as any).llm.chat = vi.fn().mockRejectedValue(new Error("boom"));
    expect(await recall.select("q", store)).toEqual({ add: [], prune: [] });
  });

  it("returns {add:[],prune:[]} on timeout", async () => {
    const recall = new MemoryRecall({ timeoutMs: 50 });
    (recall as any).llm.chat = vi.fn().mockReturnValue(new Promise(() => {}));
    expect(await recall.select("q", store)).toEqual({ add: [], prune: [] });
  });

  it("returns {add:[],prune:[]} for non-object JSON", async () => {
    const { recall } = mockChatReturning('["user/food"]');
    expect(await recall.select("q", store)).toEqual({ add: [], prune: [] });
  });

  it("skips the LLM call when index is empty", async () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "recall-empty-"));
    try {
      const emptyStore = new MemoryStore(emptyDir);
      const recall = new MemoryRecall();
      const mockChat = vi.fn();
      (recall as any).llm.chat = mockChat;
      expect(await recall.select("q", emptyStore)).toEqual({ add: [], prune: [] });
      expect(mockChat).not.toHaveBeenCalled();
    } finally { rmSync(emptyDir, { recursive: true, force: true }); }
  });

  it("never rejects when store.listAll() throws", async () => {
    const failingStore = { listAll: vi.fn().mockRejectedValue(new Error("EACCES")) } as unknown as MemoryStore;
    const recall = new MemoryRecall();
    await expect(recall.select("q", failingStore)).resolves.toEqual({ add: [], prune: [] });
  });

  it("excludes already-loaded slugs from add (dedup)", async () => {
    const { recall } = mockChatReturning(JSON.stringify({ add: ["user/food", "user/editor"], prune: [] }));
    const loaded: LoadedMemoryEntry[] = [{ slug: "user/food", source: "active" }];
    const result = await recall.select("q", store, loaded);
    expect(result.add.map((m) => m.slug)).toEqual(["user/editor"]); // user/food 已加载,排除
  });

  it("prune only includes already-loaded sidequery slugs", async () => {
    const { recall } = mockChatReturning(JSON.stringify({ add: [], prune: ["user/food", "user/ghost"] }));
    const loaded: LoadedMemoryEntry[] = [{ slug: "user/food", source: "sidequery" }];
    const result = await recall.select("q", store, loaded);
    expect(result.prune).toEqual(["user/food"]); // user/ghost 不在已加载 sidequery,排除
  });
});

describe("MemoryRecall rich index", () => {
  let dir: string | null = null;
  let store: MemoryStore;

  beforeEach(async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-123");
    dir = mkdtempSync(path.join(tmpdir(), "recall-rich-"));
    store = new MemoryStore(dir);
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

  it("select() builds a rich index with description + keywords + first-line preview", async () => {
    await store.save({
      slug: "user/java", type: "user", name: "Java偏好",
      description: "用户偏好Java后端", content: "用户主要用 Java 做后端开发。\n第二行。",
      keywords: ["Java", "后端"], createdAt: "2026-08-04T00:00:00.000Z", updatedAt: "2026-08-04T00:00:00.000Z",
    });
    const { recall, mockChat } = mockChatReturning('["user/java"]');
    await recall.select("帮我写Java接口", store);
    const prompt = mockChat.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain("Java偏好");
    expect(prompt).toContain("[关键词: Java,后端]");
    expect(prompt).toContain("用户主要用 Java 做后端开发"); // 正文首行
  });

  it("rich index omits keywords segment when absent (old memory)", async () => {
    await store.save({
      slug: "user/old", type: "user", name: "旧记忆",
      description: "无关键词的旧记忆", content: "这是旧记忆正文首行。",
      createdAt: "2026-08-04T00:00:00.000Z", updatedAt: "2026-08-04T00:00:00.000Z",
    });
    const { recall, mockChat } = mockChatReturning('["user/old"]');
    await recall.select("q", store);
    const prompt = mockChat.mock.calls[0][0].messages[0].content as string;
    expect(prompt).not.toContain("[关键词:");
    expect(prompt).toContain("旧记忆");
    expect(prompt).toContain("这是旧记忆正文首行");
  });

  it("first-line preview is truncated to 60 chars with …", async () => {
    const longFirstLine = "一".repeat(80); // 80 chars > 60
    await store.save({
      slug: "user/long", type: "user", name: "长首行",
      description: "首行超长", content: `${longFirstLine}\n第二行。`,
      keywords: ["长"], createdAt: "2026-08-04T00:00:00.000Z", updatedAt: "2026-08-04T00:00:00.000Z",
    });
    const { recall, mockChat } = mockChatReturning('["user/long"]');
    await recall.select("q", store);
    const prompt = mockChat.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain("一".repeat(60) + "…");
    expect(prompt).not.toContain("一".repeat(61));
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

  function fakeRecall(addSlugs: string[], pruneSlugs: string[] = []) {
    return {
      select: vi.fn(async (_q: string, s: MemoryStore) => {
        const all = await s.listAll();
        return {
          add: all.filter((m) => addSlugs.includes(m.slug)),
          prune: pruneSlugs,
        };
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
    // seed an old sidequery pair with a different slug
    const seeded = buildRecallPair("old", [makeMemory("user/old")]);
    mgr.replaceMessages([...seeded]);
    mgr.addUserMessage("第二问");
    const handler = createMemoryRecallHandler({ recall: fakeRecall(["user/food"], ["user/old"]), store });
    await handler(mgr);                       // prune old -> [U2] -> inject -> [U2, A2, R2]
    const msgs = mgr.getMessages();
    expect(msgs).toHaveLength(3);
    expect(msgs[0].content).toBe("第二问");
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
    const handler = createMemoryRecallHandler({ recall: fakeRecall([], ["user/food"]), store });
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

  it("registry: add slugs are registered as sidequery after inject", async () => {
    const mgr = makeManager();
    const registry = createLoadedMemoryRegistry();
    mgr.addUserMessage("今晚吃什么好？");
    const handler = createMemoryRecallHandler({ recall: fakeRecall(["user/food"]), store, registry });
    await handler(mgr);
    expect(registry.get("user/food")).toBe("sidequery");
  });

  it("registry: prune slugs are removed from registry", async () => {
    const mgr = makeManager();
    const registry = createLoadedMemoryRegistry();
    // seed: a sidequery pair already in history + registry
    const seeded = buildRecallPair("old", [makeMemory("user/food")]);
    mgr.replaceMessages([...seeded]);
    registry.add("user/food", "sidequery");
    mgr.addUserMessage("无关问题");
    const handler = createMemoryRecallHandler({ recall: fakeRecall([], ["user/food"]), store, registry });
    await handler(mgr);
    expect(registry.has("user/food")).toBe(false); // pruned -> removed
  });

  it("registry: non-pruned sidequery slug is retained (cross-turn)", async () => {
    const mgr = makeManager();
    const registry = createLoadedMemoryRegistry();
    const seeded = buildRecallPair("old", [makeMemory("user/food")]);
    mgr.replaceMessages([...seeded]);
    registry.add("user/food", "sidequery");
    mgr.addUserMessage("继续食物话题");
    // select returns no add, no prune -> user/food retained
    const handler = createMemoryRecallHandler({ recall: fakeRecall([], []), store, registry });
    await handler(mgr);
    expect(registry.get("user/food")).toBe("sidequery"); // still there
    // and the pair is still in messages
    expect(mgr.getMessages().some((m) => Array.isArray(m.content))).toBe(true);
  });
});

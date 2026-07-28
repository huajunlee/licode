# 记忆系统 Phase 2（召回层：side query + 合成 tool_call 注入）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户消息进入 agent loop 时，小模型按 MEMORY.md 索引选出 ≤5 条相关记忆，以合成 tool_call 对注入当轮上下文（每轮换新），并提供开关与降级。

**Architecture:** core 新增 `AgentConfig.onTurnStart` 可选挂点（`addUserMessage` 后、首次 LLM 调用前触发，异常不阻断 loop）；召回逻辑全部内聚于新文件 `packages/core/src/memory/recall.ts`（`MemoryRecall` 选择引擎 + 召回对纯函数 + handler 工厂）；CLI 通过同一组 `apiKey/baseUrl/model` 接线，`LICODE_MEMORY_RECALL=off` 关闭。

**Tech Stack:** TypeScript（ESM，import 带 `.js` 后缀）、pnpm workspace、vitest、`AnthropicProvider`（mock 模式参照 `extractor-llm.test.ts`）。

**设计规格：** [2026-07-28-memory-phase2-design.md](./2026-07-28-memory-phase2-design.md)（本计划实现其全部内容）

## Global Constraints

- 不新增任何 npm 依赖
- 注入后消息序列必须角色严格交替：`[..., U(文本), A(tool_use), U(tool_result)]`
- 历史中任意时刻最多一对 `memory_recall` 消息（每轮先剪除再注入）
- side query 任何失败（LLM 错误/超时/解析失败/空索引）→ 不注入，退回仅索引；`onTurnStart` 抛异常不得阻断 agent loop
- 索引层（`"memory"`, priority 5）内容未变化时不重复 `addLayer`
- `MemoryRecall` 默认模型 `deepseek-chat`（与 `MemoryExtractor` 一致），`maxResults` 默认 5，`timeoutMs` 默认 10_000
- 测试 mock 模式：`vi.mock("../llm/anthropic.js", ...)` + `(instance as any).llm.chat = mockChat`，tmpdir 建 `MemoryStore`，`vi.stubEnv("ANTHROPIC_API_KEY", ...)`
- 提交信息沿用仓库风格（`feat(memory): ...`），每个 Task 结束提交一次
- dist 构建是 CLI 生效前提（最后一个 Task 必须 `pnpm -r build`）

---

### Task 1: recall.ts — 合成对与剪除纯函数

**Files:**
- Create: `packages/core/src/memory/recall.ts`
- Test: `packages/core/src/memory/recall.test.ts`

**Interfaces:**
- Consumes: `Message`/`ToolUseMessage`/`ToolResultMessage`/`ToolUseBlock`/`ToolResultBlock`（`../llm/provider.js`）、`Memory`（`./types.js`）
- Produces（后续 Task 依赖）:
  - `MEMORY_RECALL_TOOL_NAME: "memory_recall"`（常量）
  - `pruneRecallMessages(messages: Message[]): Message[]` — 无召回对时返回原数组引用
  - `buildRecallPair(query: string, memories: Memory[]): [ToolUseMessage, ToolResultMessage]` — tool_use.id === tool_result.tool_use_id；input 为 `{ query: <截断 200 字符> }`；正文含每条记忆的 `## name (slug)` + content

- [ ] **Step 1: 写失败测试**

新建 `packages/core/src/memory/recall.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  MEMORY_RECALL_TOOL_NAME,
  buildRecallPair,
  pruneRecallMessages,
} from "./recall.js";
import type { Message, ToolUseBlock, ToolResultBlock } from "../llm/provider.js";
import type { Memory } from "./types.js";

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/core/src/memory/recall.test.ts`
Expected: FAIL（`./recall.js` 不存在）

- [ ] **Step 3: 实现纯函数**

新建 `packages/core/src/memory/recall.ts`：

```ts
import { AnthropicProvider } from "../llm/anthropic.js";
import type {
  Message,
  ToolResultBlock,
  ToolUseBlock,
  ToolUseMessage,
  ToolResultMessage,
} from "../llm/provider.js";
import type { ConversationManager } from "../conversation/manager.js";
import type { MemoryStore } from "./store.js";
import type { Memory } from "./types.js";

/** tool_use name identifying a synthetic recall pair (also the prune key). */
export const MEMORY_RECALL_TOOL_NAME = "memory_recall";

const QUERY_PREVIEW_LEN = 200;

/**
 * Remove every synthetic recall pair from `messages` (assistant tool_use
 * named memory_recall + the user tool_result referencing its id). Handles
 * pairs sitting mid-history (restored sessions). Returns the SAME array
 * reference when there is nothing to prune. Normal tool pairs are preserved;
 * mixed messages (never produced here) are kept untouched.
 */
export function pruneRecallMessages(messages: Message[]): Message[] {
  const recallIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content as ToolUseBlock[]) {
        if (b && b.name === MEMORY_RECALL_TOOL_NAME) recallIds.add(b.id);
      }
    }
  }
  if (recallIds.size === 0) return messages;

  return messages.filter((m) => {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const blocks = m.content as ToolUseBlock[];
      const hasRecall = blocks.some((b) => recallIds.has(b.id));
      // drop only pure recall messages; keep (never-produced) mixed ones
      return !(hasRecall && blocks.every((b) => recallIds.has(b.id)));
    }
    if (m.role === "user" && Array.isArray(m.content)) {
      const blocks = m.content as ToolResultBlock[];
      const hasRecall = blocks.some((b) => recallIds.has(b.tool_use_id));
      return !(hasRecall && blocks.every((b) => recallIds.has(b.tool_use_id)));
    }
    return true;
  });
}

/**
 * Build the synthetic pair injected after the current user message:
 * assistant tool_use(memory_recall) + user tool_result(memory content).
 */
export function buildRecallPair(
  query: string,
  memories: Memory[]
): [ToolUseMessage, ToolResultMessage] {
  const id = `mrec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const preview =
    query.length > QUERY_PREVIEW_LEN ? query.slice(0, QUERY_PREVIEW_LEN) + "…" : query;

  const body = memories
    .map((m) => `## ${m.name} (${m.slug})\n${m.content}`)
    .join("\n\n");
  const content = [
    "# Recalled Memories",
    "",
    "以下记忆与当前查询相关（由记忆召回系统自动选择）：",
    "",
    body,
  ].join("\n");

  const now = new Date().toISOString();
  return [
    {
      role: "assistant",
      content: [{ id, name: MEMORY_RECALL_TOOL_NAME, input: { query: preview } }],
      timestamp: now,
    },
    {
      role: "user",
      content: [{ tool_use_id: id, content }],
      timestamp: now,
    },
  ];
}
```

（注：本 Task 先落地纯函数；`AnthropicProvider`/`ConversationManager`/`MemoryStore` 的 import 在 Task 2/3 才用到，先保留——TS 不会因未使用 import 报错，若本地 lint 严格可在 Task 2 补齐。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/core/src/memory/recall.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/memory/recall.ts packages/core/src/memory/recall.test.ts
git commit -m "feat(memory): add recall pair builders and prune helpers (phase 2)"
```

---

### Task 2: MemoryRecall.select — side query 引擎

**Files:**
- Modify: `packages/core/src/memory/recall.ts`
- Test: `packages/core/src/memory/recall.test.ts`

**Interfaces:**
- Consumes: Task 1 的模块文件；`MemoryStore.loadIndex()`/`listAll()`（`./store.js`）；`AnthropicProvider.chat({ messages, model, maxTokens, temperature })`（mock 模式见 Global Constraints）
- Produces: `MemoryRecall` 类 + `MemoryRecallConfig`；`select(userQuery: string, store: MemoryStore): Promise<Memory[]>`（永不 reject）

- [ ] **Step 1: 写失败测试**

在 `recall.test.ts` 顶部追加 import 与 mock（沿用 extractor-llm.test.ts 模式），并新增 describe：

```ts
// 文件顶部追加
import { vi, beforeEach, afterEach } from "vitest";
import { MemoryRecall } from "./recall.js";
import { MemoryStore } from "./store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

vi.mock("../llm/anthropic.js", () => ({
  AnthropicProvider: vi.fn().mockImplementation(() => ({
    name: "mock-anthropic",
    maxContextTokens: 200000,
    chat: vi.fn(),
    stream: vi.fn(),
    countTokens: vi.fn(() => 100),
  })),
}));

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/core/src/memory/recall.test.ts`
Expected: FAIL（`MemoryRecall` 未导出）

- [ ] **Step 3: 实现 MemoryRecall**

在 `recall.ts` 的 `buildRecallPair` 之后追加：

```ts
export interface MemoryRecallConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Max memories injected per turn. Default 5. */
  maxResults?: number;
  /** Side-query timeout; on expiry the turn degrades to index-only. Default 10s. */
  timeoutMs?: number;
}

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Side-query engine: given the current user message, a small model picks
 * the most relevant memories from the on-disk MEMORY.md index. Never throws —
 * every failure mode degrades to an empty selection (index-only recall).
 */
export class MemoryRecall {
  private llm: AnthropicProvider;
  private model: string;
  private maxResults: number;
  private timeoutMs: number;

  constructor(config?: MemoryRecallConfig) {
    const apiKey =
      config?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
    const baseUrl =
      config?.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? process.env.OPENAI_BASE_URL;
    this.model = config?.model ?? "deepseek-chat";
    this.maxResults = config?.maxResults ?? DEFAULT_MAX_RESULTS;
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.llm = new AnthropicProvider({ apiKey, baseUrl });
  }

  async select(userQuery: string, store: MemoryStore): Promise<Memory[]> {
    try {
      const indexContent = await store.loadIndex();
      if (!indexContent || indexContent.trim().length === 0) return [];

      const all = await store.listAll();
      const knownSlugs = new Set(all.map((m) => m.slug));

      const response = await this.withTimeout(
        this.llm.chat({
          messages: [
            { role: "user", content: this.buildPrompt(indexContent, userQuery), timestamp: new Date().toISOString() },
          ],
          model: this.model,
          maxTokens: 512,
          temperature: 0,
        })
      );
      const slugs = this.parseResponse(response.content, knownSlugs).slice(0, this.maxResults);
      const bySlug = new Map(all.map((m) => [m.slug, m]));
      return slugs.map((s) => bySlug.get(s)!);
    } catch {
      return []; // store read error, LLM error, or timeout -> degrade to []
    }
  }

  /** Provider has no abort signal — race a timer and drop the loser. */
  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error("memory recall timeout")), this.timeoutMs)
      ),
    ]);
  }

  private buildPrompt(indexContent: string, userQuery: string): string {
    return [
      "Given the user's current message and the memory index below,",
      "select the memories most relevant to the message.",
      "",
      "## Memory index",
      indexContent.trim(),
      "",
      "## User message",
      userQuery,
      "",
      "## Instructions",
      `- 输出 JSON 数组，最多 ${this.maxResults} 个 slug：["user/food-preferences", ...]`,
      "- 只选与当前消息直接相关的记忆；无相关则输出 []",
      "- slug 必须来自上面的索引，禁止编造",
      "- 只输出 JSON，不要解释",
    ].join("\n");
  }

  /** Keep only strings that name real index entries; dedupe, preserve order. */
  private parseResponse(raw: string, knownSlugs: Set<string>): string[] {
    try {
      let json = raw.trim();
      const fenceMatch = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (fenceMatch) json = fenceMatch[1].trim();
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed)) return [];
      const out: string[] = [];
      for (const item of parsed) {
        if (typeof item === "string" && knownSlugs.has(item) && !out.includes(item)) {
          out.push(item);
        }
      }
      return out;
    } catch {
      return [];
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/core/src/memory/recall.test.ts`
Expected: PASS（11 个用例）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/memory/recall.ts packages/core/src/memory/recall.test.ts
git commit -m "feat(memory): add MemoryRecall side-query engine with degrade-to-index (phase 2)"
```

---

### Task 3: createMemoryRecallHandler — onTurnStart 回调工厂

**Files:**
- Modify: `packages/core/src/memory/recall.ts`
- Test: `packages/core/src/memory/recall.test.ts`

**Interfaces:**
- Consumes: Task 1-2 全部产物；`ConversationManager.getMessages()/replaceMessages()/systemPrompt`（`../conversation/manager.js`，systemPrompt 为 public）
- Produces: `createMemoryRecallHandler(deps: { recall: MemoryRecall; store: MemoryStore }): (conversation: ConversationManager) => Promise<void>` — 供 Task 4 的 `AgentConfig.onTurnStart` 与 Task 6 的 CLI 接线使用

- [ ] **Step 1: 写失败测试**

在 `recall.test.ts` 追加（import 处补 `createMemoryRecallHandler`、`ConversationManager`）：

```ts
// import 处追加：import { createMemoryRecallHandler } from "./recall.js";
// import 处追加：import { ConversationManager } from "../conversation/manager.js";

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
    await handler(mgr);                       // prune → [U1, U2] → inject → [U1, U2, A2, R2]
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
    expect(addLayerSpy).toHaveBeenCalledTimes(1); // unchanged → not called again
  });

  it("never throws even when select rejects", async () => {
    const mgr = makeManager();
    mgr.addUserMessage("q");
    const broken = { select: vi.fn().mockRejectedValue(new Error("boom")) } as unknown as MemoryRecall;
    const handler = createMemoryRecallHandler({ recall: broken, store });
    await expect(handler(mgr)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/core/src/memory/recall.test.ts`
Expected: FAIL（`createMemoryRecallHandler` 未导出）

- [ ] **Step 3: 实现 handler 工厂**

在 `recall.ts` 末尾追加：

```ts
/**
 * Build the AgentConfig.onTurnStart callback for memory recall.
 * Per turn: refresh the index layer (content-changed only) → prune the
 * previous recall pair → select → append the new pair after the current
 * user message. Best-effort: never throws.
 */
export function createMemoryRecallHandler(deps: {
  recall: MemoryRecall;
  store: MemoryStore;
}): (conversation: ConversationManager) => Promise<void> {
  const { recall, store } = deps;
  let lastIndexContent: string | null = null;

  return async (conversation: ConversationManager) => {
    try {
      // 1. Refresh the index layer so memories written this session become
      //    visible in the system prompt from the next turn.
      try {
        const indexContent = (await store.loadIndex()).trim();
        if (indexContent && indexContent !== lastIndexContent) {
          conversation.systemPrompt.addLayer({
            name: "memory",
            priority: 5,
            always: false,
            content: indexContent,
          });
          lastIndexContent = indexContent;
        }
      } catch {
        // keep the previous layer content
      }

      // 2. Prune the previous recall pair (at most one pair in history).
      const before = conversation.getMessages();
      const pruned = pruneRecallMessages([...before]);
      if (pruned.length !== before.length) {
        conversation.replaceMessages(pruned);
      }

      // 3. Select against the current user message (the one addUserMessage
      //    just appended) and append the fresh pair after it.
      const messages = conversation.getMessages();
      const last = messages[messages.length - 1];
      const query =
        last && last.role === "user" && typeof last.content === "string"
          ? last.content
          : "";
      if (!query) return;

      const memories = await recall.select(query, store);
      if (memories.length === 0) return;

      const [toolUse, toolResult] = buildRecallPair(query, memories);
      conversation.replaceMessages([...conversation.getMessages(), toolUse, toolResult]);
    } catch {
      // recall is best-effort — never break the agent loop
    }
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/core/src/memory/recall.test.ts`
Expected: PASS（16 个用例）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/memory/recall.ts packages/core/src/memory/recall.test.ts
git commit -m "feat(memory): add onTurnStart recall handler with index refresh and pair rotation (phase 2)"
```

---

### Task 4: AgentLoop — onTurnStart 挂点

**Files:**
- Modify: `packages/core/src/agent/loop.ts:16-22`（AgentConfig）、`:32-39`（constructor）、`:41-43`（run 开头）
- Test: `packages/core/src/agent/loop.test.ts`（新建——agent 目录此前无测试）

**Interfaces:**
- Consumes: Task 3 的 handler 签名 `(conversation: ConversationManager) => Promise<void>`
- Produces: `AgentConfig.onTurnStart?: (conversation: ConversationManager) => Promise<void>`（Task 6 CLI 接线依赖）

- [ ] **Step 1: 写失败测试**

新建 `packages/core/src/agent/loop.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { AgentLoop } from "./loop.js";
import { ConversationManager } from "../conversation/manager.js";
import { ToolRegistry } from "../tools/registry.js";
import type { LLMProvider, StreamChunk } from "../llm/provider.js";

function mockLLM(events: string[]): LLMProvider {
  return {
    name: "mock-llm",
    maxContextTokens: 200000,
    chat: vi.fn(),
    stream: vi.fn(async function* (): AsyncIterable<StreamChunk> {
      events.push("stream");
      yield { type: "token", text: "好的", index: 0 };
      yield { type: "stop", stopReason: "end_turn", usage: { input: 1, output: 1 } };
    }),
    countTokens: vi.fn(() => 0),
  };
}

function makeManager(): ConversationManager {
  const mgr = new ConversationManager({ model: "test-model" });
  vi.spyOn(mgr, "save").mockResolvedValue(); // 不在测试中写 .licode/sessions
  return mgr;
}

describe("AgentLoop onTurnStart", () => {
  it("fires after addUserMessage and before the first LLM call", async () => {
    const events: string[] = [];
    const conversation = makeManager();
    const loop = new AgentLoop({
      llm: mockLLM(events),
      conversation,
      tools: new ToolRegistry(),
      onTurnStart: async (conv) => {
        events.push("onTurnStart");
        const msgs = conv.getMessages();
        expect(msgs[msgs.length - 1].content).toBe("你好");
      },
    });
    await loop.run("你好");
    expect(events).toEqual(["onTurnStart", "stream"]);
  });

  it("keeps the loop alive when onTurnStart throws", async () => {
    const events: string[] = [];
    const conversation = makeManager();
    const loop = new AgentLoop({
      llm: mockLLM(events),
      conversation,
      tools: new ToolRegistry(),
      onTurnStart: async () => { throw new Error("boom"); },
    });
    const result = await loop.run("你好");
    expect(result.type).toBe("stream-complete");
    expect(events).toEqual(["stream"]);
  });

  it("works without onTurnStart (regression)", async () => {
    const conversation = makeManager();
    const loop = new AgentLoop({
      llm: mockLLM([]),
      conversation,
      tools: new ToolRegistry(),
    });
    const result = await loop.run("你好");
    expect(result.type).toBe("stream-complete");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/core/src/agent/loop.test.ts`
Expected: FAIL（`onTurnStart` 不在 AgentConfig 中，TS 报错）

- [ ] **Step 3: 实现挂点**

`packages/core/src/agent/loop.ts` 三处修改：

```ts
// AgentConfig 追加字段（eventBus 之后）：
export interface AgentConfig {
  llm: LLMProvider;
  conversation: ConversationManager;
  tools: ToolRegistry;
  termination?: TerminationConfig;
  eventBus?: EventBus;
  /**
   * Optional per-turn hook: fires once in run() after the user message is
   * appended and before the first LLM call. Errors are swallowed — the
   * loop must never break because of it. (Phase 2 memory recall injects
   * here.)
   */
  onTurnStart?: (conversation: ConversationManager) => Promise<void>;
}

// class 字段与 constructor 追加：
  private onTurnStart?: (conversation: ConversationManager) => Promise<void>;
// constructor 内：
  this.onTurnStart = config.onTurnStart;

// run() 开头（addUserMessage 之后、eventBus emit 之前）：
    this.conversation.addUserMessage(userInput);
    if (this.onTurnStart) {
      try {
        await this.onTurnStart(this.conversation);
      } catch {
        // best-effort hook — never break the loop
      }
    }
    this.eventBus?.emit({ type: "agent-loop-start" });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/core/src/agent/loop.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/agent/loop.ts packages/core/src/agent/loop.test.ts
git commit -m "feat(agent): add onTurnStart hook point to AgentLoop (phase 2)"
```

---

### Task 5: extractor — 提取 prompt 过滤召回对

**Files:**
- Modify: `packages/core/src/memory/extractor.ts:146-160`（extract 内 selectMessages 之后）
- Test: `packages/core/src/memory/extractor-llm.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `pruneRecallMessages`、`buildRecallPair`（测试构造召回对）
- Produces: 无新符号（行为修复：提取 prompt 不再含 `memory_recall` 消息）

- [ ] **Step 1: 写失败测试**

在 `extractor-llm.test.ts` 的 extract describe 中追加（文件 import 处补 `buildRecallPair`）：

```ts
// import 处追加：import { buildRecallPair } from "./recall.js";

it("excludes synthetic memory_recall messages from the extraction prompt", async () => {
  const extractor = new MemoryExtractor();
  const mockChat = vi.fn().mockResolvedValue({
    content: "[]",
    usage: { input: 1, output: 1 },
    model: "mock",
    stopReason: "end_turn",
  });
  (extractor as any).llm.chat = mockChat;

  dir = mkdtempSync(path.join(tmpdir(), "extract-filter-"));
  const store = new MemoryStore(dir);

  const [tu, tr] = buildRecallPair("今晚吃什么", [
    {
      slug: "user/food", type: "user", name: "食物偏好",
      description: "d", content: "c",
      createdAt: "2026-07-28T00:00:00.000Z", updatedAt: "2026-07-28T00:00:00.000Z",
    },
  ]);
  const messages: Message[] = [
    { role: "user", content: "我喜欢吃辣的", timestamp: new Date().toISOString() },
    tu,
    tr,
  ];
  await extractor.extract(messages, store);

  const prompt = mockChat.mock.calls[0][0].messages[0].content as string;
  expect(prompt).toContain("我喜欢吃辣的");
  expect(prompt).not.toContain("memory_recall");
  expect(prompt).not.toContain("Recalled Memories");
});
```

（注：该测试依赖 extractor-llm.test.ts 顶部已有的 `vi.mock("../llm/anthropic.js")`、`mkdtempSync/rmSync/path/tmpdir` import 与 afterEach 的 dir 清理——直接复用，勿重复添加。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/core/src/memory/extractor-llm.test.ts`
Expected: FAIL（prompt 中含 `Recalled Memories`）

- [ ] **Step 3: 实现过滤**

`packages/core/src/memory/extractor.ts`：

```ts
// import 块追加：
import { pruneRecallMessages } from "./recall.js";

// extract() 中，selectMessages 之后一行：
      const recent = this.selectMessages(messages, options);
      const conversationText = this.formatMessages(pruneRecallMessages([...recent]));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/core/src/memory/extractor-llm.test.ts`
Expected: PASS（全部用例，含既有用例无回归）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/memory/extractor.ts packages/core/src/memory/extractor-llm.test.ts
git commit -m "fix(memory): exclude synthetic recall pairs from extraction prompt (phase 2)"
```

---

### Task 6: core 导出 + CLI 接线

**Files:**
- Modify: `packages/core/src/index.ts:120-121`（memory 导出块，hook 导出之后）
- Modify: `packages/cli/src/hooks.ts:6-33`（import 块）、`:219-221`（state ref 之后）、`:374-381` 与 `:427-434`（两处 `createAgentLoopMiddleware`）

**Interfaces:**
- Consumes: Task 2 的 `MemoryRecall`/`MemoryRecallConfig`、Task 3 的 `createMemoryRecallHandler`、Task 4 的 `AgentConfig.onTurnStart`
- Produces: CLI 行为——默认开启召回；`LICODE_MEMORY_RECALL=off` 完全退回 Phase 1

- [ ] **Step 1: core 导出**

`packages/core/src/index.ts` 在 `createMemoryExtractionHook` 导出块之后追加：

```ts
export { MemoryRecall, MEMORY_RECALL_TOOL_NAME, pruneRecallMessages, buildRecallPair, createMemoryRecallHandler } from "./memory/recall.js"; // Phase 2: side-query recall
export type { MemoryRecallConfig } from "./memory/recall.js";
```

- [ ] **Step 2: 验证 core 编译**

Run: `pnpm --filter @licode/core build`
Expected: 编译通过，无 TS 错误

- [ ] **Step 3: CLI 接线**

`packages/cli/src/hooks.ts` 三处修改：

```ts
// import 块（@licode/core 值导入处）追加两个符号：
  MemoryRecall,
  createMemoryRecallHandler,

// memoryExtractionStateRef 声明（L219-221）之后追加：
  // Phase 2: per-turn memory recall (side query → synthetic tool_call pair).
  // Same model tier as extraction; disabled via LICODE_MEMORY_RECALL=off.
  const memoryRecallHandlerRef = useRef(
    createMemoryRecallHandler({
      recall: new MemoryRecall({ apiKey, baseUrl, model }),
      store: memoryStoreRef.current,
    })
  );

// 两处 createAgentLoopMiddleware({ ... }) 的 config 对象统一改为：
        createAgentLoopMiddleware({
          llm: provider,
          conversation: manager,
          tools,
          eventBus,
          ...(process.env.LICODE_MEMORY_RECALL === "off"
            ? {}
            : { onTurnStart: memoryRecallHandlerRef.current }),
        })
```

- [ ] **Step 4: 构建 + 全量回归**

```bash
pnpm -r build
ls packages/core/dist/memory/recall.js   # 必须存在
npx vitest run packages/core/src/memory packages/core/src/agent
npm test
```

Expected: 构建通过；dist 含 recall.js；全部测试通过（既有 MCP 启动测试的 1 个失败为既有问题，见 Phase 1 commit 说明）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/index.ts packages/cli/src/hooks.ts
git commit -m "feat(cli): wire memory recall into agent loop via onTurnStart (phase 2)"
```

---

### Task 7: 手工验收（对应规格 §4）

**Files:** 无（仅验证）

- [ ] **Step 1: 准备记忆 + 启动**

```bash
npm start
# 会话中先说：记住：我喜欢吃辣的，不喜欢红烧排骨
# （触发后台提取落盘；可用 /memory list 确认）
```

- [ ] **Step 2: 逐条验收**

| # | 操作 | 预期 |
|---|---|---|
| 1 | 问"今晚吃什么好？" | TUI 出现 `[调用工具: memory_recall]` 卡片；回答体现"吃辣/不红烧排骨" |
| 2 | 问"帮我重构这个函数" | 无召回卡片；仅索引层 |
| 3 | 同会话说"记住：我的编辑器是 Neovim"，再问"我的编辑器是什么？" | 无需重启，新记忆被选中注入 |
| 4 | 以无效 apiKey 启动后提问 | 对话正常，仅索引层兜底，无阻塞报错 |
| 5 | `LICODE_MEMORY_RECALL=off npm start` 提问 | 完全无召回卡片（Phase 1 行为） |
| 6 | 退出并恢复该会话，再问一条相关问题 | 历史中始终只有最新一对 memory_recall |
| 7 | 全部新旧测试通过 | `npm test` 输出确认 |

- [ ] **Step 3: 收尾提交**

如验收中发现并修复了问题，修复单独提交；全部通过后 push 分支并开 draft PR：

```bash
git push -u origin worktree-memory-system-redesign
gh pr create --draft --title "feat(memory): phase 1+2 — production layer fix + recall layer (side query)" --body "Specs: docs/superpowers/specs/2026-07-27-memory-system-redesign-design.md, 2026-07-28-memory-phase2-design.md"
```

---

## 风险与注意点

1. **dist 构建是 CLI 生效前提**：只改源码不 build，CLI 行为不变（沿用 Phase 1 计划风险 #1）
2. **连续 user 消息规避依赖注入位置**：`onTurnStart` 在 `addUserMessage` 之后触发是本设计的根基——改动 loop.ts 时不得把调用点移到 addUserMessage 之前
3. **`useRef(初始化表达式)` 每渲染都会求值**（hooks.ts 既有风格）：`new MemoryRecall(...)` 每渲染构造一次但仅首个被保留——与既有 `MemoryStore`/`MemoryExtractor` ref 一致，无副作用（构造仅赋值字段）
4. **handler 闭包内的 `lastIndexContent` 跨轮记忆**：handler 在 useRef 中创建一次，会话生命周期内有效；换会话（CLI 重启）自然重置
5. **召回对对 trimToBudget 是透明开销**：裁剪掉就下轮重注；孤儿 tool_result 风险为既有行为（规格 §2.4 已记录）
6. **测试隔离**：loop.test.ts 必须 mock `conversation.save()`，否则往包目录写 `.licode/sessions/`

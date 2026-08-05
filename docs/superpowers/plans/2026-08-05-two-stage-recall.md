# 两阶段召回 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 side-query 召回之上新增 `memory_fetch` 工具(主模型主动按 slug 取记忆正文),并引入 `LoadedMemoryRegistry` 统一层解决双向去重 + 选择性剪除。

**Architecture:** 新增会话级 `LoadedMemoryRegistry`(HashMap,O(1) 查询,session 恢复时 rebuild)跟踪已加载记忆 + 来源(sidequery/active)。`MemoryRecall.select` 改输出 `{add, prune}`(反转默认:已加载 side-query 默认保留,仅明确判无关才剪,漏输出=保留)。`pruneRecallMessages` 替换为选择性剪除。新增 `memory_fetch` 工厂工具,查 registry 去重、记账、按召回格式返回。

**Tech Stack:** TypeScript, vitest, zod, pnpm monorepo(core + cli 包)。

## Global Constraints

- **不改动**:`store.ts`、`loop.ts`、`buildRecallPair` 的输出格式(`## name (slug)\ncontent`)、`dream.ts`、提取 hook。
- **select 永不抛异常**:任何失败(LLM 错误/超时/解析失败/listAll 抛错)降级为 `{ add: [], prune: [] }`。
- **工具名 `memory_fetch`**:不得与合成注入的 `memory_recall`(`recall.ts:15`)重名。
- **开关**:`LICODE_MEMORY_RECALL=off` 时 `memory_fetch` 不注册(与 side-query 共用开关)。
- **测试**:`pnpm test`(vitest run);**build**:`pnpm build` 零错。
- **select 返回类型细化**:spec §3.2 写 `add: string[]`,实现细化为 `add: Memory[]`(select 内部已 `listAll` 持有 Memory,直接返回避免 handler 重复 `store.load`);`prune: string[]`(slug)不变。

---

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `packages/core/src/memory/loaded-memory-registry.ts` | `LoadedMemoryRegistry` 类 + `createLoadedMemoryRegistry` 工厂 | 新建 |
| `packages/core/src/memory/loaded-memory-registry.test.ts` | registry 单元测试 | 新建 |
| `packages/core/src/tools/builtin/memory-fetch.ts` | `createMemoryFetchTool` 工厂 + `memory_fetch` 工具 | 新建 |
| `packages/core/src/tools/builtin/memory-fetch.test.ts` | 工具单元测试 | 新建 |
| `packages/core/src/memory/recall.ts` | `select` 签名/prompt/parseResponse;`pruneRecallMessages`→`pruneIrrelevantRecallMessages`;`createMemoryRecallHandler` 接 registry | 改 |
| `packages/core/src/memory/recall.test.ts` | 适配新 select 返回类型 + 选择性 prune + registry 同步 | 改 |
| `packages/core/src/index.ts` | 导出 `LoadedMemoryRegistry`/`createLoadedMemoryRegistry`/`createMemoryFetchTool` | 改 |
| `packages/cli/src/hooks.ts` | registry ref + rebuild + 条件 register memory_fetch + 传 registry | 改 |
| `packages/core/src/conversation/templates/memory-guide.md` | 第 62 行 fallback 措辞 | 改 |

---

## Task 1: LoadedMemoryRegistry(统一层)

**Files:**
- Create: `packages/core/src/memory/loaded-memory-registry.ts`
- Test: `packages/core/src/memory/loaded-memory-registry.test.ts`

**Interfaces:**
- Produces: `LoadedMemoryRegistry` 类(`has`/`get`/`add`/`remove`/`getAll`/`rebuild`),`LoadedMemoryEntry = { slug: string; source: "sidequery" | "active" }`,`createLoadedMemoryRegistry()`。Task 3/4 消费。

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/memory/loaded-memory-registry.test.ts
import { describe, expect, it } from "vitest";
import { LoadedMemoryRegistry } from "./loaded-memory-registry.js";
import { buildRecallPair } from "./recall.js";
import type { Message } from "../llm/provider.js";
import type { Memory } from "./types.js";

function mem(slug: string): Memory {
  return {
    slug, type: slug.split("/")[0] as Memory["type"],
    name: slug, description: "d", content: `${slug} 正文`,
    createdAt: "", updatedAt: "",
  };
}
function fetchPair(slugs: string[]): [Message, Message] {
  const id = "mf_1";
  const content = slugs.map((s) => `## ${s} (${s})\n${s} 正文`).join("\n\n");
  return [
    { role: "assistant", content: [{ id, name: "memory_fetch", input: {} }], timestamp: "" },
    { role: "user", content: [{ tool_use_id: id, content }], timestamp: "" },
  ];
}

describe("LoadedMemoryRegistry", () => {
  it("add/has/get/remove round-trip", () => {
    const r = new LoadedMemoryRegistry();
    expect(r.has("user/a")).toBe(false);
    r.add("user/a", "active");
    expect(r.has("user/a")).toBe(true);
    expect(r.get("user/a")).toBe("active");
    r.remove("user/a");
    expect(r.has("user/a")).toBe(false);
  });

  it("add overwrites source", () => {
    const r = new LoadedMemoryRegistry();
    r.add("user/a", "sidequery");
    r.add("user/a", "active");
    expect(r.get("user/a")).toBe("active");
  });

  it("getAll returns entries", () => {
    const r = new LoadedMemoryRegistry();
    r.add("user/a", "active");
    r.add("user/b", "sidequery");
    expect(r.getAll()).toEqual([
      { slug: "user/a", source: "active" },
      { slug: "user/b", source: "sidequery" },
    ]);
  });

  it("rebuild extracts sidequery slugs from memory_recall pairs", () => {
    const r = new LoadedMemoryRegistry();
    const [tu, tr] = buildRecallPair("q", [mem("user/food")]);
    r.rebuild([tu, tr]);
    expect(r.get("user/food")).toBe("sidequery");
  });

  it("rebuild extracts active slugs from memory_fetch pairs", () => {
    const r = new LoadedMemoryRegistry();
    const [u, res] = fetchPair(["user/a", "user/b"]);
    r.rebuild([u, res]);
    expect(r.get("user/a")).toBe("active");
    expect(r.get("user/b")).toBe("active");
  });

  it("rebuild clears previous state", () => {
    const r = new LoadedMemoryRegistry();
    r.add("user/old", "active");
    r.rebuild([]);
    expect(r.getAll()).toEqual([]);
  });

  it("rebuild ignores unrelated tool pairs (Read)", () => {
    const r = new LoadedMemoryRegistry();
    const use: Message = { role: "assistant", content: [{ id: "r1", name: "Read", input: {} }], timestamp: "" };
    const res: Message = { role: "user", content: [{ tool_use_id: "r1", content: "## x (user/y)\n..." }], timestamp: "" };
    r.rebuild([use, res]);
    expect(r.getAll()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/memory/loaded-memory-registry.test.ts`
Expected: FAIL — `Cannot find module './loaded-memory-registry.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/memory/loaded-memory-registry.ts
import type { Message, ToolUseBlock, ToolResultBlock } from "../llm/provider.js";

export type LoadedMemorySource = "sidequery" | "active";

export interface LoadedMemoryEntry {
  slug: string;
  source: LoadedMemorySource;
}

/** Matches `## name (slug)` lines produced by buildRecallPair / memory_fetch. */
const SLUG_RE = /^## .* \(([^)]+)\)$/;

/**
 * Session-level registry of memories already loaded into the conversation,
 * tagged by source. O(1) lookup; rebuilt from messages on session restore.
 */
export class LoadedMemoryRegistry {
  private map = new Map<string, LoadedMemorySource>();

  has(slug: string): boolean {
    return this.map.has(slug);
  }

  get(slug: string): LoadedMemorySource | undefined {
    return this.map.get(slug);
  }

  add(slug: string, source: LoadedMemorySource): void {
    this.map.set(slug, source);
  }

  remove(slug: string): void {
    this.map.delete(slug);
  }

  getAll(): LoadedMemoryEntry[] {
    return Array.from(this.map, ([slug, source]) => ({ slug, source }));
  }

  /** Rebuild from a message list (session restore). Pairs tool_use id -> name,
   *  then extracts `## name (slug)` from memory_recall/memory_fetch tool_results. */
  rebuild(messages: Message[]): void {
    this.map.clear();
    const useNameById = new Map<string, string>();
    for (const m of messages) {
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const b of m.content as ToolUseBlock[]) {
          if (b?.id && b?.name) useNameById.set(b.id, b.name);
        }
      }
    }
    for (const m of messages) {
      if (m.role !== "user" || !Array.isArray(m.content)) continue;
      for (const b of m.content as ToolResultBlock[]) {
        const name = b.tool_use_id ? useNameById.get(b.tool_use_id) : undefined;
        if (name !== "memory_recall" && name !== "memory_fetch") continue;
        const source: LoadedMemorySource = name === "memory_fetch" ? "active" : "sidequery";
        const content = typeof b.content === "string" ? b.content : "";
        for (const line of content.split("\n")) {
          const match = line.match(SLUG_RE);
          if (match) this.map.set(match[1], source);
        }
      }
    }
  }
}

export function createLoadedMemoryRegistry(): LoadedMemoryRegistry {
  return new LoadedMemoryRegistry();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/core/src/memory/loaded-memory-registry.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/loaded-memory-registry.ts packages/core/src/memory/loaded-memory-registry.test.ts
git commit -m "feat(memory): add LoadedMemoryRegistry session-level loaded-memory map"
```

---

## Task 2: select 改输出 {add, prune}(反转默认)

**Files:**
- Modify: `packages/core/src/memory/recall.ts`(`select` `recall.ts:126`、`buildPrompt` `recall.ts:171`、`parseResponse` `recall.ts:203`)
- Modify: `packages/core/src/memory/recall.test.ts`(`MemoryRecall.select` describe block `recall.test.ts:98-202`)
- Modify: `packages/core/src/memory/recall.ts`(`createMemoryRecallHandler` 最小适配,用 `add` 注入)

**Interfaces:**
- Consumes: `LoadedMemoryEntry` from Task 1.
- Produces: `select(userQuery, store, loaded?) -> Promise<{ add: Memory[]; prune: string[] }>`。Task 3 的 handler 消费。

- [ ] **Step 1: Update select tests for the new return type**

替换 `recall.test.ts` 的 `describe("MemoryRecall.select", ...)` block(原 98-202 行)中各 `it` 的断言。新 select 返回 `{add, prune}`:

```ts
// 在 recall.test.ts 顶部 import 加 LoadedMemoryEntry
import type { LoadedMemoryEntry } from "./loaded-memory-registry.js";

// 替换 select describe 里的断言(保留 mockChatReturning/beforeEach/afterEach):
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
    const mockChat = vi.fn().mockResolvedValue({ content, usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn" });
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test packages/core/src/memory/recall.test.ts`
Expected: FAIL — select 返回 Memory[] 而非 {add,prune}

- [ ] **Step 3: Implement new select / buildPrompt / parseResponse**

修改 `recall.ts`。先加 import 与类型:

```ts
// recall.ts 顶部 import 区加:
import type { LoadedMemoryEntry } from "./loaded-memory-registry.js";
```

替换 `select` 方法(`recall.ts:126-159`):

```ts
  async select(
    userQuery: string,
    store: MemoryStore,
    loaded: LoadedMemoryEntry[] = []
  ): Promise<{ add: Memory[]; prune: string[] }> {
    try {
      const all = await store.listAll();
      if (all.length === 0) return { add: [], prune: [] };
      const knownSlugs = new Set(all.map((m) => m.slug));
      const loadedSlugs = new Set(loaded.map((l) => l.slug));
      const loadedSidequery = new Set(
        loaded.filter((l) => l.source === "sidequery").map((l) => l.slug)
      );
      const richIndex = all.map((m) => {
        const parts = [`- [${m.name}](${m.slug}.md) - ${m.description}`];
        if (m.keywords && m.keywords.length) parts.push(`[关键词: ${m.keywords.join(",")}]`);
        const first = (m.content.split("\n")[0] || "").trim();
        const preview = first.length > 60 ? first.slice(0, 60) + "…" : first;
        parts.push(`「${preview}」`);
        return parts.join(" ");
      }).join("\n");
      const loadedSection = loaded.length
        ? loaded.map((l) => `- ${l.slug} [${l.source}]`).join("\n")
        : "(无已加载记忆)";
      const response = await this.withTimeout(
        this.llm.chat({
          messages: [
            { role: "user", content: this.buildPrompt(richIndex, userQuery, loadedSection), timestamp: new Date().toISOString() },
          ],
          model: this.model,
          maxTokens: 512,
          temperature: 0,
        })
      );
      const parsed = this.parseResponse(response.content, knownSlugs);
      const bySlug = new Map(all.map((m) => [m.slug, m] as const));
      const add = parsed.add
        .filter((s) => !loadedSlugs.has(s))
        .slice(0, this.maxResults)
        .map((s) => bySlug.get(s)!)
        .filter(Boolean);
      const prune = parsed.prune.filter((s) => loadedSidequery.has(s));
      return { add, prune };
    } catch {
      return { add: [], prune: [] };
    }
  }
```

替换 `buildPrompt`(`recall.ts:171-200`),保留旧相关性规则,加 loaded section + `{add,prune}` 输出契约:

```ts
  private buildPrompt(indexContent: string, userQuery: string, loadedSection: string): string {
    return [
      "You are a STRICT memory-recall filter. Given the user's current message, the memory index, and the",
      "already-loaded memories, decide what to ADD (new, relevant, not yet loaded) and what to PRUNE",
      "(already-loaded side-query memories now irrelevant). 默认不新增、不剪除;不确定相关的不放进 add,不确定无关的不放进 prune。",
      "",
      "## Memory index（每条:名称 - 描述 [关键词] 「正文首行预览」）",
      indexContent.trim(),
      "",
      "## Already-loaded memories（当前上下文已存在的记忆）",
      loadedSection,
      "",
      "## User message",
      userQuery,
      "",
      "## 满足以下任意一条，才放入 add（新增注入）",
      "1. 该记忆包含当前请求明确需要使用的用户信息：偏好、约束、已确定的方案/选择/决策。",
      "2. 用户主动要求回忆已存在的记忆，且缺少会导致回答明显偏差。",
      '3. 当前请求明确在继续该记忆对应的历史任务（"继续之前的设计""按上次方案改"）。',
      "且该记忆必须未被加载（不在 already-loaded 中）。",
      "",
      "## 满足以下全部，才放入 prune（剪除已加载的 side-query 记忆）",
      "- 该记忆已在 already-loaded 中且来源为 sidequery。",
      "- 它与当前用户消息明确无关：删除后当前回答仍然成立。",
      "主动召回（active）的记忆永不放入 prune。不确定无关的不要放入 prune（保留更安全）。",
      "",
      "## Output（严格 JSON 对象）",
      '- {"add": ["slug", ...], "prune": ["slug", ...]}',
      "- add 最多 5 个;无相关则 add:[]。prune 仅含明确无关的已加载 sidequery slug;无则 prune:[]。",
      "- slug 必须来自上面的索引，禁止编造；只输出 JSON，不要解释。",
      "",
      "## Examples",
      '用户消息"帮我查一下天气" -> {"add": [], "prune": []}',
      '用户消息"今晚吃什么好？"（索引含食物偏好，未加载）-> {"add": ["user/food-preferences"], "prune": []}',
      '用户消息"帮我重构函数"（已加载 user/food-preferences [sidequery]）-> {"add": [], "prune": ["user/food-preferences"]}',
    ].join("\n");
  }
```

替换 `parseResponse`(`recall.ts:203-220`),解析 `{add, prune}` 对象:

```ts
  private parseResponse(raw: string, knownSlugs: Set<string>): { add: string[]; prune: string[] } {
    try {
      let json = raw.trim();
      const fenceMatch = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (fenceMatch) json = fenceMatch[1].trim();
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { add: [], prune: [] };
      }
      const pick = (v: unknown): string[] => {
        if (!Array.isArray(v)) return [];
        const out: string[] = [];
        for (const item of v) {
          if (typeof item === "string" && knownSlugs.has(item) && !out.includes(item)) {
            out.push(item);
          }
        }
        return out;
      };
      return { add: pick((parsed as Record<string, unknown>).add), prune: pick((parsed as Record<string, unknown>).prune) };
    } catch {
      return { add: [], prune: [] };
    }
  }
```

- [ ] **Step 4: Minimal-adapt createMemoryRecallHandler to compile (use add, keep full-prune for now)**

`createMemoryRecallHandler`(`recall.ts:274` 附近)中 select 调用与注入部分。把:

```ts
      const memories = await recall.select(query, store);
      if (memories.length === 0) return;
```

改为:

```ts
      const { add: memories } = await recall.select(query, store);
      if (memories.length === 0) return;
```

其余 `recordUsage(memories)` / `buildRecallPair(query, memories)` 不变(变量名仍 `memories`)。

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test packages/core/src/memory/recall.test.ts`
Expected: PASS(含新 dedup/prune 测试;handler 测试因 `fakeRecall` 返回 Memory[] 需更新,见 Step 6)

- [ ] **Step 6: Update fakeRecall in handler tests**

`recall.test.ts` 的 `fakeRecall`(原 292-299 行)返回 Memory[],需改为返回 `{add, prune}`:

```ts
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
```

并更新 handler describe 里所有 `fakeRecall(["user/food"])` 调用(原 304/316/337/347/369/382/394/403 行)保持不变(第二参数 prune 默认 [])。这些测试此刻仍应通过(handler 仍全剪 prune,Task 3 改选择性)。

Run: `pnpm test packages/core/src/memory/recall.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/memory/recall.ts packages/core/src/memory/recall.test.ts
git commit -m "feat(memory): select outputs {add,prune} with reversed-default dedup"
```

---

## Task 3: 选择性 prune + handler 接 registry

**Files:**
- Modify: `packages/core/src/memory/recall.ts`(`pruneRecallMessages`→`pruneIrrelevantRecallMessages`、`createMemoryRecallHandler` 接 registry)
- Modify: `packages/core/src/memory/recall.test.ts`(prune 测试 + handler registry 测试)

**Interfaces:**
- Consumes: `LoadedMemoryRegistry` (Task 1), `{add, prune}` from select (Task 2).
- Produces: `pruneIrrelevantRecallMessages(messages, pruneSlugs) -> Message[]`;`createMemoryRecallHandler` 接 `registry?` 参数。

- [ ] **Step 1: Write failing tests for selective prune**

在 `recall.test.ts` 的 `describe("pruneRecallMessages", ...)` 后新增:

```ts
import { pruneIrrelevantRecallMessages } from "./recall.js";

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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test packages/core/src/memory/recall.test.ts -t pruneIrrelevant`
Expected: FAIL — `pruneIrrelevantRecallMessages is not defined`

- [ ] **Step 3: Implement pruneIrrelevantRecallMessages**

在 `recall.ts` 中 `pruneRecallMessages` 后新增(保留旧 `pruneRecallMessages`,handler Task 3 后改用新函数;旧函数暂留以防外部引用,实现完确认无引用后可删,见 Step 7):

```ts
/**
 * Selectively prune: remove only synthetic memory_recall pairs whose slug is in
 * `pruneSlugs`. Keep other memory_recall pairs (still relevant) and all
 * memory_fetch tool_results (active, never pruned). Returns the SAME array
 * reference when pruneSlugs is empty.
 */
export function pruneIrrelevantRecallMessages(
  messages: Message[],
  pruneSlugs: Set<string>
): Message[] {
  if (pruneSlugs.size === 0) return messages;

  const recallIdsToPrune = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content as ToolUseBlock[]) {
        if (b && b.name === MEMORY_RECALL_TOOL_NAME && b.id) {
          const inputQuery = (b.input as { query?: string } | undefined)?.query ?? "";
          // buildRecallPair stores query preview in input; slug is in the
          // paired tool_result, so we check the result content for a prune slug.
        }
      }
    }
  }

  // Pair tool_use id -> extracted slugs from its tool_result content.
  const slugsByUseId = new Map<string, string[]>();
  for (const m of messages) {
    if (m.role === "user" && Array.isArray(m.content)) {
      for (const b of m.content as ToolResultBlock[]) {
        if (!b.tool_use_id) continue;
        const content = typeof b.content === "string" ? b.content : "";
        const slugs: string[] = [];
        for (const line of content.split("\n")) {
          const match = line.match(/^## .* \(([^)]+)\)$/);
          if (match) slugs.push(match[1]);
        }
        if (slugs.length) slugsByUseId.set(b.tool_use_id, slugs);
      }
    }
  }
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content as ToolUseBlock[]) {
        if (b && b.name === MEMORY_RECALL_TOOL_NAME && b.id) {
          const slugs = slugsByUseId.get(b.id) ?? [];
          if (slugs.some((s) => pruneSlugs.has(s))) {
            recallIdsToPrune.add(b.id);
          }
        }
      }
    }
  }
  if (recallIdsToPrune.size === 0) return messages;

  return messages.filter((m) => {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const blocks = m.content as ToolUseBlock[];
      const hasPrune = blocks.some((b) => recallIdsToPrune.has(b.id));
      return !(hasPrune && blocks.every((b) => recallIdsToPrune.has(b.id)));
    }
    if (m.role === "user" && Array.isArray(m.content)) {
      const blocks = m.content as ToolResultBlock[];
      const hasPrune = blocks.some((b) => recallIdsToPrune.has(b.tool_use_id));
      return !(hasPrune && blocks.every((b) => recallIdsToPrune.has(b.tool_use_id)));
    }
    return true;
  });
}
```

- [ ] **Step 4: Run prune tests to verify pass**

Run: `pnpm test packages/core/src/memory/recall.test.ts -t pruneIrrelevant`
Expected: PASS (3 tests)

- [ ] **Step 5: Write failing handler tests for registry integration**

在 `recall.test.ts` 的 `describe("createMemoryRecallHandler", ...)` 内新增(需 import `createLoadedMemoryRegistry`):

```ts
import { createLoadedMemoryRegistry } from "./loaded-memory-registry.js";

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
```

- [ ] **Step 6: Run to verify failure**

Run: `pnpm test packages/core/src/memory/recall.test.ts -t "registry:"`
Expected: FAIL — handler 不接受 registry 参数 / 不同步

- [ ] **Step 7: Implement handler registry integration**

修改 `createMemoryRecallHandler`(`recall.ts:229-292`)。更新签名与 deps:

```ts
export function createMemoryRecallHandler(deps: {
  recall: MemoryRecall;
  store: MemoryStore;
  /** Phase 4: when provided and running, skip usage recording (yield to Dream). */
  dreamState?: DreamState;
  /** Two-stage recall: track loaded memories for dedup + selective prune. */
  registry?: LoadedMemoryRegistry;
}): (conversation: ConversationManager) => Promise<void> {
  const { recall, store, dreamState, registry } = deps;
  let lastIndexContent: string | null = null;
```

import 顶部加:`import type { LoadedMemoryRegistry, LoadedMemoryEntry } from "./loaded-memory-registry.js";`

替换 handler 主体中"剪除 -> 选择 -> 注入"段(原 257-287 行)为:

```ts
      // 2. Selective prune: remove sidequery pairs whose slug select marks
      //    irrelevant. registry syncs (removed). Active memories never pruned.
      const loaded = registry ? registry.getAll() : [];

      const messages = conversation.getMessages();
      const last = messages[messages.length - 1];
      const query =
        last && last.role === "user" && typeof last.content === "string"
          ? last.content
          : "";
      if (!query) return;

      const { add, prune } = await recall.select(query, store, loaded);

      // prune irrelevant sidequery pairs + sync registry
      if (prune.length > 0) {
        const pruned = pruneIrrelevantRecallMessages([...messages], new Set(prune));
        if (pruned.length !== messages.length) {
          conversation.replaceMessages(pruned);
        }
        if (registry) {
          for (const slug of prune) registry.remove(slug);
        }
      }

      if (add.length === 0) return;

      // Phase 4: 注入即计数（best-effort）。Dream 整理期间让位。
      if (!dreamState?.running) {
        await Promise.all(
          add.map((m) => store.recordUsage(m.slug).catch(() => {}))
        ).catch(() => {});
      }

      if (registry) {
        for (const m of add) registry.add(m.slug, "sidequery");
      }

      const [toolUse, toolResult] = buildRecallPair(query, add);
      conversation.replaceMessages([...conversation.getMessages(), toolUse, toolResult]);
```

注意:原"刷新索引层"段(原 242-255)保留在最前。原无条件 `pruneRecallMessages` 调用删除(被上述选择性 prune 取代)。

- [ ] **Step 8: Run full recall.test.ts**

Run: `pnpm test packages/core/src/memory/recall.test.ts`
Expected: PASS(含新 registry 测试;旧"prunes the previous pair"(314-330)与"only prunes when selection is empty"(332-342)测试需检查:它们用 `fakeRecall(["user/food"])` 或 `fakeRecall([])`,新 handler 在 add 非空时注入、空时只 prune。旧测试"only prunes when selection is empty"期望 seed 被 prune 后只剩 user 消息--但新 handler 只在 select 返回 prune slug 时才剪;`fakeRecall([])` 返回 `prune:[]`,不剪。该测试需更新为 `fakeRecall([], ["user/food"])` 才会剪。更新这两个测试的 fakeRecall 调用以匹配新语义。)

更新 `recall.test.ts`:
- "prunes the previous pair and injects the new one"(314):seed 旧 pair,select 返回 add=["user/food"];新 handler 不主动剪旧 pair(除非 prune 含旧 slug)。该测试断言"至多一对"不再成立(新语义允许相关旧 pair 跨轮保留)。**改为**:seed 旧 pair `user/old`,select 返回 `add=["user/food"], prune=["user/old"]`,期望旧被剪、新注入、至多一对。
- "only prunes when selection is empty"(332):改为 `fakeRecall([], ["user/food"])`,期望 seed 被剪。

具体改这两处 `fakeRecall` 调用与断言以匹配选择性 prune 语义。

Run: `pnpm test packages/core/src/memory/recall.test.ts`
Expected: PASS

- [ ] **Step 9: Remove dead pruneRecallMessages if unused**

Run: `grep -rn "pruneRecallMessages" packages --include="*.ts" | grep -v dist | grep -v test`
- 若无引用(仅定义),删除 `pruneRecallMessages` 函数与 `recall.test.ts` 中原 `describe("pruneRecallMessages")` block,并从 `index.ts:138` 导出移除 `pruneRecallMessages`。
- 若仍有引用,保留。

Run: `pnpm test packages/core/src/memory/recall.test.ts && pnpm build`
Expected: PASS + 零错

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/memory/recall.ts packages/core/src/memory/recall.test.ts
git commit -m "feat(memory): selective prune + handler registry sync (two-stage recall)"
```

---

## Task 4: memory_fetch 工具

**Files:**
- Create: `packages/core/src/tools/builtin/memory-fetch.ts`
- Test: `packages/core/src/tools/builtin/memory-fetch.test.ts`

**Interfaces:**
- Consumes: `LoadedMemoryRegistry` (Task 1)、`MemoryStore.load`/`recordUsage`、`ConversationManager`。
- Produces: `createMemoryFetchTool({ store, conversation, registry }) -> Tool`。Task 5 接线。

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/tools/builtin/memory-fetch.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import { createMemoryFetchTool } from "./memory-fetch.js";
import { MemoryStore } from "../../memory/store.js";
import { createLoadedMemoryRegistry } from "../../memory/loaded-memory-registry.js";
import { ConversationManager } from "../../conversation/manager.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Memory } from "../../memory/types.js";

function mem(slug: string, name = slug): Memory {
  return {
    slug, type: slug.split("/")[0] as Memory["type"], name,
    description: `${name} 描述`, content: `${name} 正文`,
    createdAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z",
  };
}

describe("memory_fetch tool", () => {
  let dir: string | null = null;
  let store: MemoryStore;
  let conversation: ConversationManager;
  let registry: ReturnType<typeof createLoadedMemoryRegistry>;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mfetch-"));
    store = new MemoryStore(dir);
    await store.save(mem("user/food", "食物偏好"));
    await store.save(mem("user/editor", "编辑器"));
    conversation = new ConversationManager({ model: "test" });
    registry = createLoadedMemoryRegistry();
  });
  afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });

  const ctx = { workingDirectory: dir!, sessionId: "s1" };

  it("loads memories by slug in buildRecallPair format", async () => {
    const tool = createMemoryFetchTool({ store, conversation, registry });
    const res = await tool.execute({ slugs: ["user/food"] }, ctx as any);
    expect(res.status).toBe("success");
    const content = (res as { content: string }).content;
    expect(content).toContain("## 食物偏好 (user/food)");
    expect(content).toContain("食物偏好 正文");
  });

  it("registers loaded slugs as active in registry", async () => {
    const tool = createMemoryFetchTool({ store, conversation, registry });
    await tool.execute({ slugs: ["user/food"] }, ctx as any);
    expect(registry.get("user/food")).toBe("active");
  });

  it("skips already-loaded slugs (dedup) and reports them", async () => {
    registry.add("user/food", "sidequery");
    const tool = createMemoryFetchTool({ store, conversation, registry });
    const res = await tool.execute({ slugs: ["user/food", "user/editor"] }, ctx as any);
    expect(res.status).toBe("success");
    const content = (res as { content: string }).content;
    expect(content).toContain("user/editor");       // loaded
    expect(content).toContain("已在上下文");          // user/food skipped note
    expect(content).not.toContain("食物偏好 正文");  // user/food body not re-included
  });

  it("records usage for newly loaded memories", async () => {
    const spy = vi.spyOn(store, "recordUsage");
    const tool = createMemoryFetchTool({ store, conversation, registry });
    await tool.execute({ slugs: ["user/food"] }, ctx as any);
    expect(spy).toHaveBeenCalledWith("user/food");
  });

  it("does not record usage for already-loaded (skipped) slugs", async () => {
    registry.add("user/food", "active");
    const spy = vi.spyOn(store, "recordUsage");
    const tool = createMemoryFetchTool({ store, conversation, registry });
    await tool.execute({ slugs: ["user/food"] }, ctx as any);
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips unknown slug and returns partial + note", async () => {
    const tool = createMemoryFetchTool({ store, conversation, registry });
    const res = await tool.execute({ slugs: ["user/ghost", "user/food"] }, ctx as any);
    expect(res.status).toBe("success");
    const content = (res as { content: string }).content;
    expect(content).toContain("user/food");
    expect(content).toContain("未找到");
  });

  it("returns error when all slugs unknown/loaded", async () => {
    registry.add("user/food", "active");
    const tool = createMemoryFetchTool({ store, conversation, registry });
    const res = await tool.execute({ slugs: ["user/food", "user/ghost"] }, ctx as any);
    expect(res.status).toBe("error");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test packages/core/src/tools/builtin/memory-fetch.test.ts`
Expected: FAIL — `Cannot find module './memory-fetch.js'`

- [ ] **Step 3: Implement the tool**

```ts
// packages/core/src/tools/builtin/memory-fetch.ts
import { z } from "zod";
import type { Tool } from "../types.js";
import type { MemoryStore } from "../../memory/store.js";
import type { LoadedMemoryRegistry } from "../../memory/loaded-memory-registry.js";
import type { ConversationManager } from "../../conversation/manager.js";

const MemoryFetchParams = z.object({
  slugs: z
    .array(z.string())
    .min(1)
    .describe("要取回正文的记忆 slug 列表（来自 MEMORY.md 索引，如 [\"user/food-preferences\"]）"),
});

export interface MemoryFetchToolDeps {
  store: MemoryStore;
  conversation: ConversationManager;
  registry: LoadedMemoryRegistry;
}

/**
 * memory_fetch: 主模型主动按 slug 取回已索引记忆的正文。
 * 工厂模式：ToolContext 不含 store/conversation/registry，通过闭包注入。
 * 去重（registry）、记账（recordUsage）、按召回格式返回。
 */
export function createMemoryFetchTool(deps: MemoryFetchToolDeps): Tool<typeof MemoryFetchParams> {
  const { store, registry } = deps;
  return {
    name: "memory_fetch",
    description:
      "按 slug 精确取回已索引记忆的完整正文。当你在记忆索引（MEMORY.md）中看到某条记忆的 slug 且需要其正文时调用。" +
      "已加载的记忆会自动跳过（去重），并记入用量（影响归档）。返回格式与自动召回一致（## 名称 (slug)）。" +
      "模糊搜索记忆用 Grep，读取非记忆文件用 Read。",
    parameters: MemoryFetchParams,

    async execute(input, _context) {
      const loaded: string[] = [];
      const skippedLoaded: string[] = [];
      const notFound: string[] = [];

      for (const slug of input.slugs) {
        if (registry.has(slug)) {
          skippedLoaded.push(slug);
          continue;
        }
        try {
          const m = await store.load(slug);
          if (!m) {
            notFound.push(slug);
            continue;
          }
          loaded.push(`## ${m.name} (${m.slug})\n${m.content}`);
          registry.add(slug, "active");
          try {
            await store.recordUsage(slug);
          } catch {
            // best-effort
          }
        } catch {
          notFound.push(slug);
        }
      }

      if (loaded.length === 0) {
        const notes: string[] = [];
        if (skippedLoaded.length) notes.push(`已在上下文，跳过：${skippedLoaded.join(", ")}`);
        if (notFound.length) notes.push(`未找到：${notFound.join(", ")}`);
        return {
          status: "error",
          error: notes.length ? notes.join("；") : "无记忆可加载",
          errorType: "execution",
        };
      }

      const parts = [...loaded];
      if (skippedLoaded.length) parts.push(`（已在上下文，跳过：${skippedLoaded.join(", ")}）`);
      if (notFound.length) parts.push(`（未找到：${notFound.join(", ")}）`);
      return { status: "success", content: parts.join("\n\n") };
    },
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm test packages/core/src/tools/builtin/memory-fetch.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/builtin/memory-fetch.ts packages/core/src/tools/builtin/memory-fetch.test.ts
git commit -m "feat(tools): add memory_fetch tool for active recall by slug"
```

---

## Task 5: 接线 + memory-guide 引导 + 验收

**Files:**
- Modify: `packages/core/src/index.ts`(导出)
- Modify: `packages/cli/src/hooks.ts`(registry ref + rebuild + register + 传 registry)
- Modify: `packages/core/src/conversation/templates/memory-guide.md`(第 62 行)

**Interfaces:**
- Consumes: 所有前序 Task 产物。

- [ ] **Step 1: Export new symbols from core**

`packages/core/src/index.ts` 第 138 行后加:

```ts
export { LoadedMemoryRegistry, createLoadedMemoryRegistry } from "./memory/loaded-memory-registry.js";
export type { LoadedMemoryEntry, LoadedMemorySource } from "./memory/loaded-memory-registry.js";
```

在 tools 导出区(搜索 `journalRecallTool` 导出行附近)加:

```ts
export { createMemoryFetchTool } from "./tools/builtin/memory-fetch.js";
export type { MemoryFetchToolDeps } from "./tools/builtin/memory-fetch.js";
```

- [ ] **Step 2: Wire registry + memory_fetch in hooks.ts**

`packages/cli/src/hooks.ts`:

(a) import 加(第 22-23 行 `MemoryRecall`/`createMemoryRecallHandler` 附近):

```ts
  createLoadedMemoryRegistry,
  createMemoryFetchTool,
```

(b) 在 `memoryDreamStateRef`(第 409 行)后加 registry ref:

```ts
  // Two-stage recall: session-level loaded-memory registry (shared by
  // side-query handler + memory_fetch tool for dedup + selective prune).
  const loadedMemoryRegistryRef = useRef(createLoadedMemoryRegistry());
```

(c) `createMemoryRecallHandler`(第 412-418 行)加 `registry`:

```ts
  const memoryRecallHandlerRef = useRef(
    createMemoryRecallHandler({
      recall: new MemoryRecall({ apiKey, baseUrl, model }),
      store: memoryStoreRef.current,
      dreamState: memoryDreamStateRef.current,
      registry: loadedMemoryRegistryRef.current,
    })
  );
```

(d) 在 `initManager` 内,`tools.registerAll(builtinTools)`(第 473 行)后、`managerRef.current = manager`(第 579 行)前,加 rebuild + 条件 register:

```ts
      // Two-stage recall: rebuild registry from restored session, then
      // register memory_fetch (only when recall is enabled).
      loadedMemoryRegistryRef.current.rebuild(manager.getMessages());
      if (process.env.LICODE_MEMORY_RECALL !== "off") {
        tools.register(
          createMemoryFetchTool({
            store: memoryStoreRef.current,
            conversation: manager,
            registry: loadedMemoryRegistryRef.current,
          })
        );
      }
```

- [ ] **Step 3: Update memory-guide.md line 62**

`packages/core/src/conversation/templates/memory-guide.md` 第 62 行:

```markdown
- 索引（MEMORY.md）已注入你的上下文；需要某条记忆正文时，调用 `memory_fetch(slug)`（若该工具可用）；召回关闭时用 Read 读 `.licode/memory/<type>/<slug>.md`
```

- [ ] **Step 4: Run full test suite + build**

Run: `pnpm test && pnpm build`
Expected: 全部 PASS + build 零错

- [ ] **Step 5: Manual verification checklist**

启动 CLI(`pnpm start`),验证:
- 记忆索引在 system prompt 可见。
- 主模型可调用 `memory_fetch` 取回正文(显示为工具卡片)。
- 同一记忆不会被 side-query 与 memory_fetch 重复加载。
- `LICODE_MEMORY_RECALL=off` 启动时,工具列表无 `memory_fetch`。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/index.ts packages/cli/src/hooks.ts packages/core/src/conversation/templates/memory-guide.md
git commit -m "feat(memory): wire two-stage recall (registry + memory_fetch + guide)"
```

---

## Self-Review

**1. Spec coverage:**
- §3.1 LoadedMemoryRegistry → Task 1 ✓
- §3.2 select {add,prune} 反转默认 → Task 2 ✓
- §3.3 选择性 prune → Task 3 ✓
- §3.4 memory_fetch 工具 → Task 4 ✓
- §3.5 onTurnStart 新流程 → Task 3(Step 7)+ Task 5(接线)✓
- §3.6 一致性同步点 → Task 3(handler add/remove)+ Task 4(active add)✓
- §3.7 开关 + memory-guide 引导 → Task 5 ✓
- §4 组件改动 → 全覆盖 ✓
- §6 错误降级(select 失败 {add:[],prune:[]};memory_fetch 单 slug 失败跳过;recordUsage best-effort)→ Task 2/4 ✓
- §8 验收标准 → Task 5 Step 4-5 ✓

**2. Placeholder scan:** 无 TBD/TODO;所有代码块含实际实现;测试含实际断言。

**3. Type consistency:**
- `LoadedMemoryEntry = { slug: string; source: "sidequery" | "active" }` — Task 1 定义,Task 2/3/4 消费,一致 ✓
- `select(...) -> { add: Memory[]; prune: string[] }` — Task 2 定义,Task 3 handler 消费,一致 ✓
- `pruneIrrelevantRecallMessages(messages, pruneSlugs: Set<string>) -> Message[]` — Task 3 定义并消费 ✓
- `createMemoryFetchTool({ store, conversation, registry }) -> Tool` — Task 4 定义,Task 5 消费 ✓
- `createMemoryRecallHandler` deps 加 `registry?: LoadedMemoryRegistry` — Task 3 定义,Task 5 接线传入 ✓

**4. 注意事项:**
- Task 3 Step 8 需更新两个旧 handler 测试以匹配选择性 prune 语义(原"全剪"假设不再成立)。实现者须按 Step 8 描述调整 `fakeRecall` 调用与断言。
- Task 3 Step 9:确认 `pruneRecallMessages` 无外部引用后删除;`index.ts:138` 导出同步移除。

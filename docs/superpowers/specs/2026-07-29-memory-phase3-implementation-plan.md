# 记忆系统 Phase 3（整理层 Dream）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 后台四阶段整理记忆（Orient 出怀疑清单 -> Gather 程序 grep session 新消息捞证据 -> Consolidate LLM 出操作清单落盘 -> Prune 重建索引校验体积），after:agentLoop fire-and-forget 触发，不阻塞用户，Dream 期间提取让位，delete 前备份。

**Architecture:** core 新增 `packages/core/src/memory/dream.ts`（`MemoryDream` 四阶段引擎 + `DreamState` + 锁/状态文件 + `createMemoryDreamHook`）；复用 `MemoryStore` 的 save/delete/listAll/loadIndex/rebuildIndex、`ConversationManager.listSessions/load` 读 session、`MemoryExtractor` 的 LLM 初始化与 parseResponse 防线风格、`MemoryRecall` 的 withTimeout 模式；提取 hook 加 Dream 让位；CLI 接 `isDreaming` state（useState setter 通路，非 eventBus）+ `DreamIndicator` 底部卡片。

**Tech Stack:** TypeScript（ESM，import 带 `.js` 后缀）、pnpm workspace、vitest、`AnthropicProvider`（mock 模式参照 `extractor-llm.test.ts` / `recall.test.ts`）。

**设计规格：** [2026-07-29-memory-phase3-design.md](./2026-07-29-memory-phase3-design.md)（本计划实现其全部内容）

## Global Constraints

- 不新增任何 npm 依赖
- Dream 是 fire-and-forget：`createMemoryDreamHook` 内**不 await** `dream()`，hook 立即返回，绝不阻塞用户
- `dream()` 永不 reject（try/catch + 写 `.licode/logs/dream.log`）；`state.running` 用 try/finally 复位，防卡死
- Dream 期间提取 hook 让位（`dreamState.running` -> return）
- `delete` 前必须备份待删文件 + 索引到 `.licode/memory/.dream-backup/`；`update/create/append` 不备份
- `.dream.state` / `.dream.lock` / `.dream-backup/` 放 memory 根目录（`.` 前缀），不进 4 个 type 子目录，不被 `listAll`/`rebuildIndex` 扫到
- LLM 调用复用 recall 的 `withTimeout`（`Promise.race`）降级
- 测试 mock 模式：`vi.mock("../llm/anthropic.js", ...)` + `(instance as any).llm.chat = mockChat`，tmpdir 建 `MemoryStore` + sessions 目录，`vi.stubEnv("ANTHROPIC_API_KEY", ...)`
- 提交信息沿用仓库风格（`feat(memory): ...`），每个 Task 结束提交一次
- dist 构建是 CLI 生效前提（最后一个 Task 必须 `pnpm -r build`）
- `MemoryStore` 无改动（复用现有 API）；store 私有 `dir` 字段经 `(store as unknown as Record<string, unknown>).dir` 访问（extractor 先例）

---

### Task 1: dream.ts - DreamState + 锁/状态文件 + shouldDream 门槛

**Files:**
- Create: `packages/core/src/memory/dream.ts`
- Test: `packages/core/src/memory/dream.test.ts`

**Interfaces:**
- Consumes: `ConversationManager.listSessions(dir)` / `ConversationManager.load(path)`（`../conversation/manager.js`）
- Produces（后续 Task 依赖）:
  - `DreamState`（`{ lastConsolidatedAt: number; running: boolean }`）、`createMemoryDreamState(): DreamState`
  - `DreamConfig`（`{ apiKey?, baseUrl?, model?, minIntervalMs?, minNewSessions?, timeoutMs? }`）
  - `MemoryDream` 类骨架 + `shouldDream(sessionsDir): Promise<boolean>`
  - 模块级 `acquireLock(lockPath, timeoutMs)` / `releaseLock(lockPath)` / `readState(statePath)` / `writeState(statePath, ts)`

- [ ] **Step 1: 写失败测试**

新建 `packages/core/src/memory/dream.test.ts`：

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createMemoryDreamState, MemoryDream, acquireLock, releaseLock, readState, writeState } from "./dream.js";

vi.mock("../llm/anthropic.js", () => ({
  AnthropicProvider: vi.fn().mockImplementation(() => ({
    name: "mock", maxContextTokens: 200000, chat: vi.fn(), stream: vi.fn(), countTokens: vi.fn(() => 0),
  })),
}));

describe("lock & state files", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "dream-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("acquireLock succeeds when no lock exists", async () => {
    const lock = path.join(dir, ".dream.lock");
    expect(await acquireLock(lock, 30000)).toBe(true);
  });
  it("acquireLock fails when a fresh lock exists", async () => {
    const lock = path.join(dir, ".dream.lock");
    expect(await acquireLock(lock, 30000)).toBe(true);
    expect(await acquireLock(lock, 30000)).toBe(false);
  });
  it("acquireLock overwrites an expired lock", async () => {
    const lock = path.join(dir, ".dream.lock");
    writeFileSync(lock, JSON.stringify({ pid: 1, acquiredAt: Date.now() - 60000 }));
    expect(await acquireLock(lock, 30000)).toBe(true);
  });
  it("releaseLock removes the lock", async () => {
    const lock = path.join(dir, ".dream.lock");
    await acquireLock(lock, 30000);
    await releaseLock(lock);
    expect(await acquireLock(lock, 30000)).toBe(true);
  });
  it("readState returns 0 when no state file", async () => {
    expect(await readState(path.join(dir, ".dream.state"))).toBe(0);
  });
  it("writeState/readState round-trip", async () => {
    const sp = path.join(dir, ".dream.state");
    await writeState(sp, 12345);
    expect(await readState(sp)).toBe(12345);
  });
});

describe("MemoryDream.shouldDream", () => {
  let memoryDir: string;
  let sessionsDir: string;
  beforeEach(() => {
    memoryDir = mkdtempSync(path.join(tmpdir(), "dream-mem-"));
    sessionsDir = mkdtempSync(path.join(tmpdir(), "dream-ses-"));
  });
  afterEach(() => { rmSync(memoryDir, { recursive: true, force: true }); rmSync(sessionsDir, { recursive: true, force: true }); });

  function makeSession(id: string, updatedAtIso: string) {
    writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify({
      id, createdAt: updatedAtIso, updatedAt: updatedAtIso, model: "m",
      totalTokens: 0, messageCount: 0, systemPromptLayers: [], messages: [], metadata: { model: "m", createdAt: updatedAtIso, updatedAt: updatedAtIso },
    }));
  }

  it("returns false when < minIntervalMs since last consolidation", async () => {
    const dream = new MemoryDream({ minIntervalMs: 24 * 3600 * 1000, minNewSessions: 5 });
    await writeState(path.join(memoryDir, ".dream.state"), Date.now() - 1000); // 1s ago
    makeSession("s1", new Date().toISOString());
    expect(await dream.shouldDream(sessionsDir, memoryDir)).toBe(false);
  });
  it("returns false when enough time but < minNewSessions", async () => {
    const dream = new MemoryDream({ minIntervalMs: 1000, minNewSessions: 5 });
    await writeState(path.join(memoryDir, ".dream.state"), Date.now() - 2000);
    for (let i = 0; i < 4; i++) makeSession(`s${i}`, new Date().toISOString());
    expect(await dream.shouldDream(sessionsDir, memoryDir)).toBe(false);
  });
  it("returns true when ≥ minIntervalMs and ≥ minNewSessions", async () => {
    const dream = new MemoryDream({ minIntervalMs: 1000, minNewSessions: 5 });
    await writeState(path.join(memoryDir, ".dream.state"), Date.now() - 2000);
    for (let i = 0; i < 5; i++) makeSession(`s${i}`, new Date().toISOString());
    expect(await dream.shouldDream(sessionsDir, memoryDir)).toBe(true);
  });
  it("counts only sessions updated after lastConsolidatedAt (new-session口径)", async () => {
    const dream = new MemoryDream({ minIntervalMs: 1000, minNewSessions: 2 });
    const old = new Date(Date.now() - 10 * 86400 * 1000).toISOString();
    await writeState(path.join(memoryDir, ".dream.state"), Date.now() - 2000);
    makeSession("old1", old); // 未动过的旧 session，不计
    makeSession("old2", old);
    makeSession("new1", new Date().toISOString());
    makeSession("new2", new Date().toISOString());
    expect(await dream.shouldDream(sessionsDir, memoryDir)).toBe(true); // 只有 2 个新 session，刚好达标
  });
  it("returns false when sessions dir is empty", async () => {
    const dream = new MemoryDream({ minIntervalMs: 1000, minNewSessions: 1 });
    await writeState(path.join(memoryDir, ".dream.state"), Date.now() - 2000);
    expect(await dream.shouldDream(sessionsDir, memoryDir)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/core/src/memory/dream.test.ts`
Expected: FAIL（`./dream.js` 不存在）

- [ ] **Step 3: 实现基础工具与 shouldDream**

新建 `packages/core/src/memory/dream.ts`：

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import { AnthropicProvider } from "../llm/anthropic.js";
import { ConversationManager } from "../conversation/manager.js";
import type { PipelineEvent } from "../events/types.js";
import type { MemoryStore } from "./store.js";
import type { Memory, MemoryType } from "./types.js";

const DEFAULT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_MIN_NEW_SESSIONS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const LOCK_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

export interface DreamState {
  lastConsolidatedAt: number;
  running: boolean;
}
export function createMemoryDreamState(): DreamState {
  return { lastConsolidatedAt: 0, running: false };
}

export interface DreamConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  minIntervalMs?: number;
  minNewSessions?: number;
  timeoutMs?: number;
}

/** Atomically acquire a lock file (O_EXCL); overwrites an expired lock. */
export async function acquireLock(lockPath: string, timeoutMs = LOCK_TIMEOUT_MS): Promise<boolean> {
  try {
    const raw = await fs.promises.readFile(lockPath, "utf-8");
    const lock = JSON.parse(raw);
    if (Date.now() - lock.acquiredAt < timeoutMs) return false;
    await fs.promises.unlink(lockPath).catch(() => {});
  } catch { /* no lock yet */ }
  try {
    const fd = await fs.promises.open(lockPath, "wx");
    await fd.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
    await fd.close();
    return true;
  } catch {
    return false;
  }
}

export async function releaseLock(lockPath: string): Promise<void> {
  await fs.promises.unlink(lockPath).catch(() => {});
}

export async function readState(statePath: string): Promise<number> {
  try {
    const raw = await fs.promises.readFile(statePath, "utf-8");
    return JSON.parse(raw).lastConsolidatedAt ?? 0;
  } catch {
    return 0;
  }
}

export async function writeState(statePath: string, lastConsolidatedAt: number): Promise<void> {
  await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
  await fs.promises.writeFile(statePath, JSON.stringify({ lastConsolidatedAt }));
}

export class MemoryDream {
  protected llm: AnthropicProvider;
  protected model: string;
  protected minIntervalMs: number;
  protected minNewSessions: number;
  protected timeoutMs: number;

  constructor(config?: DreamConfig) {
    const apiKey = config?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
    const baseUrl = config?.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? process.env.OPENAI_BASE_URL;
    this.model = config?.model ?? "deepseek-chat";
    this.minIntervalMs = config?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.minNewSessions = config?.minNewSessions ?? DEFAULT_MIN_NEW_SESSIONS;
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.llm = new AnthropicProvider({ apiKey, baseUrl });
  }

  /** Zero-LLM gate: enough time elapsed AND enough new sessions. */
  async shouldDream(sessionsDir: string, memoryDir: string): Promise<boolean> {
    const lastConsolidatedAt = await readState(path.join(memoryDir, ".dream.state"));
    if (Date.now() - lastConsolidatedAt < this.minIntervalMs) return false;
    const sessions = await ConversationManager.listSessions(sessionsDir);
    const newCount = sessions.filter((s) => Date.parse(s.updatedAt) > lastConsolidatedAt).length;
    return newCount >= this.minNewSessions;
  }

  // orient/gather/consolidate/prune/dream added in Tasks 2-3
  protected withTimeout<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error("memory dream timeout")), this.timeoutMs)
      ),
    ]);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/core/src/memory/dream.test.ts`
Expected: PASS（11 个用例）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/memory/dream.ts packages/core/src/memory/dream.test.ts
git commit -m "feat(memory): add MemoryDream state, lock, and shouldDream gate (phase 3)"
```

---

### Task 2: MemoryDream - Orient + Gather

**Files:**
- Modify: `packages/core/src/memory/dream.ts`
- Test: `packages/core/src/memory/dream.test.ts`

**Interfaces:**
- Consumes: `MemoryStore.listAll()`/`loadIndex()`（`./store.js`）；`ConversationManager.listSessions`/`load`；`AnthropicProvider.chat`
- Produces: `MemoryDream.orient(store)` / `MemoryDream.gather(suspicions, sessionsDir, lastConsolidatedAt)`（protected，Task 3 的 `dream()` 调用）；`Suspicion` 类型

- [ ] **Step 1: 写失败测试**

在 `dream.test.ts` 顶部补 import（`MemoryStore`、`Memory`）并新增 describe：

```ts
import { MemoryStore } from "./store.js";
import type { Memory } from "./types.js";

function makeMemory(slug: string): Memory {
  return { slug, type: slug.split("/")[0] as Memory["type"], name: slug, description: `${slug} desc`,
    content: `${slug} 正文`, createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" };
}

describe("MemoryDream.orient", () => {
  it("parses suspicions and includes existing memory content in the prompt", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dream-orient-"));
    try {
      const store = new MemoryStore(dir);
      await store.save(makeMemory("user/food"));
      const dream = new MemoryDream();
      (dream as any).llm.chat = vi.fn().mockResolvedValue({
        content: '```json\n[{"slug":"user/food","keywords":["红烧排骨","喜欢"],"reason":"可能漂移"}]\n```',
        usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn",
      });
      const suspicions = await (dream as any).orient(store);
      expect(suspicions).toEqual([{ slug: "user/food", keywords: ["红烧排骨", "喜欢"], reason: "可能漂移" }]);
      const prompt = (dream as any).llm.chat.mock.calls[0][0].messages[0].content as string;
      expect(prompt).toContain("user/food 正文");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("drops suspicions with hallucinated slugs", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dream-orient2-"));
    try {
      const store = new MemoryStore(dir);
      await store.save(makeMemory("user/food"));
      const dream = new MemoryDream();
      (dream as any).llm.chat = vi.fn().mockResolvedValue({
        content: '[{"slug":"user/ghost","keywords":["x"],"reason":"r"}]',
        usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn",
      });
      expect(await (dream as any).orient(store)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("MemoryDream.gather", () => {
  it("only searches messages newer than lastConsolidatedAt and captures keyword hits + neighbor", async () => {
    const sessionsDir = mkdtempSync(path.join(tmpdir(), "dream-gather-"));
    try {
      const oldTs = "2026-07-01T00:00:00Z";
      const newTs = new Date().toISOString();
      // 一个 session：1 条旧消息 + 1 条含关键词的新消息
      writeFileSync(path.join(sessionsDir, "s1.json"), JSON.stringify({
        id: "s1", createdAt: oldTs, updatedAt: newTs, model: "m", totalTokens: 0, messageCount: 2,
        systemPromptLayers: [], metadata: { model: "m", createdAt: oldTs, updatedAt: newTs },
        messages: [
          { role: "user", content: "旧消息 红烧排骨", timestamp: oldTs },
          { role: "assistant", content: "好的", timestamp: oldTs },
          { role: "user", content: "我现在不喜欢红烧排骨了", timestamp: newTs },
        ],
      }));
      const dream = new MemoryDream();
      const evidence = await (dream as any).gather(
        [{ slug: "user/food", keywords: ["红烧排骨"], reason: "r" }],
        sessionsDir, Date.parse("2026-07-15T00:00:00Z")
      );
      const snippets = evidence.get("user/food");
      expect(snippets).toBeDefined();
      expect(snippets.length).toBeGreaterThan(0);
      expect(snippets[0]).toContain("不喜欢红烧排骨");
      expect(snippets[0]).not.toContain("旧消息"); // 旧消息不进证据（除非作为相邻上下文）
    } finally { rmSync(sessionsDir, { recursive: true, force: true }); }
  });
  it("returns empty map when no keyword hits", async () => {
    const sessionsDir = mkdtempSync(path.join(tmpdir(), "dream-gather2-"));
    try {
      const newTs = new Date().toISOString();
      writeFileSync(path.join(sessionsDir, "s1.json"), JSON.stringify({
        id: "s1", createdAt: newTs, updatedAt: newTs, model: "m", totalTokens: 0, messageCount: 1,
        systemPromptLayers: [], metadata: { model: "m", createdAt: newTs, updatedAt: newTs },
        messages: [{ role: "user", content: "无关内容", timestamp: newTs }],
      }));
      const dream = new MemoryDream();
      const evidence = await (dream as any).gather(
        [{ slug: "user/food", keywords: ["红烧排骨"], reason: "r" }],
        sessionsDir, Date.now() - 2000
      );
      expect(evidence.size).toBe(0);
    } finally { rmSync(sessionsDir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/core/src/memory/dream.test.ts`
Expected: FAIL（`orient`/`gather` 未实现）

- [ ] **Step 3: 实现 Orient + Gather**

在 `MemoryDream` 类内追加（`withTimeout` 之前或之后）：

```ts
export interface Suspicion {
  slug: string;
  keywords: string[];
  reason: string;
}

/** Extract plain text from a message (string content or tool blocks). */
function messageText(m: { content: unknown }): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((b: any) => (typeof b?.content === "string" ? b.content : typeof b?.name === "string" ? b.name : ""))
      .join(" ");
  }
  return "";
}

/** Phase 1 - Orient: review existing memories, output suspicions to grep for. */
protected async orient(store: MemoryStore): Promise<Suspicion[]> {
  const all = await store.listAll();
  const index = await store.loadIndex();
  const prompt = this.buildOrientPrompt(index, all);
  try {
    const response = await this.withTimeout(this.llm.chat({
      messages: [{ role: "user", content: prompt, timestamp: new Date().toISOString() }],
      model: this.model, maxTokens: 1024, temperature: 0,
    }));
    return this.parseSuspicions(response.content, new Set(all.map((m) => m.slug)));
  } catch {
    return [];
  }
}

private buildOrientPrompt(indexContent: string, all: readonly Memory[]): string {
  const parts: string[] = [];
  if (indexContent) parts.push(indexContent.trim());
  for (const m of all) {
    parts.push(`### ${m.slug}\nname: ${m.name}\ndescription: ${m.description}\ncontent:\n${m.content}`);
  }
  return [
    "You are performing a dream - a reflective pass over the memory system.",
    "Review the existing memories and identify what may need consolidation.",
    "",
    "## Existing memories (index + full content)",
    parts.length ? parts.join("\n\n") : "(No existing memories yet.)",
    "",
    "## Instructions",
    "审视现有记忆，找出需要整理的点，输出 JSON 数组（无需整理则 []）：",
    '[{"slug":"user/food-preferences","keywords":["红烧排骨","喜欢"],"reason":"可能漂移，需查证"}]',
    "",
    "Rules:",
    "- slug 必须来自上面的现有记忆",
    "- 每点给 2-5 个搜索关键词，用于在历史会话中检索证据",
    "- 重点找：可能漂移（与当前状态矛盾）、重复主题、信息失效、相对日期待转换",
    "- 只输出 JSON，不要解释",
  ].join("\n");
}

private parseSuspicions(raw: string, knownSlugs: Set<string>): Suspicion[] {
  try {
    let json = raw.trim();
    const fence = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fence) json = fence[1].trim();
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    const out: Suspicion[] = [];
    for (const item of parsed) {
      if (item && typeof item.slug === "string" && knownSlugs.has(item.slug)
          && Array.isArray(item.keywords) && item.keywords.every((k: unknown) => typeof k === "string")) {
        out.push({ slug: item.slug, keywords: item.keywords, reason: typeof item.reason === "string" ? item.reason : "" });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Phase 2 - Gather (no LLM): grep recent-session new messages for suspicion keywords. */
protected async gather(
  suspicions: Suspicion[],
  sessionsDir: string,
  lastConsolidatedAt: number
): Promise<Map<string, string[]>> {
  const evidence = new Map<string, string[]>();
  if (suspicions.length === 0) return evidence;
  const sessions = (await ConversationManager.listSessions(sessionsDir))
    .filter((s) => Date.parse(s.updatedAt) > lastConsolidatedAt);
  for (const susp of suspicions) {
    const lowerKws = susp.keywords.map((k) => k.toLowerCase());
    const snippets: string[] = [];
    for (const s of sessions) {
      let mgr: ConversationManager | null = null;
      try { mgr = await ConversationManager.load(path.join(sessionsDir, `${s.id}.json`)); } catch { continue; }
      const msgs = mgr.getMessages().filter((m) => Date.parse(m.timestamp) > lastConsolidatedAt);
      const arr = [...msgs];
      for (let i = 0; i < arr.length; i++) {
        const text = messageText(arr[i]).toLowerCase();
        if (lowerKws.some((kw) => text.includes(kw))) {
          const ctx = [arr[i - 1], arr[i], arr[i + 1]].filter(Boolean).map(messageText).join("\n");
          snippets.push(ctx.slice(0, 500));
          if (snippets.length >= 5) break;
        }
      }
      if (snippets.length >= 5) break;
    }
    if (snippets.length) evidence.set(susp.slug, snippets);
  }
  return evidence;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/core/src/memory/dream.test.ts`
Expected: PASS（含 Task 1 + 本 Task 用例）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/memory/dream.ts packages/core/src/memory/dream.test.ts
git commit -m "feat(memory): add Dream orient (suspicions) and gather (session grep) (phase 3)"
```

---

### Task 3: MemoryDream - Consolidate + Prune + dream() 编排

**Files:**
- Modify: `packages/core/src/memory/dream.ts`
- Test: `packages/core/src/memory/dream.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `orient`/`gather`；`MemoryStore.save(memory, action)`/`delete(slug)`/`load(slug)`/`rebuildIndex()`/`loadIndex()`
- Produces: `MemoryDream.dream(store, sessionsDir, memoryDir): Promise<void>`（永不 reject）；`createMemoryDreamHook` 在 Task 4 调用

- [ ] **Step 1: 写失败测试**

在 `dream.test.ts` 追加 describe：

```ts
describe("MemoryDream.dream (consolidate + prune)", () => {
  let memoryDir: string;
  let sessionsDir: string;
  beforeEach(() => {
    memoryDir = mkdtempSync(path.join(tmpdir(), "dream-c-mem-"));
    sessionsDir = mkdtempSync(path.join(tmpdir(), "dream-c-ses-"));
  });
  afterEach(() => { rmSync(memoryDir, { recursive: true, force: true }); rmSync(sessionsDir, { recursive: true, force: true }); });

  it("applies update from consolidate and updates state on success", async () => {
    const store = new MemoryStore(memoryDir);
    await store.save(makeMemory("user/food"));
    const dream = new MemoryDream({ minIntervalMs: 1, minNewSessions: 1 });
    // Orient -> suspicions; Consolidate -> update
    (dream as any).llm.chat = vi.fn()
      .mockResolvedValueOnce({ content: '[{"slug":"user/food","keywords":["红烧排骨"],"reason":"r"}]', usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn" })
      .mockResolvedValueOnce({ content: '[{"action":"update","slug":"user/food","type":"user","name":"食物偏好","description":"d","content":"不喜欢红烧排骨"}]', usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn" });
    await dream.dream(store, sessionsDir, memoryDir);
    const updated = await store.load("user/food");
    expect(updated?.content).toBe("不喜欢红烧排骨");
    expect(await readState(path.join(memoryDir, ".dream.state"))).toBeGreaterThan(0);
  });

  it("backs up before delete and removes the file", async () => {
    const store = new MemoryStore(memoryDir);
    await store.save(makeMemory("user/food"));
    const dream = new MemoryDream({ minIntervalMs: 1, minNewSessions: 1 });
    (dream as any).llm.chat = vi.fn()
      .mockResolvedValueOnce({ content: '[{"slug":"user/food","keywords":["x"],"reason":"r"}]', usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn" })
      .mockResolvedValueOnce({ content: '[{"action":"delete","slug":"user/food","reason":"失效"}]', usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn" });
    await dream.dream(store, sessionsDir, memoryDir);
    expect(await store.load("user/food")).toBeNull();
    const backup = path.join(memoryDir, ".dream-backup", "user", "food.md");
    expect(fsExists(backup)).toBe(true);
  });

  it("drops delete ops with hallucinated slug (no backup, no delete)", async () => {
    const store = new MemoryStore(memoryDir);
    await store.save(makeMemory("user/food"));
    const dream = new MemoryDream({ minIntervalMs: 1, minNewSessions: 1 });
    (dream as any).llm.chat = vi.fn()
      .mockResolvedValueOnce({ content: '[{"slug":"user/food","keywords":["x"],"reason":"r"}]', usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn" })
      .mockResolvedValueOnce({ content: '[{"action":"delete","slug":"user/ghost","reason":"r"}]', usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn" });
    await dream.dream(store, sessionsDir, memoryDir);
    expect(await store.load("user/food")).not.toBeNull(); // 未被删
  });

  it("never rejects when LLM throws (state not updated)", async () => {
    const store = new MemoryStore(memoryDir);
    await store.save(makeMemory("user/food"));
    const dream = new MemoryDream({ minIntervalMs: 1, minNewSessions: 1, timeoutMs: 50 });
    (dream as any).llm.chat = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(dream.dream(store, sessionsDir, memoryDir)).resolves.toBeUndefined();
    expect(await readState(path.join(memoryDir, ".dream.state"))).toBe(0); // 失败不更新
  });
});

function fsExists(p: string): boolean {
  try { return require("node:fs").existsSync(p); } catch { return false; }
}
```

（注：`dream()` 签名为 `(store, sessionsDir, memoryDir)`；`memoryDir` 用于定位 `.dream.state`/`.dream.lock`/`.dream-backup/`。`fsExists` 用 `node:fs` 的 `existsSync`，文件顶部已 import `writeFileSync` 等，补 `existsSync`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/core/src/memory/dream.test.ts`
Expected: FAIL（`dream` 未实现）

- [ ] **Step 3: 实现 Consolidate + Prune + dream()**

在 `MemoryDream` 类内追加：

```ts
private static readonly MEMORY_ACTIONS = ["create", "update", "append"];

/** Phase 3 - Consolidate: LLM emits ops, program persists (backup before delete). */
protected async consolidate(
  store: MemoryStore,
  suspicions: Suspicion[],
  evidence: Map<string, string[]>
): Promise<void> {
  const all = await store.listAll();
  const index = await store.loadIndex();
  const prompt = this.buildConsolidatePrompt(index, all, suspicions, evidence);
  let response;
  try {
    response = await this.withTimeout(this.llm.chat({
      messages: [{ role: "user", content: prompt, timestamp: new Date().toISOString() }],
      model: this.model, maxTokens: 2048, temperature: 0,
    }));
  } catch {
    return;
  }
  const knownSlugs = new Set(all.map((m) => m.slug));
  const ops = this.parseDreamResponse(response.content, knownSlugs);
  for (const op of ops) {
    if (op.action === "delete") {
      await this.backupAndDelete(store, op.slug);
    } else {
      const now = new Date().toISOString();
      await store.save(
        { slug: op.slug, type: op.type as MemoryType, name: op.name, description: op.description,
          content: op.content, createdAt: now, updatedAt: now },
        op.action as "create" | "update" | "append"
      );
    }
  }
}

private buildConsolidatePrompt(
  indexContent: string, all: readonly Memory[],
  suspicions: Suspicion[], evidence: Map<string, string[]>
): string {
  const memParts: string[] = [];
  if (indexContent) memParts.push(indexContent.trim());
  for (const m of all) memParts.push(`### ${m.slug}\ncontent:\n${m.content}`);
  const suspText = suspicions.map((s) => `- ${s.slug}: ${s.reason}`).join("\n") || "(无)";
  const eviText = [...evidence.entries()].map(([slug, snips]) => `### ${slug}\n${snips.join("\n---\n")}`).join("\n\n") || "(无证据)";
  return [
    "You are performing a dream - consolidate the memory system based on evidence.",
    "",
    "## Existing memories (index + full content)", memParts.join("\n\n"),
    "", "## Suspicions from Orient", suspText,
    "", "## Evidence gathered from recent sessions", eviText,
    "", "## Instructions",
    "基于证据整理记忆，输出 JSON 数组（无改动则 []）：",
    '[{"action":"create|update|append|delete","slug":"<type>/<kebab-case>","type":"user|feedback|project|reference","name":"简短名称","description":"一句话描述","content":"完整正文"}]',
    "", "Rules:",
    "- create：新主题；update：改写已有文件正文（slug 须匹配现有文件）；append：向已有文件补充新段落；delete：删除整条失效/被合并的记忆文件",
    "- delete 项用 reason 字段说明删除理由（不需 content）",
    "- 新信息与现有记忆矛盾时，用 update 重写或 delete 删除，禁止矛盾并存",
    "- 优先把新信息合并进已有 topic 文件，避免创建重复文件",
    "- 把\"昨天\"\"上周\"等相对日期转换为绝对日期",
    "- 遵守 user/feedback/project/reference 四分类与\"What NOT to save\"（不存代码模式、git 历史、调试方案、任务进度）",
    "- 只使用上述证据中的内容；不要臆测",
  ].join("\n");
}

private parseDreamResponse(raw: string, knownSlugs: Set<string>): Array<{
  action: string; slug: string; type: string; name: string; description: string; content: string; reason?: string;
}> {
  try {
    let json = raw.trim();
    const fence = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fence) json = fence[1].trim();
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    const out: any[] = [];
    for (const item of parsed) {
      if (!item || typeof item.action !== "string" || typeof item.slug !== "string") continue;
      if (item.action === "delete") {
        if (knownSlugs.has(item.slug)) out.push({ action: "delete", slug: item.slug, reason: item.reason ?? "" });
      } else if (MemoryDream.MEMORY_ACTIONS.includes(item.action)
        && typeof item.type === "string" && ["user", "feedback", "project", "reference"].includes(item.type)
        && item.slug.startsWith(`${item.type}/`)
        && typeof item.name === "string" && typeof item.description === "string" && typeof item.content === "string") {
        out.push(item);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Backup a to-be-deleted file + index, then delete. */
private async backupAndDelete(store: MemoryStore, slug: string): Promise<void> {
  const memory = await store.load(slug);
  if (!memory) return;
  const storeDir = (store as unknown as Record<string, unknown>).dir as string;
  const backupDir = path.join(storeDir, ".dream-backup", memory.type);
  await fs.promises.mkdir(backupDir, { recursive: true });
  const src = path.join(storeDir, memory.type, `${path.basename(slug)}.md`);
  await fs.promises.copyFile(src, path.join(backupDir, `${path.basename(slug)}.md`)).catch(() => {});
  await fs.promises.copyFile(path.join(storeDir, "MEMORY.md"), path.join(storeDir, ".dream-backup", "MEMORY.md")).catch(() => {});
  await store.delete(slug);
}

/** Phase 4 - Prune: rebuild index, shrink descriptions if over limits. */
protected async prune(store: MemoryStore): Promise<void> {
  await store.rebuildIndex();
  const index = await store.loadIndex();
  const lines = index.split("\n").length;
  const size = Buffer.byteLength(index, "utf-8");
  if (lines <= 200 && size <= 25 * 1024) return;
  // Over limits: ask LLM to shorten descriptions (best-effort).
  try {
    const all = await store.listAll();
    const prompt = [
      "缩短以下记忆索引描述，每条 description 不超过 150 字符，保留关键信息。输出 JSON 数组：",
      '[{"slug":"...","description":"..."}]',
      "", "## Current", index,
    ].join("\n");
    const response = await this.withTimeout(this.llm.chat({
      messages: [{ role: "user", content: prompt, timestamp: new Date().toISOString() }],
      model: this.model, maxTokens: 1024, temperature: 0,
    }));
    const shortenMap = this.parseShortenResponse(response.content, new Set(all.map((m) => m.slug)));
    for (const m of all) {
      if (shortenMap.has(m.slug)) {
        await store.save({ ...m, description: shortenMap.get(m.slug)! }, "update");
      }
    }
    await store.rebuildIndex();
  } catch {
    // keep original index
  }
}

private parseShortenResponse(raw: string, knownSlugs: Set<string>): Map<string, string> {
  const map = new Map<string, string>();
  try {
    let json = raw.trim();
    const fence = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fence) json = fence[1].trim();
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return map;
    for (const item of parsed) {
      if (item && typeof item.slug === "string" && typeof item.description === "string" && knownSlugs.has(item.slug)) {
        map.set(item.slug, item.description.slice(0, 150));
      }
    }
  } catch { /* empty */ }
  return map;
}

/**
 * Run the four phases. Never rejects. Updates .dream.state only on full success.
 */
async dream(store: MemoryStore, sessionsDir: string, memoryDir: string): Promise<void> {
  const statePath = path.join(memoryDir, ".dream.state");
  const lastConsolidatedAt = await readState(statePath);
  try {
    const suspicions = await this.orient(store);
    const evidence = await this.gather(suspicions, sessionsDir, lastConsolidatedAt);
    await this.consolidate(store, suspicions, evidence);
    await this.prune(store);
    await writeState(statePath, Date.now());
  } catch (err) {
    this.logError(err);
    // do NOT update state - next run can retry
  }
}

private logError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const detail = err instanceof Error ? err.stack ?? message : message;
  console.error("[MemoryDream] failed:", message);
  try {
    const logDir = path.join(memoryDirOfLastStore(), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "dream.log"), `[${new Date().toISOString()}] ${detail}\n`, "utf-8");
  } catch { /* give up */ }
}
```

> **注**：`logError` 需要日志目录路径。`dream()` 已有 `memoryDir` 参数，把它传给 `logError`（替换上面的 `memoryDirOfLastStore()` 占位）：
> ```ts
> private logError(memoryDir: string, err: unknown): void {
>   ...
>   const logDir = path.join(path.dirname(memoryDir), "logs"); // memoryDir 是 .licode/memory，logs 在 .licode/logs
>   ...
> }
> ```
> 与 extractor 一致：日志写 `.licode/logs/dream.log`（`memoryDir` = `.licode/memory`，`path.dirname` = `.licode`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/core/src/memory/dream.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/memory/dream.ts packages/core/src/memory/dream.test.ts
git commit -m "feat(memory): add Dream consolidate/prune/dream orchestration with backup (phase 3)"
```

---

### Task 4: createMemoryDreamHook - after:agentLoop 触发

**Files:**
- Modify: `packages/core/src/memory/dream.ts`
- Test: `packages/core/src/memory/dream.test.ts`

**Interfaces:**
- Consumes: Task 1-3 全部产物；`PipelineEvent`（`../events/types.js`）
- Produces: `createMemoryDreamHook(deps)` 返回 `(event: PipelineEvent) => Promise<void>`，供 Task 6 CLI 接线

- [ ] **Step 1: 写失败测试**

在 `dream.test.ts` 追加：

```ts
import { createMemoryDreamHook } from "./dream.js";
import type { PipelineEvent } from "../events/types.js";

describe("createMemoryDreamHook", () => {
  let memoryDir: string;
  let sessionsDir: string;
  beforeEach(() => {
    memoryDir = mkdtempSync(path.join(tmpdir(), "dream-hook-mem-"));
    sessionsDir = mkdtempSync(path.join(tmpdir(), "dream-hook-ses-"));
  });
  afterEach(() => { rmSync(memoryDir, { recursive: true, force: true }); rmSync(sessionsDir, { recursive: true, force: true }); });

  function makeEvent(): PipelineEvent {
    return { type: "agent-loop-complete" } as unknown as PipelineEvent;
  }

  it("does not dream when shouldDream is false", async () => {
    const dream = new MemoryDream({ minIntervalMs: 24 * 3600 * 1000, minNewSessions: 5 });
    const spy = vi.spyOn(dream, "dream").mockResolvedValue(undefined);
    const state = createMemoryDreamState();
    const onStateChange = vi.fn();
    const hook = createMemoryDreamHook({ dream, store: new MemoryStore(memoryDir), state, sessionsDir, memoryDir, onStateChange });
    await hook(makeEvent());
    expect(spy).not.toHaveBeenCalled();
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it("fires dream fire-and-forget and signals state on start/end", async () => {
    const dream = new MemoryDream({ minIntervalMs: 1, minNewSessions: 1 });
    // 预置 1 个新 session + 写一个过期的 state 满足 shouldDream
    writeFileSync(path.join(sessionsDir, "s1.json"), JSON.stringify({
      id: "s1", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), model: "m",
      totalTokens: 0, messageCount: 0, systemPromptLayers: [], messages: [], metadata: { model: "m", createdAt: "", updatedAt: "" },
    }));
    await writeState(path.join(memoryDir, ".dream.state"), Date.now() - 2000);
    const spy = vi.spyOn(dream, "dream").mockImplementation(async () => { /* fast */ });
    const state = createMemoryDreamState();
    const onStateChange = vi.fn();
    const hook = createMemoryDreamHook({ dream, store: new MemoryStore(memoryDir), state, sessionsDir, memoryDir, onStateChange });
    await hook(makeEvent()); // fire-and-forget: hook returns immediately
    // 等后台 dream 完成
    await new Promise((r) => setTimeout(r, 50));
    expect(spy).toHaveBeenCalled();
    expect(onStateChange).toHaveBeenCalledWith(true);
    expect(onStateChange).toHaveBeenCalledWith(false);
    expect(state.running).toBe(false);
    // 锁已释放
    expect(await acquireLock(path.join(memoryDir, ".dream.lock"), 30000)).toBe(true);
  });

  it("skips when already running (mutex)", async () => {
    const dream = new MemoryDream({ minIntervalMs: 1, minNewSessions: 1 });
    writeFileSync(path.join(sessionsDir, "s1.json"), JSON.stringify({ id: "s1", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), model: "m", totalTokens: 0, messageCount: 0, systemPromptLayers: [], messages: [], metadata: { model: "m", createdAt: "", updatedAt: "" } }));
    await writeState(path.join(memoryDir, ".dream.state"), Date.now() - 2000);
    let resolveDream: () => void;
    const spy = vi.spyOn(dream, "dream").mockImplementation(() => new Promise<void>((r) => { resolveDream = r; }));
    const state = createMemoryDreamState();
    const hook = createMemoryDreamHook({ dream, store: new MemoryStore(memoryDir), state, sessionsDir, memoryDir, onStateChange: () => {} });
    await hook(makeEvent());
    await hook(makeEvent()); // 第二次：running，应跳过
    expect(spy).toHaveBeenCalledTimes(1);
    resolveDream!();
    await new Promise((r) => setTimeout(r, 20));
  });

  it("ignores non agent-loop-complete events", async () => {
    const dream = new MemoryDream();
    const spy = vi.spyOn(dream, "dream").mockResolvedValue(undefined);
    const hook = createMemoryDreamHook({ dream, store: new MemoryStore(memoryDir), state: createMemoryDreamState(), sessionsDir, memoryDir, onStateChange: () => {} });
    await hook({ type: "user-message" } as unknown as PipelineEvent);
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/core/src/memory/dream.test.ts`
Expected: FAIL（`createMemoryDreamHook` 未导出）

- [ ] **Step 3: 实现 hook**

在 `dream.ts` 末尾追加：

```ts
/**
 * after:agentLoop hook: on agent-loop-complete, if shouldDream + lock acquired,
 * fire-and-forget dream(). The hook returns immediately (does NOT await dream),
 * so the user is never blocked. onStateChange signals the TUI indicator.
 */
export function createMemoryDreamHook(deps: {
  dream: MemoryDream;
  store: MemoryStore;
  state: DreamState;
  sessionsDir: string;
  memoryDir: string;
  onStateChange?: (running: boolean) => void;
}): (event: PipelineEvent) => Promise<void> {
  const { dream, store, state, sessionsDir, memoryDir, onStateChange } = deps;
  const lockPath = path.join(memoryDir, ".dream.lock");
  return async (event: PipelineEvent) => {
    if (event.type !== "agent-loop-complete") return;
    if (state.running) return;
    if (!(await dream.shouldDream(sessionsDir, memoryDir))) return;
    if (!(await acquireLock(lockPath))) return;

    state.running = true;
    onStateChange?.(true);
    // fire-and-forget - do NOT await; the hook must return immediately.
    dream.dream(store, sessionsDir, memoryDir)
      .catch(() => { /* dream() never rejects, but guard anyway */ })
      .finally(async () => {
        state.running = false;
        onStateChange?.(false);
        await releaseLock(lockPath);
      });
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/core/src/memory/dream.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/memory/dream.ts packages/core/src/memory/dream.test.ts
git commit -m "feat(memory): add createMemoryDreamHook after:agentLoop trigger (phase 3)"
```

---

### Task 5: 提取 hook 让位

**Files:**
- Modify: `packages/core/src/memory/hook.ts`、`packages/core/src/memory/hook.test.ts`
- Modify: `packages/cli/src/hooks.ts`（接线在 Task 6）

**Interfaces:**
- Consumes: Task 1 的 `DreamState` 类型
- Produces: `createMemoryExtractionHook` 增加可选 `dreamState?: DreamState` 参数；running 时提取 return

- [ ] **Step 1: 写失败测试**

在 `hook.test.ts` 追加（import 处补 `createMemoryDreamState`）：

```ts
it("yields to a running dream (dreamState.running -> return without extracting)", async () => {
  // 复用该文件既有的 extractor/store/conversation/state mock 套路
  const dreamState = createMemoryDreamState();
  dreamState.running = true;
  const hook = createMemoryExtractionHook(extractor, store, conversation, state, dreamState);
  await hook({ type: "agent-loop-complete" } as any);
  expect(extractor.extract).not.toHaveBeenCalled();
  expect(extractor.shouldExtract).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/core/src/memory/hook.test.ts`
Expected: FAIL（`createMemoryExtractionHook` 第 5 参不存在 / TS 报错）

- [ ] **Step 3: 实现让位**

`hook.ts`：
- import `DreamState` from `./dream.js`
- `createMemoryExtractionHook(extractor, store, conversation, state, dreamState?: DreamState)`
- 函数体开头（`if (event.type !== "agent-loop-complete") return;` 之后）加：
  ```ts
  // Dream is running - yield. Dream is a fuller consolidation; don't race it.
  if (dreamState?.running) return;
  ```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/core/src/memory/hook.test.ts`
Expected: PASS（既有用例 + 新用例）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/memory/hook.ts packages/core/src/memory/hook.test.ts
git commit -m "feat(memory): yield extraction hook to running dream (phase 3)"
```

---

### Task 6: core 导出 + CLI 接线 + TUI

**Files:**
- Modify: `packages/core/src/index.ts`（导出 dream 符号）
- Modify: `packages/cli/src/hooks.ts`（isDreaming state、dreamStateRef、创建 MemoryDream + hook、传 dreamState 给提取 hook、env 开关、返回 isDreaming）
- Create: `packages/cli/src/components/dream-indicator.tsx`
- Modify: `packages/cli/src/app.tsx`（`{isDreaming && <DreamIndicator />}`）

**Interfaces:**
- Consumes: Task 4 的 `createMemoryDreamHook`、Task 1 的 `createMemoryDreamState`/`MemoryDream`、Task 5 的 `createMemoryExtractionHook(...dreamState)`
- Produces: CLI 行为--默认开启 Dream；`LICODE_MEMORY_DREAM=off` 关闭；底部"整理中"卡片

- [ ] **Step 1: core 导出**

`packages/core/src/index.ts` 在 memory 导出块追加：

```ts
export { MemoryDream, createMemoryDreamHook, createMemoryDreamState, acquireLock, releaseLock, readState, writeState } from "./memory/dream.js"; // Phase 3: dream consolidation
export type { DreamConfig, DreamState, Suspicion } from "./memory/dream.js";
```

- [ ] **Step 2: 验证 core 编译**

Run: `pnpm --filter @licode/core build`
Expected: 编译通过

- [ ] **Step 3: DreamIndicator 组件**

新建 `packages/cli/src/components/dream-indicator.tsx`（照抄 `waiting-indicator.tsx`）：

```tsx
import React, { useState, useEffect } from "react";
import { Text } from "ink";
import { ICONS } from "../theme.js";

export function DreamIndicator() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % ICONS.spinnerFrames.length);
    }, 100);
    return () => clearInterval(timer);
  }, []);
  return (
    <Text dimColor>
      {ICONS.spinnerFrames[frame]} 🌙 记忆整理中...
    </Text>
  );
}
```

- [ ] **Step 4: CLI 接线**

`packages/cli/src/hooks.ts`：
- import 块追加：`MemoryDream`、`createMemoryDreamHook`、`createMemoryDreamState`、`DreamState`
- state 区（L203-210 附近）追加：`const [isDreaming, setIsDreaming] = useState(false);`
- `memoryExtractionStateRef` 声明之后追加：
  ```ts
  // Phase 3: dream consolidation (after:agentLoop, fire-and-forget).
  // Shared with the extraction hook so extraction yields while dreaming.
  const memoryDreamStateRef = useRef(createMemoryDreamState());
  const memoryDreamRef = useRef(
    process.env.LICODE_MEMORY_DREAM === "off"
      ? null
      : new MemoryDream({ apiKey, baseUrl, model })
  );
  ```
- 创建提取 hook 处（`createMemoryExtractionHook(...)`）追加第 5 参 `memoryDreamStateRef.current`
- after:agentLoop hook 注册区（`emitAfterAgentLoop` 附近 / 或独立注册）追加 Dream hook 注册：将 `createMemoryDreamHook(...)` 注册到 `after:agentLoop`（与提取 hook 同位置，`blocking: false`）。具体注册方式对齐现有提取 hook 的注册机制（若提取 hook 经 `extensions.hooks` 注册，Dream 同理；若经 pipeline `hook:after:agentLoop`，Dream 同样 emit）。传 `onStateChange: setIsDreaming`、`memoryDir`（= memoryStore 的 dir）、`sessionsDir`（= `.licode/sessions`）。
- `useConversation` 返回值追加 `isDreaming`

> **注**：`memoryDir` / `sessionsDir` 从 `memoryStoreRef.current` 的 dir 与项目 `.licode/sessions` 取得，对齐现有 `MemoryStore` 构造路径。

- [ ] **Step 5: app.tsx 接入卡片**

`packages/cli/src/app.tsx`：
- import `DreamIndicator`
- 从 `useConversation` 解构 `isDreaming`
- 在 `ChatView` 之后、`InputBox` 之前（与 `WaitingIndicator` 同区）加：
  ```tsx
  {isDreaming && (
    <Box marginBottom={1}>
      <DreamIndicator />
    </Box>
  )}
  ```

- [ ] **Step 6: 构建 + 全量回归**

```bash
pnpm -r build
ls packages/core/dist/memory/dream.js   # 必须存在
npx vitest run packages/core/src/memory packages/core/src/agent
npm test
```

Expected: 构建通过；dist 含 dream.js；全部测试通过

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/index.ts packages/cli/src/hooks.ts packages/cli/src/components/dream-indicator.tsx packages/cli/src/app.tsx
git commit -m "feat(cli): wire dream consolidation +整理中 indicator (phase 3)"
```

---

### Task 7: 手工验收（对应规格 §4）

**Files:** 无（仅验证）

- [ ] **Step 1: 准备 + 启动**

```bash
npm start
# 先用 /memory add 或对话积累若干记忆，并跨 ≥5 个 session、间隔 ≥24h
# （测试时可临时把 minIntervalMs 调小 / 手动写 .dream.state 为旧时间戳）
```

- [ ] **Step 2: 逐条验收**

| # | 操作 | 预期 |
|---|---|---|
| 1 | 满足触发条件后提问，等 agent loop 结束 | TUI 底部出现"🌙 记忆整理中..."卡片 |
| 2 | 整理期间继续提问 | 对话不阻塞；提取 hook 让位（日志"dream running"） |
| 3 | 有重复记忆（user/editor 与 user/ide 相近）| Dream 后合并为一个，另一个 delete 且备份到 .dream-backup/ |
| 4 | 旧记忆"喜欢红烧排骨" + 新 session 说"不喜欢了" | 同文件正文被改写，无矛盾并存 |
| 5 | 旧记忆含"昨天" | Dream 后转为绝对日期 |
| 6 | Dream 完成 | 卡片消失；MEMORY.md <200 行 / <25KB |
| 7 | 断网/无效 apiKey 触发 Dream | 不阻塞、不更新 lastConsolidatedAt、卡片消失、错误写 .licode/logs/dream.log |
| 8 | 从 .dream-backup/ 手动恢复被删文件 + rebuildIndex | 记忆恢复 |
| 9 | `LICODE_MEMORY_DREAM=off npm start` | 完全不触发 Dream |
| 10 | `npm test` | 全部通过 |

- [ ] **Step 3: 收尾提交**

如验收中发现并修复了问题，修复单独提交；全部通过后 push 分支并更新 draft PR：

```bash
git push -u origin worktree-memory-system-redesign
# 更新 PR 描述，附 phase 3 设计 + 实现计划文档链接
```

---

## 风险与注意点

1. **fire-and-forget 的 `dream()` Promise 必须自洽**：`dream()` 永不 reject（内部 try/catch），`.finally()` 才能可靠复位 `running` + 释放锁；hook 内额外 `.catch(() => {})` 双保险。若 `dream()` 漏接 reject，`running` 卡死会让提取永久让位、Dream 永不重触发。
2. **锁的 read-check-write 竞态**：`acquireLock` 用 `O_EXCL`（`open(..., "wx")`）原子创建，过期锁先 unlink 再创建--unlink 与创建之间有窗口，但个人 CLI 单进程为主，多 worktree 并发概率低，可接受。
3. **`memoryDir` 来源**：Dream 需要 `.licode/memory` 路径定位 `.dream.state`/`.dream.lock`/`.dream-backup/`。从 `memoryStoreRef.current` 的 `dir` 取，对齐 extractor 取 `dir` 的方式。
4. **session save 时机**：`after:agentLoop` 触发 Dream 时，当前会话的 session 文件是否已落盘决定 Gather 能否搜到本轮新消息。实现时确认 `SessionManager.save` 在 agent loop 结束时已调用；若未落盘，Gather 至少能搜到之前的 session（本轮新消息下轮 Dream 再搜），可接受。
5. **Dream 写文件触发提取误判**：Dream running 时提取让位（不跑）；Dream 结束后下轮提取可能因 Dream 改过的 mtime 误判"主 Agent 已写"一次（rebuildIndex + 跳过一轮），自愈可接受（Phase 1 风险清单已记录）。
6. **`useRef(初始化)` 每渲染求值**：`new MemoryDream(...)` 每渲染构造一次但仅首个保留，与既有 `MemoryStore`/`MemoryExtractor`/`MemoryRecall` ref 一致，构造仅赋值字段无副作用。
7. **`isDreaming` 跨会话**：`useState` 在 `useConversation` 生命周期内有效；CLI 重启自然重置。Dream 跨轮时 `setIsDreaming` 持续有效（组件未卸载）。
8. **Prune 的 LLM 精简是 best-effort**：个人记忆量小，索引超限罕见；精简失败保留原索引 + 日志，不阻塞。
9. **Gather 大 session 保护**：`ConversationManager.load` 全量 `JSON.parse`；若单 session 极大可能慢/占内存。实现时可对 `msgs` 加上限（如 `slice(-200)`），本期个人 CLI session 量级可控，列为后续优化。
10. **测试隔离**：dream.test.ts 用 tmpdir 建 memoryDir + sessionsDir，afterEach 清理；`vi.mock("../llm/anthropic.js")` + `vi.stubEnv`，与 recall.test.ts 一致。

# 记忆系统 Phase 4（反馈闭环）实现计划

> **⚠️ 实现期演进说明（2026-07-31 修订）**：本计划描述的是**初稿（Option A：LLM keep 否决）**。实现/验收期间迭代为**最终机制：规则驱动自动归档 + `pinned` 硬保护 + 归档通知（去 LLM keep）**。计划中 Task 1/2/3/5/6（计数、archive/store、recall 让位、命令、CLI 接线）与最终一致；**Task 4（Dream 归档）与最终不同**：归档不再靠 LLM 输出 `archive`，改为程序规则自动归档候选、`isArchiveCandidate` 排除 `pinned`、`dream()` 返回归档 slugs 供通知。另新增 `pinned` 字段（types/store `setPinned`/`/memory pin\|unpin`/memory-guide）与归档通知（`onArchived` -> TUI banner）。**最终设计以 [2026-07-30-memory-phase4-design.md](./2026-07-30-memory-phase4-design.md) 为准**（含 §0 演进说明）。迭代 commit：`445b521` -> `0bb8329` -> `35792b6` -> `7d55481`。本计划保留作历史记录，不再逐条更新。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 闭环记忆系统的"反馈"环节--recall 注入即计数（frontmatter `usageCount`/`lastUsedAt`），长期未用记忆由 Dream 复核后归档（移入 `archive/`、移出索引、可恢复）。计数写入对提取用 utimes 隐身、对 Dream 用让位缺席，两道安全网互补。

**Architecture:** core 改 `types.ts`（usage 可选字段）、`store.ts`（parse/save 保留 usage + `recordUsage`/`archive`/`listArchived`/`restore`）、`recall.ts`（handler 计数埋点 + Dream 让位）、`dream.ts`（Consolidate 扩展归档候选 + `archive` action）、`extensions/commands/builtin/memory.ts`（`restore`/`archive` 子命令）；CLI 改 `hooks.ts`（传 `dreamState` 给 recall handler + 重排 ref）。无新 LLM 调用（归档复用 Consolidate）、无新 TUI 组件、无新 npm 依赖。

**Tech Stack:** TypeScript（ESM，import 带 `.js` 后缀）、pnpm workspace、vitest、`AnthropicProvider`（mock 模式参照 `dream.test.ts` / `recall.test.ts`）。

**设计规格：** [2026-07-30-memory-phase4-design.md](./2026-07-30-memory-phase4-design.md)（本计划实现其全部内容）

## Global Constraints

- 不新增任何 npm 依赖
- `usageCount`/`lastUsedAt` 为 `Memory` 接口的**可选**字段，向后兼容所有既有构造点（extractor / dream / 命令的 `makeMemory` 不必显式赋值）
- `recordUsage` 是唯一的热路径写：写后**必须 `utimes` 恢复原 mtime**（对 `hasChangesSince` 隐身），**不 `rebuildIndex`**（usage 不进索引）
- `recordUsage` 在 Dream 期间**让位**（`dreamState.running` -> 跳过计数），与提取让位同原则；recall 的 select/inject（读）不让位
- 归档候选只看 `lastUsedAt` 非空且 >阈值，**不看 `createdAt`**（防 recall 关闭时全量误归档）
- 归档 = `archive` action（移文件到 `archive/<type>/`，可恢复），与 `delete`（不可逆、备份到 `.dream-backup/`）是两个独立 action
- `archive` 的 slug 必须在程序候选集内（规则护栏，防 LLM 幻觉归档新/常用记忆）
- `archive/` 放 memory 根目录（非 type 子目录），`listAll`/`rebuildIndex`/`hasChangesSince` 都不扫它
- 测试 mock 模式：`vi.mock("../llm/anthropic.js", ...)` + `(instance as any).llm.chat = mockChat`，tmpdir 建 `MemoryStore` + sessions 目录（参照 `dream.test.ts`）
- store 私有 `dir` 字段经 `(store as unknown as Record<string, unknown>).dir` 访问（extractor / dream 先例）
- 提交信息沿用仓库风格（`feat(memory): ...`），每个 Task 结束提交一次
- dist 构建是 CLI 生效前提（最后一个 Task 必须 `pnpm -r build`）

---

### Task 1: types.ts usage 字段 + store.ts parse/save 保留 usage + recordUsage（mtime 隐身）

**Files:**
- Modify: `packages/core/src/memory/types.ts`
- Modify: `packages/core/src/memory/store.ts`
- Test: `packages/core/src/memory/memory.test.ts`

**Interfaces:**
- Produces: `Memory.usageCount?` / `Memory.lastUsedAt?`；`MemoryStore.recordUsage(slug): Promise<void>`；`parse`/`save` 读写 usage 字段
- Consumes（后续 Task）: Task 3 的 recall handler 调 `recordUsage`；Task 4 的 Dream 读 `lastUsedAt`

- [ ] **Step 1: 写失败测试**

在 `memory.test.ts` 追加（顶部已 import `mkdtempSync`/`rmSync`/`existsSync`/`utimesSync`/`writeFileSync`、`MemoryStore`、`Memory`；`makeMemory(overrides)` 已存在）：

```ts
import { statSync } from "node:fs";

describe("MemoryStore usage tracking (Phase 4)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "licode-usage-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("parse reads usageCount/lastUsedAt; missing -> 0/empty", async () => {
    const store = new MemoryStore(dir);
    await store.save(makeMemory({ slug: "user/a" }));
    const m = await store.load("user/a");
    expect(m?.usageCount).toBe(0);
    expect(m?.lastUsedAt).toBe("");
  });

  it("save(create) writes usage fields (0/empty for new memory)", async () => {
    const store = new MemoryStore(dir);
    await store.save(makeMemory({ slug: "user/a" }));
    const raw = require("node:fs").readFileSync(path.join(dir, "user", "a.md"), "utf-8");
    expect(raw).toContain("usageCount: 0");
    expect(raw).toContain("lastUsedAt:");
  });

  it("save(update) preserves existing usage (does not reset)", async () => {
    const store = new MemoryStore(dir);
    await store.save(makeMemory({ slug: "user/a" }));
    await store.recordUsage("user/a"); // -> usageCount=1, lastUsedAt=now
    const before = await store.load("user/a");
    await store.save(makeMemory({ slug: "user/a", content: "新内容" }), "update");
    const after = await store.load("user/a");
    expect(after?.content).toBe("新内容");
    expect(after?.usageCount).toBe(before!.usageCount);
    expect(after?.lastUsedAt).toBe(before!.lastUsedAt);
  });

  it("recordUsage increments usageCount, sets lastUsedAt, preserves content + updatedAt", async () => {
    const store = new MemoryStore(dir);
    await store.save(makeMemory({ slug: "user/a", content: "正文", updatedAt: "2026-07-01T00:00:00Z" }));
    await store.recordUsage("user/a");
    const m = await store.load("user/a");
    expect(m?.usageCount).toBe(1);
    expect(m?.lastUsedAt).toBeTruthy();
    expect(m?.content).toBe("正文");
    expect(m?.updatedAt).toBe("2026-07-01T00:00:00Z"); // 不被计数改写
  });

  it("recordUsage does NOT rebuildIndex (MEMORY.md untouched)", async () => {
    const store = new MemoryStore(dir);
    await store.save(makeMemory({ slug: "user/a" }));
    const idxPath = path.join(dir, "MEMORY.md");
    const idxMtimeBefore = statSync(idxPath).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));
    await store.recordUsage("user/a");
    expect(statSync(idxPath).mtimeMs).toBe(idxMtimeBefore); // 索引未重写
  });

  it("recordUsage restores mtime -> invisible to hasChangesSince (坑回归)", async () => {
    const store = new MemoryStore(dir);
    await store.save(makeMemory({ slug: "user/a" }));
    const filePath = path.join(dir, "user", "a.md");
    const mtimeBefore = statSync(filePath).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));
    const loopStartedAt = Date.now(); // 模拟 handleSubmit 置位
    await new Promise((r) => setTimeout(r, 10));
    await store.recordUsage("user/a");
    // mtime 恢复到写入前（< loopStartedAt）
    expect(statSync(filePath).mtimeMs).toBe(mtimeBefore);
    expect(await store.hasChangesSince(loopStartedAt)).toBe(false);
    // 但 usage 确实记录了
    expect((await store.load("user/a"))?.usageCount).toBe(1);
  });

  it("recordUsage on missing slug is a silent no-op", async () => {
    const store = new MemoryStore(dir);
    await expect(store.recordUsage("user/ghost")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/core/src/memory/memory.test.ts`
Expected: FAIL（`usageCount`/`lastUsedAt` 字段不存在、`recordUsage` 未实现）

- [ ] **Step 3: 实现 types + parse/save + recordUsage**

`types.ts`：在 `Memory` 接口 `updatedAt` 后追加两字段：

```ts
  /** 更新时间 ISO */
  updatedAt: string;
  /** 被 recall 注入上下文的累计次数（Phase 4）。未用过为 0。 */
  usageCount?: number;
  /** 最近一次被 recall 注入的 ISO 时间（Phase 4）。未用过为 ""。 */
  lastUsedAt?: string;
```

`store.ts parse()`：在返回对象 `updatedAt: ...` 后追加（`fm` 是现有的 Map）：

```ts
      usageCount: fm.has("usageCount") ? Number(fm.get("usageCount")) || 0 : 0,
      lastUsedAt: fm.get("lastUsedAt") ?? "",
```

`store.ts save()`：在 `let finalContent/createdAt/updatedAt` 声明区追加 usage 局部变量，并在 update/append 分支保留现有 usage；frontmatter 数组追加两行。改后 `save()` 关键段：

```ts
    let finalContent = memory.content;
    let createdAt = memory.createdAt;
    let updatedAt = memory.updatedAt;
    // Phase 4: usage 字段。create(新文件) -> 0/""（新记忆未用过）；
    // update/append -> 保留现有（内容更新 ≠ 使用事件，不重置遗忘时钟）。
    let usageCount = 0;
    let lastUsedAt = "";

    if (effectiveAction === "update") {
      if (exists) {
        const existing = await this.load(memory.slug);
        if (existing) {
          createdAt = existing.createdAt;
          usageCount = existing.usageCount ?? 0;
          lastUsedAt = existing.lastUsedAt ?? "";
        }
      }
      updatedAt = new Date().toISOString();
    } else if (effectiveAction === "append" && exists) {
      const existing = await this.load(memory.slug);
      if (existing) {
        finalContent = mergeAppend(existing.content, memory.content);
        usageCount = existing.usageCount ?? 0;
        lastUsedAt = existing.lastUsedAt ?? "";
      }
    }

    const frontmatter = [
      "---",
      `name: ${memory.name}`,
      `description: ${memory.description}`,
      `type: ${memory.type}`,
      `createdAt: ${createdAt}`,
      `updatedAt: ${updatedAt}`,
      `usageCount: ${usageCount}`,
      `lastUsedAt: ${lastUsedAt}`,
      "---",
      "",
      finalContent,
      "",
    ].join("\n");
```

`store.ts` 新增 `recordUsage` 方法（放在 `hasChangesSince` 之后）：

```ts
  /**
   * Phase 4: record a recall-injection usage event for `slug`.
   * Increments usageCount, sets lastUsedAt=now, preserves everything else.
   * Restores the original mtime so the write is invisible to
   * {@link hasChangesSince} (the Phase 2/3 pre-noted mtime坑). Does NOT
   * rebuildIndex (usage fields are not in the index). Best-effort: a missing
   * file or utimes failure is swallowed.
   */
  async recordUsage(slug: string): Promise<void> {
    for (const type of MEMORY_TYPES) {
      const filePath = path.join(this.dir, type, `${path.basename(slug)}.md`);
      if (!fs.existsSync(filePath)) continue;
      const stat = await fs.promises.stat(filePath);
      const mtimeMs = stat.mtimeMs;
      const atimeMs = stat.atimeMs;
      const raw = await fs.promises.readFile(filePath, "utf-8");
      const existing = this.parse(raw, slug, type);
      const usageCount = (existing.usageCount ?? 0) + 1;
      const lastUsedAt = new Date().toISOString();
      const frontmatter = [
        "---",
        `name: ${existing.name}`,
        `description: ${existing.description}`,
        `type: ${existing.type}`,
        `createdAt: ${existing.createdAt}`,
        `updatedAt: ${existing.updatedAt}`,
        `usageCount: ${usageCount}`,
        `lastUsedAt: ${lastUsedAt}`,
        "---",
        "",
        existing.content,
        "",
      ].join("\n");
      await fs.promises.writeFile(filePath, frontmatter, "utf-8");
      // Restore original mtime -> invisible to hasChangesSince(loopStartedAt).
      await fs.promises
        .utimes(filePath, atimeMs / 1000, mtimeMs / 1000)
        .catch(() => {});
      return; // first matching type dir wins
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/core/src/memory/memory.test.ts`
Expected: PASS（含新用例；既有 store 用例用 `toContain` 不受新 frontmatter 行影响。若有精确匹配用例失败，补上 usage 行）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/memory/types.ts packages/core/src/memory/store.ts packages/core/src/memory/memory.test.ts
git commit -m "feat(memory): add usage tracking fields + recordUsage with mtime stealth (phase 4)"
```

---

### Task 2: store.ts archive/listArchived/restore

**Files:**
- Modify: `packages/core/src/memory/store.ts`
- Test: `packages/core/src/memory/memory.test.ts`

**Interfaces:**
- Produces: `MemoryStore.archive(slug)` / `listArchived()` / `restore(slug)`；供 Task 4 Dream 与 Task 5 命令调用

- [ ] **Step 1: 写失败测试**

在 `memory.test.ts` 的 "MemoryStore usage tracking (Phase 4)" describe 内（或新 describe）追加：

```ts
describe("MemoryStore archive/restore (Phase 4)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "licode-archive-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("archive moves file to archive/<type>/ and drops from index", async () => {
    const store = new MemoryStore(dir);
    await store.save(makeMemory({ slug: "user/old" }));
    await store.archive("user/old");
    expect(existsSync(path.join(dir, "user", "old.md"))).toBe(false);
    expect(existsSync(path.join(dir, "archive", "user", "old.md"))).toBe(true);
    expect(await store.load("user/old")).toBeNull(); // listAll/load 不扫 archive/
    await store.rebuildIndex();
    expect((await store.loadIndex()).includes("user/old")).toBe(false);
  });

  it("archive on missing slug is a no-op", async () => {
    const store = new MemoryStore(dir);
    await expect(store.archive("user/ghost")).resolves.toBeUndefined();
  });

  it("listArchived lists archived memories (with usage fields)", async () => {
    const store = new MemoryStore(dir);
    await store.save(makeMemory({ slug: "user/old" }));
    await store.archive("user/old");
    const archived = await store.listArchived();
    expect(archived).toHaveLength(1);
    expect(archived[0].slug).toBe("user/old");
  });

  it("listArchived returns [] when no archive dir", async () => {
    const store = new MemoryStore(dir);
    expect(await store.listArchived()).toEqual([]);
  });

  it("restore moves back to <type>/ and re-indexes", async () => {
    const store = new MemoryStore(dir);
    await store.save(makeMemory({ slug: "user/old" }));
    await store.archive("user/old");
    const restored = await store.restore("user/old");
    expect(restored?.slug).toBe("user/old");
    expect(existsSync(path.join(dir, "user", "old.md"))).toBe(true);
    expect(existsSync(path.join(dir, "archive", "user", "old.md"))).toBe(false);
    expect((await store.loadIndex()).includes("user/old")).toBe(true);
  });

  it("restore on missing slug returns null", async () => {
    const store = new MemoryStore(dir);
    expect(await store.restore("user/ghost")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/core/src/memory/memory.test.ts`
Expected: FAIL（`archive`/`listArchived`/`restore` 未实现）

- [ ] **Step 3: 实现 archive/listArchived/restore**

`store.ts` 在 `recordUsage` 之后追加：

```ts
  /**
   * Phase 4: retire a memory to archive/<type>/ (soft-delete, recoverable).
   * The file leaves the type directory so listAll/rebuildIndex/hasChangesSince
   * no longer see it. Does NOT rebuildIndex (Dream's Prune rebuilds once).
   */
  async archive(slug: string): Promise<void> {
    for (const type of MEMORY_TYPES) {
      const src = path.join(this.dir, type, `${path.basename(slug)}.md`);
      if (!fs.existsSync(src)) continue;
      const dstDir = path.join(this.dir, "archive", type);
      await fs.promises.mkdir(dstDir, { recursive: true });
      await fs.promises.rename(src, path.join(dstDir, `${path.basename(slug)}.md`));
      return;
    }
  }

  /** Phase 4: list memories retired to archive/. */
  async listArchived(): Promise<Memory[]> {
    const archiveDir = path.join(this.dir, "archive");
    if (!fs.existsSync(archiveDir)) return [];
    const memories: Memory[] = [];
    for (const type of MEMORY_TYPES) {
      const typeDir = path.join(archiveDir, type);
      if (!fs.existsSync(typeDir)) continue;
      const files = (await fs.promises.readdir(typeDir)).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        const raw = await fs.promises.readFile(path.join(typeDir, file), "utf-8");
        memories.push(this.parse(raw, `${type}/${path.basename(file, ".md")}`, type));
      }
    }
    return memories.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /**
   * Phase 4: restore an archived memory back to its type directory and
   * rebuild the index so it re-enters recall candidates. Returns the restored
   * memory, or null if not found in archive/.
   */
  async restore(slug: string): Promise<Memory | null> {
    for (const type of MEMORY_TYPES) {
      const src = path.join(this.dir, "archive", type, `${path.basename(slug)}.md`);
      if (!fs.existsSync(src)) continue;
      const dstDir = path.join(this.dir, type);
      await fs.promises.mkdir(dstDir, { recursive: true });
      await fs.promises.rename(src, path.join(dstDir, `${path.basename(slug)}.md`));
      await this.rebuildIndex();
      return this.load(slug);
    }
    return null;
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/core/src/memory/memory.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/memory/store.ts packages/core/src/memory/memory.test.ts
git commit -m "feat(memory): add archive/listArchived/restore to MemoryStore (phase 4)"
```

---

### Task 3: recall.ts 计数埋点 + Dream 让位

**Files:**
- Modify: `packages/core/src/memory/recall.ts`
- Test: `packages/core/src/memory/recall.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `MemoryStore.recordUsage`；`DreamState`（`./dream.js`）
- Produces: `createMemoryRecallHandler` deps 加 `dreamState?: DreamState`；select 非空时计数（Dream 期间让位）

- [ ] **Step 1: 写失败测试**

在 `recall.test.ts` 的 `describe("createMemoryRecallHandler", ...)` 内追加（`fakeRecall`/`makeManager` 已存在；补 import `createMemoryDreamState`）：

```ts
import { createMemoryDreamState } from "./dream.js";

it("records usage for each recalled memory (not dreaming)", async () => {
  const mgr = makeManager();
  mgr.addUserMessage("今晚吃什么好？");
  const storeSpy = store; // spyOn recordUsage
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
  const msgs = mgr.getMessages();
  expect(msgs.some((m) => Array.isArray(m.content))).toBe(true);
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
  const spy = vi.spyOn(store, "recordUsage").mockRejectedValue(new Error("io"));
  const handler = createMemoryRecallHandler({ recall: fakeRecall(["user/food"]), store });
  await expect(handler(mgr)).resolves.toBeUndefined();
  expect(mgr.getMessages().some((m) => Array.isArray(m.content))).toBe(true); // 仍注入
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/core/src/memory/recall.test.ts`
Expected: FAIL（handler 未调 `recordUsage`、未接收 `dreamState`）

- [ ] **Step 3: 实现计数 + 让位**

`recall.ts` 顶部 import 区追加：

```ts
import type { DreamState } from "./dream.js";
```

`createMemoryRecallHandler` 签名与函数体改：

```ts
export function createMemoryRecallHandler(deps: {
  recall: MemoryRecall;
  store: MemoryStore;
  /** Phase 4: when provided and running, skip usage recording (yield to Dream). */
  dreamState?: DreamState;
}): (conversation: ConversationManager) => Promise<void> {
  const { recall, store, dreamState } = deps;
  let lastIndexContent: string | null = null;

  return async (conversation: ConversationManager) => {
    try {
      // 1. Refresh the index layer (unchanged) ...
      try {
        const indexContent = (await store.loadIndex()).trim();
        if (indexContent && indexContent !== lastIndexContent) {
          conversation.systemPrompt.addLayer({ name: "memory", priority: 5, always: false, content: indexContent });
          lastIndexContent = indexContent;
        }
      } catch { /* keep previous layer */ }

      // 2. Prune previous recall pair (unchanged) ...
      const before = conversation.getMessages();
      const pruned = pruneRecallMessages([...before]);
      if (pruned.length !== before.length) conversation.replaceMessages(pruned);

      // 3. Select (unchanged) ...
      const messages = conversation.getMessages();
      const last = messages[messages.length - 1];
      const query = last && last.role === "user" && typeof last.content === "string" ? last.content : "";
      if (!query) return;

      const memories = await recall.select(query, store);
      if (memories.length === 0) return;

      // Phase 4: 注入即计数（best-effort）。Dream 整理期间让位（同提取），
      // 避免 recordUsage 与 Dream consolidate 的写写竞态；recall 的读路径
      // （select/inject）服务用户当轮，不让位。
      if (!dreamState?.running) {
        await Promise.all(
          memories.map((m) => store.recordUsage(m.slug).catch(() => {}))
        ).catch(() => {});
      }

      const [toolUse, toolResult] = buildRecallPair(query, memories);
      conversation.replaceMessages([...conversation.getMessages(), toolUse, toolResult]);
    } catch {
      // recall is best-effort - never break the agent loop
    }
  };
}
```

> 注：保持原 handler 的步骤 1/2/3 注释与逻辑不变，仅插入计数块。实现时对照现有 `recall.ts:219-271` 替换。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/core/src/memory/recall.test.ts`
Expected: PASS（含新用例 + 既有 handler 用例）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/memory/recall.ts packages/core/src/memory/recall.test.ts
git commit -m "feat(memory): record recall usage + yield to dreaming (phase 4)"
```

---

### Task 4: dream.ts Consolidate 归档扩展

**Files:**
- Modify: `packages/core/src/memory/dream.ts`
- Test: `packages/core/src/memory/dream.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Memory.lastUsedAt`；Task 2 的 `MemoryStore.archive`
- Produces: `DreamConfig.archiveThresholdMs`；Consolidate 计算 `candidateSlugs`、prompt 带归档候选、`parseDreamResponse` 支持 `archive`（规则护栏）、op 循环调 `store.archive`

- [ ] **Step 1: 写失败测试**

在 `dream.test.ts` 追加（`makeMemory`/`MemoryStore`/`writeFileSync`/`fsExists` 等已存在；顶部 import 补 `isArchiveCandidate`）。`save(create)` 默认 `lastUsedAt=""`，需手动 seed 旧值造候选：

```ts
import { isArchiveCandidate } from "./dream.js";

/** 直接写文件把 lastUsedAt 设为旧值造归档候选（save(create) 默认 lastUsedAt=""）。 */
async function seedLastUsedAt(store: MemoryStore, slug: string, lastUsedAt: string, usageCount = 1) {
  const m = await store.load(slug);
  if (!m) return;
  const storeDir = (store as unknown as Record<string, unknown>).dir as string;
  const file = path.join(storeDir, m.type, `${path.basename(slug)}.md`);
  writeFileSync(file, [
    "---", `name: ${m.name}`, `description: ${m.description}`, `type: ${m.type}`,
    `createdAt: ${m.createdAt}`, `updatedAt: ${m.updatedAt}`,
    `usageCount: ${usageCount}`, `lastUsedAt: ${lastUsedAt}`, "---", "", m.content, "",
  ].join("\n"));
}

describe("MemoryDream consolidate archive (Phase 4)", () => {
  let memoryDir: string;
  let sessionsDir: string;
  beforeEach(() => {
    memoryDir = mkdtempSync(path.join(tmpdir(), "dream-arc-mem-"));
    sessionsDir = mkdtempSync(path.join(tmpdir(), "dream-arc-ses-"));
  });
  afterEach(() => { rmSync(memoryDir, { recursive: true, force: true }); rmSync(sessionsDir, { recursive: true, force: true }); });

  it("archives a stale candidate when LLM emits archive", async () => {
    const store = new MemoryStore(memoryDir);
    await store.save(makeMemory("user/old"));
    await seedLastUsedAt(store, "user/old", new Date(Date.now() - 35 * 86400 * 1000).toISOString());
    const dream = new MemoryDream({ minIntervalMs: 1, minNewSessions: 1, archiveThresholdMs: 30 * 86400 * 1000 });
    (dream as any).llm.chat = vi.fn()
      .mockResolvedValueOnce({ content: "[]", usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn" }) // Orient: 无怀疑
      .mockResolvedValueOnce({ content: '[{"action":"archive","slug":"user/old","reason":"长期未用"}]', usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn" }); // Consolidate: archive
    await dream.dream(store, sessionsDir, memoryDir);
    expect(await store.load("user/old")).toBeNull(); // 已移出活跃集
    expect(fsExists(path.join(memoryDir, "archive", "user", "old.md"))).toBe(true);
  });

  it("drops archive ops on non-candidate slugs (rule guard)", async () => {
    const store = new MemoryStore(memoryDir);
    await store.save(makeMemory("user/fresh"));
    await seedLastUsedAt(store, "user/fresh", new Date().toISOString()); // 刚用过，非候选
    const dream = new MemoryDream({ minIntervalMs: 1, minNewSessions: 1, archiveThresholdMs: 30 * 86400 * 1000 });
    (dream as any).llm.chat = vi.fn()
      .mockResolvedValueOnce({ content: "[]", usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn" })
      .mockResolvedValueOnce({ content: '[{"action":"archive","slug":"user/fresh","reason":"r"}]', usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn" });
    await dream.dream(store, sessionsDir, memoryDir);
    expect(await store.load("user/fresh")).not.toBeNull(); // 未被归档
  });

  it("keeps all candidates when LLM returns [] (default-keep)", async () => {
    const store = new MemoryStore(memoryDir);
    await store.save(makeMemory("user/old"));
    await seedLastUsedAt(store, "user/old", new Date(Date.now() - 40 * 86400 * 1000).toISOString());
    const dream = new MemoryDream({ minIntervalMs: 1, minNewSessions: 1, archiveThresholdMs: 30 * 86400 * 1000 });
    (dream as any).llm.chat = vi.fn()
      .mockResolvedValueOnce({ content: "[]", usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn" })
      .mockResolvedValueOnce({ content: "[]", usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn" });
    await dream.dream(store, sessionsDir, memoryDir);
    expect(await store.load("user/old")).not.toBeNull(); // 默认保留
  });

  it("isArchiveCandidate: never-used is not a candidate; stale is", async () => {
    const store = new MemoryStore(memoryDir);
    await store.save(makeMemory("user/never")); // lastUsedAt="" (默认)
    const now = Date.now();
    const all = await store.listAll();
    expect(all.filter((m) => isArchiveCandidate(m, now, 1)).map((m) => m.slug)).toEqual([]);
    await seedLastUsedAt(store, "user/never", new Date(Date.now() - 2 * 86400 * 1000).toISOString());
    const all2 = await store.listAll();
    expect(all2.filter((m) => isArchiveCandidate(m, now, 1)).map((m) => m.slug)).toEqual(["user/never"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/core/src/memory/dream.test.ts`
Expected: FAIL（`archiveThresholdMs` 不存在、Consolidate 不处理 archive）

- [ ] **Step 3: 实现归档扩展**

`dream.ts` 顶部常量区追加：

```ts
const DEFAULT_ARCHIVE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30d
```

`DreamConfig` 接口追加：

```ts
  /** Phase 4: memories unused longer than this are archive candidates. Default 30d. */
  archiveThresholdMs?: number;
```

`MemoryDream` 类：字段区加 `protected archiveThresholdMs: number;`；构造函数加 `this.archiveThresholdMs = config?.archiveThresholdMs ?? DEFAULT_ARCHIVE_THRESHOLD_MS;`。

模块级（`Suspicion` 接口附近）导出候选判定函数：

```ts
/** Phase 4: archive candidate = recalled before (lastUsedAt set) and stale. */
export function isArchiveCandidate(
  m: { lastUsedAt?: string },
  now: number,
  thresholdMs: number
): boolean {
  if (!m.lastUsedAt) return false; // 从未召回 -> 不判候选（防 recall 关闭时全量误归档）
  const lu = Date.parse(m.lastUsedAt);
  if (!lu) return false;
  return now - lu > thresholdMs;
}
```

`consolidate()` 改（计算候选、传入 prompt 与解析、op 循环加 archive 分支）：

```ts
protected async consolidate(
  store: MemoryStore,
  suspicions: Suspicion[],
  evidence: Map<string, string[]>
): Promise<void> {
  const all = await store.listAll();
  const now = Date.now();
  const candidateSlugs = new Set(
    all.filter((m) => isArchiveCandidate(m, now, this.archiveThresholdMs)).map((m) => m.slug)
  );
  const index = await store.loadIndex();
  const prompt = this.buildConsolidatePrompt(index, all, suspicions, evidence, candidateSlugs, now);
  const response = await this.withTimeout(
    this.llm.chat({
      messages: [{ role: "user", content: prompt, timestamp: new Date().toISOString() }],
      model: this.model,
      maxTokens: 2048,
      temperature: 0,
    })
  );
  const knownSlugs = new Set(all.map((m) => m.slug));
  const ops = this.parseDreamResponse(response.content, knownSlugs, candidateSlugs);
  for (const op of ops) {
    if (op.action === "delete") {
      await this.backupAndDelete(store, op.slug);
    } else if (op.action === "archive") {
      await store.archive(op.slug); // Phase 4: 软归档（可恢复），不进 .dream-backup
    } else {
      const nowIso = new Date().toISOString();
      await store.save(
        {
          slug: op.slug,
          type: op.type as MemoryType,
          name: op.name!,
          description: op.description!,
          content: op.content!,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        op.action as MemoryAction
      );
    }
  }
}
```

`buildConsolidatePrompt` 签名加 `candidateSlugs: Set<string>, now: number`，在 "Evidence" 区之后、"Instructions" 之前插入归档候选区块，并在 Rules 末尾追加 archive 规则：

```ts
private buildConsolidatePrompt(
  indexContent: string,
  all: readonly Memory[],
  suspicions: Suspicion[],
  evidence: Map<string, string[]>,
  candidateSlugs: Set<string>,
  now: number
): string {
  const memParts: string[] = [];
  if (indexContent) memParts.push(indexContent.trim());
  for (const m of all) memParts.push(`### ${m.slug}\ncontent:\n${m.content}`);
  const suspText = suspicions.map((s) => `- ${s.slug}: ${s.reason}`).join("\n") || "(无)";
  const eviText = [...evidence.entries()].map(([slug, snips]) => `### ${slug}\n${snips.join("\n---\n")}`).join("\n\n") || "(无证据)";
  const candText =
    all
      .filter((m) => candidateSlugs.has(m.slug))
      .map((m) => {
        const ageDays = Math.floor((now - Date.parse(m.lastUsedAt!)) / 86_400_000);
        return `- ${m.slug} | usageCount=${m.usageCount ?? 0} | lastUsedAt=${m.lastUsedAt} | 已 ${ageDays} 天未用`;
      })
      .join("\n") || "(无)";
  return [
    "You are performing a dream - consolidate the memory system based on evidence.",
    "",
    "## Existing memories (index + full content)", memParts.join("\n\n"),
    "", "## Suspicions from Orient", suspText,
    "", "## Evidence gathered from recent sessions", eviText,
    "", "## Archive candidates（长期未被召回，归档候选）", candText,
    "", "## Instructions",
    "基于证据整理记忆，输出 JSON 数组（无改动则 []）：",
    '[{"action":"create|update|append|delete|archive","slug":"<type>/<kebab-case>","type":"user|feedback|project|reference","name":"简短名称","description":"一句话描述","content":"完整正文"}]',
    "",
    "Rules:",
    "- create：新主题；update：改写已有文件正文；append：向已有文件补充新段落；delete：删除整条失效/被合并的记忆文件",
    "- delete 项用 reason 字段说明删除理由（不需 content）",
    "- archive：把"归档候选"中确已长期无用、可安全退出活跃集的记忆移入归档区（可恢复）。只可作用于上面的归档候选；非候选不要 archive。用 reason 说明理由（不需 content）",
    "- 对归档候选，若仍明显相关/可能再用，则不输出（保留默认）；只对确应退役的输出 archive",
    "- 新信息与现有记忆矛盾时，用 update 重写或 delete 删除，禁止矛盾并存",
    "- 优先把新信息合并进已有 topic 文件，避免创建重复文件",
    "- 把\"昨天\"\"上周\"等相对日期转换为绝对日期",
    "- 遵守 user/feedback/project/reference 四分类与\"What NOT to save\"",
    "- 只使用上述证据中的内容；不要臆测",
  ].join("\n");
}
```

`parseDreamResponse` 签名加 `candidateSlugs: Set<string>`，在 delete 分支与 MEMORY_ACTIONS 分支之间插入 archive 分支：

```ts
private parseDreamResponse(
  raw: string,
  knownSlugs: Set<string>,
  candidateSlugs: Set<string>
): Array<{ action: string; slug: string; type?: string; name?: string; description?: string; content?: string; reason?: string }> {
  try {
    let json = raw.trim();
    const fence = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fence) json = fence[1].trim();
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    const out: Array<{ action: string; slug: string; type?: string; name?: string; description?: string; content?: string; reason?: string }> = [];
    for (const item of parsed) {
      if (!item || typeof item.action !== "string" || typeof item.slug !== "string") continue;
      if (item.action === "delete") {
        if (knownSlugs.has(item.slug)) {
          out.push({ action: "delete", slug: item.slug, reason: typeof item.reason === "string" ? item.reason : "" });
        }
      } else if (item.action === "archive") {
        // 规则护栏：只接受程序识别的候选 slug（防幻觉归档新/常用记忆）
        if (candidateSlugs.has(item.slug)) {
          out.push({ action: "archive", slug: item.slug, reason: typeof item.reason === "string" ? item.reason : "" });
        }
      } else if (
        MemoryDream.MEMORY_ACTIONS.includes(item.action) &&
        typeof item.type === "string" && ["user", "feedback", "project", "reference"].includes(item.type) &&
        item.slug.startsWith(`${item.type}/`) &&
        typeof item.name === "string" && typeof item.description === "string" && typeof item.content === "string"
      ) {
        out.push({ action: item.action, slug: item.slug, type: item.type, name: item.name, description: item.description, content: item.content });
      }
    }
    return out;
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/core/src/memory/dream.test.ts`
Expected: PASS（新用例 + 既有 Dream 用例。既有 consolidate 用例的 mock 只返回 2 次（orient+consolidate），archive 候选为空时不影响）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/memory/dream.ts packages/core/src/memory/dream.test.ts
git commit -m "feat(memory): extend Dream consolidate with usage-driven archive (phase 4)"
```

---

### Task 5: /memory restore + archive 命令 + core 导出

**Files:**
- Modify: `packages/core/src/extensions/commands/builtin/memory.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/extensions/commands/builtin.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `MemoryStore.archive`/`listArchived`/`restore`
- Produces: `memoryCommand` 路由加 `restore`/`archive`；`memoryRestoreCommand` / `memoryArchiveCommand`；core 导出两者

- [ ] **Step 1: 写失败测试**

在 `builtin.test.ts` 追加（顶部 import 补 `memoryRestoreCommand`；补 `mkdtempSync`/`rmSync`/`tmpdir`/`path`/`MemoryStore`）：

```ts
import { memoryRestoreCommand, memoryArchiveCommand } from "./builtin/memory.js";
import { MemoryStore } from "../../../memory/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

describe("memory-restore command", () => {
  it("errors when no slug provided", async () => {
    const result = await memoryRestoreCommand.execute([], mockContext());
    expect(result.type).toBe("error");
    expect((result as { message: string }).message).toContain("使用方式");
  });

  it("errors when slug not in archive", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mem-cmd-"));
    try {
      const result = await memoryRestoreCommand.execute(["user/ghost"], mockContext({ workingDirectory: dir }));
      expect(result.type).toBe("error");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("restores an archived memory", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mem-cmd-"));
    try {
      const store = new MemoryStore(`${dir}/.licode/memory`);
      await store.save({ slug: "user/x", type: "user", name: "X", description: "d", content: "c", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" });
      await store.archive("user/x");
      const result = await memoryRestoreCommand.execute(["user/x"], mockContext({ workingDirectory: dir }));
      expect(result.type).toBe("action");
      expect(await store.load("user/x")).not.toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("memory-archive command", () => {
  it("lists archived memories (empty message when none)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mem-arc-cmd-"));
    try {
      const result = await memoryArchiveCommand.execute([], mockContext({ workingDirectory: dir }));
      expect(result.type).toBe("action");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/core/src/extensions/commands/builtin.test.ts`
Expected: FAIL（`memoryRestoreCommand`/`memoryArchiveCommand` 未导出）

- [ ] **Step 3: 实现命令 + 导出**

`memory.ts`：在 `listMemories` 旁加 `listArchivedMemories` 辅助；`memoryCommand` 路由加 `restore`/`archive` 分支；末尾加两个独立命令；更新 `errorUnknown` 提示。

```ts
async function listArchivedMemories(store: MemoryStore): Promise<string> {
  const entries = await store.listArchived();
  if (entries.length === 0) return "📦 没有已归档的记忆。";
  const lines = entries.map((m) => {
    const preview = m.content.length > 60 ? m.content.slice(0, 60) + "..." : m.content;
    return `  [${m.slug}] ${m.name}: ${preview}`;
  });
  return `📦 已归档记忆 (${entries.length}):\n${lines.join("\n")}`;
}
```

`memoryCommand.execute` 在 `delete` 分支后、`return errorUnknown()` 前追加：

```ts
    if (sub === "restore") {
      const slug = args[1];
      if (!slug) return { type: "error", message: "使用方式: /memory-restore <slug>" };
      const store = getStore(context);
      const existing = await store.restore(slug);
      if (!existing) return { type: "error", message: `归档中未找到记忆 "${slug}"。` };
      return { type: "action", message: `♻️ 已恢复记忆 [${slug}]: ${existing.name}` };
    }
    if (sub === "archive") {
      return { type: "action", message: await listArchivedMemories(getStore(context)) };
    }
```

`errorUnknown` 提示更新为：

```ts
  message: "未知子命令。使用: /memory-list | /memory-add <内容> | /memory-delete <slug> | /memory-archive | /memory-restore <slug>",
```

文件末尾追加独立命令（照抄 `memoryDeleteCommand` 模式）：

```ts
// ── /memory-archive ──────────────────────────────────────────────────

export const memoryArchiveCommand: SlashCommand = {
  name: "memory-archive",
  description: "列出已归档记忆",
  async execute(_args, context) {
    return { type: "action", message: await listArchivedMemories(getStore(context)) };
  },
};

// ── /memory-restore ──────────────────────────────────────────────────

export const memoryRestoreCommand: SlashCommand = {
  name: "memory-restore",
  description: "从归档恢复记忆",
  async execute(args, context) {
    const slug = args[0];
    if (!slug) return { type: "error", message: "使用方式: /memory-restore <slug>" };
    const store = getStore(context);
    const existing = await store.restore(slug);
    if (!existing) return { type: "error", message: `归档中未找到记忆 "${slug}"。` };
    return { type: "action", message: `♻️ 已恢复记忆 [${slug}]: ${existing.name}` };
  },
};
```

`index.ts` memory 命令导出行追加：

```ts
export { memoryCommand, memoryListCommand, memoryAddCommand, memoryDeleteCommand, memoryArchiveCommand, memoryRestoreCommand } from "./extensions/commands/builtin/memory.js";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/core/src/extensions/commands/builtin.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/extensions/commands/builtin/memory.ts packages/core/src/index.ts packages/core/src/extensions/commands/builtin.test.ts
git commit -m "feat(memory): add /memory-archive and /memory-restore commands (phase 4)"
```

---

### Task 6: CLI 接线--传 dreamState 给 recall handler + 重排 ref

**Files:**
- Modify: `packages/cli/src/hooks.ts`

**Interfaces:**
- Consumes: Task 3 的 `createMemoryRecallHandler({..., dreamState})`
- Produces: recall handler 在 Dream 期间让位计数；无新 state/hook

- [ ] **Step 1: 改接线（无独立单测，由 Task 7 全量回归 + 手工验收覆盖）**

`hooks.ts`：把 `memoryDreamStateRef` 声明**挪到** `memoryRecallHandlerRef` 之前（ref 对象 identity 稳定，挪位不影响 Dream hook 已有的引用），并给 `createMemoryRecallHandler` 传 `dreamState`。

改后该段（对照现有 `hooks.ts:233-255`）：

```ts
  // Phase 3: dream consolidation (after:agentLoop, fire-and-forget).
  // Shared with the extraction hook AND the recall handler (yield-while-dreaming).
  const memoryDreamStateRef = useRef<DreamState>(createMemoryDreamState());
  // Phase 2: per-turn memory recall (side query -> synthetic tool_call pair).
  // Phase 4: dreamState passed in so recordUsage yields while dreaming.
  const memoryRecallHandlerRef = useRef(
    createMemoryRecallHandler({
      recall: new MemoryRecall({ apiKey, baseUrl, model }),
      store: memoryStoreRef.current,
      dreamState: memoryDreamStateRef.current,
    })
  );
  const dreamMemoryDir = path.join(process.cwd(), ".licode", "memory");
  const dreamSessionsDir = path.join(process.cwd(), ".licode", "sessions");
  const memoryDreamHookRef = useRef(
    process.env.LICODE_MEMORY_DREAM === "off"
      ? null
      : createMemoryDreamHook({
          dream: new MemoryDream({ apiKey, baseUrl, model }),
          store: memoryStoreRef.current,
          state: memoryDreamStateRef.current,
          sessionsDir: dreamSessionsDir,
          memoryDir: dreamMemoryDir,
          onStateChange: setIsDreaming,
        })
  );
```

> 注：`DreamState` 类型已在现有 import 中（Phase 3 接线已 import）。`memoryDreamStateRef` 挪位后，下方 `createMemoryExtractionHook(..., memoryDreamStateRef.current)` 与 `createMemoryDreamHook(... state: memoryDreamStateRef.current ...)` 的引用不变，仍指向同一稳定对象。

- [ ] **Step 2: 验证 CLI 编译**

Run: `pnpm --filter @licode/cli build`
Expected: 编译通过（TS 无“used before declaration”报错--`memoryDreamStateRef` 已在 `memoryRecallHandlerRef` 之前声明）

- [ ] **Step 3: 提交**

```bash
git add packages/cli/src/hooks.ts
git commit -m "feat(cli): pass dreamState to recall handler for usage yield (phase 4)"
```

---

### Task 7: 构建 + 全量回归 + 手工验收

**Files:** 无（仅构建/测试/验证）

- [ ] **Step 1: 全量构建**

```bash
pnpm -r build
ls packages/core/dist/memory/store.js packages/core/dist/memory/recall.js packages/core/dist/memory/dream.js
```
Expected: 构建通过；dist 含三个文件

- [ ] **Step 2: 全量回归**

```bash
npx vitest run packages/core/src/memory packages/core/src/agent packages/core/src/extensions/commands
npm test
```
Expected: 全部通过（含 Phase 4 新用例 + Phase 1/2/3 既有用例）

- [ ] **Step 3: 手工验收（对应设计规格 §4）**

```bash
npm start
# 先用对话或 /memory-add 积累若干记忆，并跨若干 session
```

| # | 操作 | 预期 |
|---|---|---|
| 1 | 问能命中已有记忆的问题（如"今晚吃什么好？"命中食物偏好） | 该记忆文件 frontmatter `usageCount` +1、`lastUsedAt`=今天 |
| 2 | 紧接着问一个无关问题（应触发提取） | 后台提取**正常执行**（日志可见，未被"主 Agent 已写"误跳过--mtime 隐身生效） |
| 3 | 手动把某记忆 `lastUsedAt` 改为 35 天前，触发 Dream（调小 `minIntervalMs`/`minNewSessions` 或写旧 `.dream.state`） | Dream 后该记忆移入 `archive/<type>/`、从 MEMORY.md 与 `/memory-list` 消失 |
| 4 | 一个 `lastUsedAt` 为空（从未召回）的旧记忆 | Dream 后**不被**热度归档 |
| 5 | Dream 复核：候选中一个仍相关、一个陈旧 | 只陈旧者被归档 |
| 6 | `/memory-archive` -> 列出归档；`/memory-restore <slug>` | 记忆回到活跃集、回索引、可被 recall 选中 |
| 7 | `LICODE_MEMORY_RECALL=off npm start`，触发 Dream | 不计数、无归档候选、不归档 |
| 8 | `LICODE_MEMORY_DREAM=off npm start` | 不整理、不归档；recall 计数仍工作 |
| 9 | Dream 期间（"🌙 整理中"卡片显示时）问能命中记忆的问题 | 召回合成对仍注入（读路径不让位）；该记忆 `usageCount` **不+1**（让位） |
| 10 | Dream 失败（断网/无效 apiKey） | 不归档、不更新 `lastConsolidatedAt`、错误写 `.licode/logs/dream.log` |
| 11 | `npm test` | 全部通过 |

- [ ] **Step 4: 收尾提交 + push**

如验收中发现并修复了问题，修复单独提交；全部通过后 push 分支并更新 PR：

```bash
git push -u origin worktree-memory-system-redesign
# 更新 PR 描述，附 phase 4 设计 + 实现计划文档链接
```

---

## 风险与注意点

1. **utimes 是缓解不是根因消除**：`recordUsage` 写后恢复 mtime 对 `hasChangesSince` 隐身；若 `utimes` 系统性失败（极罕见，文件刚写过、本进程持有）且 recall 每轮都跑，坑会重新打开（提取每轮被跳）。单次失败最多误跳一轮、下轮自愈。根因修法（hash 检测 / sidecar）已在设计 §5 否决（spec 对齐 + 轻量）。验收 #2 专门回归此点。
2. **`save()` 现在写出 usage 行**：既有 store 测试多用 `toContain`，不受影响；若有精确 frontmatter 行匹配的用例，补上 `usageCount`/`lastUsedAt` 行。Task 1 Step 4 已提示。
3. **Dream 既有 consolidate 测试的 mock 次数**：Task 4 改了 `buildConsolidatePrompt`/`parseDreamResponse` 签名，但既有 Dream 测试的 mock 仍只 orient+consolidate 两次，候选为空时 archive 分支不触发，应仍通过。若既有测试直接调 `buildConsolidatePrompt`/`parseDreamResponse`（私有方法 via `as any`），需补 `candidateSlugs`/`now` 实参。
4. **`memoryDreamStateRef` 重排**：Task 6 把它挪到 `memoryRecallHandlerRef` 之前。必须确认下方所有引用（提取 hook 第 5 参、Dream hook 的 `state`）仍指向同一对象--ref 的 `.current` identity 稳定，挪位不影响。TS 会报“used before declaration”若顺序错，编译期可捕获。
5. **归档候选只认 `lastUsedAt`**：从未召回的记忆（`lastUsedAt=""`）永不为候选，即使 `createdAt` 很旧。这是刻意（防 recall 关闭全量误归档；从未召回的垃圾交 Phase 3 内容审查 delete）。验收 #4 覆盖。
6. **`archive` 与 `delete` 同批**：LLM 可能对同一 slug 既输出 delete 又输出 archive。op 循环顺序处理：若 delete 先跑，文件已删，随后的 archive 找不到文件 -> `store.archive` no-op。无害。
7. **Dream 期间 recall 读到半整理状态**：Dream 的 consolidate 写文件中途，recall 的 `select`/`loadIndex` 可能读到中间态。仅影响当轮召回质量（best-effort，降级为 `[]`），下轮读最终态。可接受，与 Phase 3 既定一致。
8. **`recordUsage` 与主 Agent 直接 Write 同轮竞态**：recordUsage 在 `onTurnStart` 先落盘，主 Agent 在 LLM 循环中后写覆盖 frontmatter（不带 usage 字段）-> 该记忆 usage 重置为 0/""。罕见（本轮改写刚召回的记忆），属 Phase 1"直接 Write 绕过 save 语义"同类折衷。design §2.6 已记。
9. **测试隔离**：`memory.test.ts`/`dream.test.ts`/`recall.test.ts` 用 tmpdir + afterEach 清理；`vi.mock("../llm/anthropic.js")`（recall/dream）。命令测试用 `mockContext({ workingDirectory: tmpdir })` + 独立 `MemoryStore` 验证。
10. **dist 构建**：Task 7 必须构建--CLI 跑的是 `packages/cli/dist`，core 改动需 `packages/core/dist` 更新生效。

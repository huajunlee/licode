# 记忆检索元数据质量优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让记忆的"检索画像 {type, description, keywords}"在写入时准确可校验、在召回时被用好 -- 治类型选择松(A)+ description 召回瓶颈(B)。

**Architecture:** 写入侧为主:extractor/dream prompt 加类型决策树 + description/keywords 指导;`save()` 加 `validateMemory()` 校验(枚举拒绝 / feedback 缺 Why-How 降级 user),主 Agent 直写路径经 `normalizeChangedSince` 同步校验。读取侧最小改:recall 在 `select()` 内从 `listAll()` 构造富索引(description+keywords+正文首行)喂 side-query,**MEMORY.md 全程不改**。分期 A 先 B 后。

**Tech Stack:** TypeScript, Node.js, pnpm monorepo, Vitest, Anthropic-compatible LLM (deepseek-chat 默认)。

## Global Constraints

- 四类型固定:`user | feedback | project | reference`(见 `packages/core/src/memory/types.ts:1`)。
- feedback 结构契约:content 必含 `Why:` 与 `How to apply:` 子串(缺则降级 user)。
- MEMORY.md 索引格式 `- [name](slug.md) - description` **全程不改**;富索引是 recall 内部构造。
- `keywords` 是 per-memory 检索键(新),与 `dream.ts` 既有 suspicion keywords(漂移线索词)是不同概念,代码注释须消歧义。
- 测试用 Vitest;store 测试用 `mkdtempSync` 临时目录;LLM 用 `vi.mock("../llm/anthropic.js")`。
- 提交信息用 conventional commits(`feat(memory):` / `fix(memory):` / `docs(guide):`)。
- 每个 Task 结束 commit;Phase A 全部完成后再进 Phase B。

---

## File Structure

| 文件 | 责任 | 阶段 |
|---|---|---|
| `packages/core/src/memory/types.ts` | `Memory` 接口;加 `keywords?: string[]` | B |
| `packages/core/src/memory/store.ts` | 存储;加 `validateMemory()` 共享校验;`save()`/`normalizeChangedSince`/`recordUsage` 接校验 + keywords frontmatter | A+B |
| `packages/core/src/memory/extractor.ts` | 后台提取 prompt;加类型决策树 + description 指导 + keywords 产出 | A+B |
| `packages/core/src/memory/dream.ts` | dream consolidate prompt + `parseDreamResponse`;加决策树 + keywords | A+B |
| `packages/core/src/memory/recall.ts` | 召回;`select()` 构造富索引 + prompt 适配 | B |
| `packages/core/src/conversation/templates/memory-guide.md` | 主 Agent 指引;加决策树 + keywords 模板 + description 指导 | A+B |
| `packages/core/src/memory/memory.test.ts` | store 单测(枚举/降级/keywords) | A+B |
| `packages/core/src/memory/extractor.test.ts` | 提取 prompt 单测 | A+B |
| `packages/core/src/memory/dream.test.ts` | dream 单测(keywords 解析) | B |
| `packages/core/src/memory/recall.test.ts` | 召回单测(富索引构造) | B |

---

# Phase A:类型选择(soft 决策树 + hard 校验)

## Task A1:`validateMemory()` 共享校验纯函数

**Files:**
- Modify: `packages/core/src/memory/store.ts`(新增导出函数)
- Test: `packages/core/src/memory/memory.test.ts`

**Interfaces:**
- Produces: `validateMemory(memory: Memory): { ok: boolean; type: MemoryType; slug: string }` -- `ok:false` 表示枚举违规(调用方拒绝写);`type`/`slug` 可能被纠正(feedback->user 降级)。

- [ ] **Step 1: 写失败测试**

在 `memory.test.ts` 顶部 import 区加 `validateMemory`,新增 describe:

```typescript
import { MemoryStore, validateMemory } from "./store.js";

describe("validateMemory", () => {
  const base: Memory = {
    slug: "user/x", type: "user", name: "n", description: "d",
    content: "c", createdAt: "2026-08-04T00:00:00.000Z", updatedAt: "2026-08-04T00:00:00.000Z",
  };

  it("rejects type not in the four valid types", () => {
    const r = validateMemory({ ...base, type: "foo" as Memory["type"] });
    expect(r.ok).toBe(false);
  });

  it("passes a valid user memory unchanged", () => {
    const r = validateMemory(base);
    expect(r).toEqual({ ok: true, type: "user", slug: "user/x" });
  });

  it("downgrades feedback missing Why:/How to apply: to user (slug prefix fixed)", () => {
    const r = validateMemory({ ...base, type: "feedback", slug: "feedback/use-pnpm", content: "用 pnpm" });
    expect(r.ok).toBe(true);
    expect(r.type).toBe("user");
    expect(r.slug).toBe("user/use-pnpm");
  });

  it("keeps feedback that has both Why: and How to apply: as feedback", () => {
    const r = validateMemory({
      ...base, type: "feedback", slug: "feedback/use-pnpm",
      content: "用 pnpm\nWhy: 用户要求\nHow to apply: 安装时用 pnpm",
    });
    expect(r).toEqual({ ok: true, type: "feedback", slug: "feedback/use-pnpm" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @licode/core exec vitest run packages/core/src/memory/memory.test.ts -t "validateMemory"`
Expected: FAIL(`validateMemory` 未导出)。

- [ ] **Step 3: 实现**

在 `store.ts` 顶部 `MEMORY_TYPES` 之后加导出函数:

```typescript
export interface ValidationResult {
  ok: boolean;
  type: MemoryType;
  slug: string;
}

/**
 * 校验记忆的类型与 feedback 结构契约。共享给 save() 与 normalizeChangedSince()。
 * - type 不在四类 -> ok:false(调用方拒绝写,不建脏目录)。
 * - type=feedback 但 content 不含 Why: 或 How to apply: -> 降级 user(同步 slug 前缀)。
 * 注意:这里的 keywords 校验与 dream.ts 的 suspicion keywords 无关(那是漂移线索词)。
 */
export function validateMemory(memory: Memory): ValidationResult {
  if (!MEMORY_TYPES.includes(memory.type)) {
    return { ok: false, type: memory.type, slug: memory.slug };
  }
  if (
    memory.type === "feedback" &&
    !(memory.content.includes("Why:") && memory.content.includes("How to apply:"))
  ) {
    return { ok: true, type: "user", slug: memory.slug.replace(/^feedback\//, "user/") };
  }
  return { ok: true, type: memory.type, slug: memory.slug };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @licode/core exec vitest run packages/core/src/memory/memory.test.ts -t "validateMemory"`
Expected: PASS(4 用例)。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/store.ts packages/core/src/memory/memory.test.ts
git commit -m "feat(memory): add validateMemory() shared type/feedback validator"
```

---

## Task A2:`save()` 接入 validateMemory(枚举拒绝 + feedback 降级)

**Files:**
- Modify: `packages/core/src/memory/store.ts:46-122`(`save()` 方法)
- Test: `packages/core/src/memory/memory.test.ts`

**Interfaces:**
- Consumes: `validateMemory()`(Task A1)。
- Produces: `save()` 写入前校验;枚举违规 -> 记日志 + 不写;feedback 降级 -> 用纠正后的 type/slug 写。

- [ ] **Step 1: 写失败测试**

在 `memory.test.ts` 的 `MemoryStore (new API)` describe 内加:

```typescript
it("save() skips a memory with invalid type and does not create a dir", async () => {
  dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
  const store = new MemoryStore(dir);
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  await store.save({ ...makeMemory(), type: "bogus" as Memory["type"], slug: "bogus/x" });
  expect(spy).toHaveBeenCalled();
  expect(existsSync(path.join(dir, "bogus"))).toBe(false);
  spy.mockRestore();
});

it("save() downgrades feedback missing Why/How to user (writes to user/ dir)", async () => {
  dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
  const store = new MemoryStore(dir);
  await store.save({
    ...makeMemory(),
    type: "feedback", slug: "feedback/use-pnpm",
    content: "用 pnpm 而非 npm",
  });
  expect(existsSync(path.join(dir, "feedback", "use-pnpm.md"))).toBe(false);
  expect(existsSync(path.join(dir, "user", "use-pnpm.md"))).toBe(true);
  const raw = readFileSync(path.join(dir, "user", "use-pnpm.md"), "utf-8");
  expect(raw).toContain("type: user");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @licode/core exec vitest run packages/core/src/memory/memory.test.ts -t "save"`
Expected: FAIL(当前 save 不校验,会建 `bogus/` 目录、写 `feedback/`)。

- [ ] **Step 3: 实现**

改 `save()` 开头(`store.ts:46-50`),在算 `typeDir` 前插入校验:

```typescript
async save(memory: Memory, action: MemoryAction = "create"): Promise<void> {
  const vr = validateMemory(memory);
  if (!vr.ok) {
    console.warn(`[memory] rejected invalid type "${memory.type}" for slug "${memory.slug}"`);
    return;
  }
  // 用校验/降级后的 type 与 slug(降级时 feedback/ -> user/)
  const type = vr.type;
  const slug = vr.slug;
  const typeDir = path.join(this.dir, type);
  await fs.promises.mkdir(typeDir, { recursive: true });

  const filePath = path.join(typeDir, `${path.basename(slug)}.md`);
  const exists = fs.existsSync(filePath);
  // ... 后续 effectiveAction/finalContent 逻辑不变,但 frontmatter 用 `type: ${type}`
```

注意:`save()` 后续 frontmatter(108 行 `type: ${memory.type}`)改为 `type: ${type}`;`memory.slug` 相关引用改为 `slug`。其余 createdAt/updatedAt/usageCount 逻辑不动。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @licode/core exec vitest run packages/core/src/memory/memory.test.ts`
Expected: PASS(含新 2 用例 + 既有全过)。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/store.ts packages/core/src/memory/memory.test.ts
git commit -m "feat(memory): save() rejects invalid type, downgrades feedback missing Why/How"
```

---

## Task A3:`normalizeChangedSince` 接入校验(主 Agent 直写路径)

**Files:**
- Modify: `packages/core/src/memory/store.ts:247-291`
- Test: `packages/core/src/memory/memory.test.ts`

**Interfaces:**
- Consumes: `validateMemory()`(Task A1)。
- Produces: 主 Agent 直写的文件也被校验;enum 违规记日志跳过;feedback 缺结构降级(移到 user/ + 改 frontmatter type)。

- [ ] **Step 1: 写失败测试**

```typescript
it("normalizeChangedSince downgrades an agent-written feedback file (missing Why/How) to user/", async () => {
  dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
  const fbPath = path.join(dir, "feedback", "use-pnpm.md");
  mkdirSync(path.join(dir, "feedback"), { recursive: true });
  writeFileSync(fbPath, [
    "---", "name: 用pnpm", "description: d", "type: feedback",
    "createdAt: 2026-08-04T00:00:00.000Z", "updatedAt: 2026-08-04T00:00:00.000Z",
    "---", "", "用 pnpm 而非 npm", "",
  ].join("\n"));
  const ts = Date.now() - 1000;
  const store = new MemoryStore(dir);
  await store.normalizeChangedSince(ts);
  expect(existsSync(fbPath)).toBe(false);
  expect(existsSync(path.join(dir, "user", "use-pnpm.md"))).toBe(true);
  const raw = readFileSync(path.join(dir, "user", "use-pnpm.md"), "utf-8");
  expect(raw).toContain("type: user");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @licode/core exec vitest run packages/core/src/memory/memory.test.ts -t "normalizeChangedSince downgrades"`
Expected: FAIL(当前只做日期归一化,不降级)。

- [ ] **Step 3: 实现**

在 `normalizeChangedSince` 的 `const m = this.parse(...)`(261 行)之后、日期归一化之前插入校验,降级时改写 type 并移动文件:

```typescript
const m = this.parse(raw, slug, type);
const vr = validateMemory(m);
if (!vr.ok) {
  console.warn(`[memory] normalizeChangedSince: skipped invalid type "${m.type}" at ${file}`);
  continue;
}
const targetType = vr.type;
const targetSlug = vr.slug;
const targetDir = path.join(this.dir, targetType);
const targetPath = path.join(targetDir, `${path.basename(targetSlug)}.md`);
const name = normalizeDates(m.name, now);
const description = normalizeDates(m.description, now);
const content = normalizeDates(m.content, now);
// 无日期变化且未降级 -> 跳过
const unchanged = name === m.name && description === m.description && content === m.content && targetType === type;
if (unchanged) continue;
await fs.promises.mkdir(targetDir, { recursive: true });
const frontmatter = [
  "---", `name: ${name}`, `description: ${description}`, `type: ${targetType}`,
  `createdAt: ${m.createdAt}`, `updatedAt: ${m.updatedAt}`,
  `usageCount: ${m.usageCount ?? 0}`, `lastUsedAt: ${m.lastUsedAt ?? ""}`, `pinned: ${m.pinned ?? false}`,
  "---", "", content, "",
].join("\n");
await fs.promises.writeFile(targetPath, frontmatter, "utf-8");
if (targetPath !== filePath) await fs.promises.unlink(filePath).catch(() => {});
await fs.promises.utimes(targetPath, atimeMs / 1000, mtimeMs / 1000).catch(() => {});
```

(替换原 262-285 的纯日期归一化块;`continue`/`catch` 结构保留。)

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @licode/core exec vitest run packages/core/src/memory/memory.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/store.ts packages/core/src/memory/memory.test.ts
git commit -m "feat(memory): normalizeChangedSince validates agent-written memories (feedback downgrade)"
```

---

## Task A4:extractor prompt 加类型决策树

**Files:**
- Modify: `packages/core/src/memory/extractor.ts:271-282`(`buildPrompt` 的 Instructions/Rules)
- Test: `packages/core/src/memory/extractor.test.ts`

**Interfaces:**
- Produces: 提取 prompt 含四类决策树定义;LLM 产出更准的 type。

- [ ] **Step 1: 写失败测试(断言 prompt 含决策树)**

在 `extractor.test.ts` 加(用 mock 捕获 prompt):

```typescript
describe("MemoryExtractor prompt", () => {
  it("buildPrompt contains the type decision tree (feedback first, user fallback)", async () => {
    const chat = vi.fn().mockResolvedValue({ content: "[]" });
    vi.mocked(AnthropicProvider).mockImplementation(() => ({ name: "m", maxContextTokens: 200000, chat, stream: vi.fn(), countTokens: vi.fn(() => 0) }) as any);
    const store = new MemoryStore(mkdtempSync(path.join(tmpdir(), "licode-mem-")));
    const ext = new MemoryExtractor();
    await ext.extract(
      [{ role: "user", content: "以后都用 pnpm", timestamp: "2026-08-04T00:00:00.000Z" }] as any,
      store
    );
    const prompt = chat.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("feedback");
    expect(prompt).toContain("reference");
    expect(prompt).toContain("project");
    expect(prompt).toMatch(/feedback.*reference.*project.*user/s); // 决策顺序
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @licode/core exec vitest run packages/core/src/memory/extractor.test.ts -t "type decision tree"`
Expected: FAIL(当前 prompt 只列名字,不含定义/顺序)。

- [ ] **Step 3: 实现**

在 `extractor.ts` `buildPrompt` 的 Rules(274 行起)替换/追加。把 272 行输出格式后、Rules 里加类型判别块:

```typescript
"类型判别(按顺序,命中即停):",
"1. feedback - 用户明确纠正/确认过的协作方式,content 必含 Why: 与 How to apply:",
"2. reference - 外部系统入口(看板/频道/URL/账号)",
"3. project - 代码与 git 推导不出的项目背景/决策/截止日期",
"4. user - 兜底(用户是谁:角色/经验/偏好/目标)",
```

(保留既有 277 行 feedback Why/How 规则,它与判别 1 一致;保留 278 不要保存规则。)

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @licode/core exec vitest run packages/core/src/memory/extractor.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/extractor.ts packages/core/src/memory/extractor.test.ts
git commit -m "feat(memory): extractor prompt adds type decision tree (feedback->reference->project->user)"
```

---

## Task A5:dream consolidate prompt 加决策树

**Files:**
- Modify: `packages/core/src/memory/dream.ts:361-371`(`buildConsolidatePrompt` Rules)

**Interfaces:**
- Produces: dream 整理也按决策树判型(与 extractor 一致)。

- [ ] **Step 1: 写失败测试**

在 `dream.test.ts` 加(捕获 consolidate prompt):

```typescript
it("consolidate prompt contains the type decision tree", () => {
  // 构造一个 dream 实例,调用其 buildConsolidatePrompt(或等价私有方法经 runConsolidation 捕获)
  // 断言 prompt 含 "feedback" / "reference" / "project" / "user" 决策顺序
  expect(prompt).toMatch(/feedback.*reference.*project.*user/s);
});
```

> 注:`buildConsolidatePrompt` 若为私有,按 `dream.test.ts` 既有方式(经 mock chat 捕获)暴露;若既有测试已捕获 consolidate prompt,直接在该用例加断言。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @licode/core exec vitest run packages/core/src/memory/dream.test.ts -t "type decision tree"`
Expected: FAIL。

- [ ] **Step 3: 实现**

在 `dream.ts` `buildConsolidatePrompt` 的 Rules(363 行起)加与 Task A4 相同的"类型判别(按顺序)"五块(替换 370 行那条"遵守四分类"为展开的决策树)。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @licode/core exec vitest run packages/core/src/memory/dream.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/dream.ts packages/core/src/memory/dream.test.ts
git commit -m "feat(memory): dream consolidate prompt adds type decision tree"
```

---

## Task A6:memory-guide.md 加决策树(主 Agent 也按此写)

**Files:**
- Modify: `packages/core/src/conversation/templates/memory-guide.md:15-23`

- [ ] **Step 1: 改文档**

把 `memory-guide.md` 的"## 记忆类型"段落改为决策顺序表述(与 Task A4 一致),保留各类型说明,补一句"按顺序判别:先 feedback(纠正/确认协作,必含 Why/How)-> reference(外部入口)-> project(项目背景)-> 兜底 user"。

- [ ] **Step 2: 跑相关测试**

Run: `pnpm --filter @licode/core exec vitest run packages/core/src/conversation/memory-guide.test.ts`
Expected: PASS(既有测试不依赖具体措辞)。

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/conversation/templates/memory-guide.md
git commit -m "docs(guide): memory-guide adds type decision tree"
```

---

# Phase B:description + keywords + 富索引

## Task B1:keywords 字段(types + store 读写)

**Files:**
- Modify: `packages/core/src/memory/types.ts`(`Memory` 接口)
- Modify: `packages/core/src/memory/store.ts`(`parse()` + 三处 frontmatter 写:`save` 104-118、`normalizeChangedSince` 266-280、`recordUsage` 315-328)
- Test: `packages/core/src/memory/memory.test.ts`

**Interfaces:**
- Produces: `Memory.keywords?: string[]`;`save()` 写 `keywords:` frontmatter 行;`parse()` 读回(容错)。

- [ ] **Step 1: 写失败测试**

```typescript
it("save() writes keywords frontmatter and load() reads them back", async () => {
  dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
  const store = new MemoryStore(dir);
  await store.save({ ...makeMemory(), keywords: ["pnpm", "包管理器"] });
  const loaded = await store.load("user/test-preference");
  expect(loaded?.keywords).toEqual(["pnpm", "包管理器"]);
});

it("load() tolerates missing keywords (old memories) -> undefined", async () => {
  dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
  const store = new MemoryStore(dir);
  // 手写一个无 keywords 的旧记忆文件
  const fp = path.join(dir, "user", "old.md");
  mkdirSync(path.join(dir, "user"), { recursive: true });
  writeFileSync(fp, ["---", "name: old", "description: d", "type: user",
    "createdAt: 2026-01-01T00:00:00.000Z", "updatedAt: 2026-01-01T00:00:00.000Z", "---", "", "c", ""].join("\n"));
  const loaded = await store.load("user/old");
  expect(loaded?.keywords).toBeUndefined();
});

it("load() tolerates malformed keywords frontmatter -> undefined", async () => {
  dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
  const fp = path.join(dir, "user", "bad.md");
  mkdirSync(path.join(dir, "user"), { recursive: true });
  writeFileSync(fp, ["---", "name: bad", "description: d", "type: user",
    "keywords: not-json", "createdAt: 2026-01-01T00:00:00.000Z", "updatedAt: 2026-01-01T00:00:00.000Z",
    "---", "", "c", ""].join("\n"));
  const store = new MemoryStore(dir);
  const loaded = await store.load("user/bad");
  expect(loaded?.keywords).toBeUndefined();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @licode/core exec vitest run packages/core/src/memory/memory.test.ts -t "keywords"`
Expected: FAIL(`keywords` 字段不存在)。

- [ ] **Step 3a: types.ts 加字段**

```typescript
export interface Memory {
  // ... 既有字段 ...
  /** per-memory 检索关键词(Phase B,LLM 产出)。注意:与 dream 的 suspicion keywords 无关。 */
  keywords?: string[];
}
```

- [ ] **Step 3b: store.ts parse() 读 keywords**

在 `parse()` 解析 frontmatter 处加(定位 `keywords:` 行,JSON.parse,容错):

```typescript
let keywords: string[] | undefined;
const kwMatch = raw.match(/^keywords:\s*(\[.*\])\s*$/m);
if (kwMatch) {
  try { const p = JSON.parse(kwMatch[1]); if (Array.isArray(p) && p.every((k) => typeof k === "string")) keywords = p; } catch { /* -> undefined */ }
}
// 返回 Memory 时带上 keywords
return { ...parsed, keywords };
```

- [ ] **Step 3c: 三处 frontmatter 写加 keywords 行**

在 `save`(108-113)、`normalizeChangedSince`(268-275)、`recordUsage`(317-324)的 frontmatter 数组,在 `pinned:` 之后加:

```typescript
`keywords: ${JSON.stringify(memory.keywords ?? [])}`,
```

(`normalizeChangedSince`/`recordUsage` 用对应变量 `m`/`existing`:`` `keywords: ${JSON.stringify(m.keywords ?? [])}` `` / `` `keywords: ${JSON.stringify(existing.keywords ?? [])}` ``)

> 注:若想 DRY,可抽 `buildFrontmatter(mem): string` 共享三处;本 Task 先就地加,保持改动局部。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @licode/core exec vitest run packages/core/src/memory/memory.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/types.ts packages/core/src/memory/store.ts packages/core/src/memory/memory.test.ts
git commit -m "feat(memory): add per-memory keywords field (frontmatter read/write, tolerant parse)"
```

---

## Task B2:extractor prompt 加 keywords 产出 + description 检索指导

**Files:**
- Modify: `packages/core/src/memory/extractor.ts:272`(输出格式)+ Rules
- Test: `packages/core/src/memory/extractor.test.ts`

- [ ] **Step 1: 写失败测试(断言 prompt 含 keywords 与 description 指导)**

```typescript
it("buildPrompt asks for keywords and retrieval-key description", async () => {
  const chat = vi.fn().mockResolvedValue({ content: "[]" });
  vi.mocked(AnthropicProvider).mockImplementation(() => ({ name: "m", maxContextTokens: 200000, chat, stream: vi.fn(), countTokens: vi.fn(() => 0) }) as any);
  const store = new MemoryStore(mkdtempSync(path.join(tmpdir(), "licode-mem-")));
  const ext = new MemoryExtractor();
  await ext.extract([{ role: "user", content: "我喜欢番茄炒蛋", timestamp: "2026-08-04T00:00:00.000Z" }] as any, store);
  const prompt = chat.mock.calls[0][0].messages[0].content;
  expect(prompt).toContain("keywords");
  expect(prompt).toMatch(/description.*(检索|关键|不叙事)/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @licode/core exec vitest run packages/core/src/memory/extractor.test.ts -t "keywords and retrieval-key"`
Expected: FAIL。

- [ ] **Step 3: 实现**

在 `extractor.ts:272` 输出格式加 `keywords` 字段:

```typescript
'[{"action":"create|update|append","slug":"<type>/<kebab-case>","type":"user|feedback|project|reference","name":"简短名称","description":"检索key:一句话含判别词,不叙事,≤40字","keywords":["kw1","kw2"],"content":"完整正文"}]',
```

Rules 加:

```typescript
"- description 写成检索 key:一句话、含判别性关键词、不叙事、不混无关话题、≤40字",
"- keywords:2-5 个判别性词(用于召回匹配,如技术名/人名/目标名),四类都要产",
```

并在 `extract()` 落盘前把 LLM 输出的 keywords 传入 `Memory`(parseResponse 解析 `item.keywords` 为 string[],校验)。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @licode/core exec vitest run packages/core/src/memory/extractor.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/extractor.ts packages/core/src/memory/extractor.test.ts
git commit -m "feat(memory): extractor prompt produces keywords + retrieval-key description"
```

---

## Task B3:dream consolidate 产 keywords(parseDreamResponse + prompt)

**Files:**
- Modify: `packages/core/src/memory/dream.ts:361`(prompt 输出格式)+ `parseDreamResponse`(412-419 校验)
- Test: `packages/core/src/memory/dream.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
it("parseDreamResponse accepts keywords on create/update/append ops", () => {
  // 经 mock chat 返回含 keywords 的 JSON,跑一次 consolidate,断言落盘记忆含 keywords
  // 或直接测 parseDreamResponse(若可访问):喂 [{"action":"update","slug":"user/x","type":"user","name":"n","description":"d","content":"c","keywords":["k1"]}],断言解析出 keywords:["k1"]
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @licode/core exec vitest run packages/core/src/memory/dream.test.ts -t "keywords"`
Expected: FAIL。

- [ ] **Step 3: 实现**

- `dream.ts:361` 输出格式加 `"keywords":["kw1","kw2"]`。
- `parseDreamResponse`(412-419)的校验块加 `item.keywords` 解析(可选,string[],校验每项是 string),并入 out 项。
- consolidate 落盘时把 keywords 传给 `store.save`(对应 create/update/append)。
- consolidate prompt Rules 补一句:"update/create 时为记忆补全 keywords(2-5 个判别词)"。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @licode/core exec vitest run packages/core/src/memory/dream.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/dream.ts packages/core/src/memory/dream.test.ts
git commit -m "feat(memory): dream consolidate produces/backfills keywords"
```

---

## Task B4:recall 富索引构造(select + prompt)

**Files:**
- Modify: `packages/core/src/memory/recall.ts:126-150`(`select()`)+ `buildPrompt`(162-191)
- Test: `packages/core/src/memory/recall.test.ts`

**Interfaces:**
- Produces: `select()` 从 `listAll()` 构造富索引喂 side-query;省掉 `loadIndex()`;缺 keywords 兼容。

- [ ] **Step 1: 写失败测试**

```typescript
describe("MemoryRecall rich index", () => {
  it("select() builds a rich index with description + keywords + first-line preview", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "licode-recall-"));
    const store = new MemoryStore(dir);
    await store.save({
      slug: "user/java", type: "user", name: "Java偏好",
      description: "用户偏好Java后端", content: "用户主要用 Java 做后端开发。\n第二行。",
      keywords: ["Java", "后端"], createdAt: "2026-08-04T00:00:00.000Z", updatedAt: "2026-08-04T00:00:00.000Z",
    });
    const chat = vi.fn().mockResolvedValue({ content: '["user/java"]' });
    vi.mocked(AnthropicProvider).mockImplementation(() => ({ name: "m", maxContextTokens: 200000, chat, stream: vi.fn(), countTokens: vi.fn(() => 0) }) as any);
    const recall = new MemoryRecall();
    const mems = await recall.select("帮我写Java接口", store);
    const prompt = chat.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("Java偏好");
    expect(prompt).toContain("[关键词: Java,后端]");
    expect(prompt).toContain("用户主要用 Java 做后端开发"); // 正文首行
  });

  it("rich index omits keywords segment when absent (old memory)", async () => {
    // 存一条无 keywords 的记忆,断言 prompt 不含 "[关键词:" 但含 description + 首行
    // ...
  });

  it("first-line preview is truncated to 60 chars with …", async () => {
    // content 首行 >60 字,断言 prompt 含截断 + "…"
    // ...
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @licode/core exec vitest run packages/core/src/memory/recall.test.ts -t "rich index"`
Expected: FAIL(当前 select 用 loadIndex 的一行 description,无 keywords/首行)。

- [ ] **Step 3: 实现**

改 `recall.ts` `select()`(126-150),去掉 `loadIndex()`,从 `listAll()` 构造富索引:

```typescript
async select(userQuery: string, store: MemoryStore): Promise<Memory[]> {
  try {
    const all = await store.listAll();
    if (all.length === 0) return [];
    const knownSlugs = new Set(all.map((m) => m.slug));
    const richIndex = all.map((m) => {
      const parts = [`- [${m.name}](${m.slug}.md) - ${m.description}`];
      if (m.keywords && m.keywords.length) parts.push(`[关键词: ${m.keywords.join(",")}]`);
      const first = (m.content.split("\n")[0] || "").trim();
      const preview = first.length > 60 ? first.slice(0, 60) + "…" : first;
      parts.push(`「${preview}」`);
      return parts.join(" ");
    }).join("\n");
    const response = await this.withTimeout(this.llm.chat({
      messages: [{ role: "user", content: this.buildPrompt(richIndex, userQuery), timestamp: new Date().toISOString() }],
      model: this.model, maxTokens: 512, temperature: 0,
    }));
    const slugs = this.parseResponse(response.content, knownSlugs).slice(0, this.maxResults);
    const bySlug = new Map(all.map((m) => [m.slug, m]));
    return slugs.map((s) => bySlug.get(s)!);
  } catch {
    return [];
  }
}
```

`buildPrompt`(162-191)的"## Memory index"说明改为提示新格式:

```typescript
"## Memory index（每条:名称 - 描述 [关键词] 「正文首行预览」,按相关性选择）",
indexContent.trim(),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @licode/core exec vitest run packages/core/src/memory/recall.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/recall.ts packages/core/src/memory/recall.test.ts
git commit -m "feat(memory): recall builds rich index (description+keywords+first-line) from listAll"
```

---

## Task B5:memory-guide.md 加 keywords 模板 + description 指导

**Files:**
- Modify: `packages/core/src/conversation/templates/memory-guide.md`(frontmatter 模板 + description 说明)

- [ ] **Step 1: 改文档**

- frontmatter 模板(39 行附近)加 `keywords: [kw1, kw2]`。
- "## 如何保存"加一条:keywords 为 2-5 个判别词;description 写成检索 key(一句话、含判别词、不叙事)。

- [ ] **Step 2: 跑相关测试**

Run: `pnpm --filter @licode/core exec vitest run packages/core/src/conversation/memory-guide.test.ts`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/conversation/templates/memory-guide.md
git commit -m "docs(guide): memory-guide adds keywords template + description guidance"
```

---

## 全量验证(Phase B 末尾)

- [ ] **Run full memory test suite**

Run: `pnpm --filter @licode/core exec vitest run packages/core/src/memory packages/core/src/conversation/memory-guide.test.ts`
Expected: 全 PASS。

- [ ] **Build check**

Run: `pnpm build`
Expected: 零错误。

---

## Self-Review 记录

- **Spec 覆盖**:A(决策树 save/normalize/extractor/dream/guide)= Task A1-A6;B(keywords types/store + extractor/dream 产 + recall 富索引 + guide)= Task B1-B5。主 Agent 直写校验=Task A3;keywords 消歧义=A1/B1 注释;MEMORY.md 不改=B4(只改 select 内部);dream Prune 不改=未列 Task(确认无改动)。✓
- **类型一致**:`validateMemory` 返回 `{ok,type,slug}` 在 A1 定义、A2/A3 消费一致;`keywords?: string[]` 在 B1 定义、B2/B3/B4 消费一致。✓
- **占位扫描**:Task A5/B5 测试为既有套件验证(文档任务);Task B3 测试给出两种途径(私有方法或经 mock),已说明。无 TBD/TODO。✓

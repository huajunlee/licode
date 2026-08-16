# 记忆召回系统重构（memory_recall 元工具）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 `memory_recall` 元工具（子 agent 式小模型选摘）取代前置召回 hook + memory_fetch，消除缓存前缀断点，并用评测脚本验证召回率不回退。

**Architecture:** 主模型通过 `memory_recall(query, keywords)` 工具发起召回；工具内部跑一个最多 4 步的小模型 agent 循环（固定指令+完整索引为稳定前缀，`read_memory` 只读工具），输出 SELECTED slug 列表；代码侧去重、记账、拼装正文返回。system prompt 只留一行会话启动时量化的静态提示。旧的每轮前置召回、prune、索引层注入全部删除。

**Tech Stack:** TypeScript (ESM, `.js` 后缀导入)、zod、vitest、tsx（评测脚本）、DeepSeek API（Anthropic SDK 兼容端点）

**Spec:** `docs/superpowers/specs/2026-08-16-memory-recall-tool-design.md`

## Global Constraints

- 召回路径**永不抛出**：任何失败降级为「未找到相关记忆」，不得打断主循环（沿用现有 best-effort 原则）
- 环境变量 `LICODE_MEMORY_RECALL=off` 时：不注册 `memory_recall` 工具、不注入存在提示层
- 小模型默认 `deepseek-chat`，temperature 由 provider 默认（不传）；子 agent 循环 `maxSteps` 默认 4，`maxResults` 默认 5，整体超时默认 60s
- 记忆正文 ≥ 500 token（TokenCounter.estimate）时摘录（截前 2000 字符 + 标记），否则给全文
- TDD：每个任务先写失败测试再实现；每个任务结束独立 commit
- 构建/测试命令：根目录 `pnpm build`、`pnpm test`；评测脚本 `pnpm tsx packages/core/scripts/eval-recall.ts`
- **任务顺序硬约束**（spec §5）：Task 2（评测脚本+基线采集）必须先于 Task 6（删除旧代码）完成——基线依赖 `MemoryRecall.select`，删了就补测不了

---

### Task 1: 抽取富索引构建器 `buildRichIndex`

**Files:**
- Create: `packages/core/src/memory/rich-index.ts`
- Test: `packages/core/src/memory/rich-index.test.ts`

**Interfaces:**
- Consumes: `Memory`（`packages/core/src/memory/types.ts`，字段：`name, slug, description, content, keywords?`）
- Produces: `buildRichIndex(memories: Memory[]): string` —— 被 Task 3（recall-agent）和评测脚本使用。输出格式与现 `recall.ts:210-217` 内联逻辑完全一致：
  `- [name](slug.md) - description [关键词: kw1,kw2] 「正文首行前60字」`

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/src/memory/rich-index.test.ts
import { describe, it, expect } from "vitest";
import { buildRichIndex } from "./rich-index.js";
import type { Memory } from "./types.js";

const mem = (over: Partial<Memory>): Memory => ({
  name: "食物偏好",
  slug: "user/food-preferences",
  description: "用户喜欢蛋挞，不吃辣",
  content: "用户喜欢吃蛋挞，尤其宵夜。\n不吃辣。",
  keywords: ["蛋挞", "饮食"],
  ...over,
} as Memory);

describe("buildRichIndex", () => {
  it("formats one entry per memory with keywords and first-line preview", () => {
    const out = buildRichIndex([mem({})]);
    expect(out).toBe(
      "- [食物偏好](user/food-preferences.md) - 用户喜欢蛋挞，不吃辣 [关键词: 蛋挞,饮食] 「用户喜欢吃蛋挞，尤其宵夜。」"
    );
  });

  it("truncates first line preview at 60 chars with ellipsis", () => {
    const long = "一".repeat(70);
    const out = buildRichIndex([mem({ content: long })]);
    expect(out).toContain(`「${"一".repeat(60)}…」`);
  });

  it("omits keywords bracket when keywords missing or empty", () => {
    const out = buildRichIndex([mem({ keywords: undefined })]);
    expect(out).not.toContain("[关键词:");
  });

  it("joins multiple memories with newline", () => {
    const out = buildRichIndex([mem({}), mem({ slug: "project/x", name: "X" })]);
    expect(out.split("\n")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/src/memory/rich-index.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// packages/core/src/memory/rich-index.ts
import type { Memory } from "./types.js";

/**
 * 富索引：每行 `- [name](slug.md) - description [关键词: ...] 「首行预览」`。
 * 与旧 MemoryRecall.select 的内联格式一致，供 recall 子 agent 的 prompt 使用。
 * 注意：slug 已含类型前缀（如 user/xxx），展示时拼 `.md` 后缀仅作示意。
 */
export function buildRichIndex(memories: Memory[]): string {
  return memories
    .map((m) => {
      const parts = [`- [${m.name}](${m.slug}.md) - ${m.description}`];
      if (m.keywords && m.keywords.length) parts.push(`[关键词: ${m.keywords.join(",")}]`);
      const first = (m.content.split("\n")[0] || "").trim();
      const preview = first.length > 60 ? first.slice(0, 60) + "…" : first;
      parts.push(`「${preview}」`);
      return parts.join(" ");
    })
    .join("\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/core/src/memory/rich-index.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/rich-index.ts packages/core/src/memory/rich-index.test.ts
git commit -m "feat(memory): 抽取 buildRichIndex 富索引构建器(格式与旧 select 内联逻辑一致)"
```

---

### Task 2: 召回率评测脚本 + 基线数据采集（必须先于删除旧代码）

**Files:**
- Create: `packages/core/scripts/eval-recall.ts`
- Create: `packages/core/scripts/eval-recall/seed-memories.json`
- Create: `packages/core/scripts/eval-recall/cases.json`
- Create: `packages/core/scripts/eval-recall/results-baseline.json`（脚本生成，提交存档）

**Interfaces:**
- Consumes: `MemoryStore`（`src/memory/store.ts`：`listAll(), load(slug), rebuildIndex()`）、`MemoryRecall`（`src/memory/recall.ts`，基线模式专用，Task 6 删除后由 Task 7 改写脚本）
- Produces: 评测产物约定——`results-baseline.json` 结构 `{ "perCase": [{ "id", "group", "triggered", "selectedSlugs", "hit" }], "summary": { "recallA", "falsePositiveB", "precision" } }`，Task 7 新版模式输出同构便于对比

- [ ] **Step 1: 写种子记忆数据**

`packages/core/scripts/eval-recall/seed-memories.json`（12 条，四分类各 3 条）：

```json
[
  { "slug": "user/food-preferences", "name": "食物偏好", "description": "喜欢蛋挞和甜食，不吃辣", "type": "user", "keywords": ["蛋挞", "甜食", "不吃辣"], "content": "用户喜欢吃蛋挞，宵夜尤其爱吃。\n完全不吃辣，点菜要避免。\n对甜食普遍没有抵抗力。" },
  { "slug": "user/neovim-workflow", "name": "编辑器习惯", "description": "主力编辑器是 Neovim，自维护配置", "type": "user", "keywords": ["neovim", "编辑器"], "content": "用户主力编辑器是 Neovim，自己维护 lua 配置。\n不喜欢别人推荐换编辑器。" },
  { "slug": "user/fitness-schedule", "name": "健身时间", "description": "每周三、周五晚上健身", "type": "user", "keywords": ["健身", "周三", "周五"], "content": "用户每周三和周五晚上 7 点去健身房。\n其他时间一般没空锻炼。" },
  { "slug": "feedback/no-emoji", "name": "回复不用表情", "description": "用户要求回复中不使用 emoji", "type": "feedback", "keywords": ["emoji", "回复风格"], "content": "用户明确要求回复中不要使用 emoji。\n\n**Why:** 用户觉得正式场合不专业。\n\n**How to apply:** 所有面向用户的回复文本。" },
  { "slug": "feedback/conclusion-first", "name": "结论先行", "description": "回答先给结论再展开", "type": "feedback", "keywords": ["结论先行", "回答风格"], "content": "用户要求回答先给结论，再给论证。\n\n**Why:** 节省阅读时间。\n\n**How to apply:** 所有解释类回答。" },
  { "slug": "feedback/chinese-reply", "name": "中文回复", "description": "始终用中文回复", "type": "feedback", "keywords": ["中文", "语言"], "content": "用户要求始终用中文回复。\n\n**Why:** 母语沟通效率高。\n\n**How to apply:** 所有回复，即使用户用英文提问。" },
  { "slug": "project/q3-launch", "name": "Q3 上线目标", "description": "项目计划 2026 年 Q3 上线", "type": "project", "keywords": ["上线", "Q3", "2026"], "content": "项目计划在 2026 年 Q3（9 月底前）上线第一个公开版本。\n当前重点是稳定性。" },
  { "slug": "project/deepseek-default", "name": "默认模型", "description": "项目默认模型为 deepseek-chat", "type": "project", "keywords": ["deepseek-chat", "默认模型"], "content": "LICode 的默认模型是 deepseek-chat，通过 Anthropic 兼容端点接入。\n切模型用启动参数。" },
  { "slug": "project/memory-redesign", "name": "记忆系统重构", "description": "正在把记忆召回改为工具化方案", "type": "project", "keywords": ["记忆", "召回", "重构"], "content": "当前正在进行记忆召回系统重构：删除前置召回 hook，改为 memory_recall 工具。\n动机是提高缓存命中率。" },
  { "slug": "reference/zhihu-memory-article", "name": "记忆系统对比文章", "description": "知乎上 Claude Code 与 Codex 记忆设计对比文", "type": "reference", "keywords": ["知乎", "记忆系统", "Claude Code"], "content": "一篇知乎文章，对比 Claude Code 与 Codex 的记忆系统设计（生产/召回/整理）。\n本地副本在桌面。是 LICode 记忆系统的重要参考。" },
  { "slug": "reference/deepseek-docs", "name": "DeepSeek API 文档", "description": "DeepSeek 官方 API 文档地址", "type": "reference", "keywords": ["DeepSeek", "API", "文档"], "content": "DeepSeek 官方 API 文档：https://api-docs.deepseek.com/\n含上下文缓存说明。" },
  { "slug": "reference/locomo-paper", "name": "LoCoMo 基准", "description": "长期对话记忆评测基准(ACL 2024)", "type": "reference", "keywords": ["LoCoMo", "记忆评测", "基准"], "content": "LoCoMo 是 Snap Research 的长期对话记忆评测基准。\n仓库：https://github.com/snap-research/LoCoMo\n适合作为记忆系统的端到端评测。" }
]
```

- [ ] **Step 2: 写评测用例**

`packages/core/scripts/eval-recall/cases.json`（12 条：A5 / B4 / C3；`expectRecall: null` 表示 C 组只记录不判分）：

```json
[
  { "id": "a1", "group": "A", "query": "宵夜吃什么好？", "expectRecall": true, "expectedSlugs": ["user/food-preferences"] },
  { "id": "a2", "group": "A", "query": "你回复我的时候风格上有什么要注意的吗？", "expectRecall": true, "expectedSlugs": ["feedback/conclusion-first"] },
  { "id": "a3", "group": "A", "query": "我这个项目打算什么时候上线来着？", "expectRecall": true, "expectedSlugs": ["project/q3-launch"] },
  { "id": "a4", "group": "A", "query": "帮我看看我这周哪几天晚上有空锻炼？", "expectRecall": true, "expectedSlugs": ["user/fitness-schedule"] },
  { "id": "a5", "group": "A", "query": "LICode 默认用的是哪个模型？", "expectRecall": true, "expectedSlugs": ["project/deepseek-default"] },
  { "id": "b1", "group": "B", "query": "TypeScript 里 Readonly 和 as const 有什么区别？", "expectRecall": false, "expectedSlugs": [] },
  { "id": "b2", "group": "B", "query": "帮我写一个防抖函数", "expectRecall": false, "expectedSlugs": [] },
  { "id": "b3", "group": "B", "query": "git rebase 和 merge 的区别是什么？", "expectRecall": false, "expectedSlugs": [] },
  { "id": "b4", "group": "B", "query": "正则表达式怎么匹配邮箱地址？", "expectRecall": false, "expectedSlugs": [] },
  { "id": "c1", "group": "C", "query": "最近有什么值得关注的记忆系统研究吗？", "expectRecall": null, "expectedSlugs": ["reference/locomo-paper"] },
  { "id": "c2", "group": "C", "query": "我这个项目最近的重点是什么？", "expectRecall": null, "expectedSlugs": ["project/memory-redesign"] },
  { "id": "c3", "group": "C", "query": "我想找篇之前看过的记忆系统对比文章", "expectRecall": null, "expectedSlugs": ["reference/zhihu-memory-article"] }
]
```

- [ ] **Step 3: 写评测脚本（基线模式）**

`packages/core/scripts/eval-recall.ts`：

```ts
// 召回率评测脚本。用法：
//   ANTHROPIC_API_KEY=... pnpm tsx packages/core/scripts/eval-recall.ts --mode=baseline
// 数据：seed-memories.json（写入临时 MemoryStore）、cases.json（评测用例）
// 输出：eval-recall/results-<mode>.json + 控制台汇总表
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "../src/memory/store.js";
import { MemoryRecall } from "../src/memory/recall.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, "eval-recall");

interface Seed { slug: string; name: string; description: string; type: string; keywords: string[]; content: string; }
interface Case { id: string; group: "A" | "B" | "C"; query: string; expectRecall: boolean | null; expectedSlugs: string[]; }

function writeSeedMemory(dir: string, seed: Seed): void {
  const file = path.join(dir, `${seed.slug}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fm = [
    "---",
    `name: ${seed.name}`,
    `description: ${seed.description}`,
    `type: ${seed.type}`,
    `createdAt: 2026-08-01T00:00:00.000Z`,
    `updatedAt: 2026-08-01T00:00:00.000Z`,
    `pinned: false`,
    `keywords: [${seed.keywords.join(", ")}]`,
    "---",
    "",
    seed.content,
  ].join("\n");
  fs.writeFileSync(file, fm);
}

async function main(): Promise<void> {
  const mode = process.argv.find((a) => a.startsWith("--mode="))?.slice(7) ?? "baseline";
  if (mode !== "baseline") throw new Error(`unknown mode: ${mode}（tool 模式由 Task 7 实现）`);
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("需要 ANTHROPIC_API_KEY 环境变量");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eval-recall-"));
  const seeds = JSON.parse(fs.readFileSync(path.join(DATA, "seed-memories.json"), "utf-8")) as Seed[];
  for (const s of seeds) writeSeedMemory(tmp, s);
  const store = new MemoryStore(tmp);
  await store.rebuildIndex();

  const cases = JSON.parse(fs.readFileSync(path.join(DATA, "cases.json"), "utf-8")) as Case[];
  const recall = new MemoryRecall({});

  const perCase = [];
  for (const c of cases) {
    const { add } = await recall.select(c.query, store);
    const selectedSlugs = add.map((m) => m.slug);
    const hit = c.expectedSlugs.length > 0 && c.expectedSlugs.every((s) => selectedSlugs.includes(s));
    perCase.push({ id: c.id, group: c.group, triggered: selectedSlugs.length > 0, selectedSlugs, hit });
    console.log(`${c.id} [${c.group}] triggered=${selectedSlugs.length > 0} hit=${hit} selected=${selectedSlugs.join(",") || "-"}`);
  }

  const groupA = perCase.filter((p) => p.group === "A");
  const groupB = perCase.filter((p) => p.group === "B");
  const totalSelected = perCase.reduce((n, p) => n + p.selectedSlugs.length, 0);
  const totalExpected = cases.flatMap((c) => c.expectedSlugs);
  const totalCorrect = perCase.reduce(
    (n, p) => n + p.selectedSlugs.filter((s) => totalExpected.includes(s)).length, 0);
  const summary = {
    recallA: groupA.filter((p) => p.hit).length / groupA.length,
    falsePositiveB: groupB.filter((p) => p.triggered).length / groupB.length,
    precision: totalSelected === 0 ? 1 : totalCorrect / totalSelected,
  };
  console.log(`\nA组召回率=${(summary.recallA * 100).toFixed(0)}%  B组误召回率=${(summary.falsePositiveB * 100).toFixed(0)}%  选中准确率=${(summary.precision * 100).toFixed(0)}%`);

  const out = path.join(DATA, `results-${mode}.json`);
  fs.writeFileSync(out, JSON.stringify({ perCase, summary }, null, 2));
  console.log(`结果已写入 ${out}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 4: 跑基线并检查结果**

Run: `ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY pnpm tsx packages/core/scripts/eval-recall.ts --mode=baseline`
Expected: 12 行用例输出 + 汇总行；`results-baseline.json` 生成。逐行检查输出合理性（若基线本身在 A 组大量 miss，说明种子/用例构造有问题，先修数据再重跑——基线是验收参照物，必须可信）

- [ ] **Step 5: Commit**

```bash
git add packages/core/scripts/
git commit -m "test(memory): 召回率评测脚本+12种子记忆+12用例+基线结果存档"
```

---

### Task 3: recall 子 agent 循环 `createRecallAgent`

**Files:**
- Create: `packages/core/src/memory/recall-agent.ts`
- Test: `packages/core/src/memory/recall-agent.test.ts`

**Interfaces:**
- Consumes: `buildRichIndex`（Task 1）；`collectResponse`（`src/agent/react.ts`）；`ConversationManager`、`SystemPrompt`、`ToolRegistry`、`ToolExecutor`、`LLMProvider`、`MemoryStore`
- Produces:
  ```ts
  export interface RecallAgentConfig {
    llm: LLMProvider;
    model?: string;        // 默认 "deepseek-chat"
    store: MemoryStore;
    maxSteps?: number;     // 默认 4
    maxResults?: number;   // 默认 5
    timeoutMs?: number;    // 默认 60_000
  }
  export interface RecallAgent { run(query: string, keywords: string[]): Promise<string[]>; }
  export function createRecallAgent(config: RecallAgentConfig): RecallAgent;
  ```
  `run` 返回选中的 slug 列表（来自小模型最终回复的 `SELECTED:` 行，过滤已知 slug、去重、截断到 maxResults）；任何失败/超时返回 `[]`。

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/src/memory/recall-agent.test.ts
import { describe, it, expect } from "vitest";
import { createRecallAgent } from "./recall-agent.js";
import type { LLMProvider, ChatRequest, ChatResponse, StreamChunk } from "../llm/provider.js";
import type { MemoryStore } from "./store.js";
import type { Memory } from "./types.js";

const FOOD: Memory = {
  name: "食物偏好", slug: "user/food-preferences", description: "喜欢蛋挞",
  content: "用户喜欢吃蛋挞。", keywords: ["蛋挞"],
} as Memory;

function fakeStore(all: Memory[]): MemoryStore {
  return {
    listAll: async () => all,
    load: async (slug: string) => all.find((m) => m.slug === slug) ?? null,
  } as unknown as MemoryStore;
}

/**  scripted LLM：chat 不用；stream 按队列依次产出（text 或一次 tool_use） */
function scriptedLlm(script: Array<{ text?: string; toolSlug?: string }>): LLMProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    name: "fake", maxContextTokens: 200_000, requests,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      requests.push(req);
      return { content: "", usage: { input: 0, output: 0 }, stopReason: "end_turn" };
    },
    async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
      requests.push(req);
      const step = script.shift() ?? { text: "SELECTED: none" };
      if (step.toolSlug) {
        yield { type: "tool-use", toolUse: { id: "t1", name: "read_memory", input: { slug: step.toolSlug } } };
      } else {
        for (const ch of step.text ?? "") yield { type: "token", text: ch, index: 0 };
      }
      yield { type: "stop", stopReason: "end_turn", usage: { input: 1, output: 1 } };
    },
    countTokens: () => 0,
  };
}

describe("createRecallAgent", () => {
  it("returns [] without any LLM call when store is empty", async () => {
    const llm = scriptedLlm([]);
    const agent = createRecallAgent({ llm, store: fakeStore([]) });
    expect(await agent.run("宵夜吃什么", ["宵夜"])).toEqual([]);
    expect(llm.requests).toHaveLength(0);
  });

  it("parses SELECTED slugs from final text, filtered to known slugs", async () => {
    const llm = scriptedLlm([{ text: "SELECTED: user/food-preferences, fake/slug" }]);
    const agent = createRecallAgent({ llm, store: fakeStore([FOOD]) });
    expect(await agent.run("宵夜吃什么", ["宵夜"])).toEqual(["user/food-preferences"]);
  });

  it("drives read_memory tool loop before final selection", async () => {
    const llm = scriptedLlm([
      { toolSlug: "user/food-preferences" },
      { text: "SELECTED: user/food-preferences" },
    ]);
    const agent = createRecallAgent({ llm, store: fakeStore([FOOD]) });
    expect(await agent.run("宵夜吃什么", ["宵夜"])).toEqual(["user/food-preferences"]);
    expect(llm.requests.length).toBeGreaterThanOrEqual(2);
  });

  it("stops at maxSteps and returns [] when model never selects", async () => {
    const llm = scriptedLlm([{ toolSlug: "user/food-preferences" }]);
    const agent = createRecallAgent({ llm, store: fakeStore([FOOD]), maxSteps: 2 });
    // 队列耗尽后 scriptedLlm 兜底产出 "SELECTED: none" → 第 2 步必然收尾
    expect(await agent.run("q", [])).toEqual([]);
  });

  it("returns [] on LLM error (never throws)", async () => {
    const llm = scriptedLlm([]);
    llm.stream = async function* (): AsyncIterable<StreamChunk> { throw new Error("boom"); };
    const agent = createRecallAgent({ llm, store: fakeStore([FOOD]) });
    expect(await agent.run("q", [])).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/src/memory/recall-agent.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// packages/core/src/memory/recall-agent.ts
import type { LLMProvider } from "../llm/provider.js";
import { ConversationManager } from "../conversation/manager.js";
import { SystemPrompt } from "../conversation/system-prompt.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolExecutor } from "../tools/executor.js";
import { collectResponse } from "../agent/react.js";
import { z } from "zod";
import type { Tool } from "../tools/types.js";
import type { MemoryStore } from "./store.js";
import { buildRichIndex } from "./rich-index.js";

export interface RecallAgentConfig {
  llm: LLMProvider;
  model?: string;
  store: MemoryStore;
  maxSteps?: number;
  maxResults?: number;
  timeoutMs?: number;
}

export interface RecallAgent {
  run(query: string, keywords: string[]): Promise<string[]>;
}

const ReadMemoryParams = z.object({
  slug: z.string().min(1).describe("要阅读的记忆 slug（来自索引）"),
});

/** 子 agent 唯一工具：按 slug 读记忆正文（只读）。 */
function createReadMemoryTool(store: MemoryStore): Tool<typeof ReadMemoryParams> {
  return {
    name: "read_memory",
    description: "按 slug 阅读一条记忆的完整正文，用于在决定召回前确认相关性。",
    parameters: ReadMemoryParams,
    async execute(input) {
      try {
        const m = await store.load(input.slug);
        if (!m) return { status: "error", error: `未找到：${input.slug}`, errorType: "execution" };
        return { status: "success", content: `## ${m.name} (${m.slug})\n${m.content}` };
      } catch {
        return { status: "error", error: `读取失败：${input.slug}`, errorType: "execution" };
      }
    },
  };
}

const SELECTED_RE = /^SELECTED:\s*(.+)$/m;

/** 从最终文本解析 `SELECTED: slug1, slug2` / `SELECTED: none`，过滤已知 slug、去重。 */
export function parseSelected(text: string, knownSlugs: Set<string>): string[] {
  const match = text.match(SELECTED_RE);
  if (!match) return [];
  const out: string[] = [];
  for (const raw of match[1].split(",")) {
    const slug = raw.trim();
    if (slug && slug !== "none" && knownSlugs.has(slug) && !out.includes(slug)) out.push(slug);
  }
  return out;
}

function buildAgentPrompt(richIndex: string, maxResults: number): string {
  return [
    "你是记忆召回助手。根据主模型传来的查询意图，从下面的记忆索引中选出真正相关的记忆。",
    "",
    "## 记忆索引（每条：名称 - 描述 [关键词] 「首行预览」）",
    richIndex,
    "",
    "## 工作方式",
    `1. 先用索引初筛候选；拿不准时用 read_memory 工具阅读正文再判断（建议对每个候选读一次）。`,
    `2. 默认不选；不确定相关的不选。最多选 ${maxResults} 条。`,
    "3. 判断完成后，最后一行严格输出：SELECTED: slug1, slug2（无相关则 SELECTED: none）。",
    "4. slug 必须来自上面的索引，禁止编造。",
  ].join("\n");
}

/**
 * 召回子 agent：小模型在多步循环里读索引、按需读正文、输出 SELECTED slug 列表。
 * prompt 结构 = [固定指令 + 完整富索引（稳定前缀）] + [查询（尾部）]，缓存友好。
 * 永不抛出：任何失败/超时/超步数返回 []。
 */
export function createRecallAgent(config: RecallAgentConfig): RecallAgent {
  const maxSteps = config.maxSteps ?? 4;
  const maxResults = config.maxResults ?? 5;
  const timeoutMs = config.timeoutMs ?? 60_000;
  const model = config.model ?? "deepseek-chat";

  async function runOnce(query: string, keywords: string[]): Promise<string[]> {
    const all = await config.store.listAll();
    if (all.length === 0) return [];
    const knownSlugs = new Set(all.map((m) => m.slug));

    const conv = new ConversationManager({ model });
    conv.systemPrompt = new SystemPrompt();
    conv.systemPrompt.addLayer({
      name: "recall-agent",
      priority: 0,
      always: true,
      content: buildAgentPrompt(buildRichIndex(all), maxResults),
    });

    const tools = new ToolRegistry();
    tools.register(createReadMemoryTool(config.store));
    const executor = new ToolExecutor(tools);

    conv.addUserMessage(
      [`查询意图：${query}`, keywords.length ? `关键词：${keywords.join(", ")}` : ""]
        .filter(Boolean)
        .join("\n")
    );

    for (let step = 0; step < maxSteps; step++) {
      const res = await collectResponse(config.llm, conv.buildMessages(), tools.toLLMTools(), conv);
      if (res.type === "text") {
        return parseSelected(res.content, knownSlugs).slice(0, maxResults);
      }
      const results = await executor.executeParallel(res.toolUses);
      conv.addToolMessages(res.toolUses, results);
    }
    return [];
  }

  return {
    async run(query, keywords) {
      try {
        return await Promise.race([
          runOnce(query, keywords),
          new Promise<string[]>((resolve) => setTimeout(() => resolve([]), timeoutMs)),
        ]);
      } catch {
        return [];
      }
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/core/src/memory/recall-agent.test.ts`
Expected: PASS（5 个用例）。若 `ToolExecutor` 需要额外 context（如 workingDirectory），按 `src/tools/executor.ts` 的实际签名微调构造参数

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/recall-agent.ts packages/core/src/memory/recall-agent.test.ts
git commit -m "feat(memory): recall 子 agent 循环(稳定前缀 prompt+read_memory 只读工具+SELECTED 解析,maxSteps 4)"
```

---

### Task 4: `memory_recall` 主工具

**Files:**
- Create: `packages/core/src/tools/builtin/memory-recall.ts`
- Test: `packages/core/src/tools/builtin/memory-recall.test.ts`

**Interfaces:**
- Consumes: `RecallAgent.run`（Task 3，以函数注入便于 mock）；`MemoryStore.load/recordUsage`；`LoadedMemoryRegistry.has/add`；`DreamState.running`（`src/memory/dream.ts`）
- Produces:
  ```ts
  export interface MemoryRecallToolDeps {
    runRecall: (query: string, keywords: string[]) => Promise<string[]>;
    store: MemoryStore;
    registry: LoadedMemoryRegistry;
    dreamState?: DreamState;
    maxResults?: number;  // 默认 5
  }
  export function createMemoryRecallTool(deps: MemoryRecallToolDeps): Tool;
  ```
  tool name = `"memory_recall"`（与旧合成 pair 同名，registry.rebuild 天然兼容）。tool result 正文格式 `## 名称 (slug)\n正文`，多条空行分隔；正文 ≥500 token 截前 2000 字符 + `\n…（摘录）`。

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/src/tools/builtin/memory-recall.test.ts
import { describe, it, expect } from "vitest";
import { createMemoryRecallTool } from "./memory-recall.js";
import { LoadedMemoryRegistry } from "../../memory/loaded-memory-registry.js";
import type { MemoryStore } from "../../memory/store.js";
import type { Memory } from "../../memory/types.js";

const FOOD: Memory = {
  name: "食物偏好", slug: "user/food-preferences", description: "喜欢蛋挞",
  content: "用户喜欢吃蛋挞。", keywords: ["蛋挞"],
} as Memory;

function fakeStore(all: Memory[], usage: string[] = []) {
  return {
    store: {
      load: async (slug: string) => all.find((m) => m.slug === slug) ?? null,
      recordUsage: async (slug: string) => { usage.push(slug); },
    } as unknown as MemoryStore,
    usage,
  };
}

function deps(over: Partial<Parameters<typeof createMemoryRecallTool>[0]> = {}, all: Memory[] = [FOOD]) {
  const { store, usage } = fakeStore(all);
  const registry = new LoadedMemoryRegistry();
  return {
    store, usage, registry,
    deps: {
      runRecall: async () => ["user/food-preferences"],
      store,
      registry,
      ...over,
    },
  };
}

describe("memory_recall tool", () => {
  it("returns formatted memory content and records usage + registry", async () => {
    const { deps: d, usage, registry } = deps();
    const tool = createMemoryRecallTool(d);
    const res = await tool.execute(
      { query: "宵夜吃什么", keywords: ["宵夜"] },
      { workingDirectory: "/tmp", sessionId: "s" }
    );
    expect(res.status).toBe("success");
    if (res.status !== "success") return;
    expect(res.content).toContain("## 食物偏好 (user/food-preferences)");
    expect(res.content).toContain("用户喜欢吃蛋挞。");
    expect(usage).toEqual(["user/food-preferences"]);
    expect(registry.has("user/food-preferences")).toBe(true);
  });

  it("skips already-loaded memories and says so", async () => {
    const { deps: d, registry, usage } = deps();
    registry.add("user/food-preferences", "active");
    const tool = createMemoryRecallTool(d);
    const res = await tool.execute({ query: "q", keywords: [] }, { workingDirectory: "/tmp", sessionId: "s" });
    expect(res.status).toBe("success");
    if (res.status !== "success") return;
    expect(res.content).toContain("已在上下文");
    expect(res.content).not.toContain("用户喜欢吃蛋挞。");
    expect(usage).toEqual([]);
  });

  it("returns 未找到相关记忆 when recall selects nothing", async () => {
    const { deps: d } = deps({ runRecall: async () => [] });
    const tool = createMemoryRecallTool(d);
    const res = await tool.execute({ query: "q", keywords: [] }, { workingDirectory: "/tmp", sessionId: "s" });
    expect(res.status).toBe("success");
    if (res.status !== "success") return;
    expect(res.content).toContain("未找到相关记忆");
  });

  it("degrades to 未找到相关记忆 when runRecall throws (never throws)", async () => {
    const { deps: d } = deps({
      runRecall: async () => { throw new Error("boom"); },
    });
    const tool = createMemoryRecallTool(d);
    const res = await tool.execute({ query: "q", keywords: [] }, { workingDirectory: "/tmp", sessionId: "s" });
    expect(res.status).toBe("success");
    if (res.status !== "success") return;
    expect(res.content).toContain("未找到相关记忆");
  });

  it("skips recordUsage while dream is running", async () => {
    const { deps: d, usage } = deps({ dreamState: { running: true } as never });
    const tool = createMemoryRecallTool(d);
    await tool.execute({ query: "q", keywords: [] }, { workingDirectory: "/tmp", sessionId: "s" });
    expect(usage).toEqual([]);
  });

  it("excerpts memories whose content is >= 500 tokens", async () => {
    const long: Memory = { ...FOOD, slug: "project/big", name: "大文件", content: "字".repeat(3000) };
    const { deps: d } = deps({ runRecall: async () => ["project/big"] }, [long]);
    const tool = createMemoryRecallTool(d);
    const res = await tool.execute({ query: "q", keywords: [] }, { workingDirectory: "/tmp", sessionId: "s" });
    expect(res.status).toBe("success");
    if (res.status !== "success") return;
    expect(res.content).toContain("…（摘录）");
    expect(res.content.length).toBeLessThan(2600);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/src/tools/builtin/memory-recall.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// packages/core/src/tools/builtin/memory-recall.ts
import { z } from "zod";
import type { Tool } from "../types.js";
import type { MemoryStore } from "../../memory/store.js";
import type { LoadedMemoryRegistry } from "../../memory/loaded-memory-registry.js";
import type { DreamState } from "../../memory/dream.js";
import { TokenCounter } from "../../llm/token-counter.js";

const MemoryRecallParams = z.object({
  query: z
    .string()
    .min(1)
    .describe("召回意图的陈述：分析用户问题后，说明你想了解关于用户的什么（不要原样转发用户消息）"),
  keywords: z
    .array(z.string())
    .describe("辅助匹配的关键词，2-5 个（如偏好类型/人名/项目名）"),
});

export interface MemoryRecallToolDeps {
  runRecall: (query: string, keywords: string[]) => Promise<string[]>;
  store: MemoryStore;
  registry: LoadedMemoryRegistry;
  dreamState?: DreamState;
  maxResults?: number;
}

const EXCERPT_TOKEN_THRESHOLD = 500;
const EXCERPT_CHAR_LIMIT = 2000;

/**
 * memory_recall: 主模型自主召回长期记忆的元工具。
 * 内部由 recall 子 agent 完成选摘（见 memory/recall-agent.ts），
 * 本层负责去重、记账、拼装正文。永不抛出：失败降级为「未找到相关记忆」。
 */
export function createMemoryRecallTool(deps: MemoryRecallToolDeps): Tool<typeof MemoryRecallParams> {
  const { store, registry } = deps;
  const maxResults = deps.maxResults ?? 5;
  const tokenCounter = new TokenCounter();

  return {
    name: "memory_recall",
    description:
      "查询你的长期记忆（user 用户偏好 / feedback 纠偏反馈 / project 项目理解 / reference 外部资料）。" +
      "当回答可能受益于用户偏好、历史决定、进行中的项目或收藏的资料时调用；" +
      "纯技术问题、无状态问答不要调用。先想好要了解什么，再传入意图陈述和关键词。",
    parameters: MemoryRecallParams,

    async execute(input, _context) {
      let slugs: string[];
      try {
        slugs = (await deps.runRecall(input.query, input.keywords)).slice(0, maxResults);
      } catch {
        return { status: "success", content: "未找到相关记忆。" };
      }

      const fresh = slugs.filter((s) => !registry.has(s));
      const skipped = slugs.filter((s) => registry.has(s));

      if (fresh.length === 0) {
        return {
          status: "success",
          content: skipped.length
            ? `（相关记忆已在上下文，跳过：${skipped.join(", ")}）`
            : "未找到相关记忆。",
        };
      }

      const parts: string[] = [];
      for (const slug of fresh) {
        try {
          const m = await store.load(slug);
          if (!m) continue;
          let content = m.content;
          if (tokenCounter.estimate(content) >= EXCERPT_TOKEN_THRESHOLD) {
            content = content.slice(0, EXCERPT_CHAR_LIMIT) + "\n…（摘录）";
          }
          parts.push(`## ${m.name} (${m.slug})\n${content}`);
          registry.add(slug, "active");
          // dream 整理期间让位，避免 recordUsage 与 consolidate 写写竞态（移植自旧 recall handler）
          if (!deps.dreamState?.running) {
            try { await store.recordUsage(slug); } catch { /* best-effort */ }
          }
        } catch {
          // 单条读取失败跳过，不影响其余
        }
      }

      if (parts.length === 0) return { status: "success", content: "未找到相关记忆。" };
      if (skipped.length) parts.push(`（已在上下文，跳过：${skipped.join(", ")}）`);
      return { status: "success", content: parts.join("\n\n") };
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/core/src/tools/builtin/memory-recall.test.ts`
Expected: PASS（6 个用例）

- [ ] **Step 5: 在 core 导出新模块**

`packages/core/src/index.ts` 追加（旧导出在 Task 6 清理）：

```ts
export { createMemoryRecallTool } from "./tools/builtin/memory-recall.js";
export type { MemoryRecallToolDeps } from "./tools/builtin/memory-recall.js";
export { createRecallAgent, parseSelected } from "./memory/recall-agent.js";
export type { RecallAgent, RecallAgentConfig } from "./memory/recall-agent.js";
export { buildRichIndex } from "./memory/rich-index.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tools/builtin/memory-recall.ts packages/core/src/tools/builtin/memory-recall.test.ts packages/core/src/index.ts
git commit -m "feat(tools): memory_recall 元工具(去重/dream 让位记账/500 token 摘录/失败降级)"
```

---

### Task 5: 静态提示层 + memory-guide 重写 + CLI 接线

**Files:**
- Create: `packages/core/src/memory/presence-layer.ts`
- Test: `packages/core/src/memory/presence-layer.test.ts`
- Modify: `packages/core/src/conversation/templates/memory-guide.md`
- Modify: `packages/cli/src/hooks.ts`（替换 517-519 MemoryLoader 块、585-595 memory_fetch 注册块）
- Modify: `packages/cli/src/cli.ts`（替换 190-193 MemoryLoader 块）

**Interfaces:**
- Consumes: `createMemoryRecallTool` / `createRecallAgent`（Task 3-4）；`AnthropicProvider`、`SystemPromptLayer`
- Produces: `memoryPresenceLayer(count: number): SystemPromptLayer` —— layer `{ name: "memory-presence", priority: 5, always: false }`。量化规则：`count >= 10` → `向下取整到十位 + "+"`（23→"20+"）；`1-9` → `"几"`；`0` → 无数量措辞

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/src/memory/presence-layer.test.ts
import { describe, it, expect } from "vitest";
import { memoryPresenceLayer } from "./presence-layer.js";

describe("memoryPresenceLayer", () => {
  it("quantizes count down to tens for n >= 10", () => {
    expect(memoryPresenceLayer(23).content).toContain("20+ 条");
    expect(memoryPresenceLayer(10).content).toContain("10+ 条");
  });

  it("uses 几 for 1-9", () => {
    expect(memoryPresenceLayer(7).content).toContain("几 条".replace(" ", ""));
  });

  it("omits count phrase for 0", () => {
    expect(memoryPresenceLayer(0).content).toContain("目前还没有长期记忆");
  });

  it("mentions the four categories and memory_recall for n > 0", () => {
    const c = memoryPresenceLayer(23).content;
    for (const kw of ["user", "feedback", "project", "reference", "memory_recall"]) {
      expect(c).toContain(kw);
    }
  });

  it("is an optional layer named memory-presence at priority 5", () => {
    const layer = memoryPresenceLayer(5);
    expect(layer).toMatchObject({ name: "memory-presence", priority: 5, always: false });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/src/memory/presence-layer.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// packages/core/src/memory/presence-layer.ts
import type { SystemPromptLayer } from "../conversation/system-prompt.js";

/**
 * 记忆存在提示层：一行静态文本，会话启动时按记忆数量量化生成，会话期间不更新
 * （缓存安全）。不列任何具体内容——具体内容由 memory_recall 工具按需查询。
 */
export function memoryPresenceLayer(count: number): SystemPromptLayer {
  const content =
    count >= 10
      ? `你有 ${Math.floor(count / 10) * 10}+ 条长期记忆（user 用户偏好 / feedback 纠偏反馈 / project 项目理解 / reference 外部资料），需要时调用 memory_recall 工具查询。`
      : count > 0
        ? `你有几条长期记忆（user 用户偏好 / feedback 纠偏反馈 / project 项目理解 / reference 外部资料），需要时调用 memory_recall 工具查询。`
        : "你目前还没有长期记忆。当用户透露偏好、决定或项目背景时会被记入，之后可用 memory_recall 工具查询。";
  return { name: "memory-presence", priority: 5, always: false, content };
}
```

- [ ] **Step 4: 跑测试确认通过，并在 core 导出**

Run: `pnpm vitest run packages/core/src/memory/presence-layer.test.ts`
Expected: PASS。然后在 `packages/core/src/index.ts` 追加：

```ts
export { memoryPresenceLayer } from "./memory/presence-layer.js";
```

- [ ] **Step 5: 重写 memory-guide.md**

将 `packages/core/src/conversation/templates/memory-guide.md` 的「## 使用记忆时」整节（第 60-63 行）替换为下述内容（其余部分——记忆类型/不要保存/如何保存——原样保留）：

```markdown
## 使用记忆时

- 你的上下文里**没有**记忆索引和记忆正文；需要时调用 `memory_recall` 工具按需查询
- **何时该召回**：用户的提问涉及其个人偏好、习惯、历史决定、进行中的项目、收藏的资料时——先分析意图，再调 `memory_recall`（即使
用户没有明确要求"回忆一下"，也应在合适时机自主召回）
- **何时不该召回**：纯技术问题、无状态问答、与用户信息无关的请求——直接回答，不要调用
- 调用时先想好要了解什么：`query` 写意图陈述（如"用户的饮食偏好"），`keywords` 给 2-5 个关键词；不要原样转发用户消息
- 召回关闭时（无 memory_recall 工具），可用 Read 读 `.licode/memory/<type>/<slug>.md`
- 记忆可能过期：涉及文件路径、函数、命令时，先对照当前代码/git 状态验证
```

同时把第 51 行「创建前先看索引（已注入上下文）判断有无同主题条目」改为「创建前先用 memory_recall 查询有无同主题条目」。

- [ ] **Step 6: TUI 路径接线（hooks.ts）**

替换 517-519 行（MemoryLoader 块）：

```ts
      // Memory presence hint (quantized at session start; static within session).
      if (process.env.LICODE_MEMORY_RECALL !== "off") {
        const memories = await memoryStoreRef.current.listAll();
        systemPrompt.addLayer(memoryPresenceLayer(memories.length));
      }
```

替换 585-595 行（memory_fetch 注册块）：

```ts
      // Rebuild loaded-memory registry from restored session, then register
      // memory_recall (only when recall is enabled).
      loadedMemoryRegistryRef.current.rebuild(manager.getMessages());
      if (process.env.LICODE_MEMORY_RECALL !== "off") {
        const recallAgent = createRecallAgent({
          llm: new AnthropicProvider({ apiKey, baseUrl }),
          model,
          store: memoryStoreRef.current,
        });
        tools.register(
          createMemoryRecallTool({
            runRecall: (q, kw) => recallAgent.run(q, kw),
            store: memoryStoreRef.current,
            registry: loadedMemoryRegistryRef.current,
            dreamState: memoryDreamStateRef.current,
          })
        );
      }
```

同步更新 hooks.ts 顶部导入：移除 `createMemoryFetchTool`，新增 `createMemoryRecallTool, createRecallAgent, memoryPresenceLayer`（均来自 `@licode/core`）；`AnthropicProvider` 若未导入则一并加上。`MemoryLoader` 导入保留到 Task 6 移除。

- [ ] **Step 7: headless 路径接线（cli.ts）**

替换 190-193 行：

```ts
  // Memory presence hint + memory_recall tool (unless recall is disabled).
  const memoryStore = new MemoryStore(`${options.cwd}/.licode/memory`);
  if (process.env.LICODE_MEMORY_RECALL !== "off") {
    const memories = await memoryStore.listAll();
    systemPrompt.addLayer(memoryPresenceLayer(memories.length));
    const recallAgent = createRecallAgent({
      llm: provider,
      model,
      store: memoryStore,
    });
    tools.register(
      createMemoryRecallTool({
        runRecall: (q, kw) => recallAgent.run(q, kw),
        store: memoryStore,
        registry: new LoadedMemoryRegistry(),
      })
    );
  }
```

同步更新 cli.ts 导入：新增 `createMemoryRecallTool, createRecallAgent, memoryPresenceLayer, LoadedMemoryRegistry`；`MemoryLoader` 导入保留到 Task 6 移除。

- [ ] **Step 8: 构建 + 相关测试**

Run: `pnpm build && pnpm vitest run packages/core/src/memory packages/core/src/conversation`
Expected: build 成功；memory/conversation 测试全绿（memory-guide.test.ts 若断言旧文案「索引已注入」需同步更新为「没有记忆索引」表述）

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/memory/presence-layer.ts packages/core/src/memory/presence-layer.test.ts \
        packages/core/src/conversation/templates/memory-guide.md packages/core/src/index.ts \
        packages/cli/src/hooks.ts packages/cli/src/cli.ts
git commit -m "feat(memory): 静态存在提示层(启动时量化)+memory-guide 改工具召回导向+双路径接线 memory_recall"
```

---

### Task 6: 旧机制清理（删除 + registry 瘦身）

**Files:**
- Delete: `packages/core/src/memory/recall.ts`、`packages/core/src/memory/loader.ts`、`packages/core/src/tools/builtin/memory-fetch.ts`、`packages/core/src/tools/builtin/memory-fetch.test.ts`
- Modify: `packages/core/src/memory/loaded-memory-registry.ts`（瘦身为 Set 语义）
- Modify: `packages/core/src/agent/loop.ts`（删 onTurnStart）、`packages/core/src/agent/loop.test.ts`（删 onTurnStart describe 块，第 32-50 行附近）
- Modify: `packages/cli/src/hooks.ts`（删 memoryRecallHandlerRef 声明与创建 ~401-421 行、736 与 802 行的 onTurnStart 传参、createMemoryRecallHandler/MemoryRecall/MemoryLoader 导入）
- Modify: `packages/cli/src/cli.ts`（删 MemoryLoader 导入）
- Modify: `packages/core/src/index.ts`（删 134、140-141、50-51 行旧导出，143 行类型导出同步更新）
- Modify: `packages/core/src/context/compressor.ts:58`（注释去掉 memory-recall synthetic pairs 措辞）
- Modify: `packages/core/src/memory/memory.test.ts`（删 MemoryLoader describe 块，374 行附近）

**Interfaces:**
- Consumes: 前面所有任务
- Produces: 瘦身后的 registry API——`has(slug): boolean`、`add(slug): void`、`rebuild(messages): void`（保留解析 `memory_recall` 与 `memory_fetch` 两个工具名以兼容磁盘旧会话）；删除 `remove/get/getAll` 与 `LoadedMemoryEntry/LoadedMemorySource` 类型。Task 4 中 `registry.add(slug, "active")` 调用同步改为 `registry.add(slug)`

- [ ] **Step 1: 删除文件与旧导出**

```bash
git rm packages/core/src/memory/recall.ts packages/core/src/memory/loader.ts \
       packages/core/src/tools/builtin/memory-fetch.ts packages/core/src/tools/builtin/memory-fetch.test.ts
```

`packages/core/src/index.ts`：删除 `MemoryLoader`（134 行）、`MemoryRecall, MEMORY_RECALL_TOOL_NAME, pruneRecallMessages, buildRecallPair, createMemoryRecallHandler`（140-141 行）、`createMemoryFetchTool` 与 `MemoryFetchToolDeps`（50-51 行）导出。

先全局搜索确认无遗漏引用：

Run: `grep -rn "MemoryRecall\|MemoryLoader\|memory-fetch\|buildRecallPair\|pruneRecall\|createMemoryRecallHandler\|MEMORY_RECALL_TOOL_NAME" packages/*/src --include="*.ts" | grep -v node_modules | grep -v dist`
Expected: 只剩本任务要改的文件（hooks.ts、memory.test.ts、loaded-memory-registry.test.ts 若存在、评测脚本——评测脚本的 baseline 模式引用 `MemoryRecall`，在 Step 6 处理）

- [ ] **Step 2: registry 瘦身**

将 `packages/core/src/memory/loaded-memory-registry.ts` 整体替换为：

```ts
// packages/core/src/memory/loaded-memory-registry.ts
import type { Message, ToolUseBlock, ToolResultBlock } from "../llm/provider.js";

/** Matches `## name (slug)` lines in memory_recall / legacy memory_fetch tool results. */
const SLUG_RE = /^## .* \(([^)]+)\)$/;

/**
 * Session-level set of memory slugs already loaded into the conversation,
 * used to dedupe repeated memory_recall calls. Rebuilt from messages on
 * session restore; parses both memory_recall and legacy memory_fetch tool
 * results so pre-refactor sessions still dedupe correctly.
 */
export class LoadedMemoryRegistry {
  private slugs = new Set<string>();

  has(slug: string): boolean {
    return this.slugs.has(slug);
  }

  add(slug: string): void {
    this.slugs.add(slug);
  }

  rebuild(messages: readonly Message[]): void {
    this.slugs.clear();
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
        const content = typeof b.content === "string" ? b.content : "";
        for (const line of content.split("\n")) {
          const match = line.match(SLUG_RE);
          if (match) this.slugs.add(match[1]);
        }
      }
    }
  }
}

export function createLoadedMemoryRegistry(): LoadedMemoryRegistry {
  return new LoadedMemoryRegistry();
}
```

同步修改：`packages/core/src/tools/builtin/memory-recall.ts` 中 `registry.add(slug, "active")` → `registry.add(slug)`；`packages/core/src/index.ts` 143 行类型导出改为 `export type {} ` 删除（`LoadedMemoryEntry, LoadedMemorySource` 已不存在）；registry 测试文件（`loaded-memory-registry.test.ts` 若存在）改写为 Set 语义断言。

- [ ] **Step 3: 删除 onTurnStart 机制**

`packages/core/src/agent/loop.ts`：删除 `AgentConfig.onTurnStart` 字段（62 行附近及注释）、`private onTurnStart`（72 行）、构造函数赋值（103 行）、`run()` 中的调用块（109-115 行）。

`packages/core/src/agent/loop.test.ts`：删除 `describe("AgentLoop onTurnStart", ...)` 整块（32 行附近起），以及该块用到的测试夹具（若不再被其他用例使用）。

- [ ] **Step 4: hooks.ts / cli.ts 清理**

hooks.ts：删除 `memoryRecallHandlerRef` 声明与创建块（401-421 行附近，含 `createMemoryRecallHandler` 调用与 dreamState/registry 传参）；删除 734-736 与 800-802 两处的 `...(process.env.LICODE_MEMORY_RECALL === "off" ? {} : { onTurnStart: memoryRecallHandlerRef.current })`；删除导入 `createMemoryRecallHandler, MemoryRecall, MemoryLoader`（20-36 行附近）。

cli.ts：删除 `MemoryLoader` 导入（21 行附近）。

- [ ] **Step 5: 其余收尾**

- `compressor.ts:58` 注释改为「ToolUseMessage/ToolResultMessage pairs always stay within the turn they belong to」
- `memory.test.ts`：删除 `describe("MemoryLoader (new behaviour)", ...)` 块及其专用夹具
- 全局再搜一次 `sidequery`、`prune` 确认无残留引用（dream/extractor 自身的归档逻辑不含这些词，若搜到的是无关语义则保留）

- [ ] **Step 6: 评测脚本摘掉 baseline 模式**

`packages/core/scripts/eval-recall.ts`：删除 `import { MemoryRecall }` 与 baseline 分支，入口改为只接受 `--mode=tool`（占位报错信息改为「tool 模式由 Task 7 实现」）。基线数据已存档在 `results-baseline.json`，脚本不再依赖被删代码。

- [ ] **Step 7: 构建 + 全量测试**

Run: `pnpm build && pnpm test`
Expected: 全绿。若有遗漏引用按编译错误逐个清理（只允许删除旧机制残留，不得改动其他功能）

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(memory): 删除前置召回/prune/memory_fetch/MemoryLoader/onTurnStart,registry 瘦身 Set 化"
```

---

### Task 7: 评测脚本 tool 模式 + 提示词迭代验收

**Files:**
- Modify: `packages/core/scripts/eval-recall.ts`
- Create: `packages/core/scripts/eval-recall/results-tool.json`（脚本生成，提交存档）
- Modify（按需迭代）: `packages/core/src/conversation/templates/memory-guide.md`、`packages/core/src/tools/builtin/memory-recall.ts` 的 description

**Interfaces:**
- Consumes: Task 2 的 `results-baseline.json`、Task 3-5 的全部产物
- Produces: 最终验收数字（写入 results-tool.json 并在此任务 commit message 中记录）

- [ ] **Step 1: 实现 tool 模式**

`eval-recall.ts` 的 tool 模式（替换 Step 6 的占位）：对每个用例——

```ts
// tool 模式核心片段（接 Task 2 的主流程框架，替换 select 调用部分）
import { AnthropicProvider } from "../src/llm/anthropic.js";
import { ConversationManager } from "../src/conversation/manager.js";
import { SystemPrompt, loadDefaultLayers, currentDateLayer } from "../src/conversation/system-prompt.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { collectResponse } from "../src/agent/react.js";
import { createMemoryRecallTool } from "../src/tools/builtin/memory-recall.js";
import { createRecallAgent } from "../src/memory/recall-agent.js";
import { memoryPresenceLayer } from "../src/memory/presence-layer.js";
import { LoadedMemoryRegistry } from "../src/memory/loaded-memory-registry.js";

const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY!, baseUrl: process.env.ANTHROPIC_BASE_URL });
const memories = await store.listAll();

const perCase = [];
for (const c of cases) {
  // 每个用例独立会话：模拟「候选 system prompt + 一条用户消息」的单轮
  const conv = new ConversationManager({ model: "deepseek-chat" });
  const sp = new SystemPrompt();
  for (const layer of loadDefaultLayers()) sp.addLayer(layer);
  sp.addLayer(currentDateLayer());
  sp.addLayer(memoryPresenceLayer(memories.length));
  conv.systemPrompt = sp;
  conv.addUserMessage(c.query);

  const registry = new LoadedMemoryRegistry();
  const agent = createRecallAgent({ llm: provider, store });
  const tools = new ToolRegistry();
  tools.register(createMemoryRecallTool({ runRecall: (q, kw) => agent.run(q, kw), store, registry }));

  const res = await collectResponse(provider, conv.buildMessages(), tools.toLLMTools(), conv);
  let triggered = false;
  let selectedSlugs: string[] = [];
  if (res.type === "tool-use") {
    const call = res.toolUses.find((t) => t.name === "memory_recall");
    if (call) {
      triggered = true;
      const executor = new ToolExecutor(tools);
      const [toolRes] = await executor.executeParallel([call]);
      const content = toolRes.status === "success" ? toolRes.content : "";
      selectedSlugs = [...content.matchAll(/^## .* \(([^)]+)\)$/gm)].map((m) => m[1]);
    }
  }
  const hit = c.expectedSlugs.length > 0 && c.expectedSlugs.every((s) => selectedSlugs.includes(s));
  perCase.push({ id: c.id, group: c.group, triggered, selectedSlugs, hit });
  console.log(`${c.id} [${c.group}] triggered=${triggered} hit=${hit} selected=${selectedSlugs.join(",") || "-"}`);
}
// summary 计算与 Task 2 相同（recallA / falsePositiveB / precision），C 组只记录不判分
```

- [ ] **Step 2: 跑首轮对比**

Run: `ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY pnpm tsx packages/core/scripts/eval-recall.ts --mode=tool`
Expected: 生成 `results-tool.json`。对照基线：`recallA(新) >= recallA(基线)` 且 `falsePositiveB(新) <= 0.2`

- [ ] **Step 3: 迭代提示词直到达标**

若未达标，按下表定位并修改，然后重跑 Step 2：

| 症状 | 调整点 |
|---|---|
| A 组 triggered=false 多 | memory-guide「何时该召回」列举更具体的场景词（饮食/日程/项目目标/收藏资料）；tool description 首句强化「涉及用户个人化信息时必须调用」 |
| B 组误触发 | memory-guide「何时不该召回」补反例（编程语法/算法/git 等纯技术问题直接答） |
| 触发了但 hit=false | 调 recall-agent 的 buildAgentPrompt（指令强调先 read_memory 再决定） |

每轮迭代记录改了什么、数字怎么变（直接写进 commit message）。**验收标准（spec §5）：recallA(新) ≥ recallA(基线) 且 falsePositiveB(新) ≤ 20%**，达标后把最终 results-tool.json 提交。

- [ ] **Step 4: Commit**

```bash
git add packages/core/scripts/ packages/core/src/conversation/templates/memory-guide.md packages/core/src/tools/builtin/memory-recall.ts
git commit -m "test(memory): 评测 tool 模式+提示词迭代至达标(A组召回 x%→y%,B组误触发 z%)"
```

---

### Task 8: user-guide 文档同步

**Files:**
- Modify: `docs/guide/user-guide.md`

**Interfaces:**
- Consumes: Task 6-7 的最终实现

- [ ] **Step 1: 定位过时段落**

Run: `grep -n "前置召回\|两阶段\|memory_fetch\|side-query\|prune\|剪除" docs/guide/user-guide.md`
Expected: 列出所有描述旧召回机制的小节

- [ ] **Step 2: 逐节改写**

按以下原则改写（外科手术式，只动召回机制描述，不动其他内容）：

- 「前置召回 + 主动召回两方式」→ 「memory_recall 工具自主召回：模型分析用户意图后发起结构化查询，工具内部小模型子 agent 读索引、读正文、摘选片段」
- 「注册表（哈希表）标记已召回记忆」→ 保留但更新为「去重集合：同一会话内重复召回自动跳过」
- 「每轮 React 前清除上一轮前置召回记忆」→ 删除该机制描述（prune 已不存在），可补一句「召回内容作为工具结果保留在历史中，不修改不删除（缓存前缀稳定）」
- FAQ「缓存命中率 50%」条目：四个因素中「1 索引层搅动」「3 prune 断点」更新为过去式并注明「已在 2026-08 重构中消除，见 spec」，「2 side-call 稀释」更新为「前置召回已改为按需工具调用」

**不动**用户未提交的「修改后的话术」段落（spec §7，由用户自行改写）。

- [ ] **Step 3: Commit**

```bash
git add docs/guide/user-guide.md
git commit -m "docs(guide): 召回机制描述同步重构后架构(memory_recall 工具召回,删两阶段/prune 描述)"
```

---

### Task 9: 全量回归

**Files:** 无新增

- [ ] **Step 1: 全量构建 + 测试**

Run: `pnpm build && pnpm test`
Expected: 全绿

- [ ] **Step 2: 冒烟验证（手动）**

```bash
export LICODE_MEMORY_RECALL=on
pnpm start
# 在 CLI 中先让它记一条偏好（如「记住我不吃香菜」），再问「我有什么忌口吗？」
# 预期：模型自主调用 memory_recall（TUI 可见工具调用），回答包含「不吃香菜」
```

再验证关闭开关：

```bash
LICODE_MEMORY_RECALL=off pnpm start
# 预期：工具列表无 memory_recall，问同样问题不会触发召回
```

- [ ] **Step 3: 汇总提交**

```bash
git log --oneline master..HEAD
# 确认 9 个任务提交完整，工作树干净
```

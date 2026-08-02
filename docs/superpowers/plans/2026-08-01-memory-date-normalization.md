# 记忆系统·相对日期绝对化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让记忆系统在写入时把相对日期（去年/昨天/上周等）可靠地转为绝对日期——注入今天日期（根因修复）+ save 内程序化归一化（安全网 + 封死 description 盲区）。

**Architecture:** 纯函数 `normalizeDates(text, now)` 做确定性词表换算（精确词），在 `store.save()` 落盘前对 content+description 各跑一次；extractor/dream/memory-guide 三处 prompt 注入 `今天是 <ISO>` 并把规则改显式（含 description + 模糊词转范围），模糊词交 LLM。无新依赖、无回溯。

**Tech Stack:** TypeScript, vitest, Node `Date`（无日期库）。

## Global Constraints

- 无新依赖：只用 `Date` 做算术（年/月用 `new Date(y, m±n, d)` 构造自动进位），不引 dayjs/date-fns 等。
- 锚点恒为 `now`（写入时间）；不做回溯（现有记忆为测试夹具）。
- 精确词程序化（normalizeDates，覆盖 content+description）；模糊词（最近/前阵子）交 LLM 转范围，程序化不动。
- 频率词（每周/每月/每天/每年）不入词表、不转换（靠精确 token 与上周/本周区分）。
- 注入措辞 `今天是 <ISO>`，与 diary 先例（commit `72833a7`）对齐。
- 测试用 `vi.useFakeTimers({ now })` 钉住 `new Date()`；`normalizeDates` 纯函数直接传固定 `Date`。
- 提交粒度：每个 Task 末尾一次 commit。

**Pre-flight（仅首次）:** 本 worktree 是 `git worktree add` 新建，无 `node_modules`。开工前先在 worktree 根目录 `pnpm install`，否则 `vitest`/`tsc` 不可用。单文件测试用 `npx vitest run <file>`（若 npx 找不到，改 `pnpm exec vitest run <file>`）。

**Spec:** `docs/superpowers/specs/2026-08-01-memory-date-normalization-design.md`

---

## File Structure

- **Create** `packages/core/src/memory/normalize-dates.ts` — 纯函数 `normalizeDates(text, now)`，词表换算。单一职责：相对词->绝对日期。
- **Create** `packages/core/src/memory/normalize-dates.test.ts` — util 单测（年/月/日/周/幂等/最长匹配/频率词/锚点可变）。
- **Modify** `packages/core/src/memory/store.ts:56-104` — `save()` 落盘前对 `finalContent` + `memory.description` 跑 normalizeDates（try/catch 兜底）。
- **Modify** `packages/core/src/memory/memory.test.ts` — 加 save 归一化测试（content+description、盲区、幂等不漂移）。
- **Modify** `packages/core/src/memory/extractor.ts:159,238-279` — `buildPrompt` 加 `now` 参数 + 注入 `今天是 <ISO>`；规则改显式（:277）。
- **Modify** `packages/core/src/memory/extractor.test.ts` — 加 prompt 注入日期测试。
- **Modify** `packages/core/src/memory/dream.ts:316-370` — `buildConsolidatePrompt` 注入 `今天是 <ISO>`（已有 `now`）；规则改显式（:366）；可选补 description 可见性（:326）。
- **Modify** `packages/core/src/memory/dream.test.ts` — 加 consolidate prompt 注入日期测试。
- **Modify** `packages/core/src/conversation/system-prompt.ts` — 新增 `currentDateLayer(now)` 导出。
- **Modify** `packages/core/src/conversation/system-prompt.test.ts` — 加 `currentDateLayer` 测试。
- **Modify** `packages/core/src/conversation/templates/memory-guide.md:50` — 规则改显式。
- **Modify** `packages/cli/src/cli.ts:173-174` — 加载默认层后 `addLayer(currentDateLayer())`。
- **Modify** `packages/cli/src/hooks.ts:479-481` — 同上。

---

## Task 1: normalizeDates 纯函数（词表换算）

**Files:**
- Create: `packages/core/src/memory/normalize-dates.ts`
- Test: `packages/core/src/memory/normalize-dates.test.ts`

**Interfaces:**
- Produces: `normalizeDates(text: string, now?: Date): string` — 后续 Task 2/3/4 消费。

- [ ] **Step 1: 写失败测试**

Create `packages/core/src/memory/normalize-dates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeDates } from "./normalize-dates.js";

const AUG1 = new Date(2026, 7, 1); // 2026-08-01 (local), Saturday
const JAN1 = new Date(2026, 0, 1); // 2026-01-01 (local)
const JAN15 = new Date(2026, 0, 15); // 2026-01-15
const AUG5 = new Date(2026, 7, 5); // 2026-08-05 (Wed) — 跨月周

describe("normalizeDates · 年", () => {
  it("去年/前年/大前年/明年/后年/今年 @ 2026", () => {
    const t = "大前年 前年 去年 今年 明年 后年";
    expect(normalizeDates(t, AUG1)).toBe("2023年 2024年 2025年 2026年 2027年 2028年");
  });
});

describe("normalizeDates · 月", () => {
  it("上个月 @ 2026-08-01 -> 2026年7月", () => {
    expect(normalizeDates("上个月启动", AUG1)).toBe("2026年7月启动");
  });
  it("上个月 @ 2026-01-15 跨年 -> 2025年12月", () => {
    expect(normalizeDates("上个月启动", JAN15)).toBe("2025年12月启动");
  });
  it("上上个月/下个月/下下个月/本月/这个月", () => {
    expect(normalizeDates("上上个月 下个月 下下个月 本月 这个月", AUG1))
      .toBe("2026年6月 2026年9月 2026年10月 2026年8月 2026年8月");
  });
});

describe("normalizeDates · 日", () => {
  it("昨天/前天/大前天/明天/后天/今天 @ 2026-08-01", () => {
    expect(normalizeDates("昨天 前天 大前天 今天 明天 后天", AUG1))
      .toBe("2026年7月31日 2026年7月30日 2026年7月29日 2026年8月1日 2026年8月2日 2026年8月3日");
  });
  it("昨天 @ 2026-01-01 跨年 -> 2025年12月31日", () => {
    expect(normalizeDates("昨天", JAN1)).toBe("2025年12月31日");
  });
});

describe("normalizeDates · 周", () => {
  it("上周 @ 2026-08-05(跨月周) -> 2026-07-27~2026-08-02", () => {
    expect(normalizeDates("上周", AUG5)).toBe("2026-07-27~2026-08-02");
  });
  it("本周 @ 2026-08-05 -> 2026-08-03~2026-08-09（周一首日）", () => {
    expect(normalizeDates("本周", AUG5)).toBe("2026-08-03~2026-08-09");
  });
  it("上上周/下周", () => {
    expect(normalizeDates("上上周 下周", AUG5)).toBe("2026-07-20~2026-07-26 2026-08-10~2026-08-16");
  });
});

describe("normalizeDates · 性质", () => {
  it("锚点可变：同一'去年' @ 2026 -> 2025年；@ 2027 -> 2026年", () => {
    expect(normalizeDates("去年", new Date(2026, 7, 1))).toBe("2025年");
    expect(normalizeDates("去年", new Date(2027, 7, 1))).toBe("2026年");
  });
  it("幂等：对已转换输出再跑无改动", () => {
    const once = normalizeDates("去年和昨天", AUG1);
    expect(normalizeDates(once, AUG1)).toBe(once);
  });
  it("幂等：纯绝对文本不碰", () => {
    expect(normalizeDates("2025年7月15日的记录", AUG1)).toBe("2025年7月15日的记录");
  });
  it("最长匹配：大前年优先于前年", () => {
    expect(normalizeDates("大前年和前年", AUG1)).toBe("2023年和2024年");
  });
  it("最长匹配：上上个月优先于上个月", () => {
    expect(normalizeDates("上上个月", AUG1)).toBe("2026年6月");
  });
  it("频率词保留：每周/每月/每天/每年 不转", () => {
    expect(normalizeDates("每周回顾 每月清点 每天站会 每年复盘", AUG1))
      .toBe("每周回顾 每月清点 每天站会 每年复盘");
  });
  it("共存：去年和2024年的对比", () => {
    expect(normalizeDates("去年和2024年的对比", AUG1)).toBe("2025年和2024年的对比");
  });
  it("空串与无相对词", () => {
    expect(normalizeDates("", AUG1)).toBe("");
    expect(normalizeDates("普通文本无日期", AUG1)).toBe("普通文本无日期");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/core/src/memory/normalize-dates.test.ts`
Expected: FAIL — `Cannot find module './normalize-dates.js'`

- [ ] **Step 3: 写最小实现**

Create `packages/core/src/memory/normalize-dates.ts`:

```ts
/**
 * 把 `text` 里的点时间相对词（去年/昨天/上周/上个月…）换成绝对日期，锚点 `now`。
 *
 * - 精确词程序化确定性换算；模糊词（最近/前阵子）不动，交 LLM。
 * - 频率词（每周/每月/每天/每年）不入表——它们不是点时间，转换会破坏语义。
 * - 幂等：输出不含相对词，再跑无匹配无改动。
 * - 最长匹配优先：大前年先于前年、上上个月先于上个月，正则按长度降序交替。
 * - 无新依赖：用 Date 构造函数做年/月/日进位（`new Date(y, m±n, d)` 自动跨年跨月）。
 */
export function normalizeDates(text: string, now: Date = new Date()): string {
  if (!text) return text;

  const y = now.getFullYear();
  const m = now.getMonth(); // 0-based
  const d = now.getDate();

  const fmtY = (yy: number) => `${yy}年`;
  const fmtM = (date: Date) => `${date.getFullYear()}年${date.getMonth() + 1}月`;
  const fmtD = (date: Date) => `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  const iso = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  // 周一为首日：本周一 = 今天 - (day+6)%7
  const day = now.getDay(); // 0=Sun..6=Sat
  const thisMonday = new Date(y, m, d - ((day + 6) % 7));
  const fmtWeek = (monday: Date) => {
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    return `${iso(monday)}~${iso(sunday)}`;
  };
  const addWeeks = (base: Date, n: number) =>
    new Date(base.getFullYear(), base.getMonth(), base.getDate() + n * 7);

  // 触发词按长度降序排列，避免子串误匹配（大前年先于前年…）。
  // 每条 [触发词, 绝对值]；绝对值由 now 一次算定。
  const entries: Array<[string, string]> = [
    // 年（3字先于2字）
    ["大前年", fmtY(y - 3)],
    ["前年", fmtY(y - 2)],
    ["去年", fmtY(y - 1)],
    ["今年", fmtY(y)],
    ["明年", fmtY(y + 1)],
    ["后年", fmtY(y + 2)],
    // 月（4字先于3字）
    ["上上个月", fmtM(new Date(y, m - 2, 1))],
    ["下下个月", fmtM(new Date(y, m + 2, 1))],
    ["上个月", fmtM(new Date(y, m - 1, 1))],
    ["下个月", fmtM(new Date(y, m + 1, 1))],
    ["这个月", fmtM(new Date(y, m, 1))],
    ["本月", fmtM(new Date(y, m, 1))],
    // 日（3字先于2字）
    ["大前天", fmtD(new Date(y, m, d - 3))],
    ["前天", fmtD(new Date(y, m, d - 2))],
    ["昨天", fmtD(new Date(y, m, d - 1))],
    ["今天", fmtD(new Date(y, m, d))],
    ["明天", fmtD(new Date(y, m, d + 1))],
    ["后天", fmtD(new Date(y, m, d + 2))],
    // 周（3字先于2字）
    ["上上周", fmtWeek(addWeeks(thisMonday, -2))],
    ["下周", fmtWeek(addWeeks(thisMonday, 1))],
    ["上周", fmtWeek(addWeeks(thisMonday, -1))],
    ["本周", fmtWeek(thisMonday)],
    ["这周", fmtWeek(thisMonday)],
  ];

  const lookup = new Map(entries);
  const pattern = new RegExp(entries.map(([k]) => k).join("|"), "g");
  return text.replace(pattern, (match) => lookup.get(match) ?? match);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/core/src/memory/normalize-dates.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/memory/normalize-dates.ts packages/core/src/memory/normalize-dates.test.ts
git commit -m "feat(memory): normalizeDates util — relative date words to absolute (deterministic)"
```

---

## Task 2: save() 内归一化（安全网 + 盲区封口）

**Files:**
- Modify: `packages/core/src/memory/store.ts`（import + save 落盘前归一化）
- Test: `packages/core/src/memory/memory.test.ts`（加 3 个用例）

**Interfaces:**
- Consumes: `normalizeDates(text, now)` from Task 1.
- Produces: `save()` 落盘的 content/description 已是绝对日期（后续 Task 无需再关心）。

- [ ] **Step 1: 写失败测试**

在 `packages/core/src/memory/memory.test.ts` 顶部改两处 import：

```ts
// vitest import 加 vi：
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// node:fs import 加 readFileSync（现有行未含）：
import { mkdtempSync, rmSync, existsSync, utimesSync, writeFileSync, mkdirSync, statSync, readFileSync } from "node:fs";
```

在文件末尾追加新 describe 块：

```ts
describe("MemoryStore date normalization", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; }
    vi.useRealTimers();
  });

  it("save normalizes relative dates in content AND description", async () => {
    vi.useFakeTimers({ now: new Date(2026, 7, 1) });
    dir = mkdtempSync(path.join(tmpdir(), "licode-norm-"));
    const store = new MemoryStore(dir);
    const mem = makeMemory({
      slug: "project/launch",
      type: "project",
      content: "用户去年启动了项目，上个月完成评审。",
      description: "去年定的方案",
    });
    await store.save(mem);
    const raw = readFileSync(path.join(dir, "project", "launch.md"), "utf-8");
    expect(raw).toContain("2025年");
    expect(raw).toContain("2026年7月");
    expect(raw).not.toContain("去年");
    expect(raw).not.toContain("上个月");
  });

  it("save seals the description blind spot (description-only relative date)", async () => {
    vi.useFakeTimers({ now: new Date(2026, 7, 5) }); // 2026-08-05 Wed
    dir = mkdtempSync(path.join(tmpdir(), "licode-norm-"));
    const store = new MemoryStore(dir);
    const mem = makeMemory({
      slug: "project/progress",
      type: "project",
      content: "无相对日期的正文。",
      description: "上周的进展",
    });
    await store.save(mem);
    const raw = readFileSync(path.join(dir, "project", "progress.md"), "utf-8");
    // 上周 of 2026-08-05 -> 2026-07-27~2026-08-02
    expect(raw).toContain("2026-07-27~2026-08-02");
    expect(raw).not.toContain("上周");
  });

  it("save is idempotent across rewrites (no drift with later now)", async () => {
    vi.useFakeTimers({ now: new Date(2026, 7, 1) });
    dir = mkdtempSync(path.join(tmpdir(), "licode-norm-"));
    const store = new MemoryStore(dir);
    await store.save(makeMemory({
      slug: "project/launch", type: "project",
      content: "去年启动", description: "去年方案",
    }), "create");
    // 6 个月后 update 同一文件，旧已绝对化的日期不被新 now 重算
    vi.useFakeTimers({ now: new Date(2027, 1, 1) });
    await store.save(makeMemory({
      slug: "project/launch", type: "project",
      content: "2025年启动，新增内容", description: "2025年方案",
    }), "update");
    const raw = readFileSync(path.join(dir, "project", "launch.md"), "utf-8");
    expect(raw).toContain("2025年启动");
    expect(raw).not.toContain("去年");
  });
});
```

（`readFileSync` 已在 Step 1 加入 `node:fs` import；`makeMemory` helper 在文件顶部已定义，直接复用。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/core/src/memory/memory.test.ts -t "date normalization"`
Expected: FAIL — `expected '去年启动了项目…' to contain '2025年'`（save 尚未归一化）

- [ ] **Step 3: 写最小实现**

在 `packages/core/src/memory/store.ts` 顶部加 import：

```ts
import { normalizeDates } from "./normalize-dates.js";
```

在 `save()` 内、`const frontmatter = [`（约 line 88）之前插入：

```ts
    // 程序化归一化：落盘前把 content+description 的精确相对词转绝对日期。
    // 锚点 now（写入时间）；幂等；try/catch 兜底，绝不阻断 save。
    // 对 description 也跑——从结构上封死 dream consolidate 看不到 description 的盲区。
    const writeNow = new Date();
    try {
      finalContent = normalizeDates(finalContent, writeNow);
      memory.description = normalizeDates(memory.description, writeNow);
    } catch {
      // best-effort: 归一化失败则保留原文
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/core/src/memory/memory.test.ts`
Expected: PASS（含新 3 用例 + 既有全过）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/memory/store.ts packages/core/src/memory/memory.test.ts
git commit -m "feat(memory): normalize relative dates in save() (content+description, blind-spot seal)"
```

---

## Task 3: extractor 注入今天日期 + 规则显式

**Files:**
- Modify: `packages/core/src/memory/extractor.ts:159,238-279`
- Test: `packages/core/src/memory/extractor.test.ts`

**Interfaces:**
- Consumes: 无（extractor 自带 `now` 概念）。
- Produces: extractor prompt 含 `今天是 <ISO>`；LLM 据此转模糊词+精确词（精确词另有 save 兜底）。

- [ ] **Step 1: 写失败测试**

`packages/core/src/memory/extractor.test.ts` 现只测 deprecated `RegexMemoryExtractor`，无 anthropic mock。先改顶部 import + 加 mock（mock 对既有 RegexMemoryExtractor 用例无副作用）：

```ts
// vitest import 加 vi：
import { describe, expect, it, vi } from "vitest";
// 新增 import：
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { MemoryExtractor } from "./extractor.js";
import { MemoryStore } from "./store.js";

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
```

在文件末尾追加新 describe（用 LLM stub 捕获 prompt，mirror diary 测试手法）：

```ts
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
```

（`extract` 的 messages 参数为 `readonly Message[]`，用 `as any` 兼容字面量；`new MemoryExtractor()` 因上面 mock 不需真实 key；`llm.chat` 被 stub 覆盖以捕获 prompt。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/core/src/memory/extractor.test.ts -t "date injection"`
Expected: FAIL — `expected '' to contain '2026-08-01'`（prompt 未注入日期）

- [ ] **Step 3: 写最小实现**

在 `packages/core/src/memory/extractor.ts`：

(a) `extract()` 内 line 159 改为传入 now：

```ts
      const prompt = this.buildPrompt(indexContent, existingMemories, conversationText, new Date());
```

(b) `buildPrompt` 签名（line 238）加 `now: Date`：

```ts
  private buildPrompt(
    indexContent: string,
    existingMemories: readonly Memory[],
    conversationText: string,
    now: Date
  ): string {
```

(c) 在 `buildPrompt` 返回数组的开头（`"Analyze the most recent conversation messages..."` 之后）插入日期行，并把 line 277 规则改显式：

```ts
    return [
      "Analyze the most recent conversation messages and update the persistent memory system.",
      `今天是 ${now.toISOString().slice(0, 10)}。`,
      "",
      "## Existing memories (index + full content)",
      existingSection,
      "",
      "## Recent conversation",
      conversationText,
      "",
      "## Instructions",
      "",
      "从对话中识别值得跨会话保存的信息，输出 JSON 数组（无新信息则输出 []）：",
      '[{"action":"create|update|append","slug":"<type>/<kebab-case>","type":"user|feedback|project|reference","name":"简短名称","description":"一句话描述","content":"完整正文"}]',
      "",
      "Rules:",
      "- create：新主题；update：改写已有文件正文（slug 必须匹配现有文件）；append：向已有文件补充新段落",
      "- 新信息与现有记忆矛盾时，必须用 update 重写，以最新信息为准--禁止让矛盾并存",
      "- feedback 类型只记录用户明确纠正过的行为或确认过的非显然做法，content 中必须包含规则、原因（Why:）和适用范围（How to apply:）",
      "- 不要保存：代码模式与架构、git 历史、调试方案、当前任务进度、一次性问答、琐碎闲聊",
      "- 用户在提问而非陈述事实时，跳过",
      "- 把 description 与 content 中的相对日期转换为绝对日期；精确词（昨天/上周/去年）转确切日期，模糊词（最近/前阵子）转大致范围（如\"2026年7月前后\"）",
      "- 只使用上述最近对话中的内容；不要臆测或补充对话中不存在的信息",
    ].join("\n");
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/core/src/memory/extractor.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/memory/extractor.ts packages/core/src/memory/extractor.test.ts
git commit -m "feat(memory): inject today's date into extractor prompt + field-explicit rule"
```

---

## Task 4: dream consolidate 注入今天日期 + 规则显式 + description 可见性

**Files:**
- Modify: `packages/core/src/memory/dream.ts:316-370`（buildConsolidatePrompt）
- Test: `packages/core/src/memory/dream.test.ts`

**Interfaces:**
- Consumes: `buildConsolidatePrompt` 已有 `now: number` 参数。
- Produces: consolidate prompt 含 `今天是 <ISO>` + description 可见（补 :326）。

- [ ] **Step 1: 写失败测试**

在 `packages/core/src/memory/dream.test.ts` 末尾追加（直接测 `buildConsolidatePrompt`，无 side effect）：

```ts
describe("MemoryDream.buildConsolidatePrompt date injection", () => {
  it("includes today's date, the field-explicit rule, and per-memory description", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dream-cons-"));
    try {
      const store = new MemoryStore(dir);
      const dream = new MemoryDream();
      const mem = makeMemory("user/food");
      mem.description = "去年定的口味";
      const prompt = (dream as any).buildConsolidatePrompt(
        "## index", [mem], [], new Map(), new Set(), new Date(2026, 7, 1).getTime()
      );
      expect(prompt).toContain("2026-08-01");
      expect(prompt).toMatch(/相对日期/);
      expect(prompt).toContain("description");
      expect(prompt).toContain("去年定的口味"); // description 现在可见
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

（确认 `makeMemory` 在 dream.test.ts 顶部已定义且可设 description；若其默认 description 不含相对词，按上显式赋值。`buildConsolidatePrompt` 是 private，用 `(dream as any)` 访问。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/core/src/memory/dream.test.ts -t "date injection"`
Expected: FAIL — prompt 不含 `2026-08-01`、不含 description 内容

- [ ] **Step 3: 写最小实现**

在 `packages/core/src/memory/dream.ts` `buildConsolidatePrompt`（line 316-370）：

(a) line 326 补 description（与 Orient :161 / extractor :251 一致）：

```ts
    for (const m of all) memParts.push(`### ${m.slug}\ndescription: ${m.description}\ncontent:\n${m.content}`);
```

(b) 在返回数组开头插入日期行（`now` 是 epoch ms）：

```ts
    return [
      "You are performing a dream - consolidate the memory system based on evidence.",
      `今天是 ${new Date(now).toISOString().slice(0, 10)}。`,
      "",
      "## Existing memories (index + full content)",
      memParts.join("\n\n"),
      // …其余不变…
```

(c) line 366 规则改显式：

```ts
      "- 把 description 与 content 中的相对日期转换为绝对日期；精确词（昨天/上周/去年）转确切日期，模糊词（最近/前阵子）转大致范围（如\"2026年7月前后\"）",
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/core/src/memory/dream.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/memory/dream.ts packages/core/src/memory/dream.test.ts
git commit -m "feat(memory): inject date + show description in dream consolidate prompt + explicit rule"
```

---

## Task 5: system-prompt currentDateLayer + 接线 + memory-guide 规则

**Files:**
- Modify: `packages/core/src/conversation/system-prompt.ts`（新增 `currentDateLayer`）
- Test: `packages/core/src/conversation/system-prompt.test.ts`
- Modify: `packages/core/src/conversation/templates/memory-guide.md:50`
- Modify: `packages/cli/src/cli.ts:173-174`
- Modify: `packages/cli/src/hooks.ts:479-481`

**Interfaces:**
- Produces: `currentDateLayer(now?): SystemPromptLayer` — Write 工具路径靠它拿到今天日期。

- [ ] **Step 1: 写失败测试**

在 `packages/core/src/conversation/system-prompt.test.ts` 的 import 加 `currentDateLayer`：

```ts
import { SystemPrompt, SystemPromptLayer, loadDefaultLayers, currentDateLayer } from "./system-prompt.js";
```

在文件末尾追加：

```ts
describe("currentDateLayer", () => {
  it("returns an always-on layer at priority 3 with today's ISO date", () => {
    const layer = currentDateLayer(new Date("2026-08-01T12:00:00Z"));
    expect(layer.name).toBe("current-date");
    expect(layer.priority).toBe(3);
    expect(layer.always).toBe(true);
    expect(layer.content).toContain("2026-08-01");
  });

  it("defaults to real now when omitted", () => {
    const layer = currentDateLayer();
    expect(layer.content).toMatch(/今天是 \d{4}-\d{2}-\d{2}。/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/core/src/conversation/system-prompt.test.ts -t "currentDateLayer"`
Expected: FAIL — `currentDateLayer is not exported`

- [ ] **Step 3: 写最小实现**

(a) 在 `packages/core/src/conversation/system-prompt.ts` `loadDefaultLayers` 之后新增：

```ts
/**
 * 动态层：当前日期（ISO）。always-on，priority 3（safety 与 memory-guide 之间）。
 * 给主 Agent（Write 工具路径）提供相对日期换算锚点——memory-guide 里的
 * "把相对日期转换为绝对日期"规则因此能真正执行。措辞与 diary 先例对齐。
 */
export function currentDateLayer(now: Date = new Date()): SystemPromptLayer {
  return {
    name: "current-date",
    priority: 3,
    always: true,
    content: `今天是 ${now.toISOString().slice(0, 10)}。`,
  };
}
```

(b) `packages/core/src/conversation/templates/memory-guide.md:50` 改为：

```markdown
- 把 description 与 content 中的相对日期转换为绝对日期；精确词（昨天/上周/去年）转确切日期，模糊词（最近/前阵子）转大致范围（如"2026年7月前后"）
```

(c) `packages/cli/src/cli.ts` import 加 `currentDateLayer`，并在 line 173-174 的循环后追加一行：

```ts
  for (const layer of loadDefaultLayers()) {
    systemPrompt.addLayer(layer);
  }
  systemPrompt.addLayer(currentDateLayer());
```

(d) `packages/cli/src/hooks.ts` import 加 `currentDateLayer`，并在 line 479-481 的循环后追加：

```ts
      const layers = loadDefaultLayers();
      for (const layer of layers) {
        systemPrompt.addLayer(layer);
      }
      systemPrompt.addLayer(currentDateLayer());
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/core/src/conversation/system-prompt.test.ts`
Expected: PASS（含新 currentDateLayer 用例；loadDefaultLayers 既有用例不受影响——未改该函数）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/conversation/system-prompt.ts packages/core/src/conversation/system-prompt.test.ts packages/core/src/conversation/templates/memory-guide.md packages/cli/src/cli.ts packages/cli/src/hooks.ts
git commit -m "feat(memory): currentDateLayer + wire into system prompt + memory-guide explicit rule"
```

---

## Task 6: 全量回归

**Files:** 无修改，仅运行。

- [ ] **Step 1: 跑全量测试**

Run: `npm test`
Expected: 全部 PASS（memory/dream/recall/hook/extractor/conversation/cli 全套）。重点确认：
- `normalize-dates.test.ts` 全过
- `memory.test.ts` 既有用例 + 新归一化用例全过（save 单次写未破坏 mtime/索引语义）
- `extractor.test.ts`、`dream.test.ts`、`system-prompt.test.ts` 全过
- `loadDefaultLayers` 既有用例未受影响（Task 5 未改该函数）

- [ ] **Step 2: 构建检查**

Run: `npm run build`
Expected: TypeScript 编译零错（确认 `normalize-dates.ts` import、`currentDateLayer` 导出、buildPrompt 签名变更均通过 tsc）

- [ ] **Step 3: 若有失败，修复后重跑 Step 1-2 直至全绿**

- [ ] **Step 4: 最终提交（如有修复）**

```bash
git add -A
git commit -m "test(memory): regression green for date normalization"
```

（全绿则无此提交。）

---

## Self-Review

**1. Spec coverage:**
- §3.2 normalizeDates 工具 → Task 1 ✓
- §3.3 save() 内归一化（含盲区封口、try/catch、单次写）→ Task 2 ✓
- §3.4 注入今天日期（extractor / dream consolidate / memory-guide 层）→ Task 3 / Task 4 / Task 5 ✓
- §3.5 规则显式化 + 模糊词指引（三处）→ Task 3（:277）/ Task 4（:366）/ Task 5（memory-guide:50）✓
- §3.6 consolidate 补 description 可见性（可选）→ Task 4 ✓
- §4 错误处理（幂等/最长匹配/频率词/跨月跨年/周首日/空字段/不阻断/Write 路径限制）→ Task 1 用例 + Task 2 try/catch ✓
- §5 测试矩阵 → 各 Task 内 ✓
- §1.4 diary 先例对齐 → Task 3/4/5 措辞 `今天是 <ISO>` ✓
- §1.5 无回溯 → 无回溯任务 ✓

**2. Placeholder scan:** 无 TBD/TODO；每个代码步骤含真实代码；测试含真实断言。✓

**3. Type consistency:**
- `normalizeDates(text: string, now?: Date): string` — Task 1 定义，Task 2 消费（`normalizeDates(finalContent, writeNow)` / `normalizeDates(memory.description, writeNow)`）✓
- `currentDateLayer(now?: Date): SystemPromptLayer` — Task 5 定义并在 cli.ts/hooks.ts 消费 ✓
- `buildPrompt(..., now: Date)` — Task 3 签名与 extract 调用一致 ✓
- `buildConsolidatePrompt(..., now: number)` — Task 4 沿用既有 `now: number`，注入用 `new Date(now)` ✓

无命名/类型漂移。

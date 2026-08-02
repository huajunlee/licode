# 第二大脑 · phase 3（决策顾问）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `decide` / `decide_save` 两个 builtin 工具，让 LICode 在用户请求决策/意见时汇聚历史决定/事实/人物/近期日记给出 B 式分析（证据不足降级 C），并按用户确认把决策直写日记文件夹（gated，永不进 memory）。

**Architecture:** 两个工具各配一个纯函数（`gatherDecisionContext` / `buildDecisionEntry`），工具壳只做"加载 store -> 调纯函数 -> 返回"。注册进 `builtinTools` 即被 CLI 自动注册，不改 hooks.ts。读侧纯确定性汇聚 + 主 LLM 综合；写侧直写 `.licode/journal/`、不调 memory/promote/extractor。

**Tech Stack:** TypeScript（ESM，`.js` 导入）、vitest、zod、`node:fs`/`node:path`。零新依赖。分支 `worktree-second-brain-phase3`。

## Global Constraints

- ESM TS，相对导入用 `.js` 扩展名（如 `from "../../diary/types.js"`）。
- 测试用 vitest，`*.test.ts` 与源码同目录；运行 `pnpm test <file>`（= `vitest run <file>`）。
- 零新依赖；仅用 `node:fs`、`node:path`、现有 `@licode/core` 导出及 `zod`（已用于 `tools/builtin`）。
- `pnpm build` 零 TS 错；现有测试不回归。
- 不改 `hooks.ts`、`memory/`、`diary/extractor.ts`、`diary/promote.ts`、`diary/dispatch.ts`。
- `decide_save` 直写 journal，**不调** MemoryStore / autoPromoteEntry / extractor（gating 硬约束）。
- 存储路径：日记 `.licode/journal/`、人物 `.licode/people/`（工具用 `context.workingDirectory` 拼接）。
- entry id = `now.getTime().toString(36)`（与 `DiarySession` 一致）。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `packages/core/src/tools/builtin/decide.ts`（新） | `gatherDecisionContext()` 纯函数 + `decideTool` |
| `packages/core/src/tools/builtin/decide.test.ts`（新） | 汇聚逻辑 + 工具壳单测 |
| `packages/core/src/tools/builtin/decide-save.ts`（新） | `buildDecisionEntry()` 纯函数 + `decideSaveTool` |
| `packages/core/src/tools/builtin/decide-save.test.ts`（新） | 构造 + round-trip + gating 单测 |
| `packages/core/src/tools/builtin/index.ts`（改） | 注册 `decideTool` + `decideSaveTool` |
| `packages/core/src/index.ts`（改） | 导出 `decideTool` + `decideSaveTool` |

---

### Task 1: gatherDecisionContext 纯函数（决策上下文汇聚）

**Files:**
- Create: `packages/core/src/tools/builtin/decide.ts`
- Test: `packages/core/src/tools/builtin/decide.test.ts`

**Interfaces:**
- Consumes: `DiaryEntry`/`Decision`/`Fact`（`../../diary/types.js`）、`PersonProfile`（`../../people/types.js`）、`hhmmFromISO`（`../../memory/types.js`）、`emptyEntry`（测试用，`../../diary/types.js`）、`emptyProfile`（测试用，`../../people/types.js`）。
- Produces: `gatherDecisionContext(input: GatherInput): string`，`GatherInput = { entries: DiaryEntry[]; profiles: PersonProfile[]; topic: string; people?: string[] }`。Task 2 的 `decideTool` 消费。

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/tools/builtin/decide.test.ts
import { describe, it, expect } from "vitest";
import { gatherDecisionContext } from "./decide.js";
import { emptyEntry } from "../../diary/types.js";
import { emptyProfile } from "../../people/types.js";
import type { DiaryEntry } from "../../diary/types.js";

function entry(id: string, date: string, opts: Partial<DiaryEntry> = {}): DiaryEntry {
  const e = emptyEntry(id, date, `${date}T10:00:00.000Z`);
  Object.assign(e, opts);
  return e;
}

describe("gatherDecisionContext", () => {
  it("话题子串命中含 decisions 的 entry（验证搜了 decisions 字段）", () => {
    const e = entry("e1", "2026-07-30", {
      summary: "今天的事",
      decisions: [{ decision: "决定换架构", reasoning: "旧架构维护成本高", context: null }],
    });
    // summary 不含"换架构"，只有 decisions 含 -> 命中证明搜了 decisions
    const out = gatherDecisionContext({ entries: [e], profiles: [], topic: "换架构" });
    expect(out).toContain("决定换架构");
    expect(out).toContain("旧架构维护成本高");
  });

  it("无话题匹配时兜底近期决定", () => {
    const e = entry("e1", "2026-07-30", {
      decisions: [{ decision: "决定暂缓跳槽", reasoning: "等年终", context: null }],
    });
    const out = gatherDecisionContext({ entries: [e], profiles: [], topic: "换城市" });
    expect(out).toContain("无直接匹配");
    expect(out).toContain("决定暂缓跳槽");
  });

  it("people 参数与匹配 entry 里提到的人 -> 档案进结果", () => {
    const li = emptyProfile("李四", "2026-07-01"); li.summary = "同事";
    const zhao = emptyProfile("赵六", "2026-07-01"); zhao.summary = "朋友";
    const e1 = entry("e1", "2026-07-30", {
      summary: "聊换工作",
      people: [{ name: "赵六", relation: null, relationInferred: false, interaction: "聊", note: null, specific: true }],
    });
    const out = gatherDecisionContext({ entries: [e1], profiles: [li, zhao], topic: "换工作", people: ["李四"] });
    expect(out).toContain("李四");
    expect(out).toContain("赵六");
  });

  it("topic 直接提到的人名 -> 档案进结果", () => {
    const wang = emptyProfile("王总", "2026-07-01"); wang.meta.aliases = ["老板"]; wang.summary = "上级";
    const out = gatherDecisionContext({ entries: [], profiles: [wang], topic: "王总" });
    expect(out).toContain("王总");
  });

  it("最近 5 条 entry 摘要进近期日记", () => {
    const entries = Array.from({ length: 6 }, (_, i) => entry(`e${i}`, `2026-07-2${i}`));
    const out = gatherDecisionContext({ entries, profiles: [], topic: "zzz无匹配" });
    const recentSection = out.split("## 近期日记")[1];
    expect(recentSection.split("\n").filter((l) => l.startsWith("- [")).length).toBe(5);
  });

  it("空 entries 优雅且 framing 仍在", () => {
    const out = gatherDecisionContext({ entries: [], profiles: [], topic: "换工作" });
    expect(out).toContain("暂无与该话题直接相关的历史决定");
    expect(out).toContain("## 分析指引");
  });

  it("B/C framing 文案在输出中", () => {
    const out = gatherDecisionContext({ entries: [], profiles: [], topic: "x" });
    expect(out).toContain("B 式");
    expect(out).toContain("降级 C");
    expect(out).toContain("必须询问");
    expect(out).toContain("decide_save");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/tools/builtin/decide.test.ts`
Expected: FAIL（`./decide.js` 不存在）

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/tools/builtin/decide.ts
import type { DiaryEntry, Decision, Fact } from "../../diary/types.js";
import type { PersonProfile } from "../../people/types.js";
import { hhmmFromISO } from "../../memory/types.js";

const RECENT_LIMIT = 5;
const MAX_CHARS = 10000;

/** 一条 entry 的话题匹配 hay：含 decisions 字段（journal_recall 的 search 不含）。 */
function entryHay(e: DiaryEntry): string {
  return [
    e.raw.content,
    e.summary,
    ...e.people.map((p) => p.name),
    ...e.facts.map((f) => f.what),
    ...e.decisions.map((d) => `${d.decision} ${d.reasoning ?? ""}`),
  ].join("\n").toLowerCase();
}

function formatDecision(d: Decision, date: string): string {
  return `- [${date}] ${d.decision}${d.reasoning ? `（理由：${d.reasoning}）` : ""}`;
}

function formatFact(f: Fact, date: string): string {
  return `- [${date}] ${f.what}`;
}

function formatProfile(p: PersonProfile): string {
  const lines = [`### ${p.meta.canonicalName}（别名：${p.meta.aliases.join(", ") || "无"}）`];
  if (p.summary) lines.push(`概述: ${p.summary}`);
  if (p.traits.length) lines.push(`特质: ${p.traits.join("; ")}`);
  if (p.preferences.length) lines.push(`喜好: ${p.preferences.join("; ")}`);
  if (p.relationshipState.length) lines.push(`关系: ${p.relationshipState.map((r) => `${r.date} ${r.state}`).join("; ")}`);
  if (p.interactions.length) lines.push(`互动: ${p.interactions.map((i) => `${i.date} ${i.event}`).join("; ")}`);
  return lines.join("\n");
}

function formatRecent(e: DiaryEntry): string {
  const hhmm = hhmmFromISO(e.meta.createdAt);
  const title = e.title || (e.summary.length > 60 ? e.summary.slice(0, 60) + "…" : e.summary);
  return `- [${e.meta.date} ${hhmm}] ${title}`;
}

const FRAMING = [
  "## 分析指引",
  "你正在帮用户做决定/给意见。结合以上历史决定、相关事实、相关人物立场与喜好、近期状态，以及系统已自动注入的长期记忆，给出分析：",
  "- 默认 B 式：列 2-3 条可选路径，各自利弊与风险，最后给一个倾向性建议（基于用户历史与处境）。",
  '- 若证据不足以支撑明确判断（信息太少/互相矛盾/超出可判断范围），不要硬编模糊答案--降级 C：把事实与各方立场摆清，明说"目前信息不足以给倾向建议"，把判断权交还用户。',
  "- 涉及人物时结合其特质/喜好/关系状态分析。",
  '- 给出分析后，必须询问用户是否要记下这次决策（如"要不要把这次决策记下来？"）。仅在用户明确同意后调用 decide_save；用户拒绝或不回应则不保存、不主动调 decide_save。',
].join("\n");

export interface GatherInput {
  entries: DiaryEntry[];
  profiles: PersonProfile[];
  topic: string;
  people?: string[];
}

export function gatherDecisionContext(input: GatherInput): string {
  const { entries, profiles, topic, people } = input;
  const topicLower = topic.toLowerCase();

  // 按日期降序（最近在前）；同日按 createdAt 降序
  const sorted = [...entries].sort(
    (a, b) => b.meta.date.localeCompare(a.meta.date) || b.meta.createdAt.localeCompare(a.meta.createdAt)
  );
  const recent = sorted.slice(0, RECENT_LIMIT);

  // 1. 话题匹配（空 topic 不匹配，防 includes("") 命中全部）
  const matching = topicLower ? sorted.filter((e) => entryHay(e).includes(topicLower)) : [];

  // 2. 历史决定：匹配 entry 的 decisions；无匹配则兜底近期 entry 的 decisions
  let decisionEntries: DiaryEntry[];
  let decisionsHeader = "## 历史相关决定";
  if (matching.length) {
    decisionEntries = matching;
  } else {
    decisionEntries = recent;
    decisionsHeader = "## 历史相关决定（无直接匹配，显示近期决定）";
  }
  const decisionLines = decisionEntries.flatMap((e) => e.decisions.map((d) => formatDecision(d, e.meta.date)));
  const decisionsBlock = decisionLines.length
    ? `${decisionsHeader}\n${decisionLines.join("\n")}`
    : "## 历史相关决定\n暂无与该话题直接相关的历史决定";

  // 3. 相关事实：匹配 entry 的 facts
  const factLines = matching.flatMap((e) => e.facts.map((f) => formatFact(f, e.meta.date)));
  const factsBlock = factLines.length ? `## 相关事实\n${factLines.join("\n")}` : "## 相关事实\n暂无相关事实";

  // 4. 相关人物：people 参数 + topic 提到 + 匹配 entry 提到的人
  const names = new Set<string>(people ?? []);
  for (const e of matching) for (const ref of e.people) names.add(ref.name);
  const relatedProfiles = profiles.filter((p) => {
    const inTopic =
      topicLower.includes(p.meta.canonicalName.toLowerCase()) ||
      p.meta.aliases.some((a) => topicLower.includes(a.toLowerCase()));
    const inNames = names.has(p.meta.canonicalName) || p.meta.aliases.some((a) => names.has(a));
    return inTopic || inNames;
  });
  const peopleBlock = relatedProfiles.length
    ? `## 相关人物\n${relatedProfiles.map(formatProfile).join("\n\n")}`
    : "## 相关人物\n暂无相关人物档案";

  // 5. 近期日记
  const recentBlock = recent.length
    ? `## 近期日记\n${recent.map(formatRecent).join("\n")}`
    : "## 近期日记\n暂无日记";

  const content = [
    `# 决策上下文：${topic}`,
    "",
    decisionsBlock,
    "",
    factsBlock,
    "",
    peopleBlock,
    "",
    recentBlock,
    "",
    FRAMING,
  ].join("\n");

  return content.length > MAX_CHARS ? content.slice(0, MAX_CHARS) + "\n... (truncated)" : content;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/core/src/tools/builtin/decide.test.ts`
Expected: PASS（7 用例）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/builtin/decide.ts packages/core/src/tools/builtin/decide.test.ts
git commit -m "feat(decide): gatherDecisionContext 纯函数（汇聚历史决定/事实/人物/近期日记 + B/C framing）"
```

---

### Task 2: decide 工具壳 + 注册 + 导出

**Files:**
- Modify: `packages/core/src/tools/builtin/decide.ts`（追加 `decideTool`）
- Modify: `packages/core/src/tools/builtin/index.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/tools/builtin/decide.test.ts`（追加工具壳用例）

**Interfaces:**
- Consumes: `gatherDecisionContext`（Task 1）、`JournalStore.listAll()`（`../../diary/store.js`）、`PersonProfileStore.listAll()`（`../../people/store.js`）、`Tool`/`ToolContext`/`ToolResult`（`../types.js`）、`z`（`zod`）。
- Produces: `decideTool: Tool<typeof DecideParams>`，name=`"decide"`。Task 4 不依赖本任务；CLI 经 `builtinTools` 自动注册。

- [ ] **Step 1: 追加失败测试**

在 `packages/core/src/tools/builtin/decide.test.ts` 顶部 import 区追加：

```typescript
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decideTool } from "./decide.js";
import { JournalStore } from "../../diary/store.js";
```

在文件末尾追加：

```typescript
describe("decideTool execute", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "decide-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("从 workingDirectory 加载 store 并返回上下文", async () => {
    const store = new JournalStore(path.join(dir, ".licode", "journal"));
    const e = emptyEntry("e1", "2026-07-30", "2026-07-30T10:00:00.000Z");
    e.decisions = [{ decision: "决定换架构", reasoning: "贵", context: null }];
    await store.save(e);

    const res = await decideTool.execute({ topic: "换架构" }, { workingDirectory: dir, sessionId: "s" });
    expect(res.status).toBe("success");
    if (res.status === "success") expect(res.content).toContain("决定换架构");
  });

  it("空目录返回 success 且含暂无提示", async () => {
    const res = await decideTool.execute({ topic: "换工作" }, { workingDirectory: dir, sessionId: "s" });
    expect(res.status).toBe("success");
    if (res.status === "success") expect(res.content).toContain("暂无");
  });

  it("store 读错时返回 error", async () => {
    fs.mkdirSync(path.join(dir, ".licode"));
    fs.writeFileSync(path.join(dir, ".licode", "journal"), "x"); // journal 是文件而非目录 -> readdir 抛错
    const res = await decideTool.execute({ topic: "x" }, { workingDirectory: dir, sessionId: "s" });
    expect(res.status).toBe("error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/tools/builtin/decide.test.ts`
Expected: FAIL（`decideTool` 未导出）

- [ ] **Step 3: 追加 decideTool 实现**

在 `packages/core/src/tools/builtin/decide.ts` 顶部 import 区追加：

```typescript
import { z } from "zod";
import * as path from "node:path";
import type { Tool } from "../types.js";
import { JournalStore } from "../../diary/store.js";
import { PersonProfileStore } from "../../people/store.js";
```

在文件末尾追加：

```typescript
const DecideParams = z.object({
  topic: z
    .string()
    .describe("需要做决定或征求意见的事情/问题（尽量写关键词，如'换工作'，便于匹配历史）"),
  people: z
    .array(z.string())
    .optional()
    .describe("特别相关的人名（可选；不填则自动从话题与历史中找）"),
});

export const decideTool: Tool<typeof DecideParams> = {
  name: "decide",
  description:
    "当用户请你帮忙做决定、拿主意，或征求意见/建议时调用（如\"帮我决定要不要…\"\"你觉得我该不该…\"\"给我点建议\"）。" +
    "汇聚历史决定/事实/人物/近期日记供你给依据分析。闲聊、问事实、执行任务时不要调用。用户确认记下决策时用 decide_save。话题尽量写关键词便于匹配。",
  parameters: DecideParams,
  async execute(input, context) {
    try {
      const journalStore = new JournalStore(
        path.join(context.workingDirectory, ".licode", "journal")
      );
      const profileStore = new PersonProfileStore(
        path.join(context.workingDirectory, ".licode", "people")
      );
      const [entries, profiles] = await Promise.all([
        journalStore.listAll(),
        profileStore.listAll(),
      ]);
      const content = gatherDecisionContext({
        entries,
        profiles,
        topic: input.topic,
        people: input.people,
      });
      return {
        status: "success",
        content,
        metadata: { entries: entries.length, profiles: profiles.length },
      };
    } catch (err) {
      return {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        errorType: "execution",
      };
    }
  },
};
```

- [ ] **Step 4: 注册 + 导出**

`packages/core/src/tools/builtin/index.ts`：在 import 区追加两行、`builtinTools` 数组与 re-export 各追加 `decideTool`（`decideSaveTool` 留 Task 4）：

```typescript
import { decideTool } from "./decide.js";
```

```typescript
export const builtinTools: Tool[] = [
  bashTool,
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  journalRecallTool,
  profileRecallTool,
  decideTool,
];
```

```typescript
export { bashTool, readTool, writeTool, editTool, globTool, grepTool, journalRecallTool, profileRecallTool, decideTool };
```

`packages/core/src/index.ts`：在 `export { ... } from "./tools/builtin/index.js"` 块的导出名列表追加 `decideTool,`（置于 `profileRecallTool,` 之后）。

- [ ] **Step 5: Run test + build**

Run: `pnpm test packages/core/src/tools/builtin/decide.test.ts && pnpm build`
Expected: 测试 PASS（7 + 3 用例）；build 零 TS 错。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tools/builtin/decide.ts packages/core/src/tools/builtin/decide.test.ts packages/core/src/tools/builtin/index.ts packages/core/src/index.ts
git commit -m "feat(decide): decide 工具壳 + 注册 + 导出（读 journal/people 汇聚上下文）"
```

---

### Task 3: buildDecisionEntry 纯函数（决策 DiaryEntry 构造）

**Files:**
- Create: `packages/core/src/tools/builtin/decide-save.ts`
- Test: `packages/core/src/tools/builtin/decide-save.test.ts`

**Interfaces:**
- Consumes: `DiaryEntry`/`PersonRef`（`../../diary/types.js`）、`formatLocalDate`（`../../util/date.js`）、`serializeEntry`/`parseEntry`（测试用，`../../diary/serialize.js`）。
- Produces: `buildDecisionEntry(input: BuildEntryInput): DiaryEntry`，`BuildEntryInput = { topic; decision; reasoning; people?: string[]; now: () => Date }`。Task 4 的 `decideSaveTool` 消费。

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/tools/builtin/decide-save.test.ts
import { describe, it, expect } from "vitest";
import { buildDecisionEntry } from "./decide-save.js";
import { serializeEntry, parseEntry } from "../../diary/serialize.js";

const NOW = () => new Date("2026-08-01T10:00:00.000Z");

describe("buildDecisionEntry", () => {
  it("产出正确 meta（id 为 base36 时间戳）、title 标记、decisions、summary", () => {
    const e = buildDecisionEntry({ topic: "换工作", decision: "先不动", reasoning: "等年终", now: NOW });
    expect(e.meta.id).toBe(NOW().getTime().toString(36));
    expect(e.meta.date).toBe("2026-08-01");
    expect(e.title).toBe("【决策】换工作");
    expect(e.summary).toBe("先不动");
    expect(e.decisions).toEqual([{ decision: "先不动", reasoning: "等年终", context: "换工作" }]);
  });

  it("people 映射为 PersonRef", () => {
    const e = buildDecisionEntry({ topic: "t", decision: "d", reasoning: "r", people: ["王总", "李四"], now: NOW });
    expect(e.people).toEqual([
      { name: "王总", relation: null, relationInferred: false, interaction: "决策涉及", note: null, specific: true },
      { name: "李四", relation: null, relationInferred: false, interaction: "决策涉及", note: null, specific: true },
    ]);
  });

  it("futureMemory 为空（gating）", () => {
    const e = buildDecisionEntry({ topic: "t", decision: "d", reasoning: "r", now: NOW });
    expect(e.futureMemory).toEqual([]);
  });

  it("round-trip：serialize -> parse 关键字段保持", () => {
    const e = buildDecisionEntry({ topic: "换工作", decision: "先不动", reasoning: "等年终奖", people: ["王总"], now: NOW });
    const parsed = parseEntry(serializeEntry(e))!;
    expect(parsed).not.toBeNull();
    expect(parsed.meta.id).toBe(e.meta.id);
    expect(parsed.meta.date).toBe("2026-08-01");
    expect(parsed.title).toBe("【决策】换工作");
    expect(parsed.summary).toBe("先不动");
    expect(parsed.decisions[0]).toEqual({ decision: "先不动", reasoning: "等年终奖", context: "换工作" });
    expect(parsed.people[0].name).toBe("王总");
    expect(parsed.futureMemory).toEqual([]);
    expect(parsed.raw.content).toContain("先不动");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/tools/builtin/decide-save.test.ts`
Expected: FAIL（`./decide-save.js` 不存在）

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/tools/builtin/decide-save.ts
import type { DiaryEntry, PersonRef } from "../../diary/types.js";
import { formatLocalDate } from "../../util/date.js";

export interface BuildEntryInput {
  topic: string;
  decision: string;
  reasoning: string;
  people?: string[];
  now: () => Date;
}

export function buildDecisionEntry(input: BuildEntryInput): DiaryEntry {
  const { topic, decision, reasoning, people, now } = input;
  const d = now();
  const iso = d.toISOString();
  const peopleRefs: PersonRef[] = (people ?? []).map((name) => ({
    name,
    relation: null,
    relationInferred: false,
    interaction: "决策涉及",
    note: null,
    specific: true,
  }));
  return {
    meta: { id: d.getTime().toString(36), date: formatLocalDate(d), createdAt: iso, endedAt: iso },
    raw: {
      content: `# 决策：${topic}\n\n## 结论\n${decision}\n\n## 理由与分析\n${reasoning}`,
      segments: [],
    },
    title: `【决策】${topic}`,
    summary: decision,
    facts: [],
    decisions: [{ decision, reasoning, context: topic }],
    emotions: [],
    people: peopleRefs,
    futureMemory: [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/core/src/tools/builtin/decide-save.test.ts`
Expected: PASS（4 用例）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/builtin/decide-save.ts packages/core/src/tools/builtin/decide-save.test.ts
git commit -m "feat(decide): buildDecisionEntry 纯函数（构造决策 DiaryEntry + round-trip + futureMemory 空）"
```

---

### Task 4: decide_save 工具壳 + 注册 + 导出 + gating 回归

**Files:**
- Modify: `packages/core/src/tools/builtin/decide-save.ts`（追加 `decideSaveTool`）
- Modify: `packages/core/src/tools/builtin/index.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/tools/builtin/decide-save.test.ts`（追加工具壳 + gating 用例）

**Interfaces:**
- Consumes: `buildDecisionEntry`（Task 3）、`JournalStore.save()`（`../../diary/store.js`）、`Tool`（`../types.js`）、`z`（`zod`）。
- Produces: `decideSaveTool`，name=`"decide_save"`。CLI 经 `builtinTools` 自动注册。

- [ ] **Step 1: 追加失败测试**

在 `packages/core/src/tools/builtin/decide-save.test.ts` 顶部：把已有 `import { describe, it, expect } from "vitest";` 改为：

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
```

并追加：

```typescript
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decideSaveTool } from "./decide-save.js";
import { JournalStore } from "../../diary/store.js";
```

在文件末尾追加（与已有 `describe("buildDecisionEntry")` 并列，vitest 允许同文件多 describe）：

```typescript
describe("decideSaveTool execute", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsave-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("写入 journal 且能读回", async () => {
    const res = await decideSaveTool.execute(
      { topic: "换工作", decision: "先不动", reasoning: "等年终" },
      { workingDirectory: dir, sessionId: "s" }
    );
    expect(res.status).toBe("success");
    if (res.status === "success") {
      const meta = res.metadata as { id: string; date: string };
      const store = new JournalStore(path.join(dir, ".licode", "journal"));
      const loaded = await store.load(meta.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.decisions[0].decision).toBe("先不动");
      expect(loaded!.title).toBe("【决策】换工作");
    }
  });

  it("gating：不产生 memory 文件", async () => {
    await decideSaveTool.execute(
      { topic: "换工作", decision: "先不动", reasoning: "等年终" },
      { workingDirectory: dir, sessionId: "s" }
    );
    expect(fs.existsSync(path.join(dir, ".licode", "memory"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/tools/builtin/decide-save.test.ts`
Expected: FAIL（`decideSaveTool` 未导出）

- [ ] **Step 3: 追加 decideSaveTool 实现**

在 `packages/core/src/tools/builtin/decide-save.ts` 顶部 import 区追加：

```typescript
import { z } from "zod";
import * as path from "node:path";
import type { Tool } from "../types.js";
import { JournalStore } from "../../diary/store.js";
```

在文件末尾追加：

```typescript
const DecideSaveParams = z.object({
  topic: z.string().describe("决策话题"),
  decision: z.string().describe("最终倾向的决定/结论"),
  reasoning: z.string().describe("理由与分析（可含选项与权衡）"),
  people: z.array(z.string()).optional().describe("涉及的人名（可选）"),
});

export const decideSaveTool: Tool<typeof DecideSaveParams> = {
  name: "decide_save",
  description:
    "仅在用户明确确认要保存决策后调用。流程：先由 decide 给出分析 -> 你询问\"要不要记下来\" -> 用户同意 -> 才调本工具写入日记。" +
    "绝不主动保存，用户没明确同意不要调用。",
  parameters: DecideSaveParams,
  async execute(input, context) {
    try {
      const entry = buildDecisionEntry({ ...input, now: () => new Date() });
      const store = new JournalStore(path.join(context.workingDirectory, ".licode", "journal"));
      await store.save(entry);
      return {
        status: "success",
        content: `✅ 已记下决策：${input.decision}（${entry.meta.date} ${entry.meta.id}）`,
        metadata: { id: entry.meta.id, date: entry.meta.date },
      };
    } catch (err) {
      return {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        errorType: "execution",
      };
    }
  },
};
```

- [ ] **Step 4: 注册 + 导出**

`packages/core/src/tools/builtin/index.ts`：import 区追加 `import { decideSaveTool } from "./decide-save.js";`；`builtinTools` 数组追加 `decideSaveTool,`（置于 `decideTool,` 之后）；re-export 行追加 `decideSaveTool`。

`packages/core/src/index.ts`：导出名列表追加 `decideSaveTool,`（置于 `decideTool,` 之后）。

- [ ] **Step 5: 全量验证**

Run: `pnpm test && pnpm build`
Expected: 全绿（decide 7+3、decide-save 4+2、既有不回归）；零 TS 错。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tools/builtin/decide-save.ts packages/core/src/tools/builtin/decide-save.test.ts packages/core/src/tools/builtin/index.ts packages/core/src/index.ts
git commit -m "feat(decide): decide_save 工具壳 + 注册 + 导出 + gating 回归（直写 journal 不进 memory）"
```

---

## Self-Review

**1. Spec coverage：**
- `decide` 工具参数/汇聚四维/framing/截断 → Task 1 + 2 ✓
- `decide_save` 构造 DiaryEntry/id/title/decisions/people/futureMemory 空 → Task 3 ✓
- `decide_save` 工具壳 + 询问-确认 description → Task 4 ✓
- Gating 三重保障（不调 memory/promote/extractor + futureMemory 空 + 测试断言无 memory）→ Task 3（futureMemory 空）+ Task 4（execute 不碰 memory + 测试断言）✓
- 注册 + 导出 → Task 2 + 4 ✓
- 边界（空日记/无匹配/store 错/截断）→ Task 1（空/无匹配/截断）+ Task 2（store 错）✓
- round-trip → Task 3 ✓

**2. Placeholder scan：** 无 TBD/TODO；每步含实际代码与运行命令。✓

**3. Type consistency：** `gatherDecisionContext(input: GatherInput)` 在 Task 1 定义、Task 2 调用签名一致；`buildDecisionEntry(input: BuildEntryInput)` 在 Task 3 定义、Task 4 调用（`{ ...input, now }`）一致；`decideTool`/`decideSaveTool` 命名在 index.ts/导出一致；`PersonRef` 字段（name/relation/relationInferred/interaction/note/specific）与 `diary/types.ts` 一致；`Decision`（decision/reasoning/context）一致。✓

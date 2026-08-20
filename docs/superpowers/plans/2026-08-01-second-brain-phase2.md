# 第二大脑 · phase 2（提升桥 + 人物档案）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 phase-1 日记地基之上实现提升桥（diary `futureMemory` 高优候选 -> 记忆）与人物档案（diary `people` -> 独立档案库）：清晰候选 diary-end 自动落库、模糊候选经 `/diary-curate` 的 curation 引擎（side-call + 人审）整理落库，`dream` 自治合记忆，agent 可经 `profile_recall` 查档案。

**Architecture:** 新增 `packages/core/src/curation/`（共享 side-call 引擎 + 两 pass + session + dispatch）、`packages/core/src/people/`（PersonProfile 类型/序列化/Store/自动入档/profile-curation），`diary/` 下增 `curated.ts`（处理进度索引）与 `promote.ts`（diary-end 自动提升）；扩展 `diary/types.ts`（`PersonRef.specific`）与 `extractor.ts`（prompt 收紧）。CLI 在 `hooks.ts` 旁路接入 diary-end 自动提升/入档 + `/diary-curate`。分两增量：Phase A 先提升桥（memory-curation），Phase B 再人物档案（profile-curation），各增量独立可验证、可回退。

**Tech Stack:** TypeScript（ESM，`.js` 导入）、vitest、pnpm monorepo（`@licode/core` + `packages/cli`）、`node:fs`/`node:path`、zod。零新依赖（zod 已用于 tools）。

## Global Constraints

- ESM TS，相对导入用 `.js` 扩展名（如 `from "./types.js"`）。
- 测试用 vitest，`*.test.ts` 与源码同目录；运行 `pnpm test`（= `vitest run`）。
- 零新依赖；仅用 `node:fs`、`node:path`、现有 `@licode/core` 导出及 `zod`（已用于 `tools/builtin`）。
- Node >=20；pnpm。
- side-model 默认 `deepseek-chat`，经 `AnthropicProvider.chat` 调用；curation 复用，可 `LICODE_DIARY_CURATE_MODEL` 覆盖。
- env：`LICODE_DIARY=off`（整体旁路，沿用 phase-1）、`LICODE_DIARY_MODEL`、`LICODE_DIARY_CURATE_MODEL`（新，可选）。
- 存储路径：记忆 `.licode/memory/<type>/<slug>.md`（现有）、日记 `.licode/journal/YYYY-MM-DD/<id>.md`（现有）、档案 `.licode/people/<slug>.md`（新）、处理进度 `.licode/journal/.curated.json`（新）。
- 不改动 `AgentLoop`、`dream`、`SlashCommand` 接口；diary/curation 是 `hooks.ts` 顶部旁路。日记原文不可变（append-only）。
- `pnpm build` 零 TS 错；现有测试不回归。
- 提升门：`importance:high && promotability:high` 自动；`importance:high && promotability≠high` 走 curation；`importance≠high` 留日记。`people` 无门（specific 自动入档、模糊走 curation）。`other` type 即便 high+high 也走 curation（type 不清）。
- 处理进度索引 `.curated.json` 记已处理 candidate/people key（`${entryId}#c${idx}` / `${entryId}#p${idx}`）；diary-end 自动处理成功的标 key，curation 处理后标 key；curation 只 gather `!index.has(key)` 且符合门控的项。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `packages/core/src/diary/types.ts`（改） | `PersonRef` 增 `specific: boolean` |
| `packages/core/src/diary/extractor.ts`（改） | prompt 收紧（`specific` + `preference` 语义） |
| `packages/core/src/diary/curated.ts`（新） | `CuratedIndex`（`.curated.json` 读写，记已处理 key） |
| `packages/core/src/diary/promote.ts`（新） | `deriveMemory` + `autoPromoteEntry`（high+high 非人物 -> MemoryStore，标 key） |
| `packages/core/src/diary/store.ts`（改） | 增 `listAll(): Promise<DiaryEntry[]>`（curation gather 用） |
| `packages/core/src/curation/types.ts`（新） | curation proposal 类型（A: MemoryCreateProposal；B: 追加 profile proposals） |
| `packages/core/src/curation/memory-curation.ts`（新） | `MemoryCuration`（side-call buildPrompt + parse + 失败降级） |
| `packages/core/src/curation/session.ts`（新） | `CurationSession`（暂存 proposals + apply/reject + 编号清单） |
| `packages/core/src/curation/dispatch.ts`（新） | `handleCurationInput`（`/diary-curate` 调度，A 仅 memory，B 扩 profile） |
| `packages/core/src/people/types.ts`（新） | `PersonProfile` 类型 |
| `packages/core/src/people/serialize.ts`（新） | `serializeProfile`/`parseProfile`（frontmatter + JSON） |
| `packages/core/src/people/store.ts`（新） | `PersonProfileStore`（save/load/listAll/findByName/listRecent） |
| `packages/core/src/people/profile-file.ts`（新） | `autoFileEntry`（具体人 -> 档案机械追加，标 key） |
| `packages/core/src/people/curation/profile-curation.ts`（新） | `ProfileCuration`（解模糊人物 + 合并全档案，side-call） |
| `packages/core/src/tools/builtin/profile-recall.ts`（新） | `profileRecallTool` |
| `packages/core/src/tools/builtin/index.ts`（改） | 注册 `profileRecallTool` |
| `packages/core/src/index.ts`（改） | 导出新增模块 |
| `packages/cli/src/hooks.ts`（改） | diary-end 自动提升/入档 + `/diary-curate` 旁路 + refs + env |

---

# Phase A：提升桥（memory-curation）

> 增量 A 交付后：`/diary-end` 自动提升 high+high 非人物候选到记忆；`/diary-curate` 经 side-call 整理 high+low/`other` 候选、人审确认后入记忆。独立可验证、可回退。

### Task A1: PersonRef.specific + extractor prompt 收紧

**Files:**
- Modify: `packages/core/src/diary/types.ts`
- Modify: `packages/core/src/diary/extractor.ts`
- Test: `packages/core/src/diary/extractor.test.ts`（追加用例）

**Interfaces:**
- Produces: `PersonRef` 增 `specific: boolean`；extractor prompt 指示设 `specific` 且 `preference`=用户自己、人物喜好归 `person_trait`。后续 promote/profile-file/curation 消费 `specific`。

- [ ] **Step 1: 追加失败测试**

在 `packages/core/src/diary/extractor.test.ts` 末尾（现有 `describe` 内）追加：

```typescript
  it("populates PersonRef.specific and routes a person's liking to person_trait", async () => {
    const generate = async () => JSON.stringify({
      summary: "和王总开会",
      facts: [],
      decisions: [],
      emotions: [],
      people: [
        { name: "王总", relation: "上级", relationInferred: true, interaction: "开会", note: "爱喝茶", specific: true },
        { name: "朋友", relation: null, relationInferred: false, interaction: "吃饭", note: null, specific: false },
      ],
      futureMemory: [{ content: "王总爱喝茶", type: "person_trait", importance: "high", promotability: "high", reason: "稳定偏好" }],
    });
    const ex = new DiaryExtractor({ generate });
    const entry = await ex.extract(baseInput);
    expect(entry.people[0].specific).toBe(true);
    expect(entry.people[1].specific).toBe(false);
    expect(entry.futureMemory[0].type).toBe("person_trait");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/diary/extractor.test.ts`
Expected: FAIL（`specific` 字段缺失 / 类型不匹配）

- [ ] **Step 3: 改实现**

`packages/core/src/diary/types.ts`：把 `PersonRef` 接口改为

```typescript
export interface PersonRef { name: string; relation: string | null; relationInferred: boolean; interaction: string; note: string | null; specific: boolean; }
```

`packages/core/src/diary/extractor.ts` `buildPrompt` 中 `people` 与 `futureMemory` 规则行替换为：

```typescript
      "- people: 每个被提到的人都收；关系能推断就填并标 relationInferred；interaction 写这次互动；note 收暴露的喜好/特质；specific=true 表示专有名字（王总/妈妈/张三），false 表示泛称（朋友/同事/老板）。{name, relation, relationInferred, interaction, note, specific}",
      "- futureMemory: 只收“今天之后还可能重要”且“非例行流水账”的。type 语义：person_trait=某人的特质或喜好（王总爱喝茶）；preference=用户自己的偏好（我喜欢早起）；relationship=关系状态；decision=决定；goal=目标；other=其它。{content, type:person_trait|preference|relationship|decision|goal|other, importance:low|medium|high, promotability:low|medium|high, reason}",
```

并把 `buildPrompt` 末尾的 JSON 示例 people 项补 `specific`：

```typescript
      '{"summary":"...","facts":[...],"decisions":[...],"emotions":[...],"people":[{"name":"...","relation":null,"relationInferred":false,"interaction":"...","note":null,"specific":true}],"futureMemory":[...]}',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/core/src/diary/extractor.test.ts`
Expected: PASS（含新用例）

- [ ] **Step 5: 修复既有用例的 `specific` 缺失**

`packages/core/src/diary/serialize.test.ts` 与 `store.test.ts` 中构造 `PersonRef` 处补 `specific: true`（如 `people: [{ name: "老板", ..., specific: false }]`）。运行 `pnpm test packages/core/src/diary/` 全绿。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/diary/types.ts packages/core/src/diary/extractor.ts packages/core/src/diary/extractor.test.ts packages/core/src/diary/serialize.test.ts packages/core/src/diary/store.test.ts
git commit -m "feat(diary): PersonRef.specific + extractor prompt 收紧（preference 语义）"
```

---

### Task A2: CuratedIndex（处理进度索引）

**Files:**
- Create: `packages/core/src/diary/curated.ts`
- Test: `packages/core/src/diary/curated.test.ts`

**Interfaces:**
- Produces: `CuratedIndex`（`constructor(filePath)`、`load(): Promise<Set<string>>`、`mark(keys: string[]): Promise<void>`）。promote/profile-file/curation 消费。key 形如 `${entryId}#c${idx}` / `${entryId}#p${idx}`。

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/diary/curated.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CuratedIndex } from "./curated.js";

describe("CuratedIndex", () => {
  let file: string;
  beforeEach(() => { file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cur-")), ".curated.json"); });
  afterEach(() => { fs.rmSync(path.dirname(file), { recursive: true, force: true }); });

  it("load on missing file returns empty set", async () => {
    const idx = new CuratedIndex(file);
    expect((await idx.load()).size).toBe(0);
  });

  it("mark persists keys and load reads them back", async () => {
    const idx = new CuratedIndex(file);
    await idx.mark(["e1#c0", "e1#p1"]);
    const loaded = await idx.load();
    expect(loaded.has("e1#c0")).toBe(true);
    expect(loaded.has("e1#p1")).toBe(true);
    expect(loaded.has("e1#c9")).toBe(false);
  });

  it("mark is idempotent and additive", async () => {
    const idx = new CuratedIndex(file);
    await idx.mark(["e1#c0"]);
    await idx.mark(["e1#c0", "e1#c1"]);
    const loaded = await idx.load();
    expect(loaded.size).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/diary/curated.test.ts`
Expected: FAIL（`CuratedIndex` 不存在）

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/diary/curated.ts
import * as fs from "node:fs";
import * as path from "node:path";

export class CuratedIndex {
  constructor(private filePath: string) {}

  async load(): Promise<Set<string>> {
    try {
      const raw = await fs.promises.readFile(this.filePath, "utf-8");
      const obj = JSON.parse(raw) as { processed?: string[] };
      return new Set(obj.processed ?? []);
    } catch {
      return new Set();
    }
  }

  async mark(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const current = await this.load();
    for (const k of keys) current.add(k);
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.promises.writeFile(
      this.filePath,
      JSON.stringify({ processed: [...current].sort() }, null, 2),
      "utf-8"
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/core/src/diary/curated.test.ts`
Expected: PASS（3 用例）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/diary/curated.ts packages/core/src/diary/curated.test.ts
git commit -m "feat(diary): CuratedIndex 处理进度索引（.curated.json）"
```

---

### Task A3: deriveMemory + autoPromoteEntry（diary-end 自动提升）

**Files:**
- Create: `packages/core/src/diary/promote.ts`
- Test: `packages/core/src/diary/promote.test.ts`

**Interfaces:**
- Consumes: `DiaryEntry`/`Candidate`（types）、`MemoryStore`（memory/store）、`toSlug`（memory/types）、`CuratedIndex`（A2）。
- Produces: `deriveMemory(candidate, now): Memory`；`autoPromoteEntry(entry, deps): Promise<AutoPromoteResult>`。hooks.ts diary-end 调用。仅提升 `preference/decision/goal` 且 high+high 的候选，标 `${entryId}#c${idx}`。

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/diary/promote.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deriveMemory, autoPromoteEntry } from "./promote.js";
import { CuratedIndex } from "./curated.js";
import { MemoryStore } from "../memory/store.js";
import { emptyEntry, type Candidate } from "./types.js";

const NOW = () => new Date("2026-08-01T10:00:00.000Z");

function cand(content: string, type: Candidate["type"], importance: Candidate["importance"], promotability: Candidate["promotability"]): Candidate {
  return { content, type, importance, promotability, reason: "r" };
}

describe("deriveMemory", () => {
  it("maps preference->user, decision->project, goal->project", () => {
    expect(deriveMemory(cand("我喜欢早起", "preference", "high", "high"), NOW()).type).toBe("user");
    expect(deriveMemory(cand("决定换架构", "decision", "high", "high"), NOW()).type).toBe("project");
    expect(deriveMemory(cand("想学吉他", "goal", "high", "high"), NOW()).type).toBe("project");
  });
  it("derives name from content (truncated) and content/reason", () => {
    const m = deriveMemory(cand("决定下周启用新架构", "decision", "high", "high"), NOW());
    expect(m.content).toBe("决定下周启用新架构");
    expect(m.name.length).toBeLessThanOrEqual(20);
    expect(m.slug.startsWith("project/")).toBe(true);
  });
});

describe("autoPromoteEntry", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "pro-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("promotes only high+high preference/decision/goal, marks their keys, skips other/low", async () => {
    const entry = emptyEntry("e1", "2026-08-01", "2026-08-01T10:00:00.000Z");
    entry.futureMemory = [
      cand("我喜欢早起", "preference", "high", "high"),       // promote
      cand("决定换架构", "decision", "high", "high"),          // promote
      cand("今天和王总吵架", "relationship", "high", "low"),   // skip (not auto)
      cand("其它杂事", "other", "high", "high"),               // skip (other -> curation)
      cand("吃面", "decision", "low", "low"),                  // skip (low importance)
    ];
    const store = new MemoryStore(path.join(dir, "memory"));
    const idx = new CuratedIndex(path.join(dir, ".curated.json"));
    const res = await autoPromoteEntry(entry, { memoryStore: store, curatedIndex: idx, now: NOW });

    expect(res.promoted.length).toBe(2);
    const all = await store.listAll();
    expect(all.length).toBe(2);
    const marked = await idx.load();
    expect(marked.has("e1#c0")).toBe(true);
    expect(marked.has("e1#c1")).toBe(true);
    expect(marked.has("e1#c2")).toBe(false); // relationship high+low not marked -> curation
    expect(marked.has("e1#c3")).toBe(false); // other high+high not marked -> curation
    expect(marked.has("e1#c4")).toBe(false); // low not marked (curation predicate excludes by importance)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/diary/promote.test.ts`
Expected: FAIL（`promote.js` 不存在）

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/diary/promote.ts
import type { DiaryEntry, Candidate } from "./types.js";
import type { CuratedIndex } from "./curated.js";
import type { MemoryStore } from "../memory/store.js";
import { toSlug } from "../memory/types.js";
import type { Memory, MemoryType } from "../memory/types.js";

const TYPE_MAP: Record<string, MemoryType> = {
  preference: "user",
  decision: "project",
  goal: "project",
};

const NAME_MAX = 20;

export function deriveMemory(candidate: Candidate, now: () => Date): Memory {
  const type = TYPE_MAP[candidate.type];
  const iso = now().toISOString();
  const name = candidate.content.length > NAME_MAX ? candidate.content.slice(0, NAME_MAX) : candidate.content;
  return {
    slug: `${type}/${toSlug(candidate.content)}`,
    type,
    name,
    description: candidate.reason,
    content: candidate.content,
    createdAt: iso,
    updatedAt: iso,
  };
}

export interface AutoPromoteDeps {
  memoryStore: MemoryStore;
  curatedIndex: CuratedIndex;
  now: () => Date;
}
export interface AutoPromoteResult {
  promoted: string[];
  markedKeys: string[];
  errors: string[];
}

export async function autoPromoteEntry(entry: DiaryEntry, deps: AutoPromoteDeps): Promise<AutoPromoteResult> {
  const promoted: string[] = [];
  const markedKeys: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < entry.futureMemory.length; i++) {
    const c = entry.futureMemory[i];
    const auto = TYPE_MAP[c.type] && c.importance === "high" && c.promotability === "high";
    if (!auto) continue;
    const key = `${entry.meta.id}#c${i}`;
    try {
      await deps.memoryStore.save(deriveMemory(c, deps.now), "create");
      promoted.push(c.content);
      markedKeys.push(key);
    } catch (err) {
      errors.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (markedKeys.length) await deps.curatedIndex.mark(markedKeys);
  return { promoted, markedKeys, errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/core/src/diary/promote.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/diary/promote.ts packages/core/src/diary/promote.test.ts
git commit -m "feat(diary): deriveMemory + autoPromoteEntry（high+high 自动提升 + 标记）"
```

### Task A4: curation types + MemoryCuration（side-call）

**Files:**
- Create: `packages/core/src/curation/types.ts`
- Create: `packages/core/src/curation/memory-curation.ts`
- Test: `packages/core/src/curation/memory-curation.test.ts`

**Interfaces:**
- Consumes: `Candidate`（diary/types）、`MemoryType`（memory/types）。
- Produces: `PendingCandidate { key, candidate }`、`MemoryCreateProposal { kind:"memory", slug, type, name, description, content, sourceKeys }`；`MemoryCuration`（`constructor({generate})`、`curate(pending): Promise<MemoryCreateProposal[]>`，side-call 失败返回 `[]`）。A5 session 与 A6 dispatch 消费。

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/curation/memory-curation.test.ts
import { describe, it, expect } from "vitest";
import { MemoryCuration } from "./memory-curation.js";
import type { PendingCandidate } from "./types.js";

function pc(key: string, content: string, type: string): PendingCandidate {
  return { key, candidate: { content, type: type as never, importance: "high", promotability: "low", reason: "r" } };
}

describe("MemoryCuration", () => {
  it("clusters pending candidates into create proposals with sourceKeys", async () => {
    const generate = async () => JSON.stringify([
      { slug: "project/arch", type: "project", name: "新架构决定", description: "决定换架构", content: "决定下周启用新架构", sources: [0] },
    ]);
    const c = new MemoryCuration({ generate });
    const props = await c.curate([pc("e1#c0", "决定下周启用新架构", "decision")]);
    expect(props.length).toBe(1);
    expect(props[0].slug).toBe("project/arch");
    expect(props[0].type).toBe("project");
    expect(props[0].sourceKeys).toEqual(["e1#c0"]);
  });

  it("parses proposals wrapped in a json fence", async () => {
    const generate = async () => "```json\n" + JSON.stringify([
      { slug: "user/prefs", type: "user", name: "偏好", description: "d", content: "我喜欢早起", sources: [0] },
    ]) + "\n```";
    const c = new MemoryCuration({ generate });
    const props = await c.curate([pc("e1#c0", "我喜欢早起", "preference")]);
    expect(props[0].sourceKeys).toEqual(["e1#c0"]);
  });

  it("returns [] when side-call throws (skip pass)", async () => {
    const generate = async () => { throw new Error("net"); };
    const c = new MemoryCuration({ generate });
    const props = await c.curate([pc("e1#c0", "x", "other")]);
    expect(props).toEqual([]);
  });

  it("returns [] when response is not JSON", async () => {
    const generate = async () => "nope";
    const c = new MemoryCuration({ generate });
    expect(await c.curate([pc("e1#c0", "x", "other")])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/curation/memory-curation.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/curation/types.ts
import type { Candidate } from "../diary/types.js";
import type { MemoryType } from "../memory/types.js";

export interface PendingCandidate {
  key: string;            // ${entryId}#c${idx}
  candidate: Candidate;
}

export interface MemoryCreateProposal {
  kind: "memory";
  slug: string;
  type: MemoryType;
  name: string;
  description: string;
  content: string;
  sourceKeys: string[];   // candidate keys merged into this memory
}

// Phase B will add: ProfileMergeProposal / ProfileNewProposal / ProfileUpdateProposal
export type Proposal = MemoryCreateProposal;
```

```typescript
// packages/core/src/curation/memory-curation.ts
import type { MemoryType } from "../memory/types.js";
import type { PendingCandidate, MemoryCreateProposal } from "./types.js";

export interface MemoryCurationConfig {
  generate: (prompt: string) => Promise<string>;
}

const VALID_TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];

export class MemoryCuration {
  constructor(private config: MemoryCurationConfig) {}

  async curate(pending: PendingCandidate[]): Promise<MemoryCreateProposal[]> {
    if (pending.length === 0) return [];
    let raw: string;
    try {
      raw = await this.config.generate(this.buildPrompt(pending));
    } catch {
      return [];
    }
    return this.parse(raw, pending);
  }

  private buildPrompt(pending: PendingCandidate[]): string {
    const list = pending.map((p, i) =>
      `[${i}] type=${p.candidate.type} importance=${p.candidate.importance} | ${p.candidate.content}`
    ).join("\n");
    return [
      "你是日记候选记忆的整理器。把下面的 futureMemory 候选合并成少数连贯的长期记忆（窄档：只在这批候选之间合并，不碰库里已有记忆）。",
      "规则：相关候选合并成一条；type 从 user|feedback|project|reference 选（preference 倾向 user、decision/goal 倾向 project）；sources 用候选序号；不臆造。",
      "",
      "候选：",
      list,
      "",
      "只返回 JSON 数组（无则 []）：",
      '[{"slug":"project/xxx","type":"project","name":"简短","description":"一句","content":"正文","sources":[0,1]}]',
    ].join("\n");
  }

  private parse(raw: string, pending: PendingCandidate[]): MemoryCreateProposal[] {
    let s = raw.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const start = s.indexOf("[");
    const end = s.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start) return [];
    let arr: unknown;
    try { arr = JSON.parse(s.slice(start, end + 1)); } catch { return []; }
    if (!Array.isArray(arr)) return [];
    const out: MemoryCreateProposal[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const type = o.type as MemoryType;
      if (!VALID_TYPES.includes(type)) continue;
      const sources = Array.isArray(o.sources) ? (o.sources as number[]).filter((n) => Number.isInteger(n) && n >= 0 && n < pending.length) : [];
      if (sources.length === 0) continue;
      out.push({
        kind: "memory",
        slug: typeof o.slug === "string" ? o.slug : `${type}/untitled`,
        type,
        name: typeof o.name === "string" ? o.name : "untitled",
        description: typeof o.description === "string" ? o.description : "",
        content: typeof o.content === "string" ? o.content : "",
        sourceKeys: sources.map((i) => pending[i].key),
      });
    }
    return out;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/core/src/curation/memory-curation.test.ts`
Expected: PASS（4 用例）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/curation/types.ts packages/core/src/curation/memory-curation.ts packages/core/src/curation/memory-curation.test.ts
git commit -m "feat(curation): MemoryCuration side-call（候选合并 -> create proposals）"
```

---

### Task A5: CurationSession（暂存提议 + apply/reject）

**Files:**
- Create: `packages/core/src/curation/session.ts`
- Test: `packages/core/src/curation/session.test.ts`

**Interfaces:**
- Consumes: `Proposal`/`MemoryCreateProposal`（A4）、`MemoryStore`、`CuratedIndex`。
- Produces: `CurationSession`（`constructor(proposals)`、`formatList(): string`、`apply(selection, deps): Promise<ApplyResult>`）。A6 dispatch 消费。`selection = "all" | number[]`；`ApplyResult = { applied: number; markedKeys: string[] }`。

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/curation/session.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CurationSession } from "./session.js";
import { CuratedIndex } from "../diary/curated.js";
import { MemoryStore } from "../memory/store.js";
import type { MemoryCreateProposal } from "./types.js";

function prop(slug: string, sources: string[]): MemoryCreateProposal {
  return { kind: "memory", slug, type: "project", name: slug, description: "d", content: "c", sourceKeys: sources };
}

describe("CurationSession", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ses-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("formatList numbers proposals grouped by kind", () => {
    const s = new CurationSession([prop("project/a", ["e1#c0"]), prop("user/b", ["e1#c1"])]);
    const txt = s.formatList();
    expect(txt).toContain("1.");
    expect(txt).toContain("project/a");
    expect(txt).toContain("2.");
  });

  it("apply all saves selected memories and marks sourceKeys", async () => {
    const s = new CurationSession([prop("project/a", ["e1#c0"]), prop("user/b", ["e1#c1"])]);
    const store = new MemoryStore(path.join(dir, "memory"));
    const idx = new CuratedIndex(path.join(dir, ".curated.json"));
    const res = await s.apply("all", { memoryStore: store, curatedIndex: idx });
    expect(res.applied).toBe(2);
    expect((await store.listAll()).length).toBe(2);
    const marked = await idx.load();
    expect(marked.has("e1#c0")).toBe(true);
    expect(marked.has("e1#c1")).toBe(true);
  });

  it("apply selected indices only persists chosen, but marks ALL proposed keys (no nag)", async () => {
    const s = new CurationSession([prop("project/a", ["e1#c0"]), prop("user/b", ["e1#c1"])]);
    const store = new MemoryStore(path.join(dir, "memory"));
    const idx = new CuratedIndex(path.join(dir, ".curated.json"));
    const res = await s.apply([0], { memoryStore: store, curatedIndex: idx });
    expect(res.applied).toBe(1);
    expect((await store.listAll()).length).toBe(1);
    const marked = await idx.load();
    expect(marked.has("e1#c0")).toBe(true);
    expect(marked.has("e1#c1")).toBe(true); // not selected but still marked (decided)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/curation/session.test.ts`
Expected: FAIL（`CurationSession` 不存在）

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/curation/session.ts
import type { Proposal, MemoryCreateProposal } from "./types.js";
import type { MemoryStore } from "../memory/store.js";
import type { CuratedIndex } from "../diary/curated.js";

export type Selection = "all" | number[];

export interface ApplyDeps {
  memoryStore: MemoryStore;
  curatedIndex: CuratedIndex;
  // Phase B: profileStore?: PersonProfileStore;
}

export interface ApplyResult {
  applied: number;
  markedKeys: string[];
}

const NOW = () => new Date();

export class CurationSession {
  constructor(private proposals: Proposal[]) {}

  get length(): number { return this.proposals.length; }

  formatList(): string {
    const lines: string[] = [];
    this.proposals.forEach((p, i) => {
      if (p.kind === "memory") {
        lines.push(`${i + 1}. [新建记忆] ${p.slug} "${p.name}"`);
      }
      // Phase B: profile proposal formatting
    });
    return lines.join("\n");
  }

  async apply(selection: Selection, deps: ApplyDeps): Promise<ApplyResult> {
    const chosen = new Set<number>(selection === "all" ? this.proposals.map((_, i) => i) : selection);
    let applied = 0;
    const markedKeys: string[] = [];
    for (let i = 0; i < this.proposals.length; i++) {
      const p = this.proposals[i];
      // collect ALL proposed sourceKeys (selected or not) -> no nag
      if (p.kind === "memory") markedKeys.push(...p.sourceKeys);
      if (!chosen.has(i)) continue;
      if (p.kind === "memory") {
        const m = p as MemoryCreateProposal;
        const iso = NOW().toISOString();
        await deps.memoryStore.save(
          { slug: m.slug, type: m.type, name: m.name, description: m.description, content: m.content, createdAt: iso, updatedAt: iso },
          "create"
        );
        applied++;
      }
      // Phase B: profile proposal application
    }
    if (markedKeys.length) await deps.curatedIndex.mark(markedKeys);
    return { applied, markedKeys };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/core/src/curation/session.test.ts`
Expected: PASS（3 用例）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/curation/session.ts packages/core/src/curation/session.test.ts
git commit -m "feat(curation): CurationSession（暂存提议 + apply/reject + 标记）"
```

---

### Task A6: handleCurationInput + JournalStore.listAll

**Files:**
- Modify: `packages/core/src/diary/store.ts`（增 `listAll`）
- Create: `packages/core/src/curation/dispatch.ts`
- Test: `packages/core/src/curation/dispatch.test.ts`
- Test: `packages/core/src/diary/store.test.ts`（追加 `listAll` 用例）

**Interfaces:**
- Consumes: `JournalStore.listAll`（新）、`CuratedIndex`（A2）、`MemoryCuration`（A4）、`CurationSession`（A5）、`MemoryStore`。
- Produces: `handleCurationInput(input, ctx): Promise<CurationDispatchOutcome | null>`（`null`=非 curation 输入）。hooks.ts 消费。`/diary-curate` 跑 memory-curation、暂存、输出编号清单；`/diary-curate apply <sel>|all`、`reject` 确认。

- [ ] **Step 1: 追加 JournalStore.listAll 失败测试**

在 `packages/core/src/diary/store.test.ts` 的 `describe` 内追加：

```typescript
  it("listAll returns every entry across all dates", async () => {
    const store = new JournalStore(dir);
    await store.save(entry("a1", "2026-07-31", "x"));
    await store.save(entry("b1", "2026-07-30", "y"));
    const all = await store.listAll();
    expect(all.map((e) => e.meta.id).sort()).toEqual(["a1", "b1"]);
  });
```

并在 `DiaryStore` 接口与 `JournalStore` 类中补 `listAll(): Promise<DiaryEntry[]>`：

```typescript
  async listAll(): Promise<DiaryEntry[]> {
    if (!fs.existsSync(this.dir)) return [];
    const out: DiaryEntry[] = [];
    for (const date of await fs.promises.readdir(this.dir)) {
      const dateDir = path.join(this.dir, date);
      const stat = await fs.promises.stat(dateDir);
      if (!stat.isDirectory()) continue;
      out.push(...(await readEntries(dateDir)));
    }
    return out;
  }
```

- [ ] **Step 2: Run test to verify it fails then implement**

Run: `pnpm test packages/core/src/diary/store.test.ts` -> FAIL（`listAll` 不存在）-> 补上述实现 -> PASS。

- [ ] **Step 3: Write the failing dispatch test**

```typescript
// packages/core/src/curation/dispatch.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleCurationInput } from "./dispatch.js";
import { JournalStore } from "../diary/store.js";
import { CuratedIndex } from "../diary/curated.js";
import { MemoryStore } from "../memory/store.js";
import { MemoryCuration } from "./memory-curation.js";
import { emptyEntry } from "../diary/types.js";

const NOW = () => new Date("2026-08-01T10:00:00.000Z");

async function seed(dir: string) {
  const journal = new JournalStore(path.join(dir, "journal"));
  const e = emptyEntry("e1", "2026-08-01", "2026-08-01T10:00:00.000Z");
  e.futureMemory = [
    { content: "决定换架构", type: "decision", importance: "high", promotability: "low", reason: "r" },
    { content: "吃面", type: "decision", importance: "low", promotability: "low", reason: "r" },
  ];
  await journal.save(e);
  return journal;
}

describe("handleCurationInput", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdisp-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function ctx(session: null, journal: JournalStore, generate?: (p: string) => Promise<string>) {
    return {
      session,
      journalStore: journal,
      memoryStore: new MemoryStore(path.join(dir, "memory")),
      curatedIndex: new CuratedIndex(path.join(dir, "journal", ".curated.json")),
      memoryCuration: new MemoryCuration({ generate: generate ?? (async () => JSON.stringify([
        { slug: "project/arch", type: "project", name: "新架构", description: "d", content: "决定换架构", sources: [0] },
      ])) }),
      now: NOW,
    };
  }

  it("returns null for non-curation input", async () => {
    const j = await seed(dir);
    expect(await handleCurationInput("/diary", ctx(null, j))).toBeNull();
  });

  it("/diary-curate gathers high+low non-person candidates (skips low importance), proposes, stashes session", async () => {
    const j = await seed(dir);
    const out = await handleCurationInput("/diary-curate", ctx(null, j));
    expect(out).not.toBeNull();
    expect(out!.result.message).toContain("1.");
    expect(out!.result.message).toContain("project/arch");
    expect(out!.nextSession).not.toBeNull();
  });

  it("/diary-curate apply all persists memory and marks keys", async () => {
    const j = await seed(dir);
    const c = ctx(null, j);
    const proposed = await handleCurationInput("/diary-curate", c);
    const out = await handleCurationInput("/diary-curate apply all", { ...c, session: proposed!.nextSession });
    expect(out!.result.message).toMatch(/已应用/);
    expect((await c.memoryStore.listAll()).length).toBe(1);
    const marked = await c.curatedIndex.load();
    expect(marked.has("e1#c0")).toBe(true);
    expect(out!.nextSession).toBeNull();
  });

  it("/diary-curate reject clears session without persisting", async () => {
    const j = await seed(dir);
    const c = ctx(null, j);
    const proposed = await handleDiaryCurate(c, j);
    const out = await handleCurationInput("/diary-curate reject", { ...c, session: proposed!.nextSession });
    expect(out!.nextSession).toBeNull();
    expect((await c.memoryStore.listAll()).length).toBe(0);
  });

  it("re-running /diary-curate after apply finds nothing new", async () => {
    const j = await seed(dir);
    const c = ctx(null, j);
    const proposed = await handleDiaryCurate(c, j);
    await handleCurationInput("/diary-curate apply all", { ...c, session: proposed!.nextSession });
    const again = await handleCurationInput("/diary-curate", c);
    expect(again!.result.message).toMatch(/没有待整理/);
  });
});

// helper (named to avoid shadowing)
async function handleDiaryCurate(c: any, _j: JournalStore) {
  return handleCurationInput("/diary-curate", c);
}
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test packages/core/src/curation/dispatch.test.ts`
Expected: FAIL（`handleCurationInput` 不存在）

- [ ] **Step 5: Write minimal implementation**

```typescript
// packages/core/src/curation/dispatch.ts
import type { DiaryEntry } from "../diary/types.js";
import type { JournalStore } from "../diary/store.js";
import type { CuratedIndex } from "../diary/curated.js";
import type { MemoryStore } from "../memory/store.js";
import type { MemoryCuration } from "./memory-curation.js";
import { CurationSession, type Selection } from "./session.js";
import type { PendingCandidate } from "./types.js";

export interface CurationDispatchDeps {
  journalStore: JournalStore;
  memoryStore: MemoryStore;
  curatedIndex: CuratedIndex;
  memoryCuration: MemoryCuration;
  now: () => Date;
}
export interface CurationDispatchContext extends CurationDispatchDeps {
  session: CurationSession | null;
}
export interface CurationDispatchResult {
  type: "action" | "error";
  message: string;
}
export interface CurationDispatchOutcome {
  result: CurationDispatchResult;
  nextSession: CurationSession | null;
}

const NON_PERSON = new Set(["preference", "decision", "goal", "other"]);

async function gatherPending(ctx: CurationDispatchDeps): Promise<PendingCandidate[]> {
  const index = await ctx.curatedIndex.load();
  const all = await ctx.journalStore.listAll();
  const out: PendingCandidate[] = [];
  for (const e of all) {
    for (let i = 0; i < e.futureMemory.length; i++) {
      const c = e.futureMemory[i];
      const key = `${e.meta.id}#c${i}`;
      if (index.has(key)) continue;
      if (c.importance !== "high") continue;          // low/medium 留日记
      if (!NON_PERSON.has(c.type)) continue;          // person_trait/relationship 留给 Phase B
      out.push({ key, candidate: c });
    }
  }
  return out;
}

function parseApply(rest: string): Selection | "reject" | null {
  const args = rest.split(/\s+/).filter(Boolean);
  if (args[0] === "reject") return "reject";
  if (args[0] === "apply") {
    if (args[1] === "all" || args.length === 1) return "all";
    const nums = args.slice(1).flatMap((s) => s.split(",")).map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n));
    return nums.map((n) => n - 1); // 1-indexed display -> 0-indexed
  }
  return null;
}

export async function handleCurationInput(
  input: string,
  ctx: CurationDispatchContext
): Promise<CurationDispatchOutcome | null> {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/diary-curate")) return null;
  const rest = trimmed.slice("/diary-curate".length).trim();

  // apply / reject operate on an existing session
  if (rest.startsWith("apply") || rest.startsWith("reject")) {
    if (!ctx.session) {
      return { result: { type: "error", message: "没有待确认的整理提议。先 /diary-curate 生成。" }, nextSession: null };
    }
    const sel = parseApply(rest);
    if (sel === "reject") {
      return { result: { type: "action", message: "已放弃本轮整理（未落库，下次可重跑 /diary-curate）。" }, nextSession: null };
    }
    if (sel === null) {
      return { result: { type: "error", message: "用法: /diary-curate apply 1,3,5 | apply all | reject" }, nextSession: ctx.session };
    }
    const res = await ctx.session.apply(sel, { memoryStore: ctx.memoryStore, curatedIndex: ctx.curatedIndex });
    return { result: { type: "action", message: `✅ 已应用 ${res.applied} 项整理。` }, nextSession: null };
  }

  // /diary-curate (no sub) -> gather + curate + stash
  const pending = await gatherPending(ctx);
  if (pending.length === 0) {
    return { result: { type: "action", message: "没有待整理的候选（高优候选已自动提升或已整理）。" }, nextSession: null };
  }
  const proposals = await ctx.memoryCuration.curate(pending);
  if (proposals.length === 0) {
    return { result: { type: "action", message: `⚠️ memory 整理未产出提议（${pending.length} 个候选，可能 side-call 失败），可重试 /diary-curate。` }, nextSession: null };
  }
  const session = new CurationSession(proposals);
  return {
    result: { type: "action", message: `整理提议（共 ${proposals.length} 项，/diary-curate apply 1,3 | apply all | reject）：\n${session.formatList()}` },
    nextSession: session,
  };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test packages/core/src/curation/dispatch.test.ts`
Expected: PASS（5 用例）。修正 test 中 `handleDiaryCurate` helper 引用（保留）。

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/diary/store.ts packages/core/src/diary/store.test.ts packages/core/src/curation/dispatch.ts packages/core/src/curation/dispatch.test.ts
git commit -m "feat(curation): handleCurationInput 调度 + JournalStore.listAll"
```

---

### Task A7: core 导出 + hooks.ts 接入（diary-end 自动提升 + /diary-curate）

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/cli/src/hooks.ts`
- Test: `packages/cli/src/hooks.diary.test.ts`（追加 curate flags 用例）

**Interfaces:**
- Consumes: A2–A6 全部。
- Produces: `@licode/core` 导出 curation/diary 新模块；`hooks.ts` 的 `readDiaryFlags` 增 `curateModel`、`createMemoryCuration`、`handleSubmit` 中 diary-end 自动提升 + `/diary-curate` 旁路 + 自动补全。

- [ ] **Step 1: 追加失败测试**

在 `packages/cli/src/hooks.diary.test.ts` 的 `describe` 内追加：

```typescript
  it("curateModel defaults to LICODE_DIARY_MODEL then deepseek-chat", () => {
    delete process.env.LICODE_DIARY_MODEL;
    delete process.env.LICODE_DIARY_CURATE_MODEL;
    expect(readDiaryFlags().curateModel).toBe("deepseek-chat");
    process.env.LICODE_DIARY_MODEL = "gpt-4o-mini";
    expect(readDiaryFlags().curateModel).toBe("gpt-4o-mini");
    process.env.LICODE_DIARY_CURATE_MODEL = "stronger-model";
    expect(readDiaryFlags().curateModel).toBe("stronger-model");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/cli/src/hooks.diary.test.ts`
Expected: FAIL（`curateModel` 不存在）

- [ ] **Step 3: 改实现**

`packages/core/src/index.ts` 在 diary 导出块后追加：

```typescript
// diary phase-2: promote + curated
export { CuratedIndex } from "./diary/curated.js";
export { deriveMemory, autoPromoteEntry } from "./diary/promote.js";
export type { AutoPromoteDeps, AutoPromoteResult } from "./diary/promote.js";

// curation/
export { MemoryCuration } from "./curation/memory-curation.js";
export type { MemoryCurationConfig } from "./curation/memory-curation.js";
export { CurationSession } from "./curation/session.js";
export type { Selection, ApplyDeps, ApplyResult } from "./curation/session.js";
export { handleCurationInput } from "./curation/dispatch.js";
export type {
  CurationDispatchDeps, CurationDispatchContext, CurationDispatchResult, CurationDispatchOutcome,
} from "./curation/dispatch.js";
export type { PendingCandidate, MemoryCreateProposal, Proposal } from "./curation/types.js";
```

`packages/cli/src/hooks.ts`：

1. `@licode/core` import 块追加（与 `JournalStore`、`DiaryExtractor`、`handleDiaryInput` 并列）：

```typescript
  MemoryStore,
  CuratedIndex,
  autoPromoteEntry,
  MemoryCuration,
  handleCurationInput,
  type CurationSession,
```

2. `readDiaryFlags` 改为：

```typescript
export function readDiaryFlags(): { enabled: boolean; model: string; curateModel: string } {
  return {
    enabled: process.env.LICODE_DIARY !== "off",
    model: process.env.LICODE_DIARY_MODEL || "deepseek-chat",
    curateModel: process.env.LICODE_DIARY_CURATE_MODEL || process.env.LICODE_DIARY_MODEL || "deepseek-chat",
  };
}
```

3. 在 `createDiaryExtractor` 旁新增：

```typescript
function createMemoryCuration(apiKey: string, baseUrl: string | undefined, model: string): MemoryCuration {
  const sideProvider = new AnthropicProvider({ apiKey, baseUrl });
  return new MemoryCuration({
    generate: async (prompt) => {
      const res = await sideProvider.chat({
        messages: [{ role: "user", content: prompt, timestamp: new Date().toISOString() }],
        model,
        maxTokens: 2048,
      });
      return res.content;
    },
  });
}
```

4. refs 区（`diarySessionRef` 附近）新增：

```typescript
  const memoryStoreRef = useRef<MemoryStore>(new MemoryStore(path.join(process.cwd(), ".licode", "memory")));
  const curatedIndexRef = useRef<CuratedIndex>(new CuratedIndex(path.join(process.cwd(), ".licode", "journal", ".curated.json")));
  const memoryCurationRef = useRef<MemoryCuration | null>(null);
  const curationSessionRef = useRef<CurationSession | null>(null);
```

并在构造 `diaryExtractorRef` 处旁补：

```typescript
    if (diaryFlags.enabled) {
      diaryExtractorRef.current = createDiaryExtractor(apiKey, baseUrl, diaryFlags.model);
      memoryCurationRef.current = createMemoryCuration(apiKey, baseUrl, diaryFlags.curateModel);
    }
```

5. `handleSubmit` 中，**先于** diary 旁路、**先于** `router.route`，插入 curation 旁路（`/diary-curate` 必须在 `/diary` 之前判，因 `/diary-curate` 也以 `/diary` 开头）：

```typescript
      // ── curation: /diary-curate ──
      if (diaryEnabledRef.current && memoryCurationRef.current && input.trim().startsWith("/diary-curate")) {
        const outcome = await handleCurationInput(input, {
          session: curationSessionRef.current,
          journalStore: diaryStoreRef.current,
          memoryStore: memoryStoreRef.current,
          curatedIndex: curatedIndexRef.current,
          memoryCuration: memoryCurationRef.current,
          now: () => new Date(),
        });
        curationSessionRef.current = outcome.nextSession;
        setIsLoading(false);
        setCommandMessage(outcome.result.message);
        setMessages([...manager.getMessages()]);
        return;
      }
```

6. diary 旁路的 `/diary end` 分支：`handleDiaryInput` 内部已存 entry，但自动提升需在 hooks 层做（dispatch 不持有 memoryStore）。改为：在 diary 旁路 `outcome !== null` 后，若 `outcome` 是 `/diary-end` 成功（`nextSession===null` 且 message 含「已保存」），对刚存的 entry 跑自动提升。更稳妥：让 `handleDiaryInput` 的 `/diary end` 返回 entry id，hooks 据此 load + autoPromote。为最小改动，在 dispatch `/diary end` 存库后把 `entry` 暴露于 outcome 不可行（dispatch 接口已定）。改用：hooks 在 diary 旁路后，若 `diarySessionRef` 刚清空（end 成功），取 `diaryStoreRef` 最近一条 entry 跑 `autoPromoteEntry`：

```typescript
      // diary 旁路（既有）... outcome !== null:
      if (outcome !== null) {
        const wasEnd = diarySessionRef.current !== null && outcome.nextSession === null && outcome.result.type === "action";
        diarySessionRef.current = outcome.nextSession;
        setIsLoading(false);
        setCommandMessage(outcome.result.message);
        setMessages([...manager.getMessages()]);
        if (wasEnd && diaryEnabledRef.current) {
          try {
            const recent = await diaryStoreRef.current.listRecent(1);
            if (recent[0]) {
              const pr = await autoPromoteEntry(recent[0], {
                memoryStore: memoryStoreRef.current,
                curatedIndex: curatedIndexRef.current,
                now: () => new Date(),
              });
              if (pr.promoted.length) {
                setCommandMessage(outcome.result.message + `\n✨ 已自动提升 ${pr.promoted.length} 条到记忆。`);
              }
            }
          } catch { /* 自动提升失败不阻断；候选留待 /diary-curate */ }
        }
        return;
      }
```

7. 自动补全列表追加：

```typescript
      { name: "diary-curate", description: "整理日记候选到记忆/档案（/diary-curate apply 确认）" },
```

> 注：`handleSubmit` 的 React 接线由本步 `pnpm build` 验证；调度逻辑在 A6 单测覆盖。

- [ ] **Step 4: Run test + build**

Run: `pnpm test packages/cli/src/hooks.diary.test.ts && pnpm build`
Expected: 测试 PASS；build 零 TS 错。

- [ ] **Step 5: 全量验证**

Run: `pnpm test && pnpm build`
Expected: 全绿（diary 既有 + curation 新增；预存 MCP 失败若存在与本次无关）；零 TS 错。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/index.ts packages/cli/src/hooks.ts packages/cli/src/hooks.diary.test.ts
git commit -m "feat(curation): core 导出 + hooks 接入（diary-end 自动提升 + /diary-curate 旁路）"
```

---

# Phase B：人物档案（profile-curation）

> 增量 B 交付后：`/diary-end` 自动把具体人物入档；`/diary-curate` 的 profile-curation 解模糊人物（别名归一 + 人审）+ 合并全档案 raw note；agent 可经 `profile_recall` 查档案。依赖 Phase A 的 curation 引擎（session/dispatch 扩展）。

> **设计细化（相对 spec §七）**：`person_trait` 候选**不**在 diary-end 机械入档--特质抽取需 side-call 把「王总爱喝茶」提炼为 trait「爱喝茶」、并按人归档，机械追加会存冗余全句。故 `autoFileEntry` 只机械处理 `people` ref（interaction/note/relation，已逐字段干净）；`person_trait/relationship` 候选统一进 profile-curation（side-call 抽特质 + 解人）。这与 spec「high+high person_trait 自动」的精神一致（人物信息自动落档案），只是落点在 curation 而非机械段，因特质需智能抽取。

### Task B1: PersonProfile 类型 + 序列化

**Files:**
- Create: `packages/core/src/people/types.ts`
- Create: `packages/core/src/people/serialize.ts`
- Test: `packages/core/src/people/serialize.test.ts`

**Interfaces:**
- Produces: `PersonProfile`、`PersonProfileMeta`、`Interaction`、`RelationshipState`；`emptyProfile(canonicalName, date): PersonProfile`；`serializeProfile(profile): string`；`parseProfile(raw): PersonProfile | null`。B2/B3/B4 消费。

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/people/serialize.test.ts
import { describe, it, expect } from "vitest";
import { emptyProfile } from "./types.js";
import { serializeProfile, parseProfile } from "./serialize.js";

describe("PersonProfile serialize", () => {
  it("emptyProfile produces canonical shape", () => {
    const p = emptyProfile("王总", "2026-08-01");
    expect(p.meta.canonicalName).toBe("王总");
    expect(p.meta.aliases).toEqual([]);
    expect(p.traits).toEqual([]);
    expect(p.interactions).toEqual([]);
  });

  it("round-trips a full profile", () => {
    const p = emptyProfile("王总", "2026-08-01");
    p.meta.aliases = ["老板", "王志远"];
    p.meta.mentionCount = 3;
    p.summary = "用户的上级，做事果断";
    p.traits = ["做事果断"];
    p.preferences = ["爱喝茶，偏好龙井"];
    p.interactions = [{ date: "2026-08-01", entryId: "e1", event: "开会聊新项目" }];
    p.relationshipState = [{ date: "2026-08-01", state: "直属领导" }];

    const raw = serializeProfile(p);
    expect(raw).toContain("canonicalName: 王总");
    expect(raw).toContain("## 概述");
    expect(raw).toContain("## 结构化");

    const parsed = parseProfile(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.meta.canonicalName).toBe("王总");
    expect(parsed!.meta.aliases).toEqual(["老板", "王志远"]);
    expect(parsed!.traits).toEqual(["做事果断"]);
    expect(parsed!.interactions[0].event).toBe("开会聊新项目");
    expect(parsed!.relationshipState[0].state).toBe("直属领导");
  });

  it("parseProfile returns null on non-frontmatter input", () => {
    expect(parseProfile("just text")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/people/serialize.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/people/types.ts
export interface Interaction { date: string; entryId: string; event: string; }
export interface RelationshipState { date: string; state: string; }

export interface PersonProfileMeta {
  canonicalName: string;
  aliases: string[];
  slug: string;
  firstSeen: string;
  lastSeen: string;
  mentionCount: number;
}

export interface PersonProfile {
  meta: PersonProfileMeta;
  summary: string;
  traits: string[];
  preferences: string[];
  interactions: Interaction[];
  relationshipState: RelationshipState[];
}

export function emptyProfile(canonicalName: string, date: string): PersonProfile {
  return {
    meta: { canonicalName, aliases: [], slug: "", firstSeen: date, lastSeen: date, mentionCount: 0 },
    summary: "",
    traits: [], preferences: [], interactions: [], relationshipState: [],
  };
}
```

```typescript
// packages/core/src/people/serialize.ts
import type { PersonProfile } from "./types.js";

const SUMMARY_MAX = 100;

function parseFrontmatter(fm: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of fm.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return map;
}

function extractJsonBlock(body: string): string | null {
  const fence = body.match(/```json\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start !== -1 && end > start) return body.slice(start, end + 1);
  return null;
}

export function serializeProfile(p: PersonProfile): string {
  const fm = [
    "---",
    `canonicalName: ${p.meta.canonicalName}`,
    `aliases: ${p.meta.aliases.join(", ")}`,
    `slug: ${p.meta.slug}`,
    `firstSeen: ${p.meta.firstSeen}`,
    `lastSeen: ${p.meta.lastSeen}`,
    `mentionCount: ${p.meta.mentionCount}`,
    `summary: ${p.summary.slice(0, SUMMARY_MAX)}`,
    "---",
    "",
  ].join("\n");
  const json = JSON.stringify(
    { traits: p.traits, preferences: p.preferences, interactions: p.interactions, relationshipState: p.relationshipState },
    null, 2
  );
  const fence = "```";
  return `${fm}## 概述\n${p.summary}\n\n## 结构化\n${fence}json\n${json}\n${fence}\n`;
}

export function parseProfile(raw: string): PersonProfile | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const fm = parseFrontmatter(m[1]);
  const jsonStr = extractJsonBlock(m[2]);
  if (!jsonStr) return null;
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(jsonStr); } catch { return null; }
  const summaryMatch = m[2].match(/## 概述\n([\s\S]*?)\n\n## 结构化/);
  const summary = summaryMatch ? summaryMatch[1].trim() : "";
  return {
    meta: {
      canonicalName: fm.canonicalName ?? "",
      aliases: (fm.aliases ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      slug: fm.slug ?? "",
      firstSeen: fm.firstSeen ?? "",
      lastSeen: fm.lastSeen ?? "",
      mentionCount: Number(fm.mentionCount ?? 0) || 0,
    },
    summary,
    traits: Array.isArray(obj.traits) ? obj.traits as string[] : [],
    preferences: Array.isArray(obj.preferences) ? obj.preferences as string[] : [],
    interactions: Array.isArray(obj.interactions) ? obj.interactions as PersonProfile["interactions"] : [],
    relationshipState: Array.isArray(obj.relationshipState) ? obj.relationshipState as PersonProfile["relationshipState"] : [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/core/src/people/serialize.test.ts`
Expected: PASS（3 用例）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/people/types.ts packages/core/src/people/serialize.ts packages/core/src/people/serialize.test.ts
git commit -m "feat(people): PersonProfile 类型 + frontmatter/JSON 序列化往返"
```

---

### Task B2: PersonProfileStore（独立档案库）

**Files:**
- Create: `packages/core/src/people/store.ts`
- Test: `packages/core/src/people/store.test.ts`

**Interfaces:**
- Consumes: `PersonProfile`（B1）、`serializeProfile`/`parseProfile`（B1）、`toSlug`（memory/types）。
- Produces: `PersonProfileStore`（`constructor(dir)`、`save(profile, action)`、`load(slug)`、`listAll()`、`findByName(nameOrAlias)`、`listRecent(limit)`）。B3 autoFile 与 B4 curation、profile_recall 消费。

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/people/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PersonProfileStore } from "./store.js";
import { emptyProfile } from "./types.js";
import { toSlug } from "../memory/types.js";

describe("PersonProfileStore", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppl-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function profile(name: string, aliases: string[] = []) {
    const p = emptyProfile(name, "2026-08-01");
    p.meta.slug = toSlug(name);
    p.meta.aliases = aliases;
    p.meta.mentionCount = 1;
    return p;
  }

  it("save(create) writes <slug>.md and load reads it back", async () => {
    const s = new PersonProfileStore(dir);
    const p = profile("王总", ["老板"]);
    await s.save(p, "create");
    const loaded = await s.load(p.meta.slug);
    expect(loaded).not.toBeNull();
    expect(loaded!.meta.canonicalName).toBe("王总");
  });

  it("save(create) refuses to overwrite existing slug", async () => {
    const s = new PersonProfileStore(dir);
    await s.save(profile("王总"), "create");
    await expect(s.save(profile("王总"), "create")).rejects.toThrow(/already exists/);
  });

  it("save(update) overwrites", async () => {
    const s = new PersonProfileStore(dir);
    const p = profile("王总");
    await s.save(p, "create");
    p.summary = "更新过";
    await s.save(p, "update");
    expect((await s.load(p.meta.slug))!.summary).toBe("更新过");
  });

  it("findByName matches canonicalName or alias", async () => {
    const s = new PersonProfileStore(dir);
    await s.save(profile("王总", ["老板", "王志远"]), "create");
    expect((await s.findByName("王总"))?.meta.canonicalName).toBe("王总");
    expect((await s.findByName("老板"))?.meta.canonicalName).toBe("王总");
    expect((await s.findByName("王志远"))?.meta.canonicalName).toBe("王总");
    expect(await s.findByName("李四")).toBeNull();
  });

  it("listRecent returns newest-first by lastSeen", async () => {
    const s = new PersonProfileStore(dir);
    const a = profile("A"); a.meta.lastSeen = "2026-07-30";
    const b = profile("B"); b.meta.lastSeen = "2026-08-01";
    await s.save(a, "create"); await s.save(b, "create");
    const recent = await s.listRecent(2);
    expect(recent[0].meta.canonicalName).toBe("B");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/people/store.test.ts`
Expected: FAIL（`PersonProfileStore` 不存在）

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/people/store.ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { PersonProfile } from "./types.js";
import { serializeProfile, parseProfile } from "./serialize.js";

export type ProfileAction = "create" | "update";

export class PersonProfileStore {
  constructor(private dir: string) {}

  private file(slug: string): string {
    return path.join(this.dir, `${path.basename(slug)}.md`);
  }

  async save(profile: PersonProfile, action: ProfileAction = "create"): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const filePath = this.file(profile.meta.slug);
    if (action === "create" && fs.existsSync(filePath)) {
      throw new Error(`profile already exists: ${profile.meta.slug}`);
    }
    await fs.promises.writeFile(filePath, serializeProfile(profile), "utf-8");
  }

  async load(slug: string): Promise<PersonProfile | null> {
    const filePath = this.file(slug);
    if (!fs.existsSync(filePath)) return null;
    return parseProfile(await fs.promises.readFile(filePath, "utf-8"));
  }

  async listAll(): Promise<PersonProfile[]> {
    if (!fs.existsSync(this.dir)) return [];
    const out: PersonProfile[] = [];
    for (const f of await fs.promises.readdir(this.dir)) {
      if (!f.endsWith(".md")) continue;
      const parsed = parseProfile(await fs.promises.readFile(path.join(this.dir, f), "utf-8"));
      if (parsed) out.push(parsed);
    }
    return out;
  }

  async findByName(nameOrAlias: string): Promise<PersonProfile | null> {
    const all = await this.listAll();
    return all.find((p) => p.meta.canonicalName === nameOrAlias || p.meta.aliases.includes(nameOrAlias)) ?? null;
  }

  async listRecent(limit: number): Promise<PersonProfile[]> {
    const all = await this.listAll();
    return all.sort((a, b) => b.meta.lastSeen.localeCompare(a.meta.lastSeen)).slice(0, limit);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/core/src/people/store.test.ts`
Expected: PASS（5 用例）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/people/store.ts packages/core/src/people/store.test.ts
git commit -m "feat(people): PersonProfileStore（save/load/listAll/findByName/listRecent）"
```

---

### Task B3: autoFileEntry（diary-end 自动入档具体人物）

**Files:**
- Create: `packages/core/src/people/profile-file.ts`
- Test: `packages/core/src/people/profile-file.test.ts`

**Interfaces:**
- Consumes: `DiaryEntry`/`PersonRef`（diary/types）、`PersonProfileStore`（B2）、`CuratedIndex`（A2）、`toSlug`（memory/types）、`emptyProfile`（B1）。
- Produces: `autoFileEntry(entry, deps): Promise<AutoFileResult>`。hooks.ts diary-end 调用。只处理 `people` 中 `specific:true` 的，追加 interaction/note/relation，标 `${entryId}#p${idx}`。

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/people/profile-file.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { autoFileEntry } from "./profile-file.js";
import { PersonProfileStore } from "./store.js";
import { CuratedIndex } from "../diary/curated.js";
import { emptyEntry, type PersonRef } from "../diary/types.js";
import { toSlug } from "../memory/types.js";

const NOW = () => new Date("2026-08-01T10:00:00.000Z");
function person(name: string, specific: boolean, interaction: string, note: string | null, relation: string | null): PersonRef {
  return { name, relation, relationInferred: false, interaction, note, specific };
}

describe("autoFileEntry", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("creates a new profile for a specific person and marks key", async () => {
    const entry = emptyEntry("e1", "2026-08-01", "2026-08-01T10:00:00.000Z");
    entry.people = [person("王总", true, "开会聊新项目", "爱喝茶", "上级")];
    const store = new PersonProfileStore(path.join(dir, "people"));
    const idx = new CuratedIndex(path.join(dir, ".curated.json"));
    const res = await autoFileEntry(entry, { profileStore: store, curatedIndex: idx, now: NOW });

    expect(res.filed).toEqual(["王总"]);
    const p = await store.findByName("王总");
    expect(p).not.toBeNull();
    expect(p!.meta.canonicalName).toBe("王总");
    expect(p!.interactions[0]).toEqual({ date: "2026-08-01", entryId: "e1", event: "开会聊新项目" });
    expect(p!.traits).toContain("爱喝茶");
    expect(p!.relationshipState[0]).toEqual({ date: "2026-08-01", state: "上级" });
    expect((await idx.load()).has("e1#p0")).toBe(true);
  });

  it("appends to an existing profile without duplicating the same relation", async () => {
    const store = new PersonProfileStore(path.join(dir, "people"));
    const idx = new CuratedIndex(path.join(dir, ".curated.json"));
    // first entry
    const e1 = emptyEntry("e1", "2026-08-01", "2026-08-01T10:00:00.000Z");
    e1.people = [person("王总", true, "开会", null, "上级")];
    await autoFileEntry(e1, { profileStore: store, curatedIndex: idx, now: NOW });
    // second entry, same relation
    const e2 = emptyEntry("e2", "2026-08-02", "2026-08-02T10:00:00.000Z");
    e2.people = [person("王总", true, "又开会", "做事果断", "上级")];
    await autoFileEntry(e2, { profileStore: store, curatedIndex: idx, now: NOW });

    const p = await store.findByName("王总");
    expect(p!.interactions.length).toBe(2);
    expect(p!.relationshipState.length).toBe(1); // same relation not duplicated
    expect(p!.traits).toContain("做事果断");
    expect(p!.meta.mentionCount).toBe(2);
  });

  it("skips ambiguous (specific:false) people, leaves them unmarked", async () => {
    const entry = emptyEntry("e1", "2026-08-01", "2026-08-01T10:00:00.000Z");
    entry.people = [person("朋友", false, "吃饭", null, null)];
    const store = new PersonProfileStore(path.join(dir, "people"));
    const idx = new CuratedIndex(path.join(dir, ".curated.json"));
    const res = await autoFileEntry(entry, { profileStore: store, curatedIndex: idx, now: NOW });
    expect(res.filed).toEqual([]);
    expect((await store.listAll()).length).toBe(0);
    expect((await idx.load()).has("e1#p0")).toBe(false); // unmarked -> curation
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/people/profile-file.test.ts`
Expected: FAIL（`autoFileEntry` 不存在）

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/people/profile-file.ts
import type { DiaryEntry } from "../diary/types.js";
import type { CuratedIndex } from "../diary/curated.js";
import { PersonProfileStore } from "./store.js";
import { emptyProfile } from "./types.js";
import { toSlug } from "../memory/types.js";

export interface AutoFileDeps {
  profileStore: PersonProfileStore;
  curatedIndex: CuratedIndex;
  now: () => Date;
}
export interface AutoFileResult {
  filed: string[];
  markedKeys: string[];
  errors: string[];
}

export async function autoFileEntry(entry: DiaryEntry, deps: AutoFileDeps): Promise<AutoFileResult> {
  const filed: string[] = [];
  const markedKeys: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < entry.people.length; i++) {
    const ref = entry.people[i];
    if (!ref.specific) continue;            // 模糊留给 curation
    const key = `${entry.meta.id}#p${i}`;
    try {
      const existing = await deps.profileStore.findByName(ref.name);
      const p = existing ?? emptyProfile(ref.name, entry.meta.date);
      if (!existing) { p.meta.slug = toSlug(ref.name); p.meta.mentionCount = 0; }
      // interaction -> timeline
      p.interactions.push({ date: entry.meta.date, entryId: entry.meta.id, event: ref.interaction });
      // note -> traits (raw; curation 清理延后)
      if (ref.note && !p.traits.includes(ref.note)) p.traits.push(ref.note);
      // relation -> relationshipState（记变化，非每条重复）
      if (ref.relation) {
        const last = p.relationshipState[p.relationshipState.length - 1];
        if (!last || last.state !== ref.relation) {
          p.relationshipState.push({ date: entry.meta.date, state: ref.relation });
        }
      }
      p.meta.lastSeen = entry.meta.date;
      p.meta.mentionCount += 1;
      await deps.profileStore.save(p, existing ? "update" : "create");
      filed.push(ref.name);
      markedKeys.push(key);
    } catch (err) {
      errors.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (markedKeys.length) await deps.curatedIndex.mark(markedKeys);
  return { filed, markedKeys, errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/core/src/people/profile-file.test.ts`
Expected: PASS（3 用例）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/people/profile-file.ts packages/core/src/people/profile-file.test.ts
git commit -m "feat(people): autoFileEntry（具体人物机械入档 + 标记）"
```

---

### Task B4: ProfileCuration（解模糊人物，别名归一 + 人审）

**Files:**
- Modify: `packages/core/src/curation/types.ts`（追加 profile proposal 类型）
- Create: `packages/core/src/people/curation/profile-curation.ts`
- Test: `packages/core/src/people/curation/profile-curation.test.ts`

**Interfaces:**
- Consumes: `PersonRef`（diary/types）、`PersonProfile`（people/types）。
- Produces: `PendingPerson { key, personRef, date, entryId }`；`ProfileMergeProposal`/`ProfileNewProposal`；`ProfileCuration`（`constructor({generate})`、`resolveAmbiguous(pending, profiles): Promise<(ProfileMergeProposal|ProfileNewProposal)[]>`，side-call 失败返回 `[]`）。B5 dispatch/session 消费。

> **v1 范围说明**：profile-curation 的第二职责「合并全档案 raw note（档案的 dream）」（spec §六）**延后**到 follow-up。原因：它依赖「先应用 merge 再 consolidate」的状态顺序（consolidate 须基于 merge 后的档案），需在 dispatch 内做内存模拟，复杂度高；v1 先交付高价值的别名归一（resolveAmbiguous），合并全档案作为紧接的下一步。`person_trait/relationship` 候选的智能归档也随之延后（其内容与 `people.note` 高度重叠，v1 经 people.note 入档 + 后续 consolidate 覆盖）。

- [ ] **Step 1: 追加 profile proposal 类型**

在 `packages/core/src/curation/types.ts` 末尾追加（并把 `Proposal` 联合类型扩展）：

```typescript
import type { PersonRef } from "../diary/types.js";

export interface PendingPerson {
  key: string;             // ${entryId}#p${idx}
  personRef: PersonRef;
  date: string;
  entryId: string;
}

export interface ProfileMergeProposal {
  kind: "profile-merge";
  fromName: string;
  intoSlug: string;
  reason: string;
  date: string; entryId: string; interaction: string; note: string | null; relation: string | null;
  sourceKeys: string[];
}
export interface ProfileNewProposal {
  kind: "profile-new";
  name: string;
  reason: string;
  date: string; entryId: string; interaction: string; note: string | null; relation: string | null;
  sourceKeys: string[];
}

export type Proposal = MemoryCreateProposal | ProfileMergeProposal | ProfileNewProposal;
```

- [ ] **Step 2: Write the failing test**

```typescript
// packages/core/src/people/curation/profile-curation.test.ts
import { describe, it, expect } from "vitest";
import { ProfileCuration } from "./profile-curation.js";
import type { PendingPerson } from "../../curation/types.js";
import { emptyProfile } from "../types.js";
import type { PersonRef } from "../../diary/types.js";

function pp(key: string, name: string): PendingPerson {
  const ref: PersonRef = { name, relation: "上级", relationInferred: false, interaction: "开会", note: "爱喝茶", specific: false };
  return { key, personRef: ref, date: "2026-08-01", entryId: "e1" };
}

describe("ProfileCuration.resolveAmbiguous", () => {
  it("proposes merge when a name clusters to an existing profile", async () => {
    const generate = async () => JSON.stringify([
      { action: "merge", index: 0, intoSlug: "wang", reason: "都是上级/工作场景" },
    ]);
    const c = new ProfileCuration({ generate });
    const profiles = [emptyProfile("王总", "2026-07-30")];
    profiles[0].meta.slug = "wang";
    profiles[0].meta.aliases = ["老板"];
    const out = await c.resolveAmbiguous([pp("e1#p0", "老王")], profiles);
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe("profile-merge");
    expect((out[0] as any).intoSlug).toBe("wang");
    expect((out[0] as any).sourceKeys).toEqual(["e1#p0"]);
  });

  it("proposes new when no existing profile matches", async () => {
    const generate = async () => JSON.stringify([
      { action: "new", index: 0, name: "李四", reason: "新人物" },
    ]);
    const c = new ProfileCuration({ generate });
    const out = await c.resolveAmbiguous([pp("e1#p0", "朋友")], []);
    expect(out[0].kind).toBe("profile-new");
    expect((out[0] as any).name).toBe("李四");
  });

  it("returns [] on side-call failure (skip)", async () => {
    const generate = async () => { throw new Error("net"); };
    const c = new ProfileCuration({ generate });
    expect(await c.resolveAmbiguous([pp("e1#p0", "朋友")], [])).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test packages/core/src/people/curation/profile-curation.test.ts`
Expected: FAIL（`ProfileCuration` 不存在）

- [ ] **Step 4: Write minimal implementation**

```typescript
// packages/core/src/people/curation/profile-curation.ts
import type { PersonProfile } from "../types.js";
import type { PendingPerson, ProfileMergeProposal, ProfileNewProposal } from "../../curation/types.js";

export interface ProfileCurationConfig {
  generate: (prompt: string) => Promise<string>;
}

type ResolveProposal = ProfileMergeProposal | ProfileNewProposal;

export class ProfileCuration {
  constructor(private config: ProfileCurationConfig) {}

  async resolveAmbiguous(pending: PendingPerson[], profiles: PersonProfile[]): Promise<ResolveProposal[]> {
    if (pending.length === 0) return [];
    let raw: string;
    try {
      raw = await this.config.generate(this.buildResolvePrompt(pending, profiles));
    } catch {
      return [];
    }
    return this.parseResolve(raw, pending);
  }

  private buildResolvePrompt(pending: PendingPerson[], profiles: PersonProfile[]): string {
    const ppl = pending.map((p, i) =>
      `[${i}] name=${p.personRef.name} | relation=${p.personRef.relation ?? "?"} | interaction=${p.personRef.interaction} | note=${p.personRef.note ?? "?"}`
    ).join("\n");
    const profs = profiles.length
      ? profiles.map((p) => `- slug=${p.meta.slug} canonical=${p.meta.canonicalName} aliases=[${p.meta.aliases.join(",")}]`).join("\n")
      : "(无现有档案)";
    return [
      "你是人物档案的别名归一器。下面是日记里【模糊】（泛称）提到的人，和现有档案。判断每个模糊人是否就是某个现有档案（同一个人），还是新人物。",
      "靠名字周围的上下文（relation/interaction/note）判断，不是字符串匹配。歧义无法确定时判 new。",
      "",
      "现有档案：", profs,
      "",
      "模糊人：", ppl,
      "",
      '只返回 JSON 数组（无则 []）：[{"action":"merge","index":0,"intoSlug":"wang","reason":"..."} | {"action":"new","index":0,"name":"李四","reason":"..."}]',
    ].join("\n");
  }

  private parseResolve(raw: string, pending: PendingPerson[]): ResolveProposal[] {
    let s = raw.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const start = s.indexOf("[");
    const end = s.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start) return [];
    let arr: unknown;
    try { arr = JSON.parse(s.slice(start, end + 1)); } catch { return []; }
    if (!Array.isArray(arr)) return [];
    const out: ResolveProposal[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const idx = Number(o.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= pending.length) continue;
      const p = pending[idx];
      const data = { date: p.date, entryId: p.entryId, interaction: p.personRef.interaction, note: p.personRef.note, relation: p.personRef.relation };
      if (o.action === "merge" && typeof o.intoSlug === "string") {
        out.push({ kind: "profile-merge", fromName: p.personRef.name, intoSlug: o.intoSlug, reason: String(o.reason ?? ""), ...data, sourceKeys: [p.key] });
      } else if (o.action === "new" && typeof o.name === "string") {
        out.push({ kind: "profile-new", name: o.name, reason: String(o.reason ?? ""), ...data, sourceKeys: [p.key] });
      }
    }
    return out;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test packages/core/src/people/curation/profile-curation.test.ts`
Expected: PASS（3 用例）

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/curation/types.ts packages/core/src/people/curation/profile-curation.ts packages/core/src/people/curation/profile-curation.test.ts
git commit -m "feat(people): ProfileCuration.resolveAmbiguous（别名归一 side-call + 人审）"
```

---

### Task B5: CurationSession 扩展 profile + dispatch 接入 + profile_recall

**Files:**
- Modify: `packages/core/src/curation/session.ts`（formatList/apply 扩 profile）
- Modify: `packages/core/src/curation/dispatch.ts`（gather 模糊人 + 跑 ProfileCuration）
- Create: `packages/core/src/tools/builtin/profile-recall.ts`
- Modify: `packages/core/src/tools/builtin/index.ts`
- Test: `packages/core/src/curation/session.test.ts`（追加）、`packages/core/src/curation/dispatch.test.ts`（追加）、`packages/core/src/tools/builtin/profile-recall.test.ts`

**Interfaces:**
- Consumes: `ProfileCuration`（B4）、`PersonProfileStore`（B2）、`toSlug`/`emptyProfile`（B1）。
- Produces: `CurationSession.apply` 处理 `profile-merge`/`profile-new`；`handleCurationInput` 的 ctx 增 `profileStore`/`profileCuration`，gather 模糊 people；`profileRecallTool`。

- [ ] **Step 1: 追加 session profile 测试**

在 `packages/core/src/curation/session.test.ts` 追加（顶部 import 补 `PersonProfileStore`、`toSlug`）：

```typescript
  it("apply profile-new creates a profile and marks sourceKeys", async () => {
    const { CurationSession } = await import("./session.js");
    const store = new PersonProfileStore(path.join(dir, "people"));
    const idx = new CuratedIndex(path.join(dir, ".curated.json"));
    const s = new CurationSession([
      { kind: "profile-new", name: "李四", reason: "新", date: "2026-08-01", entryId: "e1", interaction: "吃饭", note: "幽默", relation: null, sourceKeys: ["e1#p0"] },
    ]);
    const res = await s.apply("all", { memoryStore: new MemoryStore(path.join(dir, "memory")), curatedIndex: idx, profileStore: store });
    expect(res.applied).toBe(1);
    const p = await store.findByName("李四");
    expect(p).not.toBeNull();
    expect(p!.traits).toContain("幽默");
    expect((await idx.load()).has("e1#p0")).toBe(true);
  });
```

- [ ] **Step 2: 扩 CurationSession 实现**

`formatList` 的 `forEach` 内补 profile 分支：

```typescript
      } else if (p.kind === "profile-merge") {
        lines.push(`${i + 1}. [并别名] "${p.fromName}" -> ${p.intoSlug} (${p.reason})`);
      } else if (p.kind === "profile-new") {
        lines.push(`${i + 1}. [新档案] ${p.name} (${p.reason})`);
      }
```

`ApplyDeps` 增可选 `profileStore?: PersonProfileStore`。`apply` 循环内补 profile 处理与 sourceKeys 收集：

```typescript
      // collect ALL proposed sourceKeys
      if (p.kind === "memory") markedKeys.push(...p.sourceKeys);
      else if (p.kind === "profile-merge" || p.kind === "profile-new") markedKeys.push(...p.sourceKeys);
      if (!chosen.has(i)) continue;
      if (p.kind === "memory") { /* 既有 */ }
      else if (p.kind === "profile-merge" && deps.profileStore) {
        const target = await deps.profileStore.load(p.intoSlug);
        if (target) {
          if (!target.meta.aliases.includes(p.fromName)) target.meta.aliases.push(p.fromName);
          target.interactions.push({ date: p.date, entryId: p.entryId, event: p.interaction });
          if (p.note && !target.traits.includes(p.note)) target.traits.push(p.note);
          if (p.relation) { const last = target.relationshipState[target.relationshipState.length - 1]; if (!last || last.state !== p.relation) target.relationshipState.push({ date: p.date, state: p.relation }); }
          target.meta.lastSeen = p.date; target.meta.mentionCount += 1;
          await deps.profileStore.save(target, "update");
          applied++;
        }
      } else if (p.kind === "profile-new" && deps.profileStore) {
        const np = emptyProfile(p.name, p.date);
        np.meta.slug = toSlug(p.name);
        np.interactions.push({ date: p.date, entryId: p.entryId, event: p.interaction });
        if (p.note) np.traits.push(p.note);
        if (p.relation) np.relationshipState.push({ date: p.date, state: p.relation });
        np.meta.mentionCount = 1;
        await deps.profileStore.save(np, "create");
        applied++;
      }
```

并在 `session.ts` 顶部 import `PersonProfileStore`、`emptyProfile`、`toSlug`。

- [ ] **Step 3: 追加 dispatch profile 测试**

在 `packages/core/src/curation/dispatch.test.ts` 追加（ctx 补 `profileStore`/`profileCuration`）：

```typescript
  it("/diary-curate also resolves ambiguous people into profile proposals", async () => {
    const j = await seed(dir);
    // 给 entry 加一个模糊人
    const e = (await j.listAll())[0];
    e.people = [{ name: "朋友", relation: null, relationInferred: false, interaction: "吃饭", note: null, specific: false }];
    // 重新存（JournalStore.save 拒绝覆盖 id；用新 id）
    const e2 = emptyEntry("e2", "2026-08-01", "2026-08-01T11:00:00.000Z");
    e2.people = [{ name: "朋友", relation: null, relationInferred: false, interaction: "吃饭", note: null, specific: false }];
    await j.save(e2);
    const profileStore = new PersonProfileStore(path.join(dir, "people"));
    const profileCuration = new ProfileCuration({ generate: async () => JSON.stringify([{ action: "new", index: 0, name: "李四", reason: "新" }]) });
    const c = { ...ctx(null, j), profileStore, profileCuration };
    const out = await handleCurationInput("/diary-curate", c);
    expect(out!.result.message).toContain("新档案");
    expect(out!.nextSession).not.toBeNull();
  });
```

（顶部 import 补 `PersonProfileStore`、`ProfileCuration`、`emptyEntry`。）

- [ ] **Step 4: 扩 dispatch 实现**

`CurationDispatchDeps` 增 `profileStore: PersonProfileStore`、`profileCuration: ProfileCuration`。`gatherPending` 旁新增 `gatherPendingPeople`：

```typescript
async function gatherPendingPeople(ctx: CurationDispatchDeps): Promise<PendingPerson[]> {
  const index = await ctx.curatedIndex.load();
  const all = await ctx.journalStore.listAll();
  const out: PendingPerson[] = [];
  for (const e of all) {
    for (let i = 0; i < e.people.length; i++) {
      const key = `${e.meta.id}#p${i}`;
      if (index.has(key)) continue;          // 已自动入档或已整理
      out.push({ key, personRef: e.people[i], date: e.meta.date, entryId: e.meta.id });
    }
  }
  return out;
}
```

`handleCurationInput` 的 `/diary-curate`（无 sub）分支：memory-curation 后追加 profile-curation：

```typescript
  const pendingC = await gatherPending(ctx);
  const pendingP = await gatherPendingPeople(ctx);
  if (pendingC.length === 0 && pendingP.length === 0) {
    return { result: { type: "action", message: "没有待整理的候选（高优候选已自动提升或已整理）。" }, nextSession: null };
  }
  const memProps = pendingC.length ? await ctx.memoryCuration.curate(pendingC) : [];
  const profiles = await ctx.profileStore.listAll();
  const profProps = pendingP.length ? await ctx.profileCuration.resolveAmbiguous(pendingP, profiles) : [];
  const proposals = [...memProps, ...profProps];
  if (proposals.length === 0) {
    return { result: { type: "action", message: `⚠️ 整理未产出提议（候选 ${pendingC.length}、模糊人 ${pendingP.length}），可能 side-call 失败，可重试 /diary-curate。` }, nextSession: null };
  }
  const session = new CurationSession(proposals);
  return { result: { type: "action", message: `整理提议（共 ${proposals.length} 项，/diary-curate apply 1,3 | apply all | reject）：\n${session.formatList()}` }, nextSession: session };
```

`apply` 调用处 deps 补 `profileStore`：

```typescript
    const res = await ctx.session.apply(sel, { memoryStore: ctx.memoryStore, curatedIndex: ctx.curatedIndex, profileStore: ctx.profileStore });
```

顶部 import 补 `PersonProfileStore`、`ProfileCuration`、`PendingPerson`。

- [ ] **Step 5: Run tests**

Run: `pnpm test packages/core/src/curation/session.test.ts packages/core/src/curation/dispatch.test.ts`
Expected: PASS

- [ ] **Step 6: Write profile_recall 工具**

```typescript
// packages/core/src/tools/builtin/profile-recall.ts
import { z } from "zod";
import * as path from "node:path";
import type { Tool } from "../types.js";
import { PersonProfileStore } from "../../people/store.js";
import type { PersonProfile } from "../../people/types.js";

const ProfileRecallParams = z.object({
  name: z.string().optional().describe("人名或别名，返回该人档案（与 limit 二选一）"),
  limit: z.number().optional().describe("无 name 时返回最近档案数（默认 5）"),
});

function formatProfile(p: PersonProfile): string {
  const lines = [`[${p.meta.canonicalName}]（别名: ${p.meta.aliases.join(", ") || "无"}）`];
  if (p.summary) lines.push(`概述: ${p.summary}`);
  if (p.traits.length) lines.push(`特质: ${p.traits.join("; ")}`);
  if (p.preferences.length) lines.push(`喜好: ${p.preferences.join("; ")}`);
  if (p.relationshipState.length) lines.push(`关系: ${p.relationshipState.map((r) => `${r.date} ${r.state}`).join("; ")}`);
  if (p.interactions.length) lines.push(`互动: ${p.interactions.map((i) => `${i.date} ${i.event}`).join("; ")}`);
  return lines.join("\n");
}

export const profileRecallTool: Tool<typeof ProfileRecallParams> = {
  name: "profile_recall",
  description:
    "查询用户的人物档案（人际关系的结构化记录）。当用户问“王总是谁”“某人什么样”“我和某人关系怎样”等关于人的问题时调用。可按人名/别名查，或不带参数返回最近档案。",
  parameters: ProfileRecallParams,
  async execute(input, context) {
    const store = new PersonProfileStore(path.join(context.workingDirectory, ".licode", "people"));
    try {
      let profiles: PersonProfile[];
      if (input.name) {
        const p = await store.findByName(input.name);
        profiles = p ? [p] : [];
      } else {
        profiles = await store.listRecent(input.limit ?? 5);
      }
      if (profiles.length === 0) return { status: "success", content: "(没有找到人物档案)" };
      const content = profiles.map(formatProfile).join("\n---\n");
      return { status: "success", content, metadata: { count: profiles.length } };
    } catch (err) {
      return { status: "error", error: err instanceof Error ? err.message : String(err), errorType: "execution" };
    }
  },
};
```

注册进 `packages/core/src/tools/builtin/index.ts`：

```typescript
import { profileRecallTool } from "./profile-recall.js";
// builtinTools 数组追加 profileRecallTool；导出列表追加 profileRecallTool
```

测试 `packages/core/src/tools/builtin/profile-recall.test.ts`（仿 `journal-recall.test.ts`：seed 一个 profile，调用 execute 按 name 查返回含 canonicalName；查不到返回「没有找到」）。

- [ ] **Step 7: Run + Commit**

Run: `pnpm test packages/core/src/tools/builtin/profile-recall.test.ts && pnpm build`
Expected: PASS；零 TS 错。

```bash
git add packages/core/src/curation/session.ts packages/core/src/curation/session.test.ts packages/core/src/curation/dispatch.ts packages/core/src/curation/dispatch.test.ts packages/core/src/tools/builtin/profile-recall.ts packages/core/src/tools/builtin/profile-recall.test.ts packages/core/src/tools/builtin/index.ts
git commit -m "feat(people): curation 接入 profile + profile_recall 工具"
```

---

### Task B6: core 导出 + hooks.ts 接入 profile（diary-end 自动入档 + /diary-curate profile）

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/cli/src/hooks.ts`

**Interfaces:**
- Consumes: B1–B5 全部。
- Produces: `@licode/core` 导出 people 模块；`hooks.ts` diary-end 调 `autoFileEntry`、`/diary-curate` ctx 补 `profileStore`/`profileCuration`、`createProfileCuration`。

- [ ] **Step 1: core 导出**

`packages/core/src/index.ts` 追加：

```typescript
// people/
export type { PersonProfile, PersonProfileMeta, Interaction, RelationshipState } from "./people/types.js";
export { emptyProfile } from "./people/types.js";
export { serializeProfile, parseProfile } from "./people/serialize.js";
export { PersonProfileStore } from "./people/store.js";
export type { ProfileAction } from "./people/store.js";
export { autoFileEntry } from "./people/profile-file.js";
export type { AutoFileDeps, AutoFileResult } from "./people/profile-file.js";
export { ProfileCuration } from "./people/curation/profile-curation.js";
export type { ProfileCurationConfig } from "./people/curation/profile-curation.js";
export { profileRecallTool } from "./tools/builtin/profile-recall.js";
export type { PendingPerson, ProfileMergeProposal, ProfileNewProposal } from "./curation/types.js";
```

- [ ] **Step 2: hooks.ts 接入 profile**

1. import 块追加 `PersonProfileStore`、`autoFileEntry`、`ProfileCuration`。
2. 在 `createMemoryCuration` 旁新增 `createProfileCuration`（同构，用 `diaryFlags.curateModel`）。
3. refs 区新增 `profileStoreRef`、`profileCurationRef`；构造处补 `profileCurationRef.current = createProfileCuration(...)`。
4. diary-end 自动提升段（A7 step 3.6）后追加自动入档：

```typescript
            const fr = await autoFileEntry(recent[0], {
              profileStore: profileStoreRef.current,
              curatedIndex: curatedIndexRef.current,
              now: () => new Date(),
            });
            if (fr.filed.length) {
              setCommandMessage((outcome.result.message + (pr.promoted.length ? `\n✨ 已自动提升 ${pr.promoted.length} 条到记忆。` : "")) + `\n👤 已自动入档 ${fr.filed.length} 人。`);
            }
```

5. `/diary-curate` 旁路 ctx 补 `profileStore: profileStoreRef.current`、`profileCuration: profileCurationRef.current`。

- [ ] **Step 3: 全量验证**

Run: `pnpm test && pnpm build`
Expected: 全绿；零 TS 错。

- [ ] **Step 4: 烟测 - 档案闭环**

启动 CLI，依次：
1. `/diary` -> `今天和王总开会，他泡了龙井，定下新架构` -> `/diary-end`（应见「自动提升」+「自动入档 王总」）。
2. 验证 `.licode/people/` 有 王总 档案，含 interaction「开会」、trait「泡龙井/爱喝茶」。
3. `/diary` -> `和朋友吃饭，他说要换工作` -> `/diary-end`。
4. `/diary-curate` -> 见「[新档案]」或「[并别名]」提议 -> `/diary-curate apply all`。
5. 普通对话问「王总是谁」-> agent 调 `profile_recall` 返回档案。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/cli/src/hooks.ts
git commit -m "feat(people): core 导出 + hooks 接入（diary-end 自动入档 + /diary-curate profile）"
```

---

## Self-Review

**1. Spec coverage：**
- §三 三路数据流（diary-end 自动 / curation / dream）-> A3/A7 autoPromote、A6 curation、dream 已有 ✅
- §四 路由与提升门 -> A3 promote（high+high 非人物）、A6 gather（high+非high 非 person）、B5 gather 模糊人；类型映射 A3 ✅
- §四 `specific` 判定 + extractor 收紧 -> A1 ✅
- §五 PersonProfile 模型 + 存储 + Store -> B1/B2 ✅
- §六 curation 两 pass + /diary-curate 确认流 + .curated.json -> A4/A5/A6（memory）、B4/B5（profile resolve）✅
- §六 profile-curation「合并全档案」（dream for profiles）-> **延后**（见 B4 v1 说明），spec §六 job2 未覆盖，列为 follow-up ⚠️
- §七 diary-end 自动提升/入档 + 失败降级 -> A3/A7、B3/B6 ✅
- §八 profile_recall -> B5 ✅
- §九 错误降级 -> curation side-call 失败返回 []（A4/B4）、diary-end 失败转 curation（A7 try/catch）✅
- §十 env LICODE_DIARY_CURATE_MODEL -> A7 readDiaryFlags ✅
- §十一 测试验收 -> 各 Task 单测 + A7/B6 全量/烟测 ✅
- person_trait/relationship 候选智能归档 -> **延后**（与 consolidate 同因），spec §四路由表 person 行部分未覆盖 ⚠️

**2. Placeholder scan：** 无 TBD/TODO；每步含可运行代码。B3 Step 3 早先的草稿双-save 瑕疵已在 self-review 中修正为 `existing ? "update" : "create"` 单次 save。✅

**3. Type consistency：** `Proposal` 联合在 B4 扩展为 `MemoryCreate | ProfileMerge | ProfileNew`；`CurationSession.apply` 的 `ApplyDeps` 增可选 `profileStore`；`handleCurationInput` ctx 增 `profileStore`/`profileCuration`；跨 Task 命名一致（`autoPromoteEntry`/`autoFileEntry`/`resolveAmbiguous`/`findByName`）。`CuratedIndex` key 格式 `${entryId}#c${idx}`/`#p${idx}` 全程一致。✅

**待实现者注意（非阻断，1 项 v1 范围缩减）：**
1. **v1 范围缩减**：profile-curation「合并全档案」（spec §六 job2，「档案的 dream」）+ `person_trait/relationship` 候选智能归档（spec §四 person 行）**延后**为 follow-up。原因：合并全档案依赖「先应用 merge 再 consolidate」的状态顺序，需 dispatch 内存模拟，复杂度高；v1 先交付高价值的别名归一（resolveAmbiguous）。`person_trait` 候选内容与 `people.note` 高度重叠，v1 经 people.note 入档覆盖。这两项作为 phase-2 的紧接下一步，不阻断 A/B 两增量交付。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-01-second-brain-phase2.md`. Two execution options:

**1. Subagent-Driven（推荐）** - 每个 task 派一个全新 subagent 实现，task 间审查，迭代快。
**2. Inline Execution** - 在本会话用 executing-plans 批量执行，带检查点审查。

Which approach?


# 第二大脑 · 日记地基 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 LICode 中实现 `/diary` 日记捕获：会话式捕获 -> `DiaryExtractor` 结构化抽取 -> 独立 `JournalStore`，为后续人际关系/咨询功能预留种子字段。

**Architecture:** 新增 `packages/core/src/diary/` 模块（types / serialize / store / extractor / session / dispatch，纯 TS、可单测）；CLI 侧在 `hooks.ts` 顶部旁路接入（`diarySessionRef` + `createDiaryExtractor` 复用 side-model）。日记库与记忆系统物理分开，仅靠 `futureMemory` 候选相连。Extractor 镜像 `CompressionAssistant`（注入 `generate`、结构化 JSON、失败降级存原文）。

**Tech Stack:** TypeScript（ESM，`.js` 导入）、vitest、pnpm monorepo（`@licode/core` + `packages/cli`）、`node:fs`/`node:path`。零新依赖。

## Global Constraints

- ESM TS，相对导入用 `.js` 扩展名（如 `from "./types.js"`）。
- 测试用 vitest，`*.test.ts` 与源码同目录；运行 `pnpm test`（= `vitest run`）。
- 零新依赖；仅用 `node:fs`、`node:path` 及现有 `@licode/core` 导出。
- Node >=20；pnpm。
- side-model 默认 `deepseek-chat`，经 `AnthropicProvider.chat` 调用。
- env 开关：`LICODE_DIARY=off`（整体旁路）、`LICODE_DIARY_MODEL`（覆盖 Extractor 模型）。
- 日记存储路径：`.licode/journal/YYYY-MM-DD/<id>.md`（frontmatter + JSON 围栏）。
- 不改动 `AgentLoop`、记忆系统、`SlashCommand` 接口；日记是 `hooks.ts` 顶部旁路。
- `pnpm build` 零 TS 错；现有测试不回归。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `packages/core/src/diary/types.ts`（新） | `DiaryEntry` 及子结构类型 + `emptyEntry`/`dateString` 纯函数 |
| `packages/core/src/diary/serialize.ts`（新） | `serializeEntry`/`parseEntry`（frontmatter + JSON 围栏往返） |
| `packages/core/src/diary/store.ts`（新） | `JournalStore`（IO：save/load/listByDate/listRecent/search）+ `DiaryStore` 接口 |
| `packages/core/src/diary/extractor.ts`（新） | `DiaryExtractor`（buildPrompt + parse + extract，失败降级） |
| `packages/core/src/diary/session.ts`（新） | `DiarySession`（segments 缓冲 + start/addSegment/end） |
| `packages/core/src/diary/dispatch.ts`（新） | `handleDiaryInput`（纯函数：/diary 子命令 + 捕获 + 召回） |
| `packages/core/src/index.ts`（改） | 导出 diary 模块 |
| `packages/cli/src/hooks.ts`（改） | `readDiaryFlags` + `createDiaryExtractor` + refs + `handleSubmit` 旁路 + 自动补全 |
| `packages/cli/src/hooks.diary.test.ts`（新） | `readDiaryFlags` 单测 |

---

### Task 1: DiaryEntry 类型 + 序列化

**Files:**
- Create: `packages/core/src/diary/types.ts`
- Create: `packages/core/src/diary/serialize.ts`
- Test: `packages/core/src/diary/serialize.test.ts`

**Interfaces:**
- Produces: `DiaryEntry`、`Segment`、`Fact`、`Decision`、`Emotion`、`PersonRef`、`Candidate` 等类型；`emptyEntry(id,date,createdAt): DiaryEntry`；`dateString(d: Date): string`；`serializeEntry(entry): string`；`parseEntry(raw): DiaryEntry | null`。后续所有 task 消费这些类型与函数。

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/diary/serialize.test.ts
import { describe, it, expect } from "vitest";
import { emptyEntry, dateString, type DiaryEntry } from "./types.js";
import { serializeEntry, parseEntry } from "./serialize.js";

describe("diary types + serialize", () => {
  it("emptyEntry produces the canonical empty shape", () => {
    const e = emptyEntry("id1", "2026-07-31", "2026-07-31T10:00:00.000Z");
    expect(e.meta).toEqual({ id: "id1", date: "2026-07-31", createdAt: "2026-07-31T10:00:00.000Z", endedAt: "2026-07-31T10:00:00.000Z" });
    expect(e.raw).toEqual({ content: "", segments: [] });
    expect(e.facts).toEqual([]);
    expect(e.futureMemory).toEqual([]);
  });

  it("dateString formats YYYY-MM-DD in local time", () => {
    expect(dateString(new Date(2026, 6, 31))).toBe("2026-07-31"); // month 0-based
    expect(dateString(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("serializeEntry then parseEntry round-trips a full entry", () => {
    const entry: DiaryEntry = {
      meta: { id: "id1", date: "2026-07-31", createdAt: "2026-07-31T10:00:00.000Z", endedAt: "2026-07-31T10:05:00.000Z" },
      raw: {
        content: "今天和老板聊了项目",
        segments: [{ timestamp: "2026-07-31T10:00:00.000Z", speaker: "user", content: "今天和老板聊了项目" }],
      },
      summary: "和老板讨论了项目技术方案",
      facts: [{ what: "和老板聊了项目", when: null, tags: ["work"] }],
      decisions: [{ decision: "换技术方案", reasoning: "老板建议", context: null }],
      emotions: [{ state: "焦虑", intensity: 3, trigger: "项目方向不确定", inferred: true }],
      people: [{ name: "老板", relation: "上级", relationInferred: true, interaction: "聊了项目方案", note: "建议换技术方案" }],
      futureMemory: [{ content: "老板倾向换技术方案", type: "decision", importance: "high", promotability: "medium", reason: "影响后续技术选型" }],
    };
    const raw = serializeEntry(entry);
    expect(raw).toContain("## 原文");
    expect(raw).toContain("## 结构化");
    expect(raw).toContain("id: id1");
    expect(raw).toContain("people: 老板");

    const parsed = parseEntry(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.meta).toEqual(entry.meta);
    expect(parsed!.summary).toBe(entry.summary);
    expect(parsed!.raw.segments).toEqual(entry.raw.segments);
    expect(parsed!.people).toEqual(entry.people);
    expect(parsed!.futureMemory).toEqual(entry.futureMemory);
  });

  it("parseEntry returns null on non-frontmatter input", () => {
    expect(parseEntry("just some text")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/diary/serialize.test.ts`
Expected: FAIL（模块不存在 / 导入失败）

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/diary/types.ts
export type FutureMemoryType = "person_trait" | "preference" | "relationship" | "decision" | "goal" | "other";
export type Importance = "low" | "medium" | "high";
export type Promotability = "low" | "medium" | "high";

export interface Segment {
  timestamp: string;
  speaker: "user";
  content: string;
}
export interface Fact { what: string; when: string | null; tags: string[]; }
export interface Decision { decision: string; reasoning: string | null; context: string | null; }
export interface Emotion { state: string; intensity: 1 | 2 | 3 | 4 | 5; trigger: string | null; inferred: boolean; }
export interface PersonRef { name: string; relation: string | null; relationInferred: boolean; interaction: string; note: string | null; }
export interface Candidate { content: string; type: FutureMemoryType; importance: Importance; promotability: Promotability; reason: string; }

export interface DiaryEntryMeta { id: string; date: string; createdAt: string; endedAt: string; }

export interface DiaryEntry {
  meta: DiaryEntryMeta;
  raw: { content: string; segments: Segment[] };
  summary: string;
  facts: Fact[];
  decisions: Decision[];
  emotions: Emotion[];
  people: PersonRef[];
  futureMemory: Candidate[];
}

export function emptyEntry(id: string, date: string, createdAt: string): DiaryEntry {
  return {
    meta: { id, date, createdAt, endedAt: createdAt },
    raw: { content: "", segments: [] },
    summary: "",
    facts: [], decisions: [], emotions: [], people: [], futureMemory: [],
  };
}

export function dateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
```

````typescript
// packages/core/src/diary/serialize.ts
import type { DiaryEntry } from "./types.js";

const INDEX_SUMMARY_MAX = 100;

function unique(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))];
}

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

export function serializeEntry(entry: DiaryEntry): string {
  const people = unique(entry.people.map((p) => p.name));
  const emotions = unique(entry.emotions.map((e) => e.state));
  const fm = [
    "---",
    `id: ${entry.meta.id}`,
    `date: ${entry.meta.date}`,
    `createdAt: ${entry.meta.createdAt}`,
    `endedAt: ${entry.meta.endedAt}`,
    `people: ${people.join(", ")}`,
    `emotions: ${emotions.join(", ")}`,
    `summary: ${entry.summary.slice(0, INDEX_SUMMARY_MAX)}`,
    "---",
    "",
  ].join("\n");

  const rawBlock = entry.raw.segments
    .map((s) => `[${s.timestamp}] ${s.speaker}: ${s.content}`)
    .join("\n");

  const json = JSON.stringify(
    {
      raw: entry.raw,
      summary: entry.summary,
      facts: entry.facts,
      decisions: entry.decisions,
      emotions: entry.emotions,
      people: entry.people,
      futureMemory: entry.futureMemory,
    },
    null,
    2
  );

  const fence = "```";
  return `${fm}## 原文\n${rawBlock}\n\n## 结构化\n${fence}json\n${json}\n${fence}\n`;
}

export function parseEntry(raw: string): DiaryEntry | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const fm = parseFrontmatter(m[1]);
  const jsonStr = extractJsonBlock(m[2]);
  if (!jsonStr) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  const rawField = (obj.raw as DiaryEntry["raw"]) ?? { content: "", segments: [] };
  return {
    meta: {
      id: fm.id ?? "",
      date: fm.date ?? "",
      createdAt: fm.createdAt ?? "",
      endedAt: fm.endedAt ?? "",
    },
    raw: rawField,
    summary: typeof obj.summary === "string" ? obj.summary : "",
    facts: Array.isArray(obj.facts) ? obj.facts as DiaryEntry["facts"] : [],
    decisions: Array.isArray(obj.decisions) ? obj.decisions as DiaryEntry["decisions"] : [],
    emotions: Array.isArray(obj.emotions) ? obj.emotions as DiaryEntry["emotions"] : [],
    people: Array.isArray(obj.people) ? obj.people as DiaryEntry["people"] : [],
    futureMemory: Array.isArray(obj.futureMemory) ? obj.futureMemory as DiaryEntry["futureMemory"] : [],
  };
}
````

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/core/src/diary/serialize.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/diary/types.ts packages/core/src/diary/serialize.ts packages/core/src/diary/serialize.test.ts
git commit -m "feat(diary): DiaryEntry 类型 + frontmatter/JSON 序列化往返"
```

---

### Task 2: JournalStore（独立日记库）

**Files:**
- Create: `packages/core/src/diary/store.ts`
- Test: `packages/core/src/diary/store.test.ts`

**Interfaces:**
- Consumes: `DiaryEntry`（Task 1）、`serializeEntry`/`parseEntry`（Task 1）。
- Produces: `DiaryStore` 接口（`save/load/listByDate/listRecent/search`）、`JournalStore` 类（实现 `DiaryStore`）。Task 5 dispatch 与 Task 6 CLI 消费 `JournalStore`。

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/diary/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JournalStore } from "./store.js";
import { emptyEntry, type DiaryEntry, type Segment } from "./types.js";

function entry(id: string, date: string, text: string): DiaryEntry {
  const e = emptyEntry(id, date, `${date}T10:00:00.000Z`);
  const seg: Segment = { timestamp: `${date}T10:00:00.000Z`, speaker: "user", content: text };
  e.raw = { content: text, segments: [seg] };
  e.summary = text;
  e.people = [{ name: "老板", relation: null, relationInferred: false, interaction: text, note: null }];
  return e;
}

describe("JournalStore", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "diary-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("save writes YYYY-MM-DD/<id>.md and load reads it back", async () => {
    const store = new JournalStore(dir);
    const e = entry("a1", "2026-07-31", "和老板聊了项目");
    await store.save(e);
    const file = path.join(dir, "2026-07-31", "a1.md");
    expect(fs.existsSync(file)).toBe(true);

    const loaded = await store.load("a1");
    expect(loaded).not.toBeNull();
    expect(loaded!.meta.id).toBe("a1");
    expect(loaded!.people[0].name).toBe("老板");
  });

  it("save refuses to overwrite an existing id", async () => {
    const store = new JournalStore(dir);
    await store.save(entry("a1", "2026-07-31", "x"));
    await expect(store.save(entry("a1", "2026-07-31", "y"))).rejects.toThrow(/already exists/);
  });

  it("listByDate returns all entries for a date", async () => {
    const store = new JournalStore(dir);
    await store.save(entry("a1", "2026-07-31", "晨会"));
    await store.save(entry("a2", "2026-07-31", "晚上跑步"));
    await store.save(entry("b1", "2026-07-30", "前一天"));
    const list = await store.listByDate("2026-07-31");
    expect(list.map((e) => e.meta.id).sort()).toEqual(["a1", "a2"]);
  });

  it("listRecent returns newest-first across dates up to limit", async () => {
    const store = new JournalStore(dir);
    await store.save(entry("b1", "2026-07-30", "旧"));
    await store.save(entry("a1", "2026-07-31", "新"));
    const recent = await store.listRecent(1);
    expect(recent.map((e) => e.meta.date)).toEqual(["2026-07-31"]);
  });

  it("search matches raw content and people names", async () => {
    const store = new JournalStore(dir);
    await store.save(entry("a1", "2026-07-31", "和老板聊了项目"));
    await store.save(entry("a2", "2026-07-31", "晚上独自跑步"));
    const hits = await store.search("老板");
    expect(hits.map((e) => e.meta.id)).toEqual(["a1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/diary/store.test.ts`
Expected: FAIL（`JournalStore` 不存在）

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/diary/store.ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { DiaryEntry } from "./types.js";
import { serializeEntry, parseEntry } from "./serialize.js";

export interface DiaryStore {
  save(entry: DiaryEntry): Promise<void>;
  load(id: string): Promise<DiaryEntry | null>;
  listByDate(date: string): Promise<DiaryEntry[]>;
  listRecent(limit: number): Promise<DiaryEntry[]>;
  search(query: string): Promise<DiaryEntry[]>;
}

async function readEntries(dir: string): Promise<DiaryEntry[]> {
  if (!fs.existsSync(dir)) return [];
  const out: DiaryEntry[] = [];
  for (const file of await fs.promises.readdir(dir)) {
    if (!file.endsWith(".md")) continue;
    const raw = await fs.promises.readFile(path.join(dir, file), "utf-8");
    const parsed = parseEntry(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

export class JournalStore implements DiaryStore {
  constructor(private dir: string) {}

  async save(entry: DiaryEntry): Promise<void> {
    const dateDir = path.join(this.dir, entry.meta.date);
    await fs.promises.mkdir(dateDir, { recursive: true });
    const filePath = path.join(dateDir, `${entry.meta.id}.md`);
    if (fs.existsSync(filePath)) {
      throw new Error(`diary entry already exists: ${entry.meta.id}`);
    }
    await fs.promises.writeFile(filePath, serializeEntry(entry), "utf-8");
  }

  async load(id: string): Promise<DiaryEntry | null> {
    if (!fs.existsSync(this.dir)) return null;
    for (const dateDir of await fs.promises.readdir(this.dir)) {
      const filePath = path.join(this.dir, dateDir, `${id}.md`);
      if (fs.existsSync(filePath)) {
        const raw = await fs.promises.readFile(filePath, "utf-8");
        return parseEntry(raw);
      }
    }
    return null;
  }

  async listByDate(date: string): Promise<DiaryEntry[]> {
    return readEntries(path.join(this.dir, date));
  }

  async listRecent(limit: number): Promise<DiaryEntry[]> {
    if (!fs.existsSync(this.dir)) return [];
    const dates = (await fs.promises.readdir(this.dir)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
    const out: DiaryEntry[] = [];
    for (const date of dates) {
      const entries = await readEntries(path.join(this.dir, date));
      out.push(...entries);
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  async search(query: string): Promise<DiaryEntry[]> {
    if (!fs.existsSync(this.dir)) return [];
    const q = query.toLowerCase();
    const all: DiaryEntry[] = [];
    for (const date of await fs.promises.readdir(this.dir)) {
      const dateDir = path.join(this.dir, date);
      const stat = await fs.promises.stat(dateDir);
      if (!stat.isDirectory()) continue;
      all.push(...(await readEntries(dateDir)));
    }
    return all.filter((e) => {
      const hay = [
        e.raw.content,
        e.summary,
        ...e.people.map((p) => p.name),
        ...e.facts.map((f) => f.what),
      ].join("\n").toLowerCase();
      return hay.includes(q);
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/core/src/diary/store.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/diary/store.ts packages/core/src/diary/store.test.ts
git commit -m "feat(diary): JournalStore 独立日记库（save/load/list/search）"
```

---

### Task 3: DiaryExtractor（结构化抽取 + 失败降级）

**Files:**
- Create: `packages/core/src/diary/extractor.ts`
- Test: `packages/core/src/diary/extractor.test.ts`

**Interfaces:**
- Consumes: `DiaryEntry`、`Segment`（Task 1）。
- Produces: `ExtractInput`、`DiaryExtractor`、`DiaryExtractorLike`（`{ extract(input): Promise<DiaryEntry> }`）。Task 4 session 与 Task 5 dispatch 消费。

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/diary/extractor.test.ts
import { describe, it, expect } from "vitest";
import { DiaryExtractor } from "./extractor.js";
import type { Segment } from "./types.js";

const segments: Segment[] = [
  { timestamp: "2026-07-31T10:00:00.000Z", speaker: "user", content: "今天和老板聊了项目，他建议我换技术方案，我有点焦虑" },
];

const baseInput = {
  id: "id1", date: "2026-07-31",
  createdAt: "2026-07-31T10:00:00.000Z", endedAt: "2026-07-31T10:05:00.000Z",
  segments, content: segments[0].content,
};

describe("DiaryExtractor", () => {
  it("extracts a full entry from valid JSON", async () => {
    const generate = async () => JSON.stringify({
      summary: "和老板讨论项目，建议换技术方案",
      facts: [{ what: "和老板聊了项目", when: null, tags: ["work"] }],
      decisions: [{ decision: "换技术方案", reasoning: "老板建议", context: null }],
      emotions: [{ state: "焦虑", intensity: 3, trigger: "项目方向", inferred: true }],
      people: [{ name: "老板", relation: "上级", relationInferred: true, interaction: "聊了方案", note: "建议换技术方案" }],
      futureMemory: [{ content: "老板倾向换方案", type: "decision", importance: "high", promotability: "medium", reason: "影响选型" }],
    });
    const ex = new DiaryExtractor({ generate });
    const entry = await ex.extract(baseInput);
    expect(entry.meta.id).toBe("id1");
    expect(entry.raw.segments).toEqual(segments);
    expect(entry.summary).toBe("和老板讨论项目，建议换技术方案");
    expect(entry.people[0].name).toBe("老板");
    expect(entry.futureMemory[0].importance).toBe("high");
  });

  it("parses JSON wrapped in a code fence", async () => {
    const generate = async () => "```json\n" + JSON.stringify({ summary: "fenced", facts: [], decisions: [], emotions: [], people: [], futureMemory: [] }) + "\n```";
    const ex = new DiaryExtractor({ generate });
    const entry = await ex.extract(baseInput);
    expect(entry.summary).toBe("fenced");
  });

  it("degrades to raw + fallback summary when generate throws", async () => {
    const generate = async () => { throw new Error("network"); };
    const ex = new DiaryExtractor({ generate });
    const entry = await ex.extract(baseInput);
    expect(entry.raw.segments).toEqual(segments);
    expect(entry.summary).toMatch(/抽取失败/);
    expect(entry.facts).toEqual([]);
    expect(entry.futureMemory).toEqual([]);
  });

  it("degrades when generate returns non-JSON", async () => {
    const generate = async () => "totally not json";
    const ex = new DiaryExtractor({ generate });
    const entry = await ex.extract(baseInput);
    expect(entry.summary).toMatch(/抽取失败/);
    expect(entry.raw.content).toBe(segments[0].content);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/diary/extractor.test.ts`
Expected: FAIL（`DiaryExtractor` 不存在）

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/diary/extractor.ts
import type { DiaryEntry, Segment } from "./types.js";

export interface DiaryExtractorConfig {
  generate: (prompt: string) => Promise<string>;
}

export interface ExtractInput {
  id: string;
  date: string;
  createdAt: string;
  endedAt: string;
  segments: Segment[];
  content: string;
}

export interface DiaryExtractorLike {
  extract(input: ExtractInput): Promise<DiaryEntry>;
}

interface ExtractedFields {
  summary: string;
  facts: DiaryEntry["facts"];
  decisions: DiaryEntry["decisions"];
  emotions: DiaryEntry["emotions"];
  people: DiaryEntry["people"];
  futureMemory: DiaryEntry["futureMemory"];
}

const FALLBACK_SUMMARY = "（自动抽取失败，仅保留原文）";

export class DiaryExtractor implements DiaryExtractorLike {
  constructor(private config: DiaryExtractorConfig) {}

  async extract(input: ExtractInput): Promise<DiaryEntry> {
    const meta = { id: input.id, date: input.date, createdAt: input.createdAt, endedAt: input.endedAt };
    const raw = { content: input.content, segments: input.segments };
    try {
      const prompt = this.buildPrompt(input.segments);
      const fields = this.parse(await this.config.generate(prompt));
      return { meta, raw, ...fields };
    } catch {
      return { meta, raw, summary: FALLBACK_SUMMARY, facts: [], decisions: [], emotions: [], people: [], futureMemory: [] };
    }
  }

  private buildPrompt(segments: Segment[]): string {
    const transcript = segments.map((s) => `[${s.timestamp}] ${s.speaker}: ${s.content}`).join("\n");
    return [
      "你是一个日记结构化抽取器。从下面的用户日记原文抽取结构化字段。",
      "总原则：不臆造（没说留 null）、推断必标注、宁可少收不要错收、语言跟随用户（中文）。",
      "",
      "逐字段规则：",
      "- summary: 2-3 句叙事摘要，只叙事不解读。",
      "- facts: 离散事件，每条一句话，去重，跳过无关琐事。{what, when, tags}",
      "- decisions: 只收明确决定，不猜意图；有理由附 reasoning。{decision, reasoning, context}",
      "- emotions: 从内容推断，标 inferred=true，必带 trigger。{state, intensity:1-5, trigger, inferred}",
      "- people: 每个被提到的人都收；关系能推断就填并标 relationInferred；interaction 写这次互动；note 收暴露的喜好/特质。{name, relation, relationInferred, interaction, note}",
      "- futureMemory: 只收“今天之后还可能重要”且“非例行流水账”的。{content, type:person_trait|preference|relationship|decision|goal|other, importance:low|medium|high, promotability:low|medium|high, reason}",
      "",
      "原文：",
      transcript,
      "",
      '只返回一个 JSON 对象，不要任何额外文字：',
      '{"summary":"...","facts":[...],"decisions":[...],"emotions":[...],"people":[...],"futureMemory":[...]}',
    ].join("\n");
  }

  private parse(raw: string): ExtractedFields {
    let s = raw.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("no JSON object in extractor response");
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(s.slice(start, end + 1));
    } catch (e) {
      throw new Error(`invalid JSON in extractor response: ${(e as Error).message}`);
    }
    return {
      summary: typeof obj.summary === "string" ? obj.summary : "",
      facts: Array.isArray(obj.facts) ? obj.facts as ExtractedFields["facts"] : [],
      decisions: Array.isArray(obj.decisions) ? obj.decisions as ExtractedFields["decisions"] : [],
      emotions: Array.isArray(obj.emotions) ? obj.emotions as ExtractedFields["emotions"] : [],
      people: Array.isArray(obj.people) ? obj.people as ExtractedFields["people"] : [],
      futureMemory: Array.isArray(obj.futureMemory) ? obj.futureMemory as ExtractedFields["futureMemory"] : [],
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/core/src/diary/extractor.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/diary/extractor.ts packages/core/src/diary/extractor.test.ts
git commit -m "feat(diary): DiaryExtractor 结构化抽取 + 失败降级"
```

---

### Task 4: DiarySession（捕获会话）

**Files:**
- Create: `packages/core/src/diary/session.ts`
- Test: `packages/core/src/diary/session.test.ts`

**Interfaces:**
- Consumes: `Segment`、`DiaryEntry`（Task 1）、`DiaryExtractorLike`、`ExtractInput`（Task 3）。
- Produces: `DiarySession`（`constructor(date, now)`、`addSegment(content, now)`、`end(extractor, now): Promise<DiaryEntry>`）。Task 5 dispatch 消费。

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/diary/session.test.ts
import { describe, it, expect } from "vitest";
import { DiarySession } from "./session.js";
import type { DiaryExtractorLike, ExtractInput } from "./extractor.js";
import type { DiaryEntry } from "./types.js";

function fakeExtractor(): DiaryExtractorLike {
  return {
    async extract(input: ExtractInput): Promise<DiaryEntry> {
      return {
        meta: { id: input.id, date: input.date, createdAt: input.createdAt, endedAt: input.endedAt },
        raw: { content: input.content, segments: input.segments },
        summary: "fake summary",
        facts: [], decisions: [], emotions: [], people: [], futureMemory: [],
      };
    },
  };
}

describe("DiarySession", () => {
  it("addSegment accumulates segments; end produces an entry with all segments", async () => {
    const session = new DiarySession("2026-07-31", new Date("2026-07-31T10:00:00.000Z"));
    session.addSegment("第一段", new Date("2026-07-31T10:01:00.000Z"));
    session.addSegment("第二段", new Date("2026-07-31T10:02:00.000Z"));
    const entry = await session.end(fakeExtractor(), new Date("2026-07-31T10:05:00.000Z"));
    expect(entry.meta.date).toBe("2026-07-31");
    expect(entry.meta.endedAt).toBe("2026-07-31T10:05:00.000Z");
    expect(entry.raw.segments.map((s) => s.content)).toEqual(["第一段", "第二段"]);
    expect(entry.raw.content).toBe("第一段\n第二段");
    expect(entry.summary).toBe("fake summary");
  });

  it("end with no segments still yields an entry (empty raw)", async () => {
    const session = new DiarySession("2026-07-31", new Date("2026-07-31T10:00:00.000Z"));
    const entry = await session.end(fakeExtractor(), new Date("2026-07-31T10:00:00.000Z"));
    expect(entry.raw.segments).toEqual([]);
    expect(entry.raw.content).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/diary/session.test.ts`
Expected: FAIL（`DiarySession` 不存在）

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/diary/session.ts
import type { Segment } from "./types.js";
import type { DiaryEntry } from "./types.js";
import type { DiaryExtractorLike, ExtractInput } from "./extractor.js";

export class DiarySession {
  private date: string;
  private id: string;
  private createdAt: string;
  private segments: Segment[] = [];

  constructor(date: string, now: Date) {
    this.date = date;
    this.id = now.getTime().toString(36);
    this.createdAt = now.toISOString();
  }

  addSegment(content: string, now: Date): void {
    this.segments.push({ timestamp: now.toISOString(), speaker: "user", content });
  }

  async end(extractor: DiaryExtractorLike, now: Date): Promise<DiaryEntry> {
    const input: ExtractInput = {
      id: this.id,
      date: this.date,
      createdAt: this.createdAt,
      endedAt: now.toISOString(),
      segments: this.segments,
      content: this.segments.map((s) => s.content).join("\n"),
    };
    return extractor.extract(input);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/core/src/diary/session.test.ts`
Expected: PASS（2 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/diary/session.ts packages/core/src/diary/session.test.ts
git commit -m "feat(diary): DiarySession 捕获会话（segments 缓冲 + end 抽取）"
```

---

### Task 5: diary dispatch（/diary 子命令 + 捕获 + 召回）

**Files:**
- Create: `packages/core/src/diary/dispatch.ts`
- Test: `packages/core/src/diary/dispatch.test.ts`

**Interfaces:**
- Consumes: `DiarySession`（Task 4）、`DiaryStore`（Task 2）、`DiaryExtractorLike`（Task 3）、`dateString`（Task 1）。
- Produces: `handleDiaryInput(input, ctx): Promise<DiaryDispatchOutcome | null>`（`null` = 非日记输入，调用方走原流程）。Task 6 CLI 消费。

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/diary/dispatch.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleDiaryInput } from "./dispatch.js";
import { JournalStore } from "./store.js";
import type { DiaryExtractorLike, ExtractInput } from "./extractor.js";
import type { DiaryEntry } from "./types.js";

function fakeExtractor(): DiaryExtractorLike {
  return {
    async extract(input: ExtractInput): Promise<DiaryEntry> {
      return {
        meta: { id: input.id, date: input.date, createdAt: input.createdAt, endedAt: input.endedAt },
        raw: { content: input.content, segments: input.segments },
        summary: "今日摘要",
        facts: [], decisions: [], emotions: [], people: [], futureMemory: [],
      };
    },
  };
}

describe("handleDiaryInput", () => {
  let dir: string;
  const now = () => new Date("2026-07-31T10:00:00.000Z");
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "disp-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const ctx = (session: null) => ({
    session, extractor: fakeExtractor(), store: new JournalStore(dir), now,
  });

  it("returns null for non-diary input with no active session", async () => {
    expect(await handleDiaryInput("帮我写代码", ctx(null))).toBeNull();
  });

  it("/diary starts a session", async () => {
    const out = await handleDiaryInput("/diary", ctx(null));
    expect(out).not.toBeNull();
    expect(out!.result.type).toBe("action");
    expect(out!.nextSession).not.toBeNull();
  });

  it("captures plain input when session active (no AgentLoop)", async () => {
    const started = await handleDiaryInput("/diary", ctx(null));
    const out = await handleDiaryInput("今天和老板聊了项目", { ...ctx(null), session: started!.nextSession });
    expect(out!.result.message).toMatch(/已记下/);
    expect(out!.nextSession).toBe(started!.nextSession);
  });

  it("/diary end extracts, stores, clears session, returns summary", async () => {
    const started = await handleDiaryInput("/diary", ctx(null));
    const session = started!.nextSession;
    await handleDiaryInput("今天和老板聊了项目", { ...ctx(null), session });
    const out = await handleDiaryInput("/diary end", { ...ctx(null), session });
    expect(out!.result.message).toContain("今日摘要");
    expect(out!.nextSession).toBeNull();
    const list = await new JournalStore(dir).listByDate("2026-07-31");
    expect(list.length).toBe(1);
  });

  it("/diary end with no session is an error", async () => {
    const out = await handleDiaryInput("/diary end", ctx(null));
    expect(out!.result.type).toBe("error");
  });

  it("/diary list shows recent entries", async () => {
    const started = await handleDiaryInput("/diary", ctx(null));
    await handleDiaryInput("内容一", { ...ctx(null), session: started!.nextSession });
    await handleDiaryInput("/diary end", { ...ctx(null), session: started!.nextSession });
    const out = await handleDiaryInput("/diary list", ctx(null));
    expect(out!.result.message).toContain("2026-07-31");
  });

  it("/diary while session active is an error (end first)", async () => {
    const started = await handleDiaryInput("/diary", ctx(null));
    const out = await handleDiaryInput("/diary", { ...ctx(null), session: started!.nextSession });
    expect(out!.result.type).toBe("error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/diary/dispatch.test.ts`
Expected: FAIL（`handleDiaryInput` 不存在）

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/diary/dispatch.ts
import type { DiaryEntry } from "./types.js";
import { dateString } from "./types.js";
import type { DiarySession } from "./session.js";
import type { DiaryStore } from "./store.js";
import type { DiaryExtractorLike } from "./extractor.js";

export interface DiaryDispatchDeps {
  extractor: DiaryExtractorLike;
  store: DiaryStore;
  now: () => Date;
}
export interface DiaryDispatchContext extends DiaryDispatchDeps {
  session: DiarySession | null;
}
export interface DiaryDispatchResult {
  type: "action" | "error";
  message: string;
}
export interface DiaryDispatchOutcome {
  result: DiaryDispatchResult;
  nextSession: DiarySession | null;
}

const RECENT_LIMIT = 10;

function formatPreview(e: DiaryEntry): string {
  const summary = e.summary.length > 60 ? e.summary.slice(0, 60) + "…" : e.summary;
  return `[${e.meta.date} ${e.meta.id}] ${summary}`;
}

export async function handleDiaryInput(
  input: string,
  ctx: DiaryDispatchContext
): Promise<DiaryDispatchOutcome | null> {
  const trimmed = input.trim();

  if (trimmed.startsWith("/diary")) {
    const rest = trimmed.slice("/diary".length).trim();
    const sub = rest.split(/\s+/)[0] ?? "";

    // /diary or /diary start
    if (sub === "" || sub === "start") {
      if (ctx.session) {
        return { result: { type: "error", message: "已在日记模式，请先 /diary end 结束当前会话。" }, nextSession: ctx.session };
      }
      const session = new DiarySession(dateString(ctx.now()), ctx.now());
      return {
        result: { type: "action", message: "📖 进入日记模式。描述今天发生的事，结束说 /diary end（查看历史：/diary list|find|show）。" },
        nextSession: session,
      };
    }

    // /diary end
    if (sub === "end") {
      if (!ctx.session) {
        return { result: { type: "error", message: "当前没有进行中的日记会话。" }, nextSession: null };
      }
      const entry = await ctx.session.end(ctx.extractor, ctx.now());
      await ctx.store.save(entry);
      return {
        result: { type: "action", message: `✅ 已保存今日日记：\n${entry.summary || "（无摘要）"}` },
        nextSession: null,
      };
    }

    // recall commands require no active session
    if (ctx.session) {
      return { result: { type: "error", message: "请先 /diary end 结束当前会话再查询。" }, nextSession: ctx.session };
    }

    if (sub === "list") {
      const dateArg = rest.split(/\s+/)[1];
      const entries = dateArg ? await ctx.store.listByDate(dateArg) : await ctx.store.listRecent(RECENT_LIMIT);
      if (entries.length === 0) return { result: { type: "action", message: "📭 没有日记条目。" }, nextSession: null };
      return { result: { type: "action", message: `📒 日记（${entries.length}）：\n${entries.map(formatPreview).join("\n")}` }, nextSession: null };
    }
    if (sub === "find") {
      const q = rest.split(/\s+/).slice(1).join(" ").trim();
      if (!q) return { result: { type: "error", message: "使用方式: /diary find <关键词>" }, nextSession: null };
      const entries = await ctx.store.search(q);
      if (entries.length === 0) return { result: { type: "action", message: `没有匹配“${q}”的日记。` }, nextSession: null };
      return { result: { type: "action", message: `🔎 匹配“${q}”（${entries.length}）：\n${entries.map(formatPreview).join("\n")}` }, nextSession: null };
    }
    if (sub === "show") {
      const id = rest.split(/\s+/)[1];
      if (!id) return { result: { type: "error", message: "使用方式: /diary show <id>" }, nextSession: null };
      const e = await ctx.store.load(id);
      if (!e) return { result: { type: "error", message: `未找到日记 ${id}。` }, nextSession: null };
      return { result: { type: "action", message: `📝 ${e.meta.date} ${e.meta.id}\n\n摘要：${e.summary}\n\n原文：\n${e.raw.segments.map((s) => s.content).join("\n")}` }, nextSession: null };
    }
    return { result: { type: "error", message: "未知子命令。使用: /diary | /diary end | /diary list [date] | /diary find <关键词> | /diary show <id>" }, nextSession: null };
  }

  // plain input during active session -> capture
  if (ctx.session) {
    ctx.session.addSegment(trimmed, ctx.now());
    return { result: { type: "action", message: "✓ 已记下（继续描述，或 /diary end 结束）" }, nextSession: ctx.session };
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/core/src/diary/dispatch.test.ts`
Expected: PASS（7 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/diary/dispatch.ts packages/core/src/diary/dispatch.test.ts
git commit -m "feat(diary): handleDiaryInput 调度（/diary 子命令 + 捕获 + 召回）"
```

---

### Task 6: core 导出 + CLI 接入（hooks.ts 旁路）

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/cli/src/hooks.ts`
- Test: `packages/cli/src/hooks.diary.test.ts`

**Interfaces:**
- Consumes: 所有 diary 模块（Task 1–5）。
- Produces: `@licode/core` 导出 diary 模块；`hooks.ts` 的 `readDiaryFlags`、`createDiaryExtractor`、`handleSubmit` 顶部旁路、`/diary` 自动补全。

- [ ] **Step 1: Write the failing test**

```typescript
// packages/cli/src/hooks.diary.test.ts
import { describe, it, expect, afterEach } from "vitest";

// readDiaryFlags 是 hooks.ts 顶层导出（参照 readContextFlags 的可测性）
import { readDiaryFlags } from "./hooks.js";

describe("readDiaryFlags", () => {
  const orig = { ...process.env };
  afterEach(() => { process.env = { ...orig }; });

  it("enabled by default, model defaults to deepseek-chat", () => {
    delete process.env.LICODE_DIARY;
    delete process.env.LICODE_DIARY_MODEL;
    const f = readDiaryFlags();
    expect(f.enabled).toBe(true);
    expect(f.model).toBe("deepseek-chat");
  });

  it("LICODE_DIARY=off disables", () => {
    process.env.LICODE_DIARY = "off";
    expect(readDiaryFlags().enabled).toBe(false);
  });

  it("LICODE_DIARY_MODEL overrides model", () => {
    process.env.LICODE_DIARY_MODEL = "gpt-4o-mini";
    expect(readDiaryFlags().model).toBe("gpt-4o-mini");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/cli/src/hooks.diary.test.ts`
Expected: FAIL（`readDiaryFlags` 未导出）

- [ ] **Step 3: Write minimal implementation**

在 `packages/core/src/index.ts` 末尾追加导出（在现有 memory/context 导出附近，遵循文件既有风格）：

```typescript
// ── diary ──
export type {
  DiaryEntry, DiaryEntryMeta, Segment, Fact, Decision, Emotion, PersonRef,
  Candidate, FutureMemoryType, Importance, Promotability,
} from "./diary/types.js";
export { emptyEntry, dateString } from "./diary/types.js";
export { serializeEntry, parseEntry } from "./diary/serialize.js";
export { JournalStore } from "./diary/store.js";
export type { DiaryStore } from "./diary/store.js";
export { DiaryExtractor } from "./diary/extractor.js";
export type { DiaryExtractorLike, ExtractInput, DiaryExtractorConfig } from "./diary/extractor.js";
export { DiarySession } from "./diary/session.js";
export { handleDiaryInput } from "./diary/dispatch.js";
export type {
  DiaryDispatchDeps, DiaryDispatchContext, DiaryDispatchResult, DiaryDispatchOutcome,
} from "./diary/dispatch.js";
```

在 `packages/cli/src/hooks.ts` 顶部 import 块（`@licode/core` 导入处）追加：

```typescript
  JournalStore,
  DiaryExtractor,
  handleDiaryInput,
```
（与现有 `MemoryStore`、`CompressionAssistant` 等并列。）并在 type import 块追加 `DiaryExtractor` 不需要类型；如 dispatch 类型用到则按需补。

在 `readContextFlags`（约 `hooks.ts:98`）附近新增：

```typescript
export function readDiaryFlags(): { enabled: boolean; model: string } {
  return {
    enabled: process.env.LICODE_DIARY !== "off",
    model: process.env.LICODE_DIARY_MODEL || "deepseek-chat",
  };
}

function createDiaryExtractor(
  apiKey: string,
  baseUrl: string | undefined,
  model: string
): DiaryExtractor {
  const sideProvider = new AnthropicProvider({ apiKey, baseUrl });
  return new DiaryExtractor({
    generate: async (prompt) => {
      const res = await sideProvider.chat({
        messages: [
          { role: "user", content: prompt, timestamp: new Date().toISOString() },
        ],
        model,
        maxTokens: 2048,
      });
      return res.content;
    },
  });
}
```

在 `useConversation` 内（与 `compressorRef`、`commandRouterRef` 同区，约 `hooks.ts:300`/`:351` 附近）新增 refs 与构造：

```typescript
  const diaryStoreRef = useRef<JournalStore>(
    new JournalStore(path.join(process.cwd(), ".licode", "journal"))
  );
  const diaryEnabledRef = useRef<boolean>(readDiaryFlags().enabled);
  const diaryExtractorRef = useRef<DiaryExtractor | null>(null);
```

在构造 compressor 的同一处（约 `hooks.ts:351` `compressorRef.current = createContextCompressor(...)` 旁）补：

```typescript
    const diaryFlags = readDiaryFlags();
    diaryEnabledRef.current = diaryFlags.enabled;
    if (diaryFlags.enabled) {
      diaryExtractorRef.current = createDiaryExtractor(apiKey, baseUrl, diaryFlags.model);
    }
```

在 `handleSubmit` 中、`router.route(input)`（约 `hooks.ts:481`）**之前**插入 diary 旁路：

```typescript
      // ── diary capture: /diary commands + capture during active session ──
      if (diaryEnabledRef.current && diaryExtractorRef.current) {
        const outcome = await handleDiaryInput(input, {
          session: diarySessionRef.current,
          extractor: diaryExtractorRef.current,
          store: diaryStoreRef.current,
          now: () => new Date(),
        });
        if (outcome !== null) {
          diarySessionRef.current = outcome.nextSession;
          setIsLoading(false);
          setCommandMessage(outcome.result.message);
          setMessages([...manager.getMessages()]);
          return;
        }
      }
```

并在 `useConversation` 的 refs 区声明：

```typescript
  const diarySessionRef = useRef<DiarySession | null>(null);
```
并在 `@licode/core` 的 type/value import 中补 `DiarySession`。

最后，把 `/diary` 加入自动补全列表：找到构建 `slashCommands` 的位置（从 `router.list()` + skills 汇总处），追加一项：

```typescript
      { name: "diary", description: "日记捕获（/diary 进入，/diary end 结束）" },
```

> 注：`handleSubmit` 的 React 状态接线由本步 `pnpm build` + Task 7 烟测验证；调度逻辑已在 Task 5 单测覆盖，Extractor 在 Task 3 单测覆盖。

- [ ] **Step 4: Run test to verify it passes + build**

Run: `pnpm test packages/cli/src/hooks.diary.test.ts && pnpm build`
Expected: 测试 PASS（3 用例）；build 零 TS 错。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/cli/src/hooks.ts packages/cli/src/hooks.diary.test.ts
git commit -m "feat(diary): core 导出 + hooks.ts /diary 旁路接入（side-model + refs + 自动补全）"
```

---

### Task 7: 全量验证 + 开关烟测

**Files:**
- 无新增文件；验证既有改动。

**Interfaces:**
- Consumes: Task 1–6 全部。

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: 全绿（diary 新增用例 + 既有用例不回归；预存 MCP startup 失败若存在则与 diary 无关，记录但不阻断）。

- [ ] **Step 2: 构建零错**

Run: `pnpm build`
Expected: 零 TS 错。

- [ ] **Step 3: 烟测 - 日记闭环**

启动 CLI（`pnpm start` 或 `./packages/cli/bin/licode.ts`），依次输入：
1. `/diary` -> 看到"进入日记模式"提示。
2. `今天和老板聊了项目，他建议换技术方案` -> 看到"已记下"。
3. `/diary end` -> 看到摘要。
4. 验证文件生成：`ls .licode/journal/2026-07-31/` 存在 `<id>.md`，打开含 `## 原文` + `## 结构化` JSON。
5. `/diary list` -> 看到该条目预览。

Expected: 闭环正常，文件格式正确。

- [ ] **Step 4: 烟测 - 开关旁路**

Run: `LICODE_DIARY=off pnpm start`，输入 `/diary`。
Expected: 不进入日记模式（旁路，`/diary` 落到未知命令或无反应），无 `.licode/journal/` 写入。

- [ ] **Step 5: Commit（若有烟测中发现的修复）**

```bash
git add -A
git commit -m "test(diary): 全量验证 + 开关烟测通过"
```
（若烟测无修复则跳过此 commit。）

---

## Self-Review

**1. Spec coverage：**
- §三 架构（日记 vs 记忆混合）-> Task 1–6（独立 JournalStore + 复用记忆系统不改动）✅
- §四 数据模型（raw.segments、Candidate importance/promotability）-> Task 1 types ✅
- §五 Extractor 抽取规则 + 失败降级 -> Task 3（buildPrompt 含逐字段规则、parse、降级）✅
- §六 JournalStore 存储格式 + 接口 -> Task 2 ✅
- §七 /diary 会话模式 + 分发 + 模块触点 -> Task 4 session + Task 5 dispatch + Task 6 hooks 旁路 ✅
- §八 召回（list/find/show）-> Task 5 dispatch + Task 2 store ✅
- §九 错误处理（Extractor 降级、save 失败保留缓冲）-> Task 3 降级；save 失败时 dispatch 抛错、`nextSession` 仍为原 session（未清空）✅（dispatch `/diary end` 中 `store.save` 抛错则不返回清空 outcome，异常上抛，session ref 不变）
- §十 配置回退（LICODE_DIARY / LICODE_DIARY_MODEL）-> Task 6 readDiaryFlags + 旁路 ✅
- §十一 测试验收 -> 各 Task 单测 + Task 7 全量/烟测 ✅

**2. Placeholder scan：** 无 TBD/TODO；每个代码步骤含完整可运行代码；dispatch save 失败保留缓冲的行为在 Task 5 代码中成立（`await ctx.store.save(entry)` 抛错则其后的 `return` 不执行，`nextSession` 不被应用）。✅

**3. Type consistency：** `DiaryEntry`/`Segment`/`Candidate`/`ExtractInput`/`DiaryStore`/`DiaryExtractorLike`/`DiarySession`/`DiaryDispatchOutcome` 跨 Task 命名与签名一致；`handleDiaryInput` 返回 `null | Outcome` 与 Task 6 调用方判空一致；`JournalStore implements DiaryStore` 与 dispatch deps 一致。✅

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-31-second-brain-diary.md`. Two execution options:

**1. Subagent-Driven (recommended)** - 每个 task 派一个全新 subagent 实现，task 间审查，迭代快。
**2. Inline Execution** - 在本会话用 executing-plans 批量执行，带检查点审查。

Which approach?

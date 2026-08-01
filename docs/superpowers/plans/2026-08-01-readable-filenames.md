# 可读文件名 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把日记与人物档案的落盘文件名从机器编码改成可读中文--日记 `<date>-<HHmm>-<title>.md`，人物 `<canonicalName>.md`，id 保留作内部 key。

**Architecture:** 文件名与 id 解耦。新增共享 `cleanName`/`hhmmFromISO` 工具；extractor 在现有同一次 LLM 调用里一并产出 `title`；diary store 用 `entryFilename(entry)` 生成可读文件名、`load` 改扫读 frontmatter 定位；people store 文件名改用 `canonicalName`、`load`/`delete` 改扫描。curation 与 memory 系统不动。

**Tech Stack:** TypeScript, vitest, Node.js `fs`/`path`

## Global Constraints

- 文件名保留中文，不转拼音、不 hash。
- id 保留作内部 key（`interactions.entryId`、`curatedIndex` mark key、`/diary-show <id>`），文件名不等于 id。
- people 的 `slug` 字段保留作 curation 内部 key，文件名改用 `canonicalName`；curation 不动。
- memory 系统的 slug（`type/slug` 形式）不动。
- 不写旧数据迁移（用户删了重来）。
- HHmm 取本地时区（与 `date` 对齐），测试用 `hhmmFromISO(createdAt)` 计算期望值，不硬编码。

---

## File Structure

- `packages/core/src/memory/types.ts` — 新增 `cleanName`、`hhmmFromISO`（与 `toSlug`/`hashString` 同文件，命名工具集）
- `packages/core/src/diary/types.ts` — `DiaryEntry` 加 `title`，`emptyEntry` 初始化
- `packages/core/src/diary/extractor.ts` — prompt/parse 加 `title`，失败回退 `""`
- `packages/core/src/diary/serialize.ts` — frontmatter 加 `title`，`parseEntry` 回填
- `packages/core/src/diary/store.ts` — `entryFilename`，`save`/`load` 改造
- `packages/core/src/diary/dispatch.ts` — `formatPreview` 用 title
- `packages/core/src/people/store.ts` — 文件名用 `canonicalName`，`load`/`delete` 扫描
- 对应 `*.test.ts` 更新

---

### Task 1: 共享命名工具 cleanName + hhmmFromISO

**Files:**
- Modify: `packages/core/src/memory/types.ts`
- Test: `packages/core/src/memory/types.test.ts` (Create)

**Interfaces:**
- Produces: `cleanName(s: string): string`、`hhmmFromISO(iso: string): string`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/memory/types.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { cleanName, hhmmFromISO } from "./types.js";

describe("cleanName", () => {
  it("保留中文与字母数字，标点空格转 -", () => {
    expect(cleanName("开会，聊项目！")).toBe("开会-聊项目");
    expect(cleanName("Food, Drink!")).toBe("Food-Drink");
    expect(cleanName("a/b:c")).toBe("a-b-c");
  });
  it("去掉首尾与重复连字符", () => {
    expect(cleanName("－－标题－－")).toBe("标题");
    expect(cleanName("  标题  ")).toBe("标题");
  });
  it("空或全标点返回空", () => {
    expect(cleanName("")).toBe("");
    expect(cleanName("！！！")).toBe("");
  });
});

describe("hhmmFromISO", () => {
  it("取本地时区时分，与 new Date 一致", () => {
    const iso = "2026-08-01T06:30:00.000Z";
    const d = new Date(iso);
    const expected = String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0");
    expect(hhmmFromISO(iso)).toBe(expected);
  });
  it("返回 4 位数字", () => {
    expect(hhmmFromISO("2026-08-01T06:30:00.000Z")).toMatch(/^\d{4}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @licode/core exec vitest run src/memory/types.test.ts`
Expected: FAIL — `cleanName`/`hhmmFromISO` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/core/src/memory/types.ts` (after `hashString`):

```ts
/**
 * 可读文件名清洗：保留中文(一-鿿)/字母/数字，其余(空格、标点、/ \ : * ? " < > | 等)转 -，
 * 去首尾与重复 -。不截断（截断由调用方定）。空或全标点返回空。
 */
export function cleanName(s: string): string {
  return s
    .replace(/[^一-鿿a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

/** 从 ISO 字符串取本地时区的 HHmm（如 "1430"），用于文件名，与本地 date 对齐。 */
export function hhmmFromISO(iso: string): string {
  const d = new Date(iso);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}${m}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @licode/core exec vitest run src/memory/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/types.ts packages/core/src/memory/types.test.ts
git commit -m "feat(memory): cleanName + hhmmFromISO 共享命名工具"
```

---

### Task 2: DiaryEntry 加 title 字段（extractor 同次产出 + serialize round-trip）

**Files:**
- Modify: `packages/core/src/diary/types.ts`
- Modify: `packages/core/src/diary/extractor.ts`
- Modify: `packages/core/src/diary/serialize.ts`
- Test: `packages/core/src/diary/extractor.test.ts`, `packages/core/src/diary/serialize.test.ts`
- Update: `packages/core/src/diary/dispatch.test.ts` (fakeExtractor 加 title)

**Interfaces:**
- Produces: `DiaryEntry.title: string`；`emptyEntry` 返回含 `title: ""`；extractor 产出的 entry 含 `title`；serialize frontmatter 含 `title:` 行。

- [ ] **Step 1: Write/update the failing tests**

In `packages/core/src/diary/extractor.test.ts`:

(a) 在第一个 `it("extracts a full entry...")` 的 `generate` mock JSON 里加 `title`，并加断言。把 mock 改为:

```ts
const generate = async () => JSON.stringify({
  title: "和老板聊项目",
  summary: "和老板讨论项目，建议换技术方案",
  facts: [{ what: "和老板聊了项目", when: null, tags: ["work"] }],
  decisions: [{ decision: "换技术方案", reasoning: "老板建议", context: null }],
  emotions: [{ state: "焦虑", intensity: 3, trigger: "项目方向", inferred: true }],
  people: [{ name: "老板", relation: "上级", relationInferred: true, interaction: "聊了方案", note: "建议换技术方案", specific: false }],
  futureMemory: [{ content: "老板倾向换方案", type: "decision", importance: "high", promotability: "medium", reason: "影响选型" }],
});
```

在该 `it` 末尾加:

```ts
expect(entry.title).toBe("和老板聊项目");
```

(b) 在 `it("degrades to raw + fallback summary when generate throws")` 末尾加:

```ts
expect(entry.title).toBe("");
```

(c) 在 `it("prompt includes the diary date...")` 末尾加:

```ts
expect(prompts[0]).toContain("title");
```

在 `packages/core/src/diary/serialize.test.ts` 的 `it("serializeEntry then parseEntry round-trips...")` 中:

(a) `entry` 字面量加 `title`（在 `summary` 前）:

```ts
const entry: DiaryEntry = {
  meta: { id: "id1", date: "2026-07-31", createdAt: "2026-07-31T10:00:00.000Z", endedAt: "2026-07-31T10:05:00.000Z" },
  raw: {
    content: "今天和老板聊了项目",
    segments: [{ timestamp: "2026-07-31T10:00:00.000Z", speaker: "user", content: "今天和老板聊了项目" }],
  },
  title: "和老板聊项目",
  summary: "和老板讨论了项目技术方案",
  facts: [{ what: "和老板聊了项目", when: null, tags: ["work"] }],
  decisions: [{ decision: "换技术方案", reasoning: "老板建议", context: null }],
  emotions: [{ state: "焦虑", intensity: 3, trigger: "项目方向不确定", inferred: true }],
  people: [{ name: "老板", relation: "上级", relationInferred: true, interaction: "聊了项目方案", note: "建议换技术方案", specific: false }],
  futureMemory: [{ content: "老板倾向换技术方案", type: "decision", importance: "high", promotability: "medium", reason: "影响后续技术选型" }],
};
```

(b) 在 `expect(raw).toContain("id: id1");` 后加:

```ts
expect(raw).toContain("title: 和老板聊项目");
```

(c) 在 `expect(parsed!.summary).toBe(entry.summary);` 后加:

```ts
expect(parsed!.title).toBe(entry.title);
```

在 `packages/core/src/diary/serialize.test.ts` 的 `it("emptyEntry produces the canonical empty shape")` 末尾加:

```ts
expect(e.title).toBe("");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @licode/core exec vitest run src/diary/extractor.test.ts src/diary/serialize.test.ts`
Expected: FAIL — `title` 属性不存在 / frontmatter 无 `title:`。

- [ ] **Step 3: Implement — types.ts**

In `packages/core/src/diary/types.ts`, `DiaryEntry` interface 加 `title: string`（在 `raw` 之后、`summary` 之前）:

```ts
export interface DiaryEntry {
  meta: DiaryEntryMeta;
  raw: { content: string; segments: Segment[] };
  title: string;
  summary: string;
  facts: Fact[];
  decisions: Decision[];
  emotions: Emotion[];
  people: PersonRef[];
  futureMemory: Candidate[];
}
```

`emptyEntry` 加 `title: ""`:

```ts
export function emptyEntry(id: string, date: string, createdAt: string): DiaryEntry {
  return {
    meta: { id, date, createdAt, endedAt: createdAt },
    raw: { content: "", segments: [] },
    title: "",
    summary: "",
    facts: [], decisions: [], emotions: [], people: [], futureMemory: [],
  };
}
```

- [ ] **Step 4: Implement — extractor.ts**

In `packages/core/src/diary/extractor.ts`:

(a) `ExtractedFields` interface 加 `title: string`（在 `summary` 前）:

```ts
interface ExtractedFields {
  title: string;
  summary: string;
  facts: DiaryEntry["facts"];
  decisions: DiaryEntry["decisions"];
  emotions: DiaryEntry["emotions"];
  people: DiaryEntry["people"];
  futureMemory: DiaryEntry["futureMemory"];
}
```

(b) `buildPrompt` 的逐字段规则数组里，在 `"- summary: ..."` 之前加一行:

```ts
"- title: 4-10 字中文短标题，概括本次日记主题，用作文件名，不含标点。",
```

(c) `buildPrompt` 末尾的 JSON 模板字符串改成（`title` 放最前）:

```ts
'{"title":"...","summary":"...","facts":[...],"decisions":[...],"emotions":[...],"people":[{"name":"...","relation":null,"relationInferred":false,"interaction":"...","note":null,"specific":true}],"futureMemory":[...]}',
```

(d) `parse` 的返回对象加 `title`（在 `summary` 前）:

```ts
return {
  title: typeof obj.title === "string" ? obj.title : "",
  summary: typeof obj.summary === "string" ? obj.summary : "",
  facts: Array.isArray(obj.facts) ? (obj.facts as ExtractedFields["facts"]) : [],
  decisions: Array.isArray(obj.decisions) ? (obj.decisions as ExtractedFields["decisions"]) : [],
  emotions: Array.isArray(obj.emotions) ? (obj.emotions as ExtractedFields["emotions"]) : [],
  people: Array.isArray(obj.people) ? (obj.people as ExtractedFields["people"]) : [],
  futureMemory: Array.isArray(obj.futureMemory) ? (obj.futureMemory as ExtractedFields["futureMemory"]) : [],
};
```

(e) `extract` 的 catch 分支返回对象加 `title: ""`:

```ts
} catch {
  return { meta, raw, title: "", summary: FALLBACK_SUMMARY, facts: [], decisions: [], emotions: [], people: [], futureMemory: [] };
}
```

- [ ] **Step 5: Implement — serialize.ts**

In `packages/core/src/diary/serialize.ts`:

(a) `serializeEntry` 的 `fm` 数组，在 `id: ${entry.meta.id}` 之后加:

```ts
`title: ${entry.title}`,
```

即 `fm` 变为:

```ts
const fm = [
  "---",
  `id: ${entry.meta.id}`,
  `title: ${entry.title}`,
  `date: ${entry.meta.date}`,
  `createdAt: ${entry.meta.createdAt}`,
  `endedAt: ${entry.meta.endedAt}`,
  `people: ${people.join(", ")}`,
  `emotions: ${emotions.join(", ")}`,
  `summary: ${entry.summary.slice(0, INDEX_SUMMARY_MAX)}`,
  "---",
  "",
].join("\n");
```

(b) `parseEntry` 的返回对象 `meta` 之后加 `title`:

```ts
return {
  meta: {
    id: fm.id ?? "",
    date: fm.date ?? "",
    createdAt: fm.createdAt ?? "",
    endedAt: fm.endedAt ?? "",
  },
  title: fm.title ?? "",
  raw: rawField,
  summary: typeof obj.summary === "string" ? obj.summary : "",
  facts: Array.isArray(obj.facts) ? (obj.facts as DiaryEntry["facts"]) : [],
  decisions: Array.isArray(obj.decisions) ? (obj.decisions as DiaryEntry["decisions"]) : [],
  emotions: Array.isArray(obj.emotions) ? (obj.emotions as DiaryEntry["emotions"]) : [],
  people: Array.isArray(obj.people) ? (obj.people as DiaryEntry["people"]) : [],
  futureMemory: Array.isArray(obj.futureMemory) ? (obj.futureMemory as DiaryEntry["futureMemory"]) : [],
};
```

- [ ] **Step 6: Update dispatch.test.ts fakeExtractor**

In `packages/core/src/diary/dispatch.test.ts` 的 `fakeExtractor` 返回对象加 `title`（在 `summary` 前）:

```ts
async extract(input: ExtractInput): Promise<DiaryEntry> {
  return {
    meta: { id: input.id, date: input.date, createdAt: input.createdAt, endedAt: input.endedAt },
    raw: { content: input.content, segments: input.segments },
    title: "今日标题",
    summary: "今日摘要",
    facts: [], decisions: [], emotions: [], people: [], futureMemory: [],
  };
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @licode/core exec vitest run src/diary/extractor.test.ts src/diary/serialize.test.ts src/diary/dispatch.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/diary/types.ts packages/core/src/diary/extractor.ts packages/core/src/diary/serialize.ts packages/core/src/diary/extractor.test.ts packages/core/src/diary/serialize.test.ts packages/core/src/diary/dispatch.test.ts
git commit -m "feat(diary): DiaryEntry 加 title 字段（extractor 同次产出 + serialize round-trip）"
```

---

### Task 3: diary store 改造（entryFilename + save + load 扫描）

**Files:**
- Modify: `packages/core/src/diary/store.ts`
- Test: `packages/core/src/diary/store.test.ts`

**Interfaces:**
- Consumes: `cleanName`、`hhmmFromISO` from `../memory/types.js`；`DiaryEntry.title` from Task 2
- Produces: `entryFilename(entry: DiaryEntry): string`（模块函数）；`save` 写 `<dir>/<date>/<entryFilename>`；`load(id)` 扫读 frontmatter 定位

- [ ] **Step 1: Update the failing tests**

In `packages/core/src/diary/store.test.ts`:

(a) `entry()` helper 加 `e.title = text;`（在 `e.summary = text;` 之后）:

```ts
function entry(id: string, date: string, text: string, person?: string): DiaryEntry {
  const e = emptyEntry(id, date, `${date}T10:00:00.000Z`);
  const seg: Segment = { timestamp: `${date}T10:00:00.000Z`, speaker: "user", content: text };
  e.raw = { content: text, segments: [seg] };
  e.summary = text;
  e.title = text;
  e.people = person ? [{ name: person, relation: null, relationInferred: false, interaction: text, note: null, specific: true }] : [];
  return e;
}
```

(b) 顶部 import 加 `hhmmFromISO`:

```ts
import { hhmmFromISO } from "../memory/types.js";
```

(c) 把 `it("save writes YYYY-MM-DD/<id>.md and load reads it back")` 整体替换为:

```ts
it("save writes <date>/<date>-<HHmm>-<title>.md and load reads it back", async () => {
  const store = new JournalStore(dir);
  const e = entry("a1", "2026-07-31", "和老板聊了项目", "老板");
  await store.save(e);
  const hhmm = hhmmFromISO(e.meta.createdAt);
  const file = path.join(dir, "2026-07-31", `2026-07-31-${hhmm}-和老板聊了项目.md`);
  expect(fs.existsSync(file)).toBe(true);

  const loaded = await store.load("a1");
  expect(loaded).not.toBeNull();
  expect(loaded!.meta.id).toBe("a1");
  expect(loaded!.people[0].name).toBe("老板");
});
```

(d) 把 `it("save refuses to overwrite an existing id")` 整体替换为（冲突加序号，不再 throw）:

```ts
it("save 同分同名冲突加序号 -2，不再 throw", async () => {
  const store = new JournalStore(dir);
  const e1 = entry("a1", "2026-07-31", "开会");
  const e2 = entry("a2", "2026-07-31", "开会"); // 同 date 同 createdAt 同 title
  await store.save(e1);
  await expect(store.save(e2)).resolves.toBeUndefined();
  const hhmm = hhmmFromISO(e1.meta.createdAt);
  const dateDir = path.join(dir, "2026-07-31");
  expect(fs.existsSync(path.join(dateDir, `2026-07-31-${hhmm}-开会.md`))).toBe(true);
  expect(fs.existsSync(path.join(dateDir, `2026-07-31-${hhmm}-开会-2.md`))).toBe(true);
});
```

(e) 加一个 load 扫描测试（在 listByDate 测试之前）:

```ts
it("load(id) 扫描 frontmatter 定位（文件名不含 id）", async () => {
  const store = new JournalStore(dir);
  await store.save(entry("a1", "2026-07-31", "晨会"));
  await store.save(entry("b1", "2026-07-30", "前一天"));
  const loaded = await store.load("b1");
  expect(loaded).not.toBeNull();
  expect(loaded!.meta.id).toBe("b1");
  expect(await store.load("nope")).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @licode/core exec vitest run src/diary/store.test.ts`
Expected: FAIL — 文件名仍是 `<id>.md`，新断言不通过。

- [ ] **Step 3: Implement — store.ts**

In `packages/core/src/diary/store.ts`:

(a) 顶部 import 加:

```ts
import { cleanName, hhmmFromISO } from "../memory/types.js";
```

(b) 在 `readEntries` 函数之后、`JournalStore` class 之前加模块函数 `entryFilename`:

```ts
function entryFilename(entry: DiaryEntry): string {
  const hhmm = hhmmFromISO(entry.meta.createdAt);
  const title = cleanName(entry.title).slice(0, 12).replace(/-+$/, "") || "无标题";
  return `${entry.meta.date}-${hhmm}-${title}.md`;
}
```

(c) 替换 `save` 方法:

```ts
async save(entry: DiaryEntry): Promise<void> {
  const dateDir = path.join(this.dir, entry.meta.date);
  await fs.promises.mkdir(dateDir, { recursive: true });
  const filePath = this.resolveUniquePath(dateDir, entry);
  await fs.promises.writeFile(filePath, serializeEntry(entry), "utf-8");
}

private resolveUniquePath(dateDir: string, entry: DiaryEntry): string {
  const name = entryFilename(entry);
  let candidate = path.join(dateDir, name);
  if (!fs.existsSync(candidate)) return candidate;
  const base = name.replace(/\.md$/, "");
  let i = 2;
  while (fs.existsSync(path.join(dateDir, `${base}-${i}.md`))) i++;
  return path.join(dateDir, `${base}-${i}.md`);
}
```

(d) 替换 `load` 方法（扫读 frontmatter）:

```ts
async load(id: string): Promise<DiaryEntry | null> {
  if (!fs.existsSync(this.dir)) return null;
  for (const dateDir of await fs.promises.readdir(this.dir)) {
    const full = path.join(this.dir, dateDir);
    const stat = await fs.promises.stat(full);
    if (!stat.isDirectory()) continue;
    const found = (await readEntries(full)).find((e) => e.meta.id === id);
    if (found) return found;
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @licode/core exec vitest run src/diary/store.test.ts`
Expected: PASS（含 listByDate/listRecent/search/listAll 旧测试，它们不依赖文件名）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/diary/store.ts packages/core/src/diary/store.test.ts
git commit -m "feat(diary): store 用 <date>-<HHmm>-<title>.md 文件名，load 扫读 frontmatter"
```

---

### Task 4: dispatch formatPreview 用 title

**Files:**
- Modify: `packages/core/src/diary/dispatch.ts`
- Test: `packages/core/src/diary/dispatch.test.ts`

**Interfaces:**
- Consumes: `hhmmFromISO` from `../memory/types.js`；`DiaryEntry.title` from Task 2

- [ ] **Step 1: Update the failing test**

In `packages/core/src/diary/dispatch.test.ts` 的 `it("/diary list shows recent entries")` 末尾加断言:

```ts
expect(out!.result.message).toContain("今日标题");
expect(out!.result.message).toMatch(/\(\w+\)/); // (id) 句柄
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @licode/core exec vitest run src/diary/dispatch.test.ts`
Expected: FAIL — message 不含「今日标题」（旧 formatPreview 用 summary）。

- [ ] **Step 3: Implement — dispatch.ts**

In `packages/core/src/diary/dispatch.ts`:

(a) 顶部 import 加（与现有 `import type { DiaryEntry }` 同区域）:

```ts
import { hhmmFromISO } from "../memory/types.js";
```

(b) 替换 `formatPreview` 函数:

```ts
function formatPreview(e: DiaryEntry): string {
  const title = e.title || (e.summary.length > 60 ? e.summary.slice(0, 60) + "…" : e.summary);
  const hhmm = hhmmFromISO(e.meta.createdAt);
  return `[${e.meta.date} ${hhmm}] ${title} (${e.meta.id})`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @licode/core exec vitest run src/diary/dispatch.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/diary/dispatch.ts packages/core/src/diary/dispatch.test.ts
git commit -m "feat(diary): formatPreview 显示 [date HHmm] title (id)"
```

---

### Task 5: people store 文件名用 canonicalName + load/delete 扫描

**Files:**
- Modify: `packages/core/src/people/store.ts`
- Test: `packages/core/src/people/store.test.ts`

**Interfaces:**
- Consumes: `cleanName` from `../memory/types.js`
- Produces: `save` 写 `cleanName(canonicalName).md`；`load(slug)`/`delete(slug)` 扫读 frontmatter slug 定位

- [ ] **Step 1: Update the failing tests**

In `packages/core/src/people/store.test.ts`:

(a) 顶部 import 加 `cleanName`（保留现有 `toSlug` import）:

```ts
import { toSlug, cleanName } from "../memory/types.js";
```

(b) 把 `it("save(create) writes <slug>.md and load reads it back")` 整体替换为:

```ts
it("save(create) writes <canonicalName>.md and load reads it back", async () => {
  const s = new PersonProfileStore(dir);
  const p = profile("王总", ["老板"]);
  await s.save(p, "create");
  const file = path.join(dir, `${cleanName("王总")}.md`);
  expect(fs.existsSync(file)).toBe(true);
  expect(fs.existsSync(path.join(dir, `${p.meta.slug}.md`))).toBe(false); // 文件名不再是 slug

  const loaded = await s.load(p.meta.slug);
  expect(loaded).not.toBeNull();
  expect(loaded!.meta.canonicalName).toBe("王总");
});
```

(c) 把 `it("save(create) refuses to overwrite existing slug")` 的描述与断言里 `slug` 改为 `canonicalName`（行为不变，文件名维度变了）:

```ts
it("save(create) refuses to overwrite existing canonicalName", async () => {
  const s = new PersonProfileStore(dir);
  await s.save(profile("王总"), "create");
  await expect(s.save(profile("王总"), "create")).rejects.toThrow(/already exists/);
});
```

(d) 加一个 delete 扫描测试（在 listRecent 测试之后）:

```ts
it("delete(slug) 扫描定位并删除文件", async () => {
  const s = new PersonProfileStore(dir);
  const p = profile("王总");
  await s.save(p, "create");
  expect(fs.existsSync(path.join(dir, `${cleanName("王总")}.md`))).toBe(true);
  await s.delete(p.meta.slug);
  expect(fs.existsSync(path.join(dir, `${cleanName("王总")}.md`))).toBe(false);
  expect(await s.load(p.meta.slug)).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @licode/core exec vitest run src/people/store.test.ts`
Expected: FAIL — 文件名仍是 `<slug>.md`，新断言不通过。

- [ ] **Step 3: Implement — people/store.ts**

In `packages/core/src/people/store.ts`:

(a) 顶部 import 加:

```ts
import { cleanName } from "../memory/types.js";
```

(b) 替换 `file` 方法（参数从 `slug` 改为 `canonicalName`）:

```ts
private file(canonicalName: string): string {
  return path.join(this.dir, `${cleanName(canonicalName) || "untitled"}.md`);
}
```

(c) 替换 `save` 方法（用 `canonicalName` 派生文件名）:

```ts
async save(profile: PersonProfile, action: ProfileAction = "create"): Promise<void> {
  await fs.promises.mkdir(this.dir, { recursive: true });
  const filePath = this.file(profile.meta.canonicalName);
  if (action === "create" && fs.existsSync(filePath)) {
    throw new Error(`profile already exists: ${profile.meta.canonicalName}`);
  }
  await fs.promises.writeFile(filePath, serializeProfile(profile), "utf-8");
}
```

(d) 替换 `load` 方法（扫描 frontmatter slug）:

```ts
async load(slug: string): Promise<PersonProfile | null> {
  const all = await this.listAll();
  return all.find((p) => p.meta.slug === slug) ?? null;
}
```

(e) 替换 `delete` 方法（扫描找 canonicalName 再删文件）:

```ts
async delete(slug: string): Promise<void> {
  const all = await this.listAll();
  const p = all.find((x) => x.meta.slug === slug);
  if (!p) return;
  const filePath = this.file(p.meta.canonicalName);
  if (fs.existsSync(filePath)) await fs.promises.unlink(filePath);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @licode/core exec vitest run src/people/store.test.ts`
Expected: PASS（含 findByName/listRecent 旧测试，它们用 listAll 扫描，不依赖文件名）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/people/store.ts packages/core/src/people/store.test.ts
git commit -m "feat(people): store 文件名用 canonicalName（中文），load/delete 扫描 slug 定位"
```

---

### Task 6: 全量测试 + 类型检查 + 部署清理说明

**Files:**
- None (验证 + 文档)

- [ ] **Step 1: 全量测试**

Run: `pnpm --filter @licode/core exec vitest run`
Expected: 全部 PASS。

- [ ] **Step 2: 类型检查**

Run: `pnpm --filter @licode/core exec tsc --noEmit`
Expected: 无错误（所有 `DiaryEntry` 字面量已含 `title`）。

- [ ] **Step 3: 部署清理说明（用户环境执行）**

代码不碰 `.licode`（测试用 tmpdir）。用户在自己的运行环境删除旧编码文件:

```bash
rm -rf .licode/people .licode/diary
```

curated index（`<旧id>#p<i>` 形式的 key）不匹配新 id，无害，可留；如想清也一并删 `.licode` 下 curated index 文件。

- [ ] **Step 4: 最终提交（如有遗漏修复）**

若 step 1/2 发现遗漏（如其他构造 `DiaryEntry` 的字面量缺 `title`），修复后提交:

```bash
git add -A
git commit -m "fix(diary): 补齐遗漏的 DiaryEntry.title 字面量"
```

若无遗漏，跳过。

- [ ] **Step 5: 推送**

```bash
git push -u gitee worktree-readable-filenames
```

---

## Self-Review

**1. Spec coverage:**
- 命名规则（日记 `<date>-<HHmm>-<title>.md`、人物 `<canonicalName>.md`）→ Task 3、Task 5 ✓
- `cleanName` 共享 + `hhmmFromISO` → Task 1 ✓
- title 由 extractor 同次 LLM 调用产出 → Task 2 ✓
- id 保留作内部 key，文件名与 id 解耦 → Task 3（load 扫描）✓
- diary `load(id)` 扫读 frontmatter → Task 3 ✓
- `formatPreview` 用 title → Task 4 ✓
- people slug 保留作 curation key，文件名用 canonicalName → Task 5（slug 字段未删，curation 不动）✓
- 旧数据删了重来 → Task 6 Step 3 ✓
- 测试覆盖 → 各 Task 的 TDD 步骤 ✓

**2. Placeholder scan:** 无 TBD/TODO；每个代码步骤含实际代码。✓

**3. Type consistency:**
- `cleanName(s: string): string`、`hhmmFromISO(iso: string): string` — Task 1 定义，Task 3/4/5 消费，签名一致 ✓
- `entryFilename(entry: DiaryEntry): string` — Task 3 定义并使用 ✓
- `DiaryEntry.title: string` — Task 2 定义，Task 3/4 消费 ✓
- people `file(canonicalName: string)` — Task 5 内部一致 ✓
- `load(slug)`/`delete(slug)` 签名不变（curation 仍传 slug），实现改扫描 ✓

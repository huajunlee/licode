# 可读文件名设计 — 日记与人物档案

- 日期: 2026-08-01
- 状态: 设计待审阅
- 分支: worktree-readable-filenames

## 背景

phase1 日记系统与 phase2 人际关系系统已落地。当前落盘文件名是机器编码，对人不可读：

- 日记: `.licode/diary/<date>/<id>.md`，`id = Date.now().toString(36)`（毫秒时间戳 base36，如 `ms9vc5q0`）
- 人物: `.licode/people/<slug>.md`，`slug = toSlug(name)`；中文名走 `hashString` 兜底（如 `王总` → `k6j4`）

目标：文件名对人可读——日记含日期/时分/概述，人物保留中文名。

## 决策汇总（已与用户确认）

1. **简要概述来源**: extractor 在产出现有结构化字段的同一次 LLM 调用里一并产出 `title`（4-10 字中文短标题），不额外调用 LLM。
2. **目录结构**: 日期目录 + 文件名含完整日期。`.licode/diary/<date>/<date>-<HHmm>-<title>.md`。现有按日期目录的查询逻辑不动。
3. **旧数据**: 删了重来，不写迁移。
4. **people slug**: 保留 slug 作 curation 内部 key，文件名改用 `canonicalName`（中文）。curation 不动。

## 命名规则

### 日记

- 路径: `.licode/diary/<date>/<date>-<HHmm>-<title>.md`
- 例: `.licode/diary/2026-08-01/2026-08-01-1430-开会聊项目方向.md`
- `date`: `entry.meta.date`（本地日期，已有，`YYYY-MM-DD`）
- `HHmm`: 从 `entry.meta.createdAt`（UTC ISO）转本地时区取时分，与 `date` 对齐，避免 UTC 偏移导致日期/时分错位
- `title`: extractor 产出的短标题，经 `cleanName` 清洗后截断 12 字；空或清洗后空回退「无标题」
- 冲突: 文件名已存在则在 `.md` 前追加 `-2`、`-3`，如 `2026-08-01-1430-开会-2.md`（含时分，极少撞）

### 人物

- 路径: `.licode/people/<cleanName(canonicalName)>.md`
- 例: `.licode/people/王总.md`
- `canonicalName` 直接作文件名，经 `cleanName` 清洗；清洗后为空（极端情况）回退 `untitled`
- slug 字段保留（curation 用），不作文件名
- canonicalName 变更只在 `mergeProfiles` 发生（那里已 delete 旧文件 + save 新文件），store 无需自动重命名

### 统一 cleanName

放 `memory/types.ts`（与 `toSlug`/`hashString` 同文件）。

```
cleanName(s): 保留中文(一-鿿)/字母/数字，其余(空格、标点、/ \ : * ? " < > | 等)一律转 -，去首尾与重复 -；不截断(截断由调用方定)
```

diary `title`（截断 12）与 people `canonicalName`（不截断）共用。

### HHmm 提取

共享 helper `hhmmFromISO(iso)`：`new Date(iso)` 后取本地 `getHours()`/`getMinutes()` 补零拼接。`entryFilename` 与 `formatPreview` 共用，保证时分一致。

## id 体系与 load/查询机制

核心：文件名与 id 解耦。id 保留作内部 key。

- **id 保留**: `session.ts` 仍生成 `now.getTime().toString(36)`，存 frontmatter。id 继续作内部 key — `interactions.entryId`、`curatedIndex` mark key（`<id>#p<i>`）、`/diary-show <id>` 入参 — 并兼作短句柄供用户复制定位。
- **save**: 文件名由 `entryFilename(entry)` 生成 = `<date>-<HHmm>-<cleanName(title)>.md`；冲突追加 `-2`/`-3`；不再 throw `already exists`。
- **load(id)**: 改为遍历日期目录下 `.md` 读 frontmatter 的 `id` 字段匹配（复用 `readEntries` 思路）。O(文件数)，日记量小可接受。
- **listByDate / listRecent / listAll / search**: 日期目录结构不变，`readEntries` 按 `.md` 遍历读 frontmatter、不依赖文件名 → 无需改动。
- **`/diary-show <id>`**: 不变，仍用 id 定位。
- **formatPreview**: 从 `[date id] summary` 改为 `[date HHmm] title (id)`；title 为空回退 summary 前 60 字。

## extractor 改动（加 title 字段）

同一次 LLM 调用一并产出 title，不额外调用。

- **DiaryEntry**（`diary/types.ts`）顶层加 `title: string`；`emptyEntry` 初始化 `title: ""`。
- **buildPrompt**（`diary/extractor.ts`）逐字段规则加: `title: 4-10 字中文短标题，概括本次日记主题，用作文件名，不含标点`；返回 JSON 模板加 `"title":"..."`。
- **parse**: 解析 `title`（string，否则 `""`）；`extract` 失败回退 `title: ""`（由 `entryFilename` 统一兜底「无标题」）。
- **serialize**（`diary/serialize.ts`）frontmatter 加 `title: ${entry.title}`；`parseEntry` 回填 title。
- title 的清洗与截断在 `entryFilename` 的 `cleanName` 完成，extractor 只负责产出干净短标题。

## store 改动

### diary store（`diary/store.ts`）

- 新增 `entryFilename(entry)`: 生成 `<date>-<HHmm>-<cleanName(title)>.md`，HHmm 从 `createdAt` 经 `hhmmFromISO` 取；title 空/清洗后空回退「无标题」；`cleanName(title)` 截断 12 字；冲突追加 `-2`/`-3`。
- save: 路径 = `<dir>/<date>/<entryFilename>`；去掉 throw already exists（冲突加序号）。
- load(id): 遍历日期目录读 frontmatter id 匹配。
- listByDate/listRecent/listAll/search: 不动。

### people store（`people/store.ts`）

- save: 文件名 = `cleanName(canonicalName).md`（不再用 slug）；create 重名 throw 保留。
- load(slug): 改为 listAll 找 frontmatter slug 匹配（文件名≠slug，不能直接定位）。
- delete(slug): 改为 listAll 找 slug 匹配的文件删除。
- findByName/listAll/listRecent: 不动（本就扫描）。
- `people/profile-file.ts` / curation: 不动（slug 仍作 curation key）。

## 数据清理

- 删除 `.licode/people/*`、`.licode/diary/*` 旧编码文件（手动 rm，不写迁移）。
- curated index 的旧 key（`<旧id>#p<i>`）无害（不匹配新 id），可留或一并清。

## 测试

- `diary/store.test.ts`: entryFilename 格式/cleanName/冲突序号/HHmm 本地时区/空 title 回退；save 用新文件名落盘；load(id) 扫描定位。
- `diary/serialize.test.ts`: title round-trip。
- `diary/extractor.test.ts`: title 解析 + 失败回退 ""。
- `people/store.test.ts`: 文件名=canonicalName；load(slug)/delete(slug) 扫描定位。
- `diary/dispatch.test.ts`: formatPreview 用 title；/diary-show 用 id。
- 更新现有断言里文件名=id 的部分。

## 改动文件清单

- `packages/core/src/memory/types.ts` — 加 `cleanName`
- `packages/core/src/diary/types.ts` — DiaryEntry 加 `title`，`emptyEntry`
- `packages/core/src/diary/extractor.ts` — prompt/parse 加 title，失败回退
- `packages/core/src/diary/serialize.ts` — frontmatter title，`parseEntry`
- `packages/core/src/diary/store.ts` — `entryFilename`，save/load 改
- `packages/core/src/diary/dispatch.ts` — `formatPreview` 改
- `packages/core/src/people/store.ts` — 文件名用 canonicalName，load/delete 扫描
- 对应 `*.test.ts` 更新
- `session.ts` 不变（id 生成不变）；curation 不变

## 非目标（YAGNI）

- 不改 memory 系统的 slug（另一套长期记忆，文件名 `type/slug`，不在范围）。
- 不写旧数据迁移（删了重来）。
- 不引入 id->filename 索引文件（日记量小，扫描足够）。
- 不去掉 people 的 slug 字段（curation 仍用，保留作内部 key）。
- 不改 curation 的 intoSlug 流程（风险隔离）。

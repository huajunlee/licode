# 第二大脑 · 日记地基 设计

> **状态**：设计已与用户逐节确认，待写实现计划
>
> **设计日期**：2026-07-31
>
> **前置**：LICode 记忆系统（memory/，Phase 1–4）与上下文管理（Phase 1–5）均已落地并接线。
>
> **说明**：本文是"第二大脑"第一步（日记地基）的设计 spec，非实现计划。实现步骤由后续 writing-plans 产出。遵循项目"独立可验证、可回退"原则。

---

## 一、背景与现状（已核实）

将 LICode 扩展为"第二大脑"个人 Agent。用户提出三大块：日记（捕获）、人际关系（结构化）、情感/关系咨询（综合）。三大块偏大，本 spec 只做**第一步：日记地基**--它是后两块的输入源。整体记忆模型预留对"人物/事件"的扩展位。

对设计最相关的现状（已读源码核实）：

- **记忆系统**（`packages/core/src/memory/`）：`Memory` 类型（`types.ts`）= `{slug, type:user|feedback|project|reference, name, description, content, createdAt, updatedAt, usageCount, lastUsedAt, pinned}`。`MemoryStore`（`store.ts`）以 frontmatter markdown 存于 `.licode/memory/<type>/<slug>.md` + `MEMORY.md` 索引；`save` 的 `create` 在文件已存在时**防御性降级为 append**（永不丢旧内容）。`recall.ts` 按 frontmatter side-query 召回；`extractor.ts` 从会话抽取记忆；`dream.ts` 整理/归档。
- **上下文 side-call 模式**（`packages/core/src/context/summarizer.ts`）：`CompressionAssistant` 注入 `generate: (prompt)=>Promise<string>`，`buildPrompt` + `parse`（处理 ```json 围栏、提取 `{...}`、校验字段），失败抛错由调用方降级。side-model 默认 `deepseek-chat`（`ContextConfig.summarizerModel`）。
- **命令系统**（`packages/core/src/extensions/commands/`）：`SlashCommand`（`registry.ts`）= `{name, description, args?, execute(args, ctx): Promise<CommandResult>}`；`CommandResult` = `{type:"prompt"|"action"|"error", ...}`；`CommandRouter.route`（`router.ts`）按 `/name args` 分发。builtin 命令在 `extensions/commands/builtin/`（如 `memory.ts` 用 `new MemoryStore(\`${workingDirectory}/.licode/memory\`)` 直存）。
- **输入分发**（`packages/cli/src/hooks.ts`）：`handleSubmit` 中 `router.route(input)`（约 `:481`）；命令返回 `{type:"prompt"}` 则把 `content` 当 user-message 送进 pipeline（约 `:546`）；普通输入 `yield {type:"user-message", content:input}`（约 `:609`）驱动 `AgentLoop`。side-model 经 `createContextCompressor`（约 `:113`）用独立 `AnthropicProvider` 构造。
- **AgentLoop**（`packages/core/src/agent/loop.ts`）：`run(userInput)` 一次处理一条用户输入；`onTurnStart` 钩子（记忆召回注入处）；每 run 至多压缩一次。
- **测试**：vitest（`pnpm test`），`*.test.ts` 与源码同目录。

---

## 二、目标与范围

### 目标

第二大脑第一步：**日记地基**。`/diary` 开启捕获会话 -> 会话结束 **Extractor 立即生成结构化条目（JSON）** -> 存入**独立日记库**；原文逐轮保留；当天可多次追加。记忆模型预留人物/事件/提升桥。

### 范围（本次 spec）

- ✅ `/diary` 会话模式（start / 捕获 / end）
- ✅ `DiaryExtractor` side-call（结构化 JSON，复用 `CompressionAssistant` 模式）
- ✅ `JournalStore`（独立日记库，与记忆系统物理分开）
- ✅ `DiaryEntry` 数据模型（`raw.segments`、`summary`、`facts`、`decisions`、`emotions`、`people`、`futureMemory` 带 `importance`/`promotability`）
- ✅ 召回（按日期 / 人物 / 关键词查日记）

### 范围外（延后）

- ❌ **提升桥自动执行**：v1 只抽取并存储 `futureMemory` 候选，**不自动**写入现有记忆系统（守护"记忆必须有意义"）。提升为紧接的下一步。
- ❌ **人际关系人物档案聚合**（people-feature）：日记 `people` 字段为其种子，本 spec 不做聚合。
- ❌ **情感/关系咨询**、周期性回顾、前瞻提醒、决策记录等扩展。

---

## 三、核心架构：日记 vs 记忆

两类数据本质不同，物理分开、语义不同，仅靠 `futureMemory` 候选一个字段相连：

- **日记（Journal）**：每天的流水账，**不一定有意义**。量大、时序、允许冗余，append-only 按日期归集。存独立日记库。
- **记忆（Memory）**：长期存在、**必须有实际意义**。稀疏、耐用、可复用。**复用现有记忆系统**，不重造。

```
/diary 会话
   │  原文（逐轮 segments）
   ▼
DiaryExtractor（side-call，复用 CompressionAssistant 模式）
   │
   ├──▶ 日记库 JournalStore（新·独立）   一条结构化条目 / 会话
   │       raw / summary / facts / decisions /
   │       emotions / people / futureMemory
   │
   └──▶ [提升桥] futureMemory 候选 ──▶ 现有记忆系统（v1 不自动执行）
           有意义、值得长期记的 -> 提升为记忆（下一步）
           其余留在日记里当流水账
```

**实现路径采用混合方案**（候选 A/B/C 中选 C）：

| 候选 | 说明 | 取舍 |
|---|---|---|
| A) 日记作为一种新 memory 类型塞进现有系统 | 复用存储/召回 | ❌ 日记量大、低意义，污染记忆 |
| B) 完全独立日记库、与记忆系统无关 | 干净 | ❌ 丢了"提升"这条线 |
| C) **混合：日记独立成库 + 记忆复用现有系统 + 提升桥** | 日记/记忆各得其所 | ✅ 选定 |

---

## 四、DiaryEntry 数据模型

一个 `/diary` 会话 = 一条 `DiaryEntry`：

```ts
DiaryEntry {
  meta {
    id:          string    // 会话 id（时间戳生成）
    date:        string    // YYYY-MM-DD，归属当天
    createdAt:   string    // 会话开始 ISO 时间
    endedAt:     string    // 抽取完成 ISO 时间
  }
  raw: {
    content:   string      // 全文拼接（便于阅读/检索）
    segments: [            // 逐轮保留会话结构
      { timestamp: string, speaker: "user", content: string }
    ]
  }
  summary:       string    // 2-3 句叙事摘要
  facts:         Fact[]
  decisions:     Decision[]
  emotions:      Emotion[]
  people:        PersonRef[]
  futureMemory:  Candidate[]
}
```

子结构：

```ts
Fact          { what: string, when: string|null, tags: string[] }
Decision      { decision: string, reasoning: string|null, context: string|null }
Emotion       { state: string, intensity: 1|2|3|4|5, trigger: string|null, inferred: boolean }
PersonRef     { name: string, relation: string|null, relationInferred: boolean,
                interaction: string, note: string|null }            // 人际关系功能种子
Candidate     { content: string,                  // futureMemory 候选
                type: "person_trait"|"preference"|"relationship"|
                      "decision"|"goal"|"other",
                importance:    "low"|"medium"|"high",   // 内容本身的意义
                promotability: "low"|"medium"|"high",   // 适不适合提升为长期记忆
                reason: string }
```

**设计要点：**
- `raw` 用 `segments` 保留多轮时序结构（非 flat string），日后人际关系功能关联"何时与谁聊了什么"时直接可用；`content` 为便利全文。
- `Candidate` 不用自由浮点 confidence，改两个枚举：`importance`（意义）+ `promotability`（可提升性）。枚举比方差大的 0–1 浮点可靠，且**本身就是提升门**。
- `PersonRef` 是人际关系功能的种子：未来按 `name` 聚合成人物档案（别名归一"老板=王总"留到那一步）。

---

## 五、DiaryExtractor 抽取规则

### 逐字段规则

- **raw**：逐字存原文 + segments，**不经模型**（确定性）。
- **summary**：2-3 句，只叙事不解读，覆盖本会话主要事件。
- **facts**：离散事件，每条一句话，去重，跳过无关琐事。
- **decisions**：只收明确决定，不猜意图；有理由就附。
- **emotions**：从内容推断，但标 `inferred=true`，必带触发因素。
- **people**：每个被提到的人都收；关系能推断就填并标 `relationInferred`；`interaction` 写这次具体互动；`note` 收暴露的喜好/特质。
- **futureMemory**：只收"今天之后还可能重要"且"不是例行流水账"的；每条给 `type` + `importance` + `promotability` + `reason`。这是"意义"过滤器。

### 总原则

- **不臆造**：没说的留 null，不编。
- **推断必标注**：`emotion.inferred`、`person.relationInferred` 等推断字段显式标。
- **保守**：宁可少收，不要错收。
- **语言跟随用户**（中文）。
- **schema 强约束**：side-call 用结构化 JSON 输出。

### 机制（复用 `CompressionAssistant` 模式）

- **触发**：会话结束（`/diary end`）。
- **方式**：side-call（小模型，默认 `deepseek-chat`），`DiaryExtractorConfig.generate: (prompt)=>Promise<string>` 注入。输入 = 本会话 `raw.segments` 拼接；输出 = 上述 JSON。
- **`DiaryExtractor`**（新，`packages/core/src/diary/extractor.ts`）：`buildPrompt`（含 schema + 逐字段规则 + 总原则 + "Respond with ONLY a JSON object"）+ `parse`（处理 ```json 围栏、提取 `{...}`、按字段校验、缺字段降级为空数组/默认）。**失败抛错**，由调用方降级。
- **失败降级**：side-call 抛错或 JSON 解析失败 -> 只存 `raw`（必有）+ 一句兜底 `summary`（"（自动抽取失败，仅保留原文）"），其余字段为空数组。**绝不丢用户输入**（对齐 Phase 5 summarizer 降级）。

---

## 六、JournalStore（独立日记库）

**新模块** `packages/core/src/diary/store.ts`，参照 `MemoryStore` 但独立于记忆系统。

### 存储格式

每条 entry 一个 frontmatter markdown 文件：

- 路径：`.licode/journal/YYYY-MM-DD/<id>.md`
- frontmatter（索引/检索字段）：`id, date, createdAt, endedAt, people: [name...], emotions: [state...]`
- body：
  - `## 原文`：逐轮 `[timestamp] user: content`
  - `## 结构化`：```json 围栏内放 `{summary, facts, decisions, emotions, people, futureMemory}`

frontmatter 让按日期/人物/情绪列表化扫描低成本；JSON 围栏让全文结构化字段可机器解析（复用 `CompressionAssistant.parse` 的围栏提取思路）。

### 接口（最小）

- `save(entry: DiaryEntry): Promise<void>` — 写文件（`id` 唯一，不覆盖已存在）
- `load(id): Promise<DiaryEntry | null>`
- `listByDate(date: string): Promise<DiaryEntry[]>` — 当天多条
- `listRecent(limit): Promise<DiaryEntry[]>`
- `search(query): Promise<DiaryEntry[]>` — 关键词/人物名扫描（v1 顺序扫描，规模可接受）

### 不做（v1）

- ❌ 日记索引文件（类比 `MEMORY.md`）：按日期目录 + `readdir` 已够召回；索引延后。
- ❌ usage/归档/pinned：日记是 append-only 流水账，不套记忆的遗忘/归档机制。

---

## 七、/diary 会话模式与分发

### 职责切分

- **Core（可测）**：`DiarySession`（`packages/core/src/diary/session.ts`）持 `segments` 缓冲 + 状态；`start() / addSegment(text, timestamp) / end(extractor, store): Promise<DiaryEntry>`。`DiaryExtractor`、`JournalStore` 同在 core。
- **CLI（`packages/cli/src/hooks.ts`）**：`diarySessionRef`（`useRef<DiarySession | null>`，类比 `memoryExtractionStateRef`）；`/diary*` 在 `handleSubmit` 中**先于** `router.route` 特判（因会话状态在 ref，`SlashCommand.execute` 拿不到）；side-model 经 `createDiaryExtractor`（类比 `createContextCompressor`）用独立 `AnthropicProvider` + `summarizerModel` 构造。

### 分发逻辑（`handleSubmit` 顶部）

1. 输入以 `/diary` 开头 -> 交给 diary 处理器：
   - `/diary` 或 `/diary start`：`diarySessionRef.current = new DiarySession(today)`；返回 action "进入日记模式，描述今天…（/diary end 结束）"。
   - `/diary end`：`session.end(extractor, store)` -> 存库 -> 清 ref -> 返回 action（含 `summary`）。
   - `/diary list [date]` / `/diary find <query>` / `/diary show <id>`：召回（见 §八），返回 action。
2. 否则若 `diarySessionRef.current` 活跃 -> `addSegment(input, now)`；返回 action 轻确认（如"✓ 已记下（/diary end 结束）"）。**不** yield user-message，**不**进 `AgentLoop`（捕获期不消耗主模型）。
3. 否则 -> 现有流程（`router.route` 其它命令 / yield user-message）。

### 模块与触点

| 文件 | 变更 |
|---|---|
| `packages/core/src/diary/types.ts`（新） | `DiaryEntry` 及子结构类型 |
| `packages/core/src/diary/extractor.ts`（新） | `DiaryExtractor`（镜像 `CompressionAssistant`：`buildPrompt`+`parse`+失败抛错） |
| `packages/core/src/diary/store.ts`（新） | `JournalStore`（frontmatter+JSON，存于 `.licode/journal/`） |
| `packages/core/src/diary/session.ts`（新） | `DiarySession`（segments 缓冲 + start/addSegment/end） |
| `packages/core/src/index.ts` | 导出上述 diary 模块 |
| `packages/cli/src/hooks.ts` | `diarySessionRef` + `handleSubmit` 顶部 diary 特判 + `createDiaryExtractor`（复用 side-provider） |
| `packages/cli/src/hooks.ts`（slashCommands） | `/diary` 加入自动补全列表 |

> 不改 `AgentLoop`、不改记忆系统、不改命令 `SlashCommand` 接口。日记是 `hooks.ts` 顶部的旁路。

---

## 八、召回

- **命令**：`/diary list [date]`（默认最近 N 条）、`/diary find <query>`（关键词/人物名）、`/diary show <id>`（全文）。
- **查询**：v1 顺序扫描 `.licode/journal/`（规模：每天 1–数条，可接受）。`find` 匹配 `raw.content`、`people.name`、`facts`、`summary`。
- **与记忆召回分离**：日记召回独立，**不动**现有 `MemoryRecall`。记忆侧 v1 不被日记触碰。
- 活跃会话中调用召回命令：先提示 `/diary end` 结束当前会话（避免状态混乱）。

---

## 九、错误处理与降级

- **Extractor 失败 / JSON 非法**：降级存 `raw` + 兜底 `summary`，其余空数组（§五）。entry 仍入库，不丢输入。
- **`JournalStore.save` 失败**（磁盘等）：向用户报错，**保留 `diarySessionRef` 缓冲**不清空，可重试 `/diary end`。
- **side-call 超时/网络**：同 Extractor 失败降级。
- **会话中断**（进程退出）：v1 不持久化进行中会话缓冲；未 `/diary end` 的内容丢失（可接受，流水账性质；持久化进行中缓冲延后）。

---

## 十、配置与回退

- **env 开关**（对齐 `LICODE_CONTEXT_*` 风格）：
  - `LICODE_DIARY=off` -> 整个日记功能关闭，`/diary` 返回提示。
  - `LICODE_DIARY_MODEL` -> 覆盖 Extractor side-model（默认 `deepseek-chat`）。
- **回退**：`LICODE_DIARY=off` 即完全旁路；代码回滚 = 删 `diary/` 模块 + 还原 `hooks.ts` 的 diary 特判与 ref。不影响记忆/上下文/主循环。

---

## 十一、测试与验收

### 验收标准

- [ ] **DiaryExtractor schema**：mock `generate` 返回合法 JSON -> 解析出完整 `DiaryEntry`；逐字段规则由用例覆盖（facts 去重、decisions 不猜意图、emotions 标 inferred、people 收全、futureMemory 只收非流水账）。
- [ ] **Extractor 降级**：`generate` 抛错 / 返回非 JSON -> 降级为 `raw` + 兜底 summary，其余空数组，不抛错。
- [ ] **JournalStore**：`save` 写 `.licode/journal/YYYY-MM-DD/<id>.md`（frontmatter + 原文 + JSON 围栏）；`load`/`listByDate`/`listRecent`/`search` 正确；`id` 已存在不覆盖。
- [ ] **DiarySession**：`start`->`addSegment`->`end` 产出含全部 segments 的 entry；`end` 后清空。
- [ ] **/diary 流程**：`/diary` 进入捕获态；捕获期非命令输入被收为 segment、不进 `AgentLoop`；`/diary end` 触发 extract+store 并返回 summary。
- [ ] **召回**：`/diary list`/`find`/`show` 正确返回；活跃会话中召回提示先 end。
- [ ] **隔离**：不改动现有记忆系统行为（`memory.test.ts`/`recall.test.ts` 绿）；不改动 `AgentLoop`（`loop.test.ts` 绿）。
- [ ] **开关**：`LICODE_DIARY=off` 时 `/diary` 旁路。

### 回归

- 现有 `pnpm test` 不回归（diary 为新增模块 + `hooks.ts` 顶部旁路）。
- `pnpm build` 零 TS 错。

---

## 十二、设计决策记录

| 决策 | 候选 | 选定 | 原因 |
|---|---|---|---|
| 第一步范围 | 日记/人际/咨询全做 / 日记地基 | 日记地基 | 后两块消费日记输出；地基先行，记忆模型预留扩展 |
| 日记 vs 记忆存储 | 塞进记忆 / 独立库无关 / 混合 | 混合（独立日记库 + 复用记忆 + 提升桥） | 日记量大低意义、记忆须有意义；物理分开各得其所 |
| `raw` 形态 | flat string / segments | segments（+content 全文） | 保留多轮时序，为人物关联留结构 |
| `futureMemory` 评分 | 自由 0–1 浮点 / 枚举 | `importance`+`promotability` 枚举 | 可靠、方差小；枚举即提升门 |
| 提升执行时机 | v1 自动 / v1 手动 / 推迟 | v1 推迟（只存候选） | 守"记忆必须有意义"；自动提升易写脏，难清 |
| Extractor 实现 | 新造 / 复用 CompressionAssistant 模式 | 镜像 CompressionAssistant | 同为 side-call 结构化 JSON，模式成熟、降级路径现成 |
| 触发方式 | 自然对话 / 显式命令 / 主动提醒 | 显式命令 | 简单可控；CLI 非常驻，主动提醒成本高 |
| 会话状态位置 | core / CLI ref | 逻辑在 core（DiarySession），ref 在 CLI（hooks.ts） | core 可测；ref 随 React 状态生命周期 |
| `/diary` 接入 | 走 SlashCommand / hooks.ts 特判 | hooks.ts 顶部特判 | 会话状态在 ref，SlashCommand.execute 拿不到 |
| 召回索引 | 目录扫描 / 索引文件 | 目录扫描 | 规模小；索引延后 |
| 当天多条 | 一条/天重抽 / 多条独立 | 多条独立、同 date 归集 | 一次会话=一条；不跨会话重抽，省模型 |

---

## 十三、后续（本 spec 范围外，记路标）

1. **提升桥**：`futureMemory` 中 `importance:high && promotability:high` 的候选 -> 经确认/整理 pass 提升为现有记忆系统（复用 `MemoryStore.save`）。
2. **人际关系人物档案**：跨 entry 按 `people.name` 聚合成人物档案（关系/喜好/共同事件），别名归一。
3. **情感/关系咨询**：基于日记+人物档案的综合问答。
4. **周期性回顾 / 前瞻提醒 / 决策记录**等扩展。

---

## 十四、参考

- 现状来源：`packages/core/src/memory/{types,store,recall,extractor,dream}.ts`、`packages/core/src/context/summarizer.ts`（`CompressionAssistant`）、`packages/core/src/agent/loop.ts`、`packages/core/src/extensions/commands/{registry,router}.ts`、`packages/core/src/extensions/commands/builtin/memory.ts`、`packages/cli/src/hooks.ts`
- spec 模板：`docs/superpowers/specs/2026-07-31-context-phase5-design.md`
- 记忆系统设计参考：`docs/superpowers/specs/2026-07-27-memory-system-redesign-design.md`

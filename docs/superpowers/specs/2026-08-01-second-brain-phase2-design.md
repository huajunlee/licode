# 第二大脑 · phase 2（提升桥 + 人物档案）设计

> **状态**：设计已与用户逐节确认，待写实现计划
>
> **设计日期**：2026-08-01
>
> **前置**：phase-1 日记地基已合入 master（tip `8e3199a`）；记忆系统（含 `dream.ts` 四阶段整理）、上下文管理均已落地。
>
> **说明**：本文是「第二大脑」第二步（提升桥 + 人物档案）的设计 spec，非实现计划。实现步骤由后续 writing-plans 产出。遵循项目「独立可验证、可回退」原则。

---

## 一、背景与现状（已核实）

phase-1 把 `/diary` 会话捕获 -> `DiaryExtractor` 结构化 -> `JournalStore` 落地，但留了两条尾巴（phase-1 spec §十三）：

1. **提升桥**：`futureMemory` 候选只存未提升（守「记忆必须有意义」）。
2. **人物档案**：`people` 字段是档案种子，未聚合。

phase-2 把这两条一起做（合并理由见 §十二）：**提升桥（diary -> 记忆）+ 人物档案（diary -> 档案库）**，共享一台 curation 引擎。

对设计最相关的现状（已读源码核实）：

- **DiaryEntry**（`packages/core/src/diary/types.ts`）：`meta` / `raw{content,segments}` / `summary` / `facts` / `decisions` / `emotions` / `people` / `futureMemory`。
  - `PersonRef { name, relation, relationInferred, interaction, note }`--人物档案种子，`note` 收暴露的喜好/特质。
  - `Candidate { content, type: person_trait|preference|relationship|decision|goal|other, importance: low|medium|high, promotability: low|medium|high, reason }`--`importance`（意义）+ `promotability`（可提升性）两枚举，phase-1 原话「枚举即提升门」。
- **JournalStore**（`diary/store.ts`）：frontmatter+JSON 存 `.licode/journal/YYYY-MM-DD/<id>.md`；`save/load/listByDate/listRecent/search`。
- **`dream.ts` 四阶段整理**（`memory/dream.ts`，已核实）：Orient（审全部记忆找「重复主题/漂移/失效」）-> Gather（grep 会话取证）-> Consolidate（`create|update|append|delete`，「优先合并进已有 topic 文件，避免重复」）-> Prune。自动后台跑（`after:agentLoop` hook，`shouldDream` 门控 ≥24h 且 ≥5 新会话，fire-and-forget + 文件锁，删前备份）。**dream 只碰记忆，不碰档案**。
- **MemoryStore**（`memory/store.ts`）：`save(memory, action)`，action=`create|update|append`，`create` 在文件已存在时防御性 append。`Memory { slug, type: user|feedback|project|reference, name, description, content, ... }`。
- **journal_recall**（`tools/builtin/journal-recall.ts`）：agent 被问过去事件时按 date/query/最近查日记，返回结构化摘要（含 people/facts/decisions/emotions）。
- **hooks.ts 旁路**（`cli/hooks.ts`）：`handleSubmit` 顶部 `/diary*` 特判 + `diarySessionRef`；side-model 经 `createDiaryExtractor` 用独立 provider + `LICODE_DIARY_MODEL`（默认 `deepseek-chat`）。
- **env**：`LICODE_DIARY=off` 关日记；`LICODE_DIARY_MODEL` 覆盖 extractor side-model。

---

## 二、目标与范围

### 目标

phase-2：**提升桥 + 人物档案**。`/diary-end` 后，清晰的候选**自动**落长期存储（high+high 非人物 -> 记忆；具体人 -> 档案）；模糊/边缘的经 `/diary-curate` 的 curation 引擎（side-call + 人审）整理落库；`dream` 自治合记忆全库；agent 可经 `profile_recall` 查人物档案。

### 范围内

- ✅ diary-end 机械自动提升/入档（high+high 非人物 -> 记忆；具体人 -> 档案）
- ✅ curation 引擎两 pass（memory-curation + profile-curation），共享 side-call 模式
- ✅ `/diary-curate` 命令 + 暂存编号确认流
- ✅ PersonProfile 数据模型 + PersonProfileStore（独立档案库）
- ✅ 别名归一（模型聚类 + 人审）
- ✅ `profile_recall` 工具
- ✅ `.curated.json` 处理进度索引

### 范围外（延后 phase-3）

- ❌ 情感/关系咨询（基于日记 + 档案的综合问答）
- ❌ 周期性回顾 / 前瞻提醒 / 决策记录
- ❌ 别名归一全自动（仍人审兜底）

---

## 三、核心架构：三路数据流

```
/diary 会话 -> DiaryExtractor -> DiaryEntry -> JournalStore（phase-1，不变）
                                          │
                  ┌───────────────────────┼───────────────────────┐
                  ▼                       ▼                       ▼
        [diary-end 机械自动]      [/diary-curate curation]      [dream 后台]
        high+high 非人物 -> 记忆    high+非high + other -> 记忆    合并全库记忆
        具体人 -> 档案             模糊人 -> 档案（解歧义）
                                  合并全档案 raw note
                  │                       │
                  ▼                       ▼
            MemoryStore            MemoryStore + PersonProfileStore
                                          │
                              profile_recall（agent 查档案）
```

三路：

1. **diary-end 机械自动**（无 side-call）：清晰的直接落。
2. **/diary-curate curation**（side-call + 人审）：模糊/边缘的整理后落。
3. **dream 后台**（已有，自治）：合记忆全库去重。

**关键边界**：提升桥（#1）= memory-curation pass + diary-end 自动提升到记忆那条线；人物档案（#2）= profile-curation pass + diary-end 自动入档那条线。两者共享 curation 引擎，概念上是两座桥。

---

## 四、路由与提升门

### 提升门（两轴）

`Candidate` 的 `importance`（意义）+ `promotability`（可提升性）两轴会分叉，正是分两个的意义：

| 例子 | importance | promotability | 处理 |
|---|---|---|---|
| 「决定下月辞职」 | high | high | 自动提升 |
| 「今天和王总大吵一架」 | high | low（一次性冲突，非稳定事实） | curation 再评估 |
| 「中午吃了面」 | low | low | 留日记 |

### 路由原则

1. **`people` refs 无门**（无筛种子）：`specific` -> diary-end 自动入档案；模糊 -> curation 解歧义。
2. **`futureMemory` 候选有门**（importance + promotability）：
   - **high + (high|medium)** -> 自动（非人物按类型映射入记忆；`other` / 模糊人物走 curation）
   - **high + low** -> curation（非人物再评估入记忆；人物解歧义入档案）
   - **importance≠high** -> 留日记
3. **对人物，「具体 vs 模糊」优先于 importance**：模糊人物候选即便 high+high 也走 curation（先解歧义）。

> 自动门放宽（2026-08-01）：从 high+high 放宽到 high+(high|medium)，medium 也自动提升；仅 high+low 走 curation。

### 路由表（常见情况）

| 来源 | 条件 | 路由 | 机制 | 时机 |
|---|---|---|---|---|
| `people` ref | specific | 档案 | 自动追加 | diary-end |
| `people` ref | 模糊 | curation 解歧义 | side-call | /diary-curate |
| `futureMemory`：preference/decision/goal | high+high/medium | 记忆 | 自动（类型映射） | diary-end |
| `futureMemory`：other | high+high/medium | curation（type 不清） | side-call | /diary-curate |
| `futureMemory`：person_trait/relationship（specific） | high+high/medium | 档案 | 自动追加 | diary-end |
| `futureMemory`：非人物 | high+low | curation 再评估 | side-call | /diary-curate |
| `futureMemory`：person_trait/relationship（模糊） | high | curation 解歧义 | side-call | /diary-curate |
| `futureMemory`（任意） | importance≠high | 留日记 | - | - |

### 类型映射（自动提升用，机械）

`futureMemory` candidate `type` -> `Memory` `type`：

| candidate type | memory type |
|---|---|
| preference | user |
| decision | project |
| goal | project |
| other | （走 curation，side-call 定） |

`other` 即便 high+high 也走 curation（type 不清）。

### 「具体人」判定

phase-2 给 `PersonRef` 增 `specific: boolean`（extractor 设；专有名字=true，泛称"朋友/同事/老板"=false）。diary-end 只自动入档 `specific:true`；`specific:false` 走 curation 解歧义。（备选：泛称停用词表；`specific` flag 更准，本 spec 取之。）

### phase-1 扩展（extractor prompt 收紧）

phase-2 修改 `DiaryExtractor` prompt 三点（不改 `DiaryEntry` 结构，只增 `PersonRef.specific`）：

1. `PersonRef` 增 `specific` 字段（见上）。
2. `preference` type 明确 = **用户自己的偏好**（"我喜欢早起"）；一个人的喜好（"王总爱喝茶"）归 `person_trait`。避免「王总爱喝茶」误打成 `preference` 误路由到记忆。
3. 把日记日期喂进 prompt（`今天是 {date}`），指示把相对时间（下个月/昨天/上周）转成绝对日期，写入 `facts.when`/`futureMemory.content`/`decisions`。这样 candidate 直接带绝对时间，autoPromote（机械复制）和 curation（合并）都覆盖，不必等 dream 转换。

---

## 五、PersonProfile 数据模型

```ts
PersonProfile {
  meta {
    canonicalName: string     // 归一主名（"王总"）
    aliases: string[]         // ["老板","王志远"]
    slug: string              // people/<kebab>，创建时定，后续不变
    firstSeen: string         // 最早提及日期
    lastSeen: string          // 最近提及日期
    mentionCount: number
  }
  summary: string             // 2-3 句叙事：这人是谁、和用户什么关系
  traits: string[]            // 性格特质（note + person_trait 聚合）
  preferences: string[]       // 喜好（note + preference 聚合）
  interactions: [{            // 共同事件时间线
    date: string, entryId: string, event: string
  }]
  relationshipState: [{       // 关系/状态时间线；PersonRef.relation + relationship 候选都喂；记变化；最新=当前
    date: string, state: string
  }]
}
```

**设计要点**：

- `relationshipState` 时间序列（不收敛单值）：结构关系（"直属领导"）+ 关系质量（"关系缓和"）都进，按日期排，最新=当前。无单独 `relation` 字段。
- `traits`/`preferences` 分开（spec 点名「喜好」；curation 归桶）。
- `interactions` 带 `entryId`/`date` 供溯源。

### 存储

`.licode/people/<slug>.md`，frontmatter（`canonicalName, aliases, firstSeen, lastSeen, mentionCount`）+ body（`## 概述` summary + `## 结构化` JSON 围栏 `{traits, preferences, interactions, relationshipState}`）。沿用 JournalStore 的 frontmatter+JSON 模式。`slug` 创建时由 canonicalName 派生，后续 canonicalName 变化不重命名文件（frontmatter canonicalName 为准）。

### PersonProfileStore 接口（最小）

- `save(profile, action)`: write/merge（`action: create|update`）
- `load(slug): PersonProfile | null`
- `listAll(): PersonProfile[]`
- `findByName(nameOrAlias): PersonProfile | null`--别名感知查找（diary-end 自动入档找现有档案 + profile_recall 用）
- `listRecent(limit): PersonProfile[]`

不做（v1）：usage/归档/pinned（档案是 append-only 聚合，不套记忆遗忘机制；清理靠 curation 合并）。

---

## 六、curation 引擎

两 pass 共享 side-call 模式（镜像 `CompressionAssistant`/`DiaryExtractor`：`buildPrompt` + `parse` + 失败降级），但 prompt/schema/输出分开。一个命令触发、统一确认。

### memory-curation pass

- **输入**：pending 的 high+非 high 非人物候选 + `other` high+high 候选（窄档：只合并本批 pending，不碰已有记忆--已有记忆去重归 dream）。
- **输出**：`[{action:"create", slug, type, name, description, content}]`（复用 dream op schema 子集，只 create）。type 由 side-call 从 `{user,feedback,project,reference}` 按内容 + 候选 type 选。
- **落库**：`MemoryStore.save(mem, "create")`。

### profile-curation pass（=「档案的 dream」）

两职责：

1. **解模糊人物**：side-call 看**现有档案**（canonical + aliases）+ 本批模糊 people refs（带 `interaction`/`note`/`relation` 上下文），输出建议聚类：`{并别名: fromName -> intoSlug, 理由}` 或 `{新档案: name}`。模型靠名字周围**上下文**聚类（非字符串匹配），歧义名"老板"也能靠"都是上级 + 工作场景"判。
2. **合并全档案**：side-call 把各档案累积的 raw note 去重合并成干净 `traits`/`preferences`，更新 `summary`/`relationshipState`。输出 `{update: slug, summary, traits, preferences, relationshipState}`。

**别名归一的人审**：用户逐条确认才落库。UI 里用户既能**拒绝**模型的合并建议（挡误并），也能**手动合并**模型漏掉的两个档案（补漏并）。这样吸收了「显式声明」的可控，不另开声明机制。误并由人审兜底。

### /diary-curate 命令 + 确认流

现有命令系统是请求/响应（无交互 y/n），diary 捕获用 ref + 多轮。curation 复用：

- `/diary-curate`：跑两 pass 过 pending 候选/people refs，把**提议操作**暂存 `curationSessionRef`，输出编号统一清单：
  ```
  [记忆]
   1. [新建] user/tea-prefs "王总爱喝茶，偏好龙井"
   2. [新建] project/arch "决定下周启用新架构"
  [人物]
   3. [并别名] "老王" -> 王总 (理由: 都是上级/工作场景)
   4. [新档案] 李四
   5. [更新档案] 王总: +特质"做事果断"，合并"爱喝茶"
  ```
- 用户回：`/diary-curate apply 1,3,5`（选）/ `apply all`（全）/ `reject`（弃整轮）。
- **`apply` 后**：选中的落库；本批涉及的 entry 全标已处理--**被选中的进库、没选中的视为「已决定不提升」**，都不再 nag。`reject` 不标记，下次重来（幂等：候选还在，重跑重整理）。

### .curated.json 处理进度索引

`.licode/journal/.curated.json`，记已处理 entry id。两 pass 共用：只处理「上次以来新 entry」。diary-end 自动提升/入档的 entry 也标已处理（那部分候选已落，不进 curation）。未确认就关会话不丢--pending 还在，重跑。

---

## 七、自动提升与入档（diary-end）

`/diary-end` 在 phase-1（extract -> JournalStore.save）之后，新增**机械自动**（无 side-call）：

1. **自动提升**：`futureMemory` 中 `preference/decision/goal` 且 high+high 的候选 -> `MemoryStore.save(deriveMemory(candidate), "create")`。
   - `deriveMemory` 机械派生：`type` 按映射表；`content`=候选 content；`name`/`description` 从 content 截取 / `reason`（较粗，后续 dream/curation 精修）。
2. **自动入档**：`people` 中 `specific:true` 的 + high+high 具体 `person_trait` 候选 -> `PersonProfileStore`：
   - 档案存在（`findByName`）：追加 `interaction` 入时间线、`note`/特质入 `traits`/`preferences`、`relation` 入 `relationshipState`（记变化，非每条重复）。
   - 不存在：新建档案（canonicalName=name, aliases=[], 初始字段）。
3. 标记 entry 已处理（`.curated.json`）。

### 失败降级

- **日记先存**（JournalStore.save 优先，不丢用户输入）。
- 自动提升/入档失败的那些 -> 不标已处理，降级转 curation 待处理（下次 `/diary-curate` 兜底）。
- 对齐 phase-1「绝不丢用户输入」。

---

## 八、profile_recall 工具

新工具 `tools/builtin/profile-recall.ts`，注册进 `builtinTools`，镜像 `journal_recall`：

```ts
params: { name?: string, limit?: number }
// name（含别名）-> 该人档案；无参 -> 最近档案列表
```

agent 被问「王总是谁」「我和某人关系怎样」等人物问题时调用，返回该人**成品档案**（聚合好的特质/喜好/关系/互动时间线）。因吃别名归一，叫「王总」「老板」「王志远」都命中同一档案。

与 `journal_recall` 区分：

- `journal_recall`：查**日记库**（raw 条目，按事件/日期）--"今天干啥了"。
- `profile_recall`：查**档案库**（成品档案，按人）--"王总是谁"。

---

## 九、错误处理与降级

- **curation side-call 失败 / JSON 非法**：该 pass 降级为「跳过本轮，不部分落库」，pending 保留，用户可重试 `/diary-curate`。不丢数据。
- **diary-end 自动提升/入档失败**：见 §七，降级转 curation。
- **PersonProfileStore.save 失败**：报错，保留 `curationSessionRef` 提议不清空，可重试 apply。
- **别名误并**：人审兜底；用户可手动拆分或删档重建。

---

## 十、配置与回退

- **env**：
  - `LICODE_DIARY=off`：整个日记 + curation 关闭（沿用 phase-1）。
  - `LICODE_DIARY_MODEL`：extractor + curation side-call 默认模型。
  - `LICODE_DIARY_CURATE_MODEL`（新，可选）：单独覆盖 curation side-call（合并/解歧义可能需更强模型）。
- **回退**：`LICODE_DIARY=off` 全旁路；代码回滚 = 删 phase-2 新增（PersonProfileStore、curation 引擎、profile_recall、/diary-curate）+ 还原 hooks.ts 的 diary-end 自动提升段 + 还原 extractor prompt。不影响 phase-1 日记/记忆/dream/主循环。

---

## 十一、测试与验收

### 验收标准

- [ ] **路由**：high+high preference/decision/goal 候选 diary-end 自动进记忆（按类型映射）；high+非 high + other 进 curation；importance≠high 留日记。具体人入档案、模糊人进 curation。
- [ ] **自动提升/入档**：diary-end 后 MemoryStore/PersonProfileStore 正确写入；失败降级转 curation 不丢日记。
- [ ] **memory-curation**：mock side-call 返回 create-ops -> 解析 -> 确认后 `MemoryStore.save(create)`；type 由 side-call 选。
- [ ] **profile-curation**：解模糊（聚类建议 + 人审）+ 合并全档案（raw note -> 干净 traits）。
- [ ] **别名归一**：模型提议聚类，用户可拒/可手动合并；误并有兜底。
- [ ] **/diary-curate**：暂存提议 + 编号清单 + apply 选择性落库 + reject 不标记 + `.curated.json` 进度。
- [ ] **PersonProfileStore**：save/load/listAll/findByName（别名感知）/listRecent；frontmatter+JSON 往返。
- [ ] **profile_recall**：按 name/别名查档案；无参列最近。
- [ ] **extractor prompt**：`PersonRef.specific` 正确设；`preference`=用户自己、人物喜好归 `person_trait`。
- [ ] **隔离**：不改动 phase-1 日记行为、dream、AgentLoop（现有测试绿）。
- [ ] **开关**：`LICODE_DIARY=off` 全旁路。

### 回归

- 现有 `pnpm test` 不回归；`pnpm build` 零 TS 错。

---

## 十二、设计决策记录

| 决策 | 候选 | 选定 | 原因 |
|---|---|---|---|
| phase-2 范围 | 4 路标全做 / 提升桥+档案合并 | 合并（+ 分阶段实现） | 人物信息归宿一次定清；curation 引擎两处复用；省一轮 spec/plan |
| curation 机制 | B 手动确认 / C side-call 合并 | C | 门只「批准」不「合并」；碎片仍脏；合并才让记忆有意义 |
| curation 输入范围 | 窄档 / 宽档 | 窄档 | dream 已做全库去重（已核实）；窄档 + dream 分层互补 |
| curation 切分 | 一 pass / 两 pass | 两 pass | 输入/存储/逻辑全不重叠，可测可回退 |
| 别名归一 | B 声明 / C 自动 / A 模型+人审 | A | 模型干重活、人审兜底误并；UI 补漏并吸收 B 可控 |
| relationshipState | 收敛单值 / 时间序列 | 时间序列 | 关系演变需追；最新=当前 |
| 提升执行 | 全 curation / 清晰自动+模糊 curation | 清晰自动+模糊 curation | high+high 本身是门，再确认冗余；模糊才需判断 |
| 档案合并 | curation 兼任 / 接受 raw 累积 | curation 兼任 | dream 不碰档案；curation 顺手合全档案，与 dream 对称 |
| people gate | 无门 / 有门 | 无门（种子）/ person_trait 候选有门 | people 是无筛聚合底料 |
| 提升门 | 单轴 / importance+promotability | 两轴（phase-1 续） | 分叉「有意义但短暂」；枚举即门 |
| 触发 | 自然对话 / 显式命令 | 显式命令（/diary-curate） | 简单可控；CLI 非常驻 |
| 召回 | 只 journal_recall / +profile_recall | +profile_recall | 档案需读侧；类比 journal_recall |

---

## 十三、后续（phase-3 路标）

1. **情感/关系咨询**：基于日记 + 人物档案的综合问答（`profile_recall` 是其地基）。
2. **周期性回顾 / 前瞻提醒 / 决策记录**。
3. **别名归一全自动**（量够后可减人审）。

---

## 十四、参考

- 现状来源：`packages/core/src/diary/{types,store,session,dispatch}.ts`、`memory/{types,store,dream}.ts`、`tools/builtin/journal-recall.ts`、`cli/hooks.ts`
- phase-1 spec/plan：`docs/superpowers/specs/2026-07-31-second-brain-diary-design.md`、`docs/superpowers/plans/2026-07-31-second-brain-diary.md`
- 记忆系统设计：`docs/superpowers/specs/2026-07-27-memory-system-redesign-design.md`

# 第二大脑 · phase 3（决策顾问）Design

**Date:** 2026-08-01
**Status:** Design approved；待写实现计划
**Branch:** `worktree-second-brain-phase3`

## 背景与动机

第二大脑 phase 1（日记）与 phase 2（提升桥 + 人物档案）已落地并合入 master：

- **memory**（`.licode/memory/`）：`onTurnStart` 钩子自动召回，side-LLM 选相关 slug 注入上下文。`Memory` 含 type/name/description/content。
- **diary**（`.licode/journal/`）：`DiaryEntry` 含 `decisions`(decision/reasoning/context)、`facts`、`emotions`、`people`、`title`、`summary`。经 `journal_recall` 工具 + `/diary*` 命令访问；`JournalStore.search` 只匹配 raw.content/summary/people 名/facts.what（**不搜 decisions**）。entry id = `now.getTime().toString(36)`。
- **people**（`.licode/people/`）：`PersonProfile` 含 traits/preferences/relationshipState/interactions。经 `profile_recall` 工具访问。

phase 3 原计划另有方向，本次改为**决策顾问**：当用户请 LICode 帮忙做决定或征求意见时，基于已有记忆/日记/人物档案，分析并给出一条较好的路径或解决方案。

## 目标

用户用自然语言请求决策/意见时（"帮我决定…""你觉得我该不该…""给点建议"），LICode：

1. 汇聚与话题相关的历史决定、事实、人物档案、近期日记（memory 由现有钩子自动召回，不重复）。
2. 给出 **B 式分析**（2-3 条可选路径 + 利弊风险 + 倾向建议）；证据不足时**降级 C**（中立摆事实，明示信息不足，不硬给模糊答案）。
3. 分析后**必须询问**用户是否记下决策；用户**明确同意**才写入日记文件夹；保存的决策永不进 memory、永不被自动召回（gated）。

## 非目标（v1）

- 不用子 LLM 做相关性筛选或产出分析（v1 纯确定性汇聚 + 主 LLM 综合；召回不足是已知局限，v2 可加 side-LLM）。
- 不加 `/decide` slash 命令（自然语言 tool 触发；如需可后续补）。
- 不改 memory 自动召回、不改 extractor/promote 提升桥。
- `decide_save` 不走 extractor/promote（直写 journal）。

## 架构

新增两个 builtin 工具（read/write 一对），注册进 `builtinTools` 即被 CLI 自动注册（`cli.ts` / `hooks.ts` 的 `tools.registerAll(builtinTools)`），**不改 hooks.ts**。核心逻辑抽成纯函数，工具壳只做"加载 store -> 调纯函数 -> 返回"，便于无 fs 单测（沿用 phase 2 的可测风格）。

### 数据流

```
用户："帮我决定要不要换工作"
   │
   ├─ (memory 自动召回钩子照常从 .licode/memory 注入相关记忆)
   ▼
主 LLM 识别决策意图 -> 调 decide(topic)
   ▼
decide: JournalStore.listAll() + PersonProfileStore.listAll()
   -> gatherDecisionContext() 纯函数汇聚 -> 返回结构化上下文 + B/C framing 指引
   ▼
主 LLM 综合：B 式分析（证据不足降级 C）-> 呈现
   -> 必须询问"要不要记下这次决策？"
   -> 用户明确同意  ────────> 调 decide_save
   -> 用户拒绝/未回应 ───────> 不调用，结束
   ▼
decide_save: buildDecisionEntry() 构造 DiaryEntry -> JournalStore.save() 写入 .licode/journal/
   -> 返回确认（id/date）
   ▼
未来 decide 经 listAll 可回溯该决策（闭环）；因直写 journal、不走 extractor/promote，永不进 memory、永不被自动召回（gated）
```

## 组件

### `decide` 工具（read）

**参数：**
```typescript
const DecideParams = z.object({
  topic: z.string().describe("需要做决定或征求意见的事情/问题（尽量写关键词，如'换工作'，便于匹配历史）"),
  people: z.array(z.string()).optional().describe("特别相关的人名（可选；不填则自动从话题与历史中找）"),
});
```

**description：**
> 当用户请你帮忙做决定、拿主意，或征求意见/建议时调用（如"帮我决定要不要…""你觉得我该不该…""给我点建议"）。汇聚历史决定/事实/人物/近期日记供你给依据分析。闲聊、问事实、执行任务时不要调用。用户确认记下决策时用 decide_save。话题尽量写关键词便于匹配。

**汇聚逻辑（`gatherDecisionContext(entries, profiles, topic, people?)` 纯函数）：**

输入：已加载的 `entries: DiaryEntry[]` + `profiles: PersonProfile[]`（工具用 `listAll()` 载入传入）。

1. **话题匹配**：`topic.toLowerCase()` 对每条 entry 的 hay 子串匹配。hay = `raw.content + summary + people 名 + facts.what + decisions.decision + decisions.reasoning`（比 `journal_recall` 的 search 多搜 decisions 字段，这正是决策场景需要的）。匹配 entry -> 抽其 `decisions`（带 date）与 `facts`。
2. **历史决定兜底**：若无话题匹配，取最近 5 条 entry 的 decisions，标注"(无直接匹配，显示近期决定)"。
3. **人物**：合并 `people` 参数 + 档案中 canonicalName/alias 出现在 topic 里的 + 匹配 entry 里提到的人；从传入 profiles 取这些人的档案。
4. **近期日记**：最近 5 条 entry 的 `[date HHmm] title/summary` 摘要，给主 LLM 近况背景。
5. **截断**：> 10000 字符截断（同 journal_recall）。

> 召回局限（v1 已接受）：中文长句话题子串匹配可能漏语义相关条目；靠"人物维度 + 近期日记 + 主 LLM 二次过滤"缓解。tool description 引导 LLM 传简洁关键词话题。

**输出格式（返回给主 LLM）：**
```
# 决策上下文：{topic}

## 历史相关决定
- [2026-07-30] 决定换架构（理由：旧架构维护成本高）
（无则：暂无与该话题直接相关的历史决定）

## 相关事实
- [2026-07-28] 和王总谈话，提到新项目机会

## 相关人物
### 王总（别名：老板）
概述: 用户的上级，做事果断
特质: 做事果断; 爱喝茶
喜好: 偏好龙井
关系: 2026-07-01 直属领导
互动: 2026-07-28 开会聊新项目

## 近期日记
- [08-01 1430] 和团队对齐迭代计划
- [07-31 0900] 修复登录bug

## 分析指引
你正在帮用户做决定/给意见。结合以上历史决定、相关事实、相关人物立场与喜好、近期状态，以及系统已自动注入的长期记忆，给出分析：
- 默认 B 式：列 2-3 条可选路径，各自利弊与风险，最后给一个倾向性建议（基于用户历史与处境）。
- 若证据不足以支撑明确判断（信息太少/互相矛盾/超出可判断范围），不要硬编模糊答案--降级 C：把事实与各方立场摆清，明说"目前信息不足以给倾向建议"，把判断权交还用户。
- 涉及人物时结合其特质/喜好/关系状态分析。
- 给出分析后，必须询问用户是否要记下这次决策（如"要不要把这次决策记下来？"）。仅在用户明确同意后调用 decide_save；用户拒绝或不回应则不保存、不主动调 decide_save。
```

### `decide_save` 工具（write）

**参数：**
```typescript
const DecideSaveParams = z.object({
  topic: z.string().describe("决策话题"),
  decision: z.string().describe("最终倾向的决定/结论"),
  reasoning: z.string().describe("理由与分析（可含选项与权衡）"),
  people: z.array(z.string()).optional().describe("涉及的人名（可选）"),
});
```

**description：**
> 仅在用户明确确认要保存决策后调用。流程：先由 decide 给出分析 -> 你询问"要不要记下来" -> 用户同意 -> 才调本工具写入日记。绝不主动保存，用户没明确同意不要调用。

**`buildDecisionEntry(topic, decision, reasoning, people?, now)` 纯函数 -> DiaryEntry：**

- `meta`: `{ id: now().getTime().toString(36), date: formatLocalDate(now()), createdAt: now().toISOString(), endedAt: now().toISOString() }`（id 与 DiarySession 同法）
- `title`: `【决策】${topic}`（标记，便于区分手工日记；cleanName 截断用于文件名）
- `summary`: `decision`（结论）
- `decisions`: `[{ decision, reasoning, context: topic }]`
- `people`: `people` 参数 -> `PersonRef[]{ name, relation:null, relationInferred:false, interaction:"决策涉及", note:null, specific:true }`（无则空）
- `facts` / `emotions` / `futureMemory`: `[]`（**futureMemory 空 = 无可提升候选**）
- `raw.content`: `# 决策：{topic}\n\n## 结论\n{decision}\n\n## 理由与分析\n{reasoning}`

工具壳：`journalStore.save(entry)` -> 返回 `✅ 已记下决策：{decision}（{date} {id}）`，metadata `{ id, date }`。

### Gating 硬约束（用户核心要求）

`decide_save` 只调 `JournalStore.save()`，**不调** MemoryStore / autoPromoteEntry / extractor。因此：

- 决策落 `.licode/journal/`，**永不进 `.licode/memory/`** -> 永不被自动召回钩子注入（该钩子只读 memory）。
- `futureMemory: []` -> 即便误跑提升桥也无候选可提。
- 只能经 `decide`（主动决策）或 `journal_recall`（主动问过去）显式取出 -> 满足"只有用户主动要时才给"。
- 写入测试断言"不产生 memory 文件"作回归护栏。

### 询问-确认交互（B 模式）

由 **prompt 层约束**（工具 description + framing 指引）实现：decide 返回的 framing 要求主 LLM 给完分析后必须询问是否保存；decide_save 的 description 要求仅在用户明确同意后调用。本系统所有规则（memory-guide 等）均为 prompt 层约束，这是该架构下最强的执行手段。

## 文件结构

| 文件 | 职责 |
|---|---|
| `tools/builtin/decide.ts`（新） | `decide` 工具 + 纯函数 `gatherDecisionContext()` |
| `tools/builtin/decide.test.ts`（新） | 汇聚逻辑单测 |
| `tools/builtin/decide-save.ts`（新） | `decide_save` 工具 + 纯函数 `buildDecisionEntry()` |
| `tools/builtin/decide-save.test.ts`（新） | 写入单测 |
| `tools/builtin/index.ts`（改） | 注册 `decide` + `decide_save` |
| `index.ts`（改） | 导出两个工具 |

## 边界与错误处理

- `decide`：空日记 -> 各 section 标"暂无"但仍输出 framing（主 LLM 见无上下文应降级 C 或追问）；无话题匹配 -> 兜底近期决定；store 读错 -> catch 返回 `{ status:"error", error, errorType:"execution" }`（同 journal_recall）；> 10000 字截断。
- `decide_save`：磁盘错 -> catch 返回 error；参数缺失 -> zod 校验；`people` 可选。

## 测试策略（TDD）

沿用 phase 2 风格：co-located `*.test.ts`，纯函数无需 fs，`pnpm test` + `pnpm build` 零错。

**`decide.test.ts`（测 `gatherDecisionContext` 纯函数）：**

- 话题子串命中含 decisions 的 entry（验证搜了 decisions 字段）
- 话题按人名命中；`people` 参数 + 档案名出现在 topic + 匹配 entry 的人 -> 三来源人物档案都进结果
- 最近 5 条 entry 摘要进"近期日记"
- 空 entries -> 优雅、framing 仍在
- 无话题匹配 -> 兜底近期决定
- B/C framing 文案在输出中
- 截断

**`decide-save.test.ts`：**

- `buildDecisionEntry` 产出正确 meta（id 为 base36 时间戳）、title 标记、decisions 字段、people 映射
- round-trip：`parseEntry(serializeEntry(buildDecisionEntry(...)))` 关键字段保持
- `futureMemory` 为空（gating）
- 工具壳：execute 写入临时 journal 目录 -> `JournalStore.load(id)` 能读回；且临时目录下**无 memory 产生**（gating 回归）

## 已知局限

- 召回靠关键词子串匹配，中文长句话题可能漏语义相关条目；靠"人物维度 + 近期日记 + 主 LLM 二次过滤"缓解。v2 可加 side-LLM 选相关性。
- B/C 兜底与询问-确认均为 prompt 层约束，依赖主 LLM 遵守。

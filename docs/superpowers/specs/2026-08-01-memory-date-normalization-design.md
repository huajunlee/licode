# 记忆系统·相对日期绝对化设计：注入今天日期 + save 内程序化归一化

> **日期**：2026-08-01
> **状态**：设计中
> **前置文档**：[记忆系统重构设计](./2026-07-27-memory-system-redesign-design.md)、[Phase 1 生产层](./2026-07-27-memory-phase1-implementation-plan.md)、[Phase 2 召回层](./2026-07-28-memory-phase2-design.md)、[Phase 3 整理层 Dream](./2026-07-29-memory-phase3-design.md)、[Phase 4 反馈层](./2026-07-30-memory-phase4-design.md)，均已落地
> **关联先例**：[Second Brain Phase 2 设计](./2026-08-01-second-brain-phase2-design.md)（diary extractor 已用"喂日期 + LLM 转绝对日期"模式，commit `72833a7`）

---

## 1. 背景与现状

### 1.1 问题

记忆系统三条写入路径（extractor 自动抽取 / dream 整理 / Agent Write 工具）的提示词里都有一条规则："把相对日期（"昨天""上周"）转换为绝对日期"。调研发现两个缺陷使其无法可靠生效：

1. **无今天日期锚点**：三处提示词（`extractor.ts` buildPrompt、`dream.ts` buildConsolidatePrompt、`memory-guide.md`）都要求 LLM 把"昨天"转成绝对日期，却都没注入"今天是几号"。LLM 没有参照点，无法换算。（本会话 harness 里的 `Today's date is 2026-08-01` 来自 Claude Code 外层，非 LICode 自身 prompt 注入。）
2. **代码零归一化**：`store.save()` 原样落盘 content；全仓库无日期解析库。记忆正文里任何语义日期都是自由文本，无程序化保障。

### 1.2 description 盲区（结构性）

`description` 是召回选择的关键字段（索引 `MEMORY.md` 每行载荷就是 description，`recall.ts` 选择阶段只看索引），却有一条结构性盲区：

- dream **Consolidate**（真正改写的阶段）每条只展示 content，**不展示 description**（`dream.ts:326`：`for (const m of all) memParts.push(\`### ${m.slug}\\ncontent:\\n${m.content}\`);`）。
- 而 Orient（`dream.ts:161`）、extractor（`extractor.ts:251`）都展示 description。
- 三条日期规则都**未点名字段**，LLM 是否转 description 全凭运气。
- update/append 时 description 被**整体覆盖**（`store.ts:92`），consolidator 必须在看不到当前 description 的情况下重写一个。

结果：藏在 description 里的"去年"既不被 LLM 可靠转换（consolidate 看不见），也无程序化兜底，且会拖累召回（未来用绝对日期提问时选不中）。

### 1.3 Agent Write 路径绕过 save

`hook.ts:80-82` 注释明说：Agent 用 Write 工具直写记忆文件**绕过 `store.save()`**，hook 只重建索引 + 跳过提取，不重存。故 save 内建的任何逻辑都兜不到这条路径，需靠系统提示注入今天日期让 Agent 自行转换。

### 1.4 diary 先例（代码库已有模式）

commit `72833a7`「feat(diary): extractor 把日记日期喂进 prompt + 相对时间转绝对日期」已在 **diary extractor** 落地同款模式：

```ts
`今天是 ${date}。所有相对时间（下个月、昨天、上周、下周等）一律转成绝对日期（基于今天 ${date}）...`
```

即"注入日期 + LLM 转绝对日期"，纯 LLM、无程序化工具。本设计的"注入今天日期"一半与之同源、措辞对齐（`今天是 <ISO>`）；多出的 save 内程序化归一化是 memory 系统为封 description 盲区而加的增量安全网，diary 无此需求。

### 1.5 现有记忆

现有记忆文件为测试夹具、非真实数据，故**不做回溯**：只管今后新写入。锚点恒为 `now`，无 `updatedAt` 区分。

### 1.6 master 现状核实（2026-08-01）

在 master HEAD（`72833a7`）核实：memory extractor 的 `buildPrompt` 仍不接收 `now`、不注入日期；dream `buildConsolidatePrompt` 有 `now` 但只算 ageDays、未注进 prompt 文本；`memory-guide.md:50` 仍是裸规则。**问题在 master 确实存在**。利好：memory extractor 已有可注入的 `now?: number`（`extractor.ts:57-58`，用于 cooldown），把它传给 buildPrompt 即可，改动极小。

---

## 2. 设计目标

- **根因修复**：注入今天日期，让既有 LLM 规则真正能执行（含模糊词转范围）。
- **安全网**：save 内程序化归一化，确定性兜底精确词（不靠 LLM 注意到），并从结构上封死 description 盲区。
- **精确词 vs 模糊词分工**：精确词程序化确定性换算；模糊词交 LLM（需今天日期）转大致范围。
- **最简**：无新依赖、无回溯命令、无 Dream 回溯 pass、无 hook 归一化。

---

## 3. 详细设计

### 3.1 总体机制

```
新写入（立即）：
  extractor / dream consolidate / dream 缩写pass ──► store.save() ──► [save 内归一化, anchor=now] ──► 落盘
  Agent Write 工具（绕过 save） ──► 靠系统提示注入今天日期让 LLM 转

锚点：恒为 now（无回溯，无 updatedAt 区分）
```

**精确词**程序化（save 兜底，all paths 的 content+description）；**模糊词** LLM（注入今天日期 + 显式规则，all paths）。根因（无锚点）与盲区（description 不可见）都解。

### 3.2 normalizeDates 工具

纯函数 `normalizeDates(text: string, now: Date): string`。对 text 里的精确相对词按粒度换算，模糊词不动（留 LLM）。词表触发词固定、值随 `now` 计算（日历往前走词表不改）：

| 粒度 | 触发词 | 输出格式（now=2026-08-01） |
|---|---|---|
| 年 | 去年 / 前年 / 大前年 / 明年 / 后年 / 今年 | 2025年 / 2024年 / 2023年 / 2027年 / 2028年 / 2026年 |
| 月 | 上个月 / 上上个月 / 下个月 / 下下个月 / 本月 / 这个月 | 2026年7月 / 2026年6月 / 2026年9月 / 2026年10月 / 2026年8月 / 2026年8月 |
| 日 | 昨天 / 前天 / 大前天 / 明天 / 后天 / 今天 | 2026年7月31日 / 2026年7月30日 / 2026年7月29日 / 2026年8月2日 / 2026年8月3日 / 2026年8月1日 |
| 周 | 上周 / 上上周 / 本周 / 这周 / 下周 | 2026-07-20~2026-07-26 等（周一~周日，两端全 ISO） |

性质：

- **幂等**：输出无相对词，再跑无匹配无改动。save 每次写都跑、重复跑都安全。
- **最长匹配**：`大前年`优先于`前年`、`大前天`优先于`前天`、`上上个月`优先于`上个月`。正则按长度降序交替，避免子串误匹配。
- **零误报**：精确历法词本身无歧义（`去年`必指上一年），给定锚点换算恒正确；不碰已绝对化文本（无相对词不匹配）。
- **作用域**：对 `content` 与 `description` 各跑一次，与字段无关--盲区封死原理（纯文本变换，不看路径不看 LLM 是否看见）。
- **无新依赖**：用 `Date` 做算术（年/月用 `new Date(y, m±n, d)` 构造自动进位），不引日期库，贴合 core 现有零日期依赖。
- **频率词不入表**：`每周/每月/每天/每年`是频率非点时间，保留不转。精确 token 匹配，`每周`≠`本周`，无误匹配。

### 3.3 save() 内归一化（安全网 + 盲区封口）

`store.save()` 落盘前、序列化前：

```ts
const now = new Date();
try {
  memory.content = normalizeDates(memory.content, now);
  memory.description = normalizeDates(memory.description, now);
} catch { /* 纯运算理论不抛；异常回退原文，不阻断 save */ }
```

- 覆盖全部 save 调用方：`extractor.ts:180`、`dream.ts:290`（consolidate）、`dream.ts:487`（缩写 pass）、`middleware.ts:19`。
- 单次写之前做，不产生额外 mtime bump、不二次落盘。
- **盲区封口**：consolidate 的 LLM 即便没看 description，其吐出的 description 一进 save 就被扫掉精确词--结构上消除，不依赖改 consolidate 可见性。

### 3.4 注入今天日期（根因修复）

三处各加 `今天是 <ISO>`（由 `new Date()` 生成，措辞与 diary 先例 `72833a7` 对齐）：

| 位置 | 现状 | 改动 |
|---|---|---|
| extractor `buildPrompt` | 不接收 now | 把已有的 `now`（`extractor.ts:113`）传入 buildPrompt，顶部加 `今天是 <ISO>` |
| dream `buildConsolidatePrompt` | 已有 now，只算 ageDays | 同个 now 格式化成 `今天是 <ISO>` 加进 prompt 文本 |
| 系统提示 memory-guide 层 | 静态模板（readFileSync 加载，无插值） | system-prompt.ts build 时 `new Date()` 生成，加一个动态 layer（`今天是 <ISO>`，复用 addLayer 机制，recall 的 memory 层 priority 5 已有先例） |

Write 工具路径靠第三处：Agent 写记忆时系统提示已有今天日期 + 既有规则，根因（无锚点）解除。

### 3.5 规则显式化 + 模糊词指引

三处规则（`extractor.ts:277`、`dream.ts:366`、`memory-guide.md:50`）统一改为：

> 把 description 与 content 中的相对日期转换为绝对日期；精确词（昨天/上周/去年）转确切日期，模糊词（最近/前阵子）转大致范围（如"2026年7月前后"）

仍点名 description：save 只兜底**精确词**，**模糊词**的 description 转换只能靠 LLM--规则显式才能让 LLM 在两个 field 都做模糊转换。

### 3.6（可选）consolidate 补 description 可见性

`dream.ts:326` 现每条只展示 content。有 3.3 的 save 封口后已**非必需**。补上（和 Orient `dream.ts:161` / extractor `extractor.ts:251` 一致、带上 description）能让 consolidate 时 LLM 对 description 的模糊词转得更好。小改动，建议做但不阻塞。

---

## 4. 错误处理与边界

| 场景 | 行为 |
|---|---|
| **频率词（每X）** | `每周/每月/每天/每年`是频率非点时间，不入词表不转换。精确 token 匹配，`每周`≠`本周` |
| **跨月/跨年算术** | 用日历分量构造 `new Date(y, m±n, d)`，不用时间戳减法。`new Date(2026, 0-1, 1)`->2025-12，自动进位。避免 DST/时区 off-by-one |
| **周首日** | 周一为首日。`上周`=本周一往前推一周的周一~周日。跨月周（如 8/5 的上周=`2026-07-27~2026-08-02`）两端写全 ISO |
| **幂等/重复 save** | 已绝对化文本无相对词不匹配不改；记忆多次 update，早先转好的 `2026-02-09` 不会被后续 save 用新 now 重算（它不是相对词）。**无漂移** |
| **空/缺字段** | `normalizeDates("")=""`；description 缺省走原流程。纯函数对任意字符串安全 |
| **normalize 抛错** | 纯字符串+Date 运算理论不抛；save 内 try/catch 兜底回退原文，**不阻断 save** |
| **精确词与绝对词共存** | "去年和2024年的对比"->"2025年和2024年的对比"，只动相对词，已绝对的不碰 |
| **引号/上下文** | "他说'去年不错'"->"他说'2025年不错'"，仍准确，无副作用 |
| **Write 路径 LLM 漏转** | Write 绕过 save，精确词漏转无程序化兜底。**已知限制**：根因（无锚点）已解，Agent 有今天日期+规则；若日后补，可加 hook 级 `normalizeFile`（复用 `hasChangesSince`），本次不做 |
| **性能** | 每次 save 对 content+description（小字符串）跑两次正则，可忽略 |

---

## 5. 测试矩阵

`normalizeDates` 纯函数、`now` 为参数，直接传固定日期单测，无需 mock。save 集成用 `vi.useFakeTimers({ now })`（与现有 createdAt/updatedAt 测试同法）。

| 区域 | 测试 | 断言 |
|---|---|---|
| normalizeDates·年 | 去年/前年/大前年/明年/后年/今年 @ 2026-08-01 | -> 2025年/2024年/2023年/2027年/2028年/2026年 |
| normalizeDates·月 | 上个月 @ 2026-08-01；上个月 @ 2026-01-15（跨年） | -> 2026年7月；-> 2025年12月 |
| normalizeDates·日 | 昨天 @ 2026-08-01；昨天 @ 2026-01-01（跨年） | -> 7月31日；-> 2025年12月31日 |
| normalizeDates·周 | 上周/本周/下周 @ 2026-08-05（跨月周） | 上周 -> 2026-07-27~2026-08-02；周一首日 |
| normalizeDates·锚点可变 | "去年" @ 2026 / @ 2027 | -> 2025年 / 2026年（印证词表固定、值随 now） |
| normalizeDates·幂等 | 对已转换输出再跑；对纯绝对文本 | 第二次无改动；绝对文本不碰 |
| normalizeDates·最长匹配 | 大前年/前年 混排；上上个月/上个月 混排 | 长词优先，不被子串误吞 |
| normalizeDates·频率词保留 | 每周/每月/每天 | 原样不动（每X 不入词表） |
| normalizeDates·共存/边界 | "去年和2024年对比"；空串；"今天。" | -> "2025年和2024年对比"；""；"2026年8月1日。" |
| save·归一化落盘 | create 含"去年"的 content+description，fake now=2026-08-01，save 后读文件 | 两字段均"2025年"；单次写（mtime 行为不变） |
| save·盲区封口 | description 含"上周"、content 不含，save 后 | description 转成 ISO 区间（content 无相对词不动） |
| save·幂等不漂移 | 同一 memory 连续 save 两次（第二次 now 推后 6 个月） | 早先转好的绝对日期不被新 now 重算 |
| save·不阻断 | 注入抛错的 normalize | save 仍成功、回退原文 |
| prompt·注入今天日期 | extractor `buildPrompt` / dream `buildConsolidatePrompt` / memory-guide 层输出 | 各含 `今天是 <ISO>` 行 |
| prompt·规则显式 | 三处规则文本 | 含 "description 与 content" + 模糊词转范围指引 |
| dream·consolidate 归一化 | consolidate 处理含"昨天"的记忆，后读文件 | 经 save 转成绝对日期（集成层） |
| 回归 | 现有 memory/dream/recall/hook/extractor 全套 | 全过；save 单次写未破坏 mtime/索引语义 |

---

## 6. 设计决策记录

| 决策 | 选择 | 原因 |
|---|---|---|
| 根因修复 | 注入今天日期到三处 prompt | 既有规则因无锚点无法执行；注入后 LLM 可转（含模糊词），all paths；与 diary 先例 `72833a7` 同源同措辞 |
| 精确词兜底 | save 内程序化 normalizeDates | LLM 不可靠（原失败模式）；确定性换算；从结构封死 description 盲区（纯文本变换与路径/字段无关） |
| 模糊词处理 | LLM 转范围（非程序化） | 模糊词无法确定性换算；需判断，交 LLM |
| 盲区封法 | save 内对 content+description 都跑归一化 | 不依赖改 consolidate 可见性；纯文本变换与路径/字段无关 |
| 锚点 | 恒 now（无回溯） | 现有记忆为测试夹具；回溯无必要；省 updatedAt 区分 |
| 无回溯命令 | 不做（曾考虑 `/memory normalize` + Dream 回溯 pass） | 用户反馈：单独命令过度；现有是测试文件，不做回溯 |
| 无新依赖 | 用 Date 算术 | core 现有零日期依赖；月/年算术用构造函数自动进位即可 |
| 频率词不入表 | 每周/每月/每天 保留 | 频率非点时间；转换会破坏语义；靠精确 token 与上周/本周区分 |
| 周输出格式 | ISO 区间两端全写 | 跨月周不歧义；统一可读 |
| Write 路径 | 靠注入今天日期（LLM），无程序化兜底 | 简化；根因已解；漏转可日后加 hook `normalizeFile` 补 |
| 注入措辞 | `今天是 <ISO>` | 与 diary 先例 `72833a7` 一致，保持代码库统一 |
| consolidate 补 description 可见性 | 可选增强 | save 已封口非必需；补上利于模糊词，不阻塞 |

---

## 7. 参考

- [记忆系统重构设计](./2026-07-27-memory-system-redesign-design.md)
- [Phase 4 反馈层设计](./2026-07-30-memory-phase4-design.md)（格式范本 + 设计哲学：确定性->程序规则，主观->LLM，安全网）
- [Second Brain Phase 2 设计](./2026-08-01-second-brain-phase2-design.md)（diary 日期注入先例，commit `72833a7`）
- 调研结论（master HEAD `72833a7`）：`extractor.ts:57-58,113,180,251,277` / `dream.ts:161,290,322,326,366,487` / `store.ts:92,188` / `recall.ts:66,168` / `memory-guide.md:50` / `hook.ts:80-82` / `system-prompt.ts:23-26,43,63`

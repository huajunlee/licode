# 记忆召回系统重构设计：memory_tool 元工具

- 日期：2026-08-16
- 状态：已批准（用户逐节讨论确认）
- 分支：worktree-cache-hit-rate-guide

## 1. 背景与问题

DeepSeek 控制台显示 LICode 的上下文缓存命中率只有约 50%。DeepSeek 缓存是纯前缀匹配：新请求从第一个 token 开始与历史请求比对，第一处差异点之后全部算 miss。排查定位出 5 个问题（详见 `docs/guide/user-guide.md` 常见问题「为什么 DeepSeek 控制台的缓存命中率只有 50% 左右？」）：

| # | 问题 | 机制 | 本方案是否覆盖 |
|---|---|---|---|
| 1 | 记忆索引层嵌在 system prompt 中段，频繁变化 | 改前缀中段 → 差异点后整段历史 miss | ✅ 消除 |
| 2 | side-call 约占一半流量，天然不可命中 | 每轮一次 recall select + extractor + dream，内容每次全新 | ✅ 大幅缓解 |
| 3 | recall prune 删除对话历史中段消息 | 删前缀中段 → 后续请求永久断点 | ✅ 消除 |
| 4 | system 预算随消息长度浮动，裁剪区逐轮漂移 | 前缀逐轮变化 | ❌ 后置，独立处理 |
| 5 | date 层每天变、缓存空闲过期等 | 环境性因素 | ❌ 接受 |

## 2. 设计总览

核心决策：**记忆索引彻底退出主模型上下文，召回从「每轮强制前置」改为「模型自主调用工具」**。

1. 新建 `memory_recall` 元工具：主模型发送结构化查询，工具内部以**子 agent 式小模型循环**完成「读索引 → 读候选正文 → 摘选片段」，将结果作为 tool result 返回
2. 删除前置召回（onTurnStart hook 的每轮 side-query），只保留工具召回一条路
3. 删除 prune 机制（没有前置召回 pair，就没有可剪除的对象）
4. 删除 `memory_fetch` 工具（slug 只能从上下文索引得知，索引移出后成为死代码）
5. system prompt 增加**一行静态提示**（数量模糊化 + 四分类说明），并重写 `memory-guide.md` 层为「何时该召回」的行为约束
6. 新建召回率评测脚本，作为方案验收关卡

## 3. 缓存收益机理

- system prompt 变为全天候静态（仅 date 层每天变一次）→ 主循环前缀稳定，历史全程可命中，问题 1 消除
- 不再有每轮一次的 select side-call；select 只在模型真正调用工具时触发 → 问题 2 的 miss 流量大幅下降
- 无人再修改对话历史中段 → 问题 3 消除
- 工具内部的子 agent 循环：prompt = `[固定指令 + 完整索引（稳定前缀）] + [查询（尾部）]`，多步读片段在同一缓存前缀上追加，额外调用基本被缓存吸收
- 预期：主循环命中率 90%+；整体命中率上限由 extractor/dream/diary 等剩余 side-call 流量占比决定

## 4. 组件设计

### 4.1 `memory_recall` 工具（新建）

**Schema（刻意保持两个字段，拒绝过度结构化）**：

- `query: string` — 召回意图的自然语言陈述（主模型分析用户问题后的意图，不是原样转发用户消息）
- `keywords: string[]` — 关键词数组，辅助索引匹配

「结构化」的价值在于强迫模型调用前先想一步，两个字段即可实现；category 枚举、time_range 等经讨论按 YAGNI 删除。

**内部流程（子 agent 式）**：

```
memory_recall(query, keywords)
  └─ 构建富索引：store.listAll() → 名称+描述+关键词+首行预览（复用现有格式）
  └─ 小 AgentLoop（复用现有 AgentLoop 类，deepseek-chat，temperature 0）
       system/user prompt: [固定指令 + 完整富索引（稳定前缀）] + [query/keywords（尾部）]
       可用工具：read_memory(slug) —— 唯一工具，只读
       上限：maxSteps 4
       输出：最终选中的记忆（正文 < 500 token 给全文，≥ 500 token 给摘录）
  └─ 代码侧兜底：
       - registry 去重：已在上下文的 slug 跳过并在结果中注明（沿用 memory_fetch 先例）
       - recordUsage 记账（影响 dream 归档）
  └─ tool result 格式：## 名称 (slug)\n正文，多条空行分隔；无匹配返回「未找到相关记忆」
```

**错误处理**：内部循环任何失败（LLM 错误、超时、解析失败）降级为返回「未找到相关记忆」，绝不抛出打断主循环（沿用现有 recall best-effort 原则）。

**延迟代价（用户已接受）**：每次召回 2~4 次串行小模型调用，多等几秒，换选中准确率提升。

### 4.2 静态提示行 + memory-guide.md 重写

system prompt 的 memory-guide 层（priority 4，静态）重写为两部分：

1. **存在提示**（一行）：「你有 N+ 条长期记忆（user 用户偏好 / feedback 纠偏反馈 / project 项目理解 / reference 外部资料），可用 memory_recall 工具查询」。N 在**会话启动时**按实际记忆数量向下取整到十位（如 23 条 → 「20+」，7 条 → 「几条」），会话期间不更新 → 会话内静态、缓存安全；不列任何具体内容
2. **召回时机约束**：涉及个人偏好、历史决定、进行中的项目时**主动**召回（不等用户要求）；纯技术问题、无状态问答**不召回**（设门槛防过度触发，否则 side-call 成本从后门回流）

分工：tool description 讲「这是什么、怎么用」；system prompt 讲「什么时候该想到它」。

### 4.3 旧机制清理清单

**整体删除**：

| 删除对象 | 位置 | 说明 |
|---|---|---|
| `createMemoryRecallHandler` | `packages/core/src/memory/recall.ts` | onTurnStart 前置召回整个移除 |
| `MemoryRecall` 类（select/buildPrompt/parseResponse/withTimeout） | `recall.ts` | 一次性 select 由子 agent 循环取代；富索引构建逻辑抽到新模块复用 |
| `buildRecallPair` / `pruneRecallMessages`（两个变体）/ `MEMORY_RECALL_TOOL_NAME` | `recall.ts:15-124` | 合成 pair 构造与剪除，含 `index.ts:140` 导出清理 |
| onTurnStart 接线 | `packages/cli/src/hooks.ts:736,802` | 含 memoryRecallHandlerRef |
| `AgentConfig.onTurnStart` 钩子机制 | `agent/loop.ts:62,72,103,109-115` | 唯一消费者就是前置召回，YAGNI 删除（公开 API 变更，在此显式声明） |
| system prompt `memory` 索引层注入 | `recall.ts:344` 附近 | 索引不再进上下文 |
| `memory_fetch` 工具 | `tools/builtin/memory-fetch.ts` | 按 slug 精确取的逻辑由新工具内部继承 |
| 两阶段召回相关测试 | 对应 .test.ts | 同步删除/改写 |

**瘦身保留**：

- `LoadedMemoryRegistry`：职责只剩「跨多次 `memory_recall` 调用去重」。保留 `has`/`add`/`rebuild`；删除 `remove()`、`getAll()`、`get()`、`source` 分类（`"sidequery" | "active"`）——全部为 prune/select 服务，新方案下死代码。实现上退化为 Set 语义
- **命名沿用**：旧合成 pair 的工具名本就叫 `memory_recall`，registry 的 `rebuild()` 按此名解析 `## 名称 (slug)` 行——新工具同名同格式，会话恢复重建逻辑天然兼容，零改动
- `store.rebuildIndex()` 与 MEMORY.md 索引文件：作为工具内部富索引的数据源，继续由提取/dream 维护
- extractor、dream、diary、decide 均不动

**需要审计而非盲删**：

- `compressor.ts:58` 有针对 memory-recall 合成 pair 的特殊处理（保证 pair 不跨轮次拆分）——新方案下真实工具调用的 pair 本就在轮次内，需确认这段逻辑是随旧机制删除还是自然兼容
- `recordUsage` 的 dream 让位守卫（现位于 `recall.ts:386`，dream 运行期间跳过记账避免写写竞态）——**必须随记账逻辑一起移植到新工具**，不能丢
- 磁盘上的旧会话文件含合成 pair：原样保留为普通历史（不修改 = 缓存友好），压缩器和 registry 重建都需能正常消化它们

## 5. 召回率评测脚本（验收关卡）

新方案召回率 = **触发率**（该调时模型会不会调，提示词调优唯一影响环节）× **选准率**（工具内部选对，与现状同一内核）。评测端到端测量并对比新旧两版。

**形态**：独立脚本（不进单测），用例存 JSON，人可维护、可持续补充；以后每次改记忆系统提示词都拿它回归。

**评测集**（约 30 条用户消息 + 种子记忆库 20~30 条覆盖四分类）：

- A 组 10~15 条：明确对应某条记忆（存了「喜欢蛋挞」→ 问「宵夜吃什么」）→ 期望触发且命中
- B 组 10 条：纯技术/无状态问题 → 期望**不触发**（防「每次都召回」刷分）
- C 组 5 条：模糊相关，测边界
- 种子记忆：手工构造（可控、可提交进仓库）；后续可选加入脱敏真实记忆

**流程**：

> 实现顺序约束：评测脚本与基线数据采集必须**先于**旧代码删除实施——基线依赖现有 hook select，删除后无法补测。基线结果存档为 JSON 供后续对比。

1. 基线版：现有 hook select 对每个用例的输出（每轮必跑，只测选准/召回）
2. 新版版：单轮模拟 = 候选 system prompt + 用户消息 → 真模型（deepseek-chat，temperature 0）→ 是否发出 `memory_recall` 调用、参数为何 → 执行工具内部 select → 返回记忆是否命中标注
3. 输出新旧并排对比表：应召召回率 / 误触发率 / 选中准确率
4. 迭代调提示词重跑，直到达标

**验收标准**：

- 新版应召召回率 ≥ 基线（用户原话：接近或达到目前水平即可接受）
- B 组误触发率 ≤ 20%（10 条中误触发不超过 2 条）
- temperature 0 + 固定输入 → 结果可复现

## 6. 测试策略

- 单元测试：工具 schema 校验、registry 去重、read_memory 只读行为、错误降级路径、无匹配返回
- 集成测试（mock LLM）：子 agent 循环的步数上限、读片段后再决策的多步流程
- 评测脚本（真 API，手动运行）：见 §5
- 全量回归：build + vitest 全绿

## 7. 文档更新

- `docs/guide/user-guide.md`：召回相关章节（两阶段召回的描述全部过时）+ 亮点/面试章节中「召回分两种方式」的话术需同步更新
- 用户未提交的「修改后的话术」段落同样描述了两阶段召回，**不在本分支修改**，由用户自行决定如何改写

## 8. 范围外（明确不做）

- 问题 4（system 预算漂移的档位化）：独立后续处理
- extractor / dream / diary / decide 的任何改动
- RAG / embedding 基础设施（side-LLM 复用现有链路，YAGNI）
- Anthropic 官方 API 的显式 `cache_control` 断点（DeepSeek 场景无意义）

## 9. 后续增强（本次不实现，方向已确认）

- **LoCoMo 端到端评测**（[snap-research/LoCoMo](https://github.com/snap-research/LoCoMo)，ACL 2024）：10 段超长多会话对话 + 带类别与证据标注的 QA。定位为大版本前的**里程碑验证**（与 §5 开发循环评测互补，不替代）。价值：证据对话 ID 可换算召回精确率/召回率；时间推理类测日期锚点；对抗类（不可答问题）测「不召回、不乱编」；端到端覆盖生产→整理→召回全管线；可与论文 baseline 横向对比。实施时子采样（2~3 段对话 + 每类 QA 抽样）控制成本；注意公开基准可能被 deepseek 训练数据见过，绝对分数仅供参考，版本间相对对比有效

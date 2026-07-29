# 上下文管理渐进式改进方案

> **状态**：调研完成，Phase 1-5 规划中
>
> **冻结日期**：2026-07-29（基于 commit `192932c` 时的代码快照）
>
> **说明**：本文上半部分为"冻结事实"——对当前上下文管理实现的客观记录，附 `file:line` 引用以便复核；下半部分为多阶段改进蓝图，每阶段独立可验证、可回退。

---

## 一、冻结事实：当前上下文管理现状

### 1.1 架构概览

上下文相关代码分布在 `packages/core/src/` 下四个位置：

| 位置 | 职责 |
|------|------|
| `context/` | 压缩、摘要、溢出、预算——**全部为死脚手架** |
| `conversation/manager.ts` | 消息存储 + `buildMessages()` + 休眠的 `trimToBudget()` |
| `conversation/system-prompt.ts` | 分层系统提示词 + 预算感知裁剪（逻辑存在但休眠） |
| `llm/token-counter.ts` | 字符比例启发式 token 估算（非真 tokenizer） |
| `agent/loop.ts` + `agent/termination.ts` | ReAct 循环 + 硬停终止策略 |
| `memory/recall.ts` | 唯一活跃的上下文注入机制（onTurnStart） |

### 1.2 运行时真正生效的机制（仅 4 项）

**① 系统提示词分层** — `conversation/system-prompt.ts`
- always 层（`role` priority 0、`safety` priority 1）必发；可裁剪层（`memory-guide` priority 4、`tool-use` priority 10）按 priority 排序填入。
- `assemble(budget)`（`system-prompt.ts:81`）实现了预算感知裁剪：always 层优先，可裁剪层按优先级填入，预算不足时 `truncateToTokens` 截断。
- **但休眠**：`ConversationManager.buildMessages()`（`manager.ts:121`）在 `agent/loop.ts:67` 与 `events/generator.ts:16` 均**无参调用**，`tokenBudget` 默认 `Infinity`，故裁剪逻辑永不触发，所有层永远全量发送。

**② memory recall 注入** — `memory/recall.ts:219` `createMemoryRecallHandler`
- 挂在 `AgentLoop.onTurnStart`（`loop.ts:52`），每轮执行：
  1. 内容变化时刷新 `memory` 系统提示词层（`recall.ts:233`，priority 5）；
  2. 剪掉上一轮注入的 synthetic tool_use/tool_result 对（`pruneRecallMessages`，`recall.ts:247`），历史中最多保留一对；
  3. 针对当前 user message 做 side-query 召回，把命中记忆作为新 synthetic 对追加（`recall.ts:266`）。
- 整个 handler 包裹在 try/catch 中，best-effort，永不中断循环。
- 受 `LICODE_MEMORY_RECALL=off` 环境变量开关控制（`hooks.ts:390`）。

**③ 终止策略硬停** — `agent/termination.ts`
- `AgentLoop` 每步调 `termination.check(this.conversation.getTokenCount())`（`loop.ts:65`）。
- 默认阈值：`maxSteps=50`、`maxTokens=200_000`、`maxTimeMs=600_000`（`termination.ts:12`）。
- token 超 200k → 抛 `TerminationError` → **整个循环终止**，无压缩、无降级。
- 注意 `getTokenCount()`（`manager.ts:287`）只数 `this.messages`，**不含 system prompt**。

**④ 会话持久化** — `conversation/manager.ts:186` `save()`
- 整段 messages 落盘到 `.licode/sessions/<id>.json`，含 `totalTokens`、`messageCount`、`systemPromptLayers`。

### 1.3 死脚手架：`context/` 模块（写好但从未接线）

全仓 `grep` 确认：以下符号除 `index.ts` 的 `export` 与测试文件外，**无任何运行时引用**。

| 模块 | 文件 | 本应做的事 | 死因 |
|------|------|-----------|------|
| `ContextCompressor` | `context/compressor.ts:16` | 超预算时保留近期一半消息，旧消息摘要成一条 `"Previous conversation summary"` assistant 消息 | 从未实例化 |
| `contextMiddleware` | `context/middleware.ts:5` | 在 `user-message` 事件触发压缩 | 从未注册到任何 pipeline |
| `TokenBudget` | `context/token-budget.ts:16` | 测量 token 用量，报告 `isNearLimit`/`isOverBudget` | 从未实例化 |
| `overflowToolResult` | `context/overflow.ts:10` | >64KB 工具输出溢出到 `.licode/overflow/` 文件并返回指针 | 无任何 tool 调用 |
| `Summarizer` | `context/summarizer.ts:7` | 通用 LLM 摘要 helper | 从未实例化 |
| `ConversationManager.trimToBudget()` | `manager.ts:138` | 从新到旧保留 user/assistant 对直到预算耗尽 | 从未调用 |

### 1.4 关键问题与隐患

1. **运行时零压缩**：compressor 是死的，长会话涨上去撞 200k 硬墙直接死掉，而非摘要续命。
2. **token 计数是粗略启发式**（`llm/token-counter.ts`）：英 4 字符/token、中 1.5 字符/token，非真 tokenizer；工具/JSON 内容靠 `JSON.stringify` 估算。即便接上预算逻辑，判定也不可信。
3. **`buildMessages()` 永远传 `Infinity`**：SystemPrompt 的预算裁剪逻辑形同虚设，可裁剪层从不会被丢弃。
4. **两套重叠且都休眠的裁剪机制**：`ContextCompressor.compress()`（摘要式）与 `trimToBudget()`（丢弃式），激活前需先取舍。
5. **`trimToBudget()` 结构缺陷**（`manager.ts:138`）：只认 user/assistant 文本对，忽略 tool_use（assistant）+ tool_result（user）结构。一旦激活会把 tool_result 孤立——Anthropic API 要求 tool_result 必须紧跟同一轮 tool_use，**会直接 API 报错**。
6. **工具输出无溢出保护**：`overflowToolResult` 没被任何工具调用，大段 `read`/`bash`/`grep` 输出全量灌进上下文。
7. **无增量摘要 / 滑动窗口**：即便接上 compressor，当前方案是"保留近期一半 + 一条静态摘要 blob"，细节丢失，且每次从零重摘要、摘要本身不再演化。
8. **`context-compressed` 事件**已在 `events/types.ts:13` 定义，但只有死掉的 middleware 会发，UI 也未消费。
9. **`collectResponse` 输出硬上限** `maxTokens: 4096`（`react.ts:36`）——与输入上下文无关，但改进时需一并审视。

### 1.5 事件与中间件现状

- `EventPipeline`（`events/pipeline.ts`）为洋葱模型中间件链。CLI 实际注册顺序（`hooks.ts:382`）：`before:agentLoop 扩展` → `tokenCountingMiddleware` → `createAgentLoopMiddleware` → `hook:after:agentLoop` → 错误处理。
- `tokenCountingMiddleware`（`events/middleware/token-count.ts`）：仅在 `llm-response-complete` 时累加 `usage.input+usage.output` 回调 UI 状态栏，**只读展示，不参与任何裁剪决策**。
- `context-compressed` 事件类型已就绪但无生产者/消费者。

---

## 二、改进起点：多阶段蓝图

### 总体路线

```
Phase 1: 真实 token 计数（地基）              📋 规划中
  ├── 用真 tokenizer 替换字符比例启发式
  ├── 适配 TokenCounter API（保持调用点不变）
  └── 与 API 返回 usage 对齐校准

Phase 2: 激活预算感知的消息构建               📋 规划中
  ├── buildMessages() 传入真实 budget
  ├── 激活 SystemPrompt.assemble() 分层裁剪
  └── 引入模型上下文窗口配置 + 输出预留

Phase 3: 接活压缩管线，替换硬停（核心）        📋 规划中
  ├── 压缩器接入 agent loop（替换/补足 200k 硬停）
  ├── 修复 trimToBudget() 的 tool_use/tool_result 孤立坑
  ├── 取舍两套裁剪机制（统一为结构感知的压缩）
  ├── 发出 context-compressed 事件 + UI 消费
  └── 长会话从"撞墙即死"变为"摘要续命"

Phase 4: 工具输出溢出保护                     📋 规划中
  ├── overflowToolResult 接入 read/bash/grep 等工具
  ├── 单条输出内联上限 + 溢出落盘 + 指针返回
  └── 与压缩管线协同（溢出指针而非全文入上下文）

Phase 5: 增量摘要 / 滑动窗口                  📋 规划中
  ├── 一次性整段摘要 → 可演化滚动摘要
  ├── 结构感知压缩（tool_use 对整体保留，prose 轮次摘要）
  └── 选择性保留（重要轮次不压缩）
```

**依赖关系**：Phase 1 是 Phase 2/3 的地基（预算判断依赖可信计数）；Phase 2/3 可合并推进（都是"接活预算感知"）；Phase 4/5 相对独立，可并行或后置。

---

### Phase 1：真实 token 计数（地基）

#### 目标

用真 tokenizer 替换 `TokenCounter` 的字符比例启发式，让所有预算/裁剪判定可信。

#### 关键变更

1. **Tokenizer 选型**：
   - 方案 A：引入 `tiktoken`（OpenAI BPE，离线、快，但与 Anthropic 分词略有差异）。
   - 方案 B：用 Anthropic Messages Count Tokens API（精确但需网络往返，适合校准而非每步调用）。
   - 建议：A 做日常估算，B 做离线校准基准。
2. **保持 `TokenCounter` 接口不变**（`estimate(text)` / `estimateMessages(messages)`），替换内部实现，避免改动所有调用点。
3. **工具/JSON 内容估算优化**：当前 `JSON.stringify(msg.content)`（`token-counter.ts:35`）粗略，需针对 tool_use/tool_result 结构做更准的展开估算。

#### 验收标准

- [ ] `TokenCounter.estimate()` 与 API 返回 `usage.input` 误差 ≤ ±5%（中英文混合样本）。
- [ ] `TokenCounter` 接口签名不变，现有调用点零改动。
- [ ] 现有 token-counter 相关测试适配并通过。
- [ ] 无新增运行时依赖问题（`tiktoken` 体积/wasm 加载）。

---

### Phase 2：激活预算感知的消息构建

#### 目标

让 `buildMessages()` 传入真实 budget，激活已存在但休眠的 `SystemPrompt.assemble()` 分层裁剪。

#### 关键变更

1. **引入模型上下文窗口配置**：在 `ConversationManager` 或 `AgentConfig` 中声明 `contextWindow`（如 200k）与 `outputReserve`（如 8k）。
2. **`buildMessages(tokenBudget)` 传真实值**：budget = `contextWindow - outputReserve - 已用消息 token`（依赖 Phase 1 计数）。
3. **激活 `SystemPrompt.assemble(budget)`**：压力下按 priority 丢弃/截断可裁剪层（`memory-guide`、`tool-use`），always 层（`role`、`safety`）必发。
4. **可选**：在 `AgentLoop.run()` LLM 调用前加预算预检，超限时触发 Phase 3 压缩而非直接发请求。

#### 验收标准

- [ ] 接近上下文上限时，可裁剪系统提示层被按 priority 丢弃；always 层始终保留。
- [ ] system prompt 永不超出分配预算。
- [ ] 短会话行为零回归（所有层照常全发）。
- [ ] `/context` 命令展示窗口配置与剩余预算。

---

### Phase 3：接活压缩管线，替换硬停（核心）

#### 目标

把 `ContextCompressor` 真正接入 agent loop，让长会话从"撞 200k 即死"变为"摘要续命"；修复结构缺陷。

#### 关键变更

1. **压缩器接入点**：在 `AgentLoop.run()` 每步 LLM 调用前（或 `onTurnStart`）检查预算，超阈值时压缩，而非依赖 `termination.check()` 硬停。
2. **结构感知压缩**：替换朴素"保留近期一半 + 一条摘要"。新策略需：
   - 整体保留最近的 tool_use/tool_result 对（不可截断，否则 API 报错）；
   - 对较早的 prose 轮次做摘要；
   - 保留首条 user message（任务原始意图）。
3. **修复 `trimToBudget()`**（`manager.ts:138`）：使其按"完整结构单元"（user→assistant→tool_use→tool_result）裁剪，绝不孤立 tool_result。或直接弃用，统一走压缩器。
4. **取舍两套机制**：`compress()`（摘要式）与 `trimToBudget()`（丢弃式）二选一或明确分工（如先 trim 到阈值，仍超则 summarize）。
5. **事件 + UI**：发出 `context-compressed` 事件（`events/types.ts:13`），CLI 状态栏/流式渲染消费，提示用户"已压缩 N 条消息"。
6. **终止策略调整**：`maxTokens` 从"硬停"降级为"压缩后仍超限的最终兜底"。

#### 验收标准

- [ ] 长会话接近上限时自动压缩并继续，不再直接 `TerminationError` 终止。
- [ ] 压缩后历史中无孤立 tool_result（API 不报错）。
- [ ] 首条 user message 与最近工具轮次被保留。
- [ ] `context-compressed` 事件被正确发出且 UI 可见。
- [ ] 短会话零压缩、零回归。

---

### Phase 4：工具输出溢出保护

#### 目标

把 `overflowToolResult` 接入 `read`/`bash`/`grep` 等工具，限制单条输出入上下文的体积。

#### 关键变更

1. **接入点**：在 `ToolExecutor` 或各工具返回前调用 `overflowToolResult`，超过 `maxInlineBytes`（默认 64KB）时落盘到 `.licode/overflow/` 并返回指针。
2. **工具适配**：`readTool`（大文件）、`bashTool`（长 stdout）、`grepTool`（大量匹配）优先接入。
3. **与压缩协同**：溢出指针是轻量上下文项，压缩时可作为整体单元保留或丢弃。
4. **指针可回收**：模型可通过 `read` 工具按需取回溢出文件全文（已有 `11-context-offload` 模式可参考）。

#### 验收标准

- [ ] 单条工具输出 >64KB 时落盘，上下文中仅留指针。
- [ ] 模型可经 `read` 取回溢出全文。
- [ ] 小输出不受影响（直接内联）。
- [ ] `/context` 展示溢出文件数量。

---

### Phase 5：增量摘要 / 滑动窗口

#### 目标

把一次性整段摘要升级为可演化滚动摘要 + 选择性保留，减少跨压缩的细节丢失。

#### 关键变更

1. **滚动摘要**：维护一条随会话演化的摘要消息，每次压缩时把新被裁剪的轮次并入现有摘要（而非从零重摘要）。
2. **选择性保留**：标记重要轮次（如用户明确决策、错误修复点），压缩时不纳入摘要、整体保留。
3. **结构感知分级**：prose 轮次高压缩比，工具轮次低压缩比或整体保留。
4. **摘要质量校验**：可选地用 LLM 评估摘要是否丢失关键信息（离线，不阻塞主循环）。

#### 验收标准

- [ ] 多次压缩后摘要逐轮演化，而非每次从零生成。
- [ ] 标记的重要轮次在压缩中保留。
- [ ] 工具轮次的结构完整性不被破坏。
- [ ] 跨压缩的信息丢失率低于 Phase 3 的一次性方案（人工评估或对比测试）。

---

## 三、设计决策记录（待补）

| 决策 | 候选 | 倾向 | 原因 |
|------|------|------|------|
| Tokenizer | tiktoken / Anthropic count API | tiktoken 估算 + API 校准 | 离线快，API 仅做基准 |
| 裁剪机制取舍 | compress 摘要式 / trimToBudget 丢弃式 | 待定（Phase 3 定） | 需评估信息保留 vs 实现成本 |
| 压缩触发点 | onTurnStart / 每步 LLM 前 | 每步 LLM 前 | 能在工具轮次中实时响应增长 |
| 预算来源 | 硬编码 / 模型配置 | 模型配置 | 不同模型窗口不同 |
| 溢出策略 | 落盘指针 / 截断 | 落盘指针 | 可回收，参考 context-offload 模式 |

---

## 四、参考

- 冻结事实来源：`packages/core/src/context/`、`conversation/manager.ts`、`conversation/system-prompt.ts`、`llm/token-counter.ts`、`agent/loop.ts`、`agent/termination.ts`、`memory/recall.ts`
- 模式参考：`docs/clipboard/11-context-offload.md`（工具结果溢出落盘 + 指针回收）
- 同类文档：`memory-improvement-plan.md`（记忆模块渐进式改进，本方案沿用其格式与"独立可验证、可回退"原则）

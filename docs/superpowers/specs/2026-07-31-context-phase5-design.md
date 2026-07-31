# 上下文管理 Phase 5 设计：滚动演化摘要 + 选择性保留

> **状态**：设计已审定，待写实现计划
>
> **设计日期**：2026-07-31
>
> **前置**：Phase 1（校准式 token 计数）、Phase 2/3（预算感知构建 + 结构感知压缩）、Phase 4（工具输出溢出保护）均已落地并接线。
>
> **说明**：本文是 Phase 5 的设计 spec，非实现计划。实现步骤由后续 writing-plans 产出。遵循项目"独立可验证、可回退"原则。

---

## 一、背景与现状（已核实）

代码与 `context-improvement-plan.md` 一致，Phase 1–4 均已落地。对 Phase 5 设计最相关的现状：

- **压缩触发**（`agent/loop.ts:121-138`）：每轮 LLM 前检查 `getTokenCount() > compressThreshold × maxContextTokens`，超阈值调 `compressor.compress()`，**每次 `run()` 至多压缩一次**（`compressedThisRun` 守卫）。跨多个 user turn 可多次压缩——这是滚动摘要发挥作用的场景。
- **当前压缩形态**（`context/compressor.ts:59`）：`splitIntoTurns` 按轮次切（user 文本开新轮，tool 对原子不拆），产出 `[firstUser, SUMMARY(assistant), ...recentTurns]`；summarizer 失败降级 trim。
- **伪滚动**：第 2 次压缩时上一轮 SUMMARY 落入 `summarizeRegion` 被重新摘要，但 `Summarizer`（`context/summarizer.ts`）用一次性 prompt `"Summarize the following conversation for future context"` 把旧摘要当普通 transcript 行**从零重摘**，非显式合并。
- **无选择性保留**：`Message` 类型（`llm/provider.ts`）无 pinned/metadata 字段，消息无稳定 `id`（仅 `timestamp`），压缩后索引漂移。
- **结构安全已满足**：tool_use/tool_result 对原子不拆、不孤立；Phase 5 验收"工具轮次结构完整性不被破坏"现状即满足。
- **状态变更工具**：`Write{file_path, content}`、`Edit{file_path, old_string, new_string, replace_all}`（`tools/builtin/write.ts`、`edit.ts`）。无独立 mkdir/patch 工具。
- **`context-compressed` 事件**（`events/types.ts`）：现形为 `{type, method:"trim"|"summarize", removedMessages?}`。
- **CLI 侧压缩器构造**（`cli/hooks.ts:89` `createContextCompressor`）：`AnthropicProvider` 侧模型 + `Summarizer`（`maxTokens:1024`）注入压缩器。
- **仓库无现成 git 工具模块**；remote 为 gitee，主分支 `master`。

---

## 二、目标与范围

### 目标

把一次性整段摘要升级为**可演化滚动摘要** + **选择性保留**，减少跨压缩的细节丢失。

### 范围（本次 spec）

- ✅ **滚动演化摘要**：旧摘要 + 新被裁剪轮 -> 更新摘要，逐轮演化（非从零）。
- ✅ **选择性保留**：三层机制——确定性硬保留（must-keep）+ 模型软判断（should-keep）+ 预算最终裁剪。

### 范围外（延后）

- ❌ **结构感知分级**（prose 高压缩比 / tool 低压缩比差异化）：结构安全已由 Phase 2/3 保证；分级为可选增强，延后。
- ❌ **摘要质量校验**（离线 LLM 评估摘要是否丢关键信息）：本就可选，延后。

---

## 三、选择性保留：三层模型

### 第一层 · must-keep（确定性硬保留，永不并入摘要）

由确定性规则判定，是硬地板——压缩中整体保留，预算再紧也不动。代码判定，无模型、可单测。两条规则：

1. **错误修复轮**：含 `is_error:true` 的 `tool_result` 所在轮。保留"试过 X 失败"的上下文；纠正通常在相邻轮或 recent 窗口内。
2. **文件写入/编辑轮**：含 `Write` 或 `Edit` tool_use 的轮。保留关键状态变更、避免重复操作。此类轮**压缩为 file_change 笔记**（见 §五），非原文照留。

> 首条 user 消息（任务意图）继续整体保留（现状），语义上归入硬保留。

### 第二层 · should-keep（模型软判断，预算允许则保留）

压缩时统一 side-call（见 §六）对**非 must-keep** 的中间轮逐轮分类 `important` / `normal`：
- `important`：优先整体保留。
- `normal`：并入滚动摘要。

判据由 side-call prompt 给出：用户明确决策、关键结论、不可重 derived 的信息等。

### 第三层 · 预算最终裁剪

压缩器估算组装后 token，超阈值时按优先级牺牲：

**normal（已并入摘要）-> important（降级，其内容已在摘要里以简短引用保留，graceful）-> must-keep（硬地板，不动）**

若 must-keep + recent 仍超预算 -> 触发既有 `maxTokens` 兜底（trim/终止）+ emit 事件，绝不静默丢。详见 §七。

### 压缩后形态

```
[firstUser, SUMMARY(滚动), ...mustKeepError(原样), ...mustKeepWrite(file_change 笔记), ...important(原样, 预算允许时), ...recentTurns]
```

角色交替成立：SUMMARY(assistant) 后接 must-keep 轮（user 起始）；各轮末为 assistant（run() 正常结束于 assistant 文本），轮间 a->u 交替。整轮保留保证 tool 对不孤立。

---

## 四、模块与触点

| 文件 | 变更 |
|---|---|
| `context/compressor.ts` | 核心：三层保留 + 滚动合并 + 预算裁剪编排；注入回调由 `summarizer` 升级为 `compressionAssistant` |
| `context/summarizer.ts` | 扩展为 `CompressionAssistant`：统一 side-call，结构化 JSON 输出 |
| `context/file-change.ts`（新） | `file_change` JSON 构造 + 确定性字段（op/path/stats）+ 既有笔记识别 |
| `context/git-pointer.ts`（新） | `git hash-object -w` 取 blob hash；非 git 回退落盘 `.licode/overflow/` |
| `agent/loop.ts` | `ContextConfig` 加字段；`compress()` 调用传入 `budgetTokens` |
| `cli/hooks.ts` | `createContextCompressor` 构造新的 `compressionAssistant` 回调 |
| `events/types.ts` | 扩展 `context-compressed` 事件字段 |
| `commands/builtin/context.ts` | `/context` 展示压缩/保留统计 |

实现路径采用**原地扩展 `ContextCompressor`**（候选 A）。曾考虑抽出 `CompressionStrategy` 类（B）或单职责阶段流水线（C），当前复杂度不值，否决。沿用现有"侧模型注入、失败降级 trim、永不中断循环"模式。

---

## 五、file_change 压缩

`must-keep-write` 轮原本 `[userText, assistant(Write/Edit tool_use 全文), user(tool_result)]` **替换**为 `[userText, assistant(file_change JSON 笔记)]`（直接替换，不塞进 tool_use）。

### 笔记结构

```json
{
  "type": "file_change",
  "operation": "edit",
  "path": "src/auth/JwtFilter.java",
  "stats": { "added": 35, "removed": 12 },
  "symbols": ["JwtFilter.doFilter", "TokenProvider.validate"],
  "summary": { "kind": "add authentication filter" },
  "pointer": { "path": "src/auth/JwtFilter.java", "version": "<git-blob-hash>" }
}
```

### 字段来源

| 字段 | 来源 | 计算 |
|---|---|---|
| `type` | 确定性 | 常量 `"file_change"` |
| `operation` | 确定性 | tool 名映射：`Write`/`Edit` |
| `path` | 确定性 | tool_use input `file_path` |
| `stats.added` / `stats.removed` | 确定性 | Edit：`lines(new_string)` / `lines(old_string)`；Write：`lines(content)` / `0` |
| `symbols` | **模型** | 从 diff/内容提取新增核心方法 |
| `summary.kind` | **模型** | 一句话变更意图/原理（必须简短） |
| `pointer.path` | 确定性 | = `path` |
| `pointer.version` | 确定性 | 见下 |

### pointer.version（恢复指针）

- **git 仓库内**：`git hash-object -w` 得 blob hash（写入 git 对象库，不产生 commit），恢复 `git cat-file -p <hash>` 或 `git show <hash>`。快照内容来源按操作区分：
  - `Write`：快照 tool_use input 的 `content`（精确写入时内容，经 `--stdin` 喂入），不受后续 Edit 影响。
  - `Edit`：快照压缩时**磁盘上的文件**（即该 Edit 的产物；tool_use 仅含 hunk，无全文）。
- **非 git 回退**：对应内容落盘 `.licode/overflow/<contentHash>`，pointer 记 spill 路径 + 内容 hash，模型用 `read` 取回（复用 Phase 4 overflow 模式）。

> 边界情况：同一文件在压缩前被多轮 Edit，则各 Edit 轮的磁盘快照均为"最新"状态（无法逐轮区分）。可接受--file_change 笔记是记忆辅助，最新状态由最近一条 file_change 或 `read` 当前文件覆盖；逐轮精确版本化非本阶段目标。

### 幂等性

下一轮压缩遇到已存在的 file_change 笔记（assistant 消息，按结构可识别）-> 视为 `must-keep-write` 原样保留，**不重复压缩**。error 轮原样保留同样幂等（再次扫描仍命中 `is_error`）。

### 模型输入保护

传给 side-call 的 write 轮内容做截断保护：巨文件只给前 N 行 + 行数（全文在磁盘，经 pointer 可恢复），避免 side-call 输入爆炸。

---

## 六、统一 side-call 契约

**一次调用三件事**，返回结构化 JSON：

1. **分类**：每个 `candidate`（非 must-keep 中间）轮 -> `important` | `normal`
2. **file_change 生成**：每个 `must-keep-write` 轮 -> `{symbols, summary}`
3. **滚动合并**：现有摘要 + `normal` 轮 -> `updatedSummary`（有界，见 §七）；`important` 与 must-keep 轮在摘要里**仅简短引用**（保叙事连贯 + 为 important 的 shed 留 graceful 退路）

### 输入

- 现有 SUMMARY 文本（若有；首次为空）
- 各中间轮内容，带标记：`must-keep-error`（仅引用）、`must-keep-write`（给截断内容，生成描述符）、`candidate`（给内容，分类）

### 输出（JSON）

```json
{
  "updatedSummary": "...",
  "classifications": [{ "turnIndex": 1, "keep": "important" | "normal" }],
  "fileChanges": [{ "turnIndex": 3, "symbols": ["..."], "summary": { "kind": "..." } }]
}
```

> `turnIndex` 是代码为本轮压缩的中间区轮次分配的**顺序索引**（从 1 起），仅用于 side-call 往返定位--消息无稳定 id（仅 `timestamp`），故不依赖消息 id。代码按索引把分类/描述符回填到对应轮。

### 约束

- 复用 `summarizerModel`（默认 `deepseek-chat`）。
- `updatedSummary` 有界：总长 ≤ `summaryMaxTokens`（默认 2048），超则丢最旧/最次要细节（单调用有界合并，见 §七）。
- **失败降级**：side-call 抛错或 JSON 解析失败 -> 整体降级 trim（沿用现机制，不中断循环）。

---

## 七、滚动演化摘要

### 槽位与识别

槽位不变：一条 assistant 消息 `"Previous conversation summary: <text>"`。代码按 role+前缀识别并提取旧摘要文本，传给合并调用。

### 单调用有界合并

合并 prompt 带"总长 ≤ `summaryMaxTokens`、超则丢最旧/最次要细节"约束，**并入新轮 + 压缩旧摘要一次完成**，不另开自压缩 pass。开销与现一次性摘要相同（一次 side-call）。

### 首次压缩

无旧摘要时，合并调用 existing 为空，退化为普通摘要。

### 引用保留轮

`updatedSummary` 对 `important` 与 must-keep 轮仅简短引用（如"用户随后决定用方案 A（见保留轮）"、"编辑了 JwtFilter.java 加认证过滤器（见 file_change 笔记）"），保证：
- 叙事连贯（摘要 + 保留轮拼出完整脉络）；
- important 轮被预算 shed 后，其简短引用仍在摘要里，graceful 退化。

---

## 八、预算裁剪与兜底

### 估算

压缩器内置 `TokenCounter`，估算组装后 `[firstUser + SUMMARY + must-keep + important + recent]` 的 token。阈值 = `compressThreshold × maxContextTokens`（与触发同源）。`compress()` opts 扩展：加 `budgetTokens`。

### shed 顺序

1. `important` 轮逐个丢（已在 SUMMARY 简引，graceful）；
2. 仍超 -> must-keep 是硬地板，不动；
3. 仍超 -> 触发既有 `maxTokens` 兜底（trim/终止）+ emit 事件，绝不静默丢。

---

## 九、事件与 /context

### `context-compressed` 事件扩展

```ts
{
  type: "context-compressed";
  method: "trim" | "summarize" | "rolling";
  removedMessages?: number;
  retainedTurns?: number;     // must-keep + important 保留数
  compactedTurns?: number;    // file_change 笔记数
  summaryUpdated?: boolean;   // 滚动摘要是否更新
}
```

### `/context` 命令增显

- 累计压缩次数
- 上次压缩统计（removed/retained/compacted）
- must-keep 保留轮数

---

## 十、ContextConfig 新增

`agent/loop.ts` 的 `ContextConfig` 增加：

| 字段 | 默认 | 说明 |
|---|---|---|
| `summaryMaxTokens?` | `2048` | 滚动摘要硬上限 |
| `importantTurnsBudget?` | 可选 | should-keep 保留预算比例（0–1），不设则尽力保留 |
| `rollingSummary?` | `true` | 滚动演化摘要开关（关则退回一次性） |
| `selectiveRetention?` | `true` | 选择性保留开关（关则不分层、全部并入摘要） |
| `fileChangeCompaction?` | `true` | file_change 压缩开关（关则 write 轮原样保留） |

三个开关默认全开，可单独关以回退子特性。

---

## 十一、测试与验收

### 验收标准

- [ ] **多次压缩摘要逐轮演化**：mock side-call 断言合并 prompt 收到旧摘要文本（非从零）。第 2 次压缩的 `updatedSummary` 是旧摘要 + 新轮的合并结果。
- [ ] **must-keep 保留**：含 `is_error` 的轮、含 `Write`/`Edit` 的轮在压缩中保留。
- [ ] **file_change 压缩正确**：write 轮 -> file_change JSON 笔记；确定性字段（op/path/stats）正确；`pointer.version` 为 git blob hash 且可经 `git cat-file` 恢复；非 git 回退落盘且可经 `read` 恢复。
- [ ] **should-keep 行为**：模型标 `important` 的轮默认整体保留；超预算时 graceful shed（内容已在摘要简引）。
- [ ] **结构完整性**：压缩后无孤立 tool_result（API 不报错）。
- [ ] **摘要有界**：`updatedSummary` ≤ `summaryMaxTokens`。
- [ ] **失败降级**：side-call 抛错或 JSON 解析失败 -> 降级 trim、不中断循环。
- [ ] **跨压缩信息丢失 < Phase 3**：对比测试（人工或用例对比一次性 vs 滚动的关键信息保留率）。

### 回归

- 短会话零压缩、零回归。
- 现有 `context.test.ts` / `summarizer.test.ts` / `loop.test.ts` 适配并通过。

---

## 十二、回退

- **整层**：`compressor` 配置省略即退回硬停（现状）。
- **子特性**：三个开关可单独关（`rollingSummary`/`selectiveRetention`/`fileChangeCompaction`）。
- **代码回滚**：revert `compressor.ts` + `summarizer.ts` + `hooks.ts` + 新文件（`file-change.ts`、`git-pointer.ts`）+ 事件/`/context` 扩展。

---

## 十三、设计决策记录

| 决策 | 候选 | 选定 | 原因 |
|---|---|---|---|
| Phase 5 范围 | 核心两项 / 完整 / 仅滚动 | 核心两项（滚动 + 选择性保留） | 分级与质量校验可选，延后；与既有 phase 风格一致 |
| 重要轮判定 | 启发式 / 模型 / 显式 / 分层 | 三层（确定性 must-keep + 模型 should-keep + 预算裁剪） | 确定性兜底硬地板 + 模型自适应 + 预算务实 |
| must-keep 规则 | error / file-write / 决策语言 / 所有工具轮 | error 修复轮 + file-write/edit 轮 | 确定性高、可单测；决策语言归模型软判断 |
| file-write 轮内容处理 | 确定性压缩 / 模型摘要 / 预览+指针 | 结构化 file_change JSON（确定性字段 + 模型填 symbols/summary） | 信号量高；全文在磁盘可恢复 |
| file_change 指针 | blob hash / commit hash / spill / 仅 path | git blob hash + 非 git spill 回退 | 精确内容、无需 auto-commit；复用 Phase 4 |
| file_change 形态 | 替换原轮为合成笔记 / 塞进 tool_use | 合成 assistant 笔记替换 | 最简、最省 token |
| 摘要增长控制 | 单调用有界 / 合并+独立自压缩 / 软约束 | 单调用有界合并 | 开销不变、有界 |
| 实现路径 | 原地扩展 / 抽 Strategy / 阶段流水线 | 原地扩展 ContextCompressor | 复杂度匹配、沿用注入模式 |
| side-call 次数 | 一次统一 / 多次分离 | 一次统一（分类 + file_change + 合并） | 少往返 |

---

## 十四、参考

- 现状来源：`packages/core/src/context/compressor.ts`、`summarizer.ts`、`agent/loop.ts`、`conversation/manager.ts`、`tools/builtin/write.ts`、`edit.ts`、`events/types.ts`、`cli/hooks.ts`
- 总蓝图：`context-improvement-plan.md`（Phase 5 节）
- 前序计划：`context-phase4-plan.md`、`context-phase2-plan.md`、`context-phase1-plan.md`
- 模式参考：`docs/clipboard/11-context-offload.md`（溢出落盘 + 指针回收，file_change 非 git 回退沿用）

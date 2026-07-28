# 记忆系统 Phase 2 详细设计：召回层升级（side query + 合成 tool_call 注入）

> **日期**：2026-07-28
> **状态**：已批准（brainstorming 产出）
> **前置文档**：[记忆系统重构设计](./2026-07-27-memory-system-redesign-design.md)（本文档细化其 §6.1 Phase 2 蓝图）
> **前置实施**：[Phase 1 生产层修复](./2026-07-27-memory-phase1-implementation-plan.md)（commit `70b21e6`，已落地）

---

## 1. 背景与现状

### 1.1 Phase 1 已交付能力（生产层）

| 能力 | 实现 | 位置 |
|---|---|---|
| action 语义落盘 | `save(memory, action)`：update 替换正文/保留 createdAt；append 段落去重；create 遇已存在防御降级 append | `packages/core/src/memory/store.ts` |
| 索引自动重建 | `rebuildIndex()` 公开，覆盖主 Agent 直接 Write 的文件；索引行相对路径 | `store.ts` |
| 主 Agent 写入检测 | `hasChangesSince(tsMs)` 按 mtime 扫描 4 个类型目录 | `store.ts` |
| 提取门槛 | 冷却 5 分钟 + 问句排除 + 明确指令（"记住"等）绕过冷却；无关键词白名单 | `extractor.ts` |
| 矛盾处理 | 提取 prompt 携带全部现有记忆正文，LLM 可输出 update 重写 | `extractor.ts` |
| 进程内互斥 | `MemoryExtractionState.running`，重叠直接跳过不排队 | `hook.ts` |
| 主 Agent 指引层 | `memory-guide.md`（priority 4）：何时/如何/不写什么 | `conversation/templates/` |

### 1.2 召回层现状与差距分析

**已被现有功能满足（无需 Phase 2 重复建设）**：

1. spec §6.1 **Step a（零模型成本按需召回）已在 Phase 1 完整落地**——memory-guide 层含"索引已注入上下文；需要正文时用 Read 读取对应文件"，主 Agent 有 Read/Grep 工具可自行深入记忆目录。对齐 CC 旧方案。
2. 启动时 MEMORY.md 索引注入 system prompt（`MemoryLoader` → `"memory"` 层，priority 5）。

**Phase 2 要补齐的差距**：

1. **side query**：用户消息进入时，小模型按索引选择 ≤5 个相关记忆文件——不存在。
2. **正文注入当轮上下文**：记忆正文永远进不了上下文（召回层核心痛点）——不存在。
3. **可配置开关 + 失败降级为仅索引**——不存在。
4. **会话内新写记忆可被后续轮次选中**——当前索引层是**启动时快照**（`packages/cli/src/hooks.ts` 只在会话 init 时 `loadInto` 一次），会话内新写的记忆连索引行都不会刷新进 system prompt。

### 1.3 架构约束（调研已核实）

1. **注入时机**：现有 `before:agentLoop` hook 在 `AgentLoop.run()` 之前触发，而 `addUserMessage` 在 `run()` 内部——hook 拿不到"用户消息已入列"的时机，需要 core 暴露新挂点。
2. **角色交替**：`U(tool_result)` 后紧跟 `U(文本)` 会产生连续 user 消息，Anthropic API 虽能合并但 deepseek 兼容端点行为未验证——注入位置必须保证角色严格交替。
3. **provider 无 abort signal** → 超时只能用 `Promise.race` 降级（后台请求结果被丢弃）。
4. **prompt cache 未启用**（provider 仅透传 `cache_control`，LICode 未主动使用）→ 每轮更新消息历史无缓存损失顾虑；且本设计不动 system prompt 中除索引层外的任何层。
5. **无 CLI 配置文件机制**（配置全部来自 env/CLI 参数）→ 开关走环境变量。
6. **TUI 渲染**：历史中的 tool_use 消息渲染为 `[调用工具: <names>]` 卡片，tool_result 渲染为 `✓ <前 100 字符>`——召回对对**用户可见**，构成透明性优势。
7. **单一 React 会话路径**：`app.tsx` → `useConversation`（`hooks.ts`），pipeline 构造有两处（正常提交 + slash-command prompt 递归），都给 `createAgentLoopMiddleware` 传同样的 config——`onTurnStart` 挂在 AgentConfig 上则两条路径自动覆盖。

---

## 2. Phase 2 详细设计

### 2.1 总体机制：合成 tool_call 对 + 每轮换新

不改动 system prompt（除索引层刷新）和用户消息原文。记忆正文以**合成工具调用对**的形式进入消息历史：

```
[..., U(今晚吃什么好？), A(调用 memory_recall), U(tool_result: 记忆正文)]
                                                              ↑ 模型从这里继续生成
```

每轮 agent loop 第一次 LLM 调用之前依次执行：

1. **刷新索引层**：重读 `store.loadIndex()`，内容变化才 `addLayer("memory", ...)` 替换——会话内新写的记忆从下一轮起进入 system prompt 索引（满足 spec"本会话新写入的记忆当轮即可被 side query 选中"：side query 每轮读的是磁盘最新索引，索引层刷新保证 system prompt 与之一致）。
2. **剪除**：从消息历史中移除上一轮的召回对（assistant `tool_use: memory_recall` + 对应的 user `tool_result`）——任意时刻历史中最多只有一对，token 不累积，记忆内容始终反映当轮选择。
3. **选择**：side query 读磁盘最新索引，小模型选出 ≤5 个相关记忆。
4. **注入**：选择非空时，把合成对追加到**当前用户消息之后**（`addUserMessage` 已执行）。

**为什么注在用户消息之后而非之前**：之前会形成 `U(tool_result), U(文本)` 连续 user 消息（约束 1.3.2）；之后则角色严格交替（U → A → U），任何 provider 都安全；且"模型回答前主动查了记忆"的语义更自然，与 CC side query 的行为模型一致。

### 2.2 组件变更

| 组件 | 变更 | 文件 |
|---|---|---|
| **MemoryRecall**（新） | side query 引擎 + 召回对管理，内聚于单文件 | `packages/core/src/memory/recall.ts` |
| **AgentLoop** | `AgentConfig` 新增可选 `onTurnStart` 回调；`run()` 在 `addUserMessage` 后、while 循环前调用，`try/catch` 包裹——回调失败不阻断 loop | `packages/core/src/agent/loop.ts` |
| **MemoryExtractor** | `formatMessages` 过滤 `memory_recall` 合成消息对，避免记忆正文 JSON 重复进入提取 prompt | `packages/core/src/memory/extractor.ts` |
| **CLI 接线** | 创建 `MemoryRecall`（与 extractor 同 apiKey/baseUrl/model）；两处 pipeline 的 `createAgentLoopMiddleware` config 传入 `onTurnStart`；env 开关 | `packages/cli/src/hooks.ts` |
| **core 导出** | `MemoryRecall`、`createMemoryRecallHandler` 等新符号 | `packages/core/src/index.ts` |

`recall.ts` 内部结构：

```ts
/** 合成对标识：tool_use 的 name，剪除时据此识别 */
export const MEMORY_RECALL_TOOL_NAME = "memory_recall";

export interface MemoryRecallConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;       // 与提取同模型级别（CLI 传入同一 model）
  maxResults?: number;  // 默认 5
  timeoutMs?: number;   // 默认 10_000
}

export class MemoryRecall {
  constructor(config?: MemoryRecallConfig);
  /**
   * 按用户查询选择相关记忆。
   * - 索引为空 → 不调 LLM，返回 []
   * - LLM 错误 / 超时 / 解析失败 → 返回 []（降级为仅索引）
   * - slug 必须真实存在于索引（防幻觉），超出 maxResults 截断
   */
  select(userQuery: string, store: MemoryStore): Promise<Memory[]>;
}

/** 移除历史中的全部召回对（含会话恢复后位于历史中间的旧对） */
export function pruneRecallMessages(messages: Message[]): Message[];

/** 构造合成对；tool_use 的 id 与 tool_result 的 tool_use_id 互相关联 */
export function buildRecallPair(
  query: string,
  memories: Memory[]
): [ToolUseMessage, ToolResultMessage];

/**
 * 返回 AgentConfig.onTurnStart 回调：
 *   刷新索引层 → 剪除旧对 → select → 非空则追加新对
 * 只做副作用，不抛异常（内部全 catch）。
 */
export function createMemoryRecallHandler(deps: {
  recall: MemoryRecall;
  store: MemoryStore;
}): (conversation: ConversationManager) => Promise<void>;
```

设计要点：

- **`onTurnStart` 只需 `conversation` 一个参数**：`manager.systemPrompt` 是 public 字段，索引层刷新在回调内完成，无需额外注入 SystemPrompt。
- **side query 读磁盘索引而非 system prompt 层**：磁盘是真相源（store.save / hook rebuildIndex 都即时落盘），且不受 token 预算裁剪影响。
- **不注册真实 `memory_recall` 工具**：合成对的 tool_use 不需要存在于 ToolRegistry（API 不校验历史 tool_use 是否在当前工具表中）。模型若模仿调用，executor 返回"工具未找到"错误结果，模型自愈——低风险，YAGNI。
- **AgentLoop 的 `onTurnStart` 由 core `try/catch` 包裹**：挂点是通用机制，core 不应因可选回调失败而崩溃；回调实现方（`createMemoryRecallHandler`）同样内部全 catch，双保险。

### 2.3 side query prompt 设计

```text
Given the user's current message and the memory index below,
select the memories most relevant to the message.

## Memory index
{MEMORY.md 内容：- [name](slug) — description 每行一条}

## User message
{当前用户消息原文}

## Instructions
- 输出 JSON 数组，最多 5 个 slug：["user/food-preferences", ...]
- 只选与当前消息直接相关的记忆；无相关则输出 []
- slug 必须来自上面的索引，禁止编造
- 只输出 JSON，不要解释
```

**解析防线**（与 Phase 1 `parseResponse` 同风格）：提取 JSON（容错 markdown 代码围栏）→ 数组校验 → **slug 必须存在于当前索引的 slug 集合**（防幻觉的关键）→ 截断至 `maxResults`。

**不做问句排除**：与生产门槛相反——"我喜欢吃什么？"这类问句恰恰最需要召回，side query 的唯一跳过条件是索引为空或开关关闭。

**tool_result 正文格式**（markdown 分节，与索引行呼应）：

```markdown
# Recalled Memories

以下记忆与当前查询相关（由记忆召回系统自动选择）：

## 食物偏好 (user/food-preferences)
用户不喜欢红烧排骨（2026-07-27 起）。

## 编辑器 (user/editor)
...
```

合成对的 `tool_use.input` 为 `{ "query": "<用户消息截断至 200 字符>" }`，供 TUI 卡片与调试查看。

### 2.4 错误处理

| 场景 | 行为 |
|---|---|
| 索引为空 | 跳过 LLM 调用，零成本 |
| `LICODE_MEMORY_RECALL=off` | CLI 不装回调，完全退回 Phase 1 现状 |
| LLM 错误 / 超时（默认 10s） | `Promise.race` 兜底 → 只剪除不注入（降级为仅索引层，spec 要求） |
| 解析失败 / 全部 slug 幻觉 | 过滤后为空 → 不注入 |
| `onTurnStart` 自身抛异常 | core `try/catch`，agent loop 照常运行 |
| 会话恢复后历史含旧召回对 | 下一轮被剪除换新；session 文件中最多一对 |
| 模型模仿调用 `memory_recall` | 工具未注册 → executor 错误结果 → 模型自愈 |
| `trimToBudget` 裁掉召回对 | 可接受——下轮重新注入；裁剪产生孤儿 tool_result 是既有行为（普通工具调用同此），不新增风险类别 |
| 索引层刷新读盘失败 | catch 后保留旧层内容，不影响主流程 |

### 2.5 测试

| 测试 | 断言 |
|---|---|
| `recall.select`：正常路径 | mock LLM 返回 slug 数组 → 返回对应 Memory 列表（含正文）；prompt 中含索引与查询 |
| `recall.select`：防线 | >5 截断；幻觉 slug 被过滤；非数组/围栏 JSON 容错 |
| `recall.select`：降级 | LLM throw → `[]`；超时（注入短 timeoutMs + 慢 mock）→ `[]`；空索引 → 不调 LLM |
| `pruneRecallMessages` | 历史含旧对 → 全部移除（含位于历史中间的恢复场景）；无对 → 原样返回；普通工具调用对**不被误删** |
| `buildRecallPair` | tool_use.id === tool_result.tool_use_id；name 为 `memory_recall`；正文含全部记忆 name/slug/content |
| handler 完整流 | 调用后消息序列为 `[..., U, A_recall, U_result]`；select 为空 → 只剪除不注入；索引变化 → `addLayer` 被调用，无变化 → 不重复调用 |
| loop：`onTurnStart` | 在 `addUserMessage` 之后、首次 LLM 调用之前被调用；回调抛异常 → loop 继续正常完成 |
| extractor | `formatMessages` 输出不含 `memory_recall` 消息对内容，普通工具消息保留 |
| 回归 | 现有全部测试通过 |

---

## 3. 配置

| 项 | 值 |
|---|---|
| 开关 | `LICODE_MEMORY_RECALL=off` 关闭；**默认开启**（Phase 2 的核心能力，关闭仅为逃生通道） |
| side query 模型 | 与提取模型一致——CLI 把同一组 `apiKey/baseUrl/model` 传给 `MemoryRecall`（对齐 spec"沿用提取所用模型级别"） |
| 选择上限 | 常量 5（`maxResults` 可注入，仅供测试） |
| 超时 | 常量 10s（`timeoutMs` 可注入，仅供测试） |

---

## 4. 验证方式（Phase 2 验收标准）

1. 已有"食物偏好"记忆时问"今晚吃什么好？" → 当轮上下文包含该记忆正文（TUI 可见 `[调用工具: memory_recall]` 卡片），回答体现记忆内容
2. 问与记忆无关的问题（"帮我重构这个函数"）→ 无召回卡片、无正文注入，仅索引层
3. 会话中说"记住：我的编辑器是 Neovim" → 后续轮次问"我的编辑器是什么？" → 新记忆可被选中注入（无需重启会话）
4. 断网/无效 apiKey → 对话正常进行，仅索引层兜底（无报错阻塞）
5. `LICODE_MEMORY_RECALL=off` 启动 → 完全退回 Phase 1 行为
6. 恢复旧会话（历史中含召回对）→ 新一轮后旧对被替换，历史中最多一对
7. 全部新旧测试通过

---

## 5. 设计决策记录

| 决策 | 选择 | 原因 |
|---|---|---|
| 注入载体 | 合成 tool_call 对（assistant tool_use + user tool_result） | 不动 system prompt 与用户原文；未来启用 prompt cache 时 system 前缀稳定；TUI 渲染为工具卡片，召回透明可见；贴合 ReAct 循环结构（用户提的方案，优于动态 system 层与拼接 user 消息） |
| 注入位置 | 当前用户消息**之后** | 保证角色严格交替（U→A→U），规避连续 user 消息在 deepseek 兼容端点的未验证行为；语义为"回答前主动查记忆" |
| 历史累积控制 | 每轮剪除旧对、注入新对 | 任意时刻最多一对，token 不累积；内容始终反映当轮查询 |
| 注入挂点 | core 新增 `AgentConfig.onTurnStart` 可选回调 | 现有 `before:agentLoop` hook 在 `addUserMessage` 之前触发，拿不到所需时机；回调风格与 `eventBus` 一致，core 不涉及记忆逻辑 |
| side query 输入 | 仅当前用户消息（不带对话历史） | YAGNI：指代消歧（"那第二个呢？"）属少数场景，主 Agent 仍可按 memory-guide 自行 Read 兜底；后续按需演进 |
| 选择清单来源 | 每轮读磁盘 MEMORY.md 索引 | 磁盘是真相源；会话内新写记忆下轮即可被选中 |
| 索引层 | 保留启动注入 + 每轮按需刷新 | 修复"启动时快照"缺口；内容未变不重写，零成本 |
| 问句处理 | 不做问句排除 | 与生产门槛相反：问句恰恰最需要召回 |
| 开关 | env var `LICODE_MEMORY_RECALL`，默认开 | LICode 无配置文件机制，与现有配置风格一致 |
| 真实工具注册 | 不注册 | API 不校验历史 tool_use 是否在工具表；模仿调用可由 executor 错误自愈；YAGNI |

---

## 6. 与 Phase 3/4 的衔接（预注）

- **Phase 4 反馈闭环**：spec §6.3 的"注入即计数"埋点位置即本设计的 `createMemoryRecallHandler`（select 返回处）。⚠️ **已识别的坑**：`recordUsage` 改写 frontmatter 会更新文件 mtime → Phase 1 的 `hasChangesSince(loopStartedAt)` 会误判"主 Agent 已写"→ 后台提取被永久跳过。Phase 4 设计必须处理（候选：计数写入后 `utimes` 恢复 mtime；或主 Agent 写入检测改为内容 hash；或 mtime 检测排除仅 frontmatter 变化的文件）。
- **Phase 3 整理层（Dream）**：整理改写记忆文件后，下一轮 side query 与索引层刷新自动生效，无需额外接线；整理触发的 mtime 变化与 Phase 1 hook 的交互（误判"主 Agent 已写"一次，自愈）已在 Phase 1 风险清单记录。
- **side query 演进空间**（本期不做）：带最近对话上下文消歧；注册真实 `memory_recall` 工具供模型主动调用；按 token 预算动态调整注入文件数。

---

## 7. 参考

- [记忆系统重构设计](./2026-07-27-memory-system-redesign-design.md) §6.1（Phase 2 蓝图）
- [Phase 1 实现计划](./2026-07-27-memory-phase1-implementation-plan.md)
- 知乎文章《Claude Code 的 Memory》：https://zhuanlan.zhihu.com/p/2062191639829935034（本地副本 `~/Desktop/Claude Code的Memory.md`）——side query 方案蓝本

# 记忆系统 Phase 3 详细设计：整理层 Dream（程序编排四阶段 + 后台触发）

> **日期**：2026-07-29
> **状态**：已批准（grill-me 产出）
> **前置文档**：[记忆系统重构设计](./2026-07-27-memory-system-redesign-design.md) §6.2（本文档细化其 Phase 3 蓝图）
> **前置实施**：[Phase 1 生产层](./2026-07-27-memory-phase1-implementation-plan.md)（commit `70b21e6`）、[Phase 2 召回层](./2026-07-28-memory-phase2-design.md)（commit `1072b52`..`150585a`），均已落地
> **核心参考**：知乎文章《Claude Code 的 Memory》§整理（Auto Dream 四阶段 prompt）--本地副本 `~/Desktop/Claude Code的Memory.md`

---

## 1. 背景与现状

### 1.1 Phase 1/2 已交付能力

| 能力 | 实现 | 位置 |
|---|---|---|
| action 语义落盘 | `save(memory, action)`：create/update/append | `packages/core/src/memory/store.ts` |
| 索引自动重建 | `rebuildIndex()`，覆盖主 Agent 直接 Write 的文件 | `store.ts` |
| 主 Agent 写入检测 | `hasChangesSince(tsMs)` 按 mtime 扫 4 个类型目录 | `store.ts` |
| 提取门槛 | 冷却 5 分钟 + 问句排除 + 明确指令绕过冷却 | `extractor.ts` |
| 矛盾处理 | 提取 prompt 携带全部现有记忆正文，LLM 可输出 update | `extractor.ts` |
| 进程内互斥 | `MemoryExtractionState.running`，重叠直接跳过 | `hook.ts` |
| 召回 side query | `MemoryRecall.select` 按索引选 ≤5 条，合成 tool_call 对注入当轮 | `recall.ts` |
| 召回挂点 | `AgentConfig.onTurnStart`（`addUserMessage` 后、首次 LLM 调用前） | `loop.ts` |
| 主 Agent 指引层 | `memory-guide.md`（priority 4） | `conversation/templates/` |

### 1.2 整理层现状与差距

**现状**：记忆只增不改（除 Phase 1 提取偶发的 update/append），碎片化累积；无任何整理机制--无去重、无矛盾清理、无漂移修正、无遗忘。Phase 1 的矛盾处理只在"单轮提取时 LLM 恰好看到旧正文"时生效，跨会话累积的重复/漂移无人收敛。

**差距（对齐 spec §6.2 蓝图）**：

| 蓝本能力 | 现状 |
|---|---|
| 定期整理（≥24h + ≥5 sessions） | 无触发机制 |
| 四阶段（Orient/Gather/Consolidate/Prune） | 整个 Auto Dream 能力空白 |
| 回读 session 蒸馏新信号 | 无（提取只看当轮对话，不看历史 session） |
| 合并重复 / 漂移修正 | 无 |
| 索引体积约束 | 无 |

### 1.3 架构约束（调研已核实）

1. **CC 蓝本是 fork 带工具 agent**（Read/Grep 查 session、Write/Edit 改文件）；LICode 的 Phase 1/2 提取与召回都是**单次无工具 LLM 调用**。Phase 3 选 C 方案（程序编排多步无工具 LLM + 程序 grep），不 fork 受限 agent（避免搭建受限工具集 + 独立 agent loop + 权限沙箱，对个人 CLI 过重）。
2. **session 文件是 JSON**（非 JSONL）：`{ messages: Message[] }`，每条消息有 `role/content/timestamp`（`conversation/manager.ts` 的 `SessionFile`）。`ConversationManager.listSessions(dir)` 返回 summary 列表（含 `updatedAt`），按 `updatedAt` 倒序。
3. **消息 timestamp 已持久化**：核查 `provider.ts` 类型定义（UserMessage/AssistantMessage/ToolUseMessage/ToolResultMessage 均有 `timestamp`）+ 6 月 8 号旧 session 文件（2 条消息 2 个 timestamp），Phase 1 提取的 `shouldExtract`/`selectMessages` 已在用 `Date.parse(m.timestamp)`。按消息时间戳细筛**不需改存储格式**。
4. **eventBus 是 per-turn 的**：`hooks.ts` 每次 `handleSubmit` 新建 `createEventBus(...)`，pipeline.run 完即弃。Dream 跨多轮，**不能走 eventBus 传状态**，改走 `useState` setter（见 §2.7）。
5. **`after:agentLoop` hook 是 fire-and-forget**（`blocking: false`）：Phase 1 提取 hook 已验证此模式，Dream 同位置同模式，绝不阻塞用户。
6. **store 的 `delete(slug)` 是文件级**：unlink 整个 `.md` + `rebuildIndex()`（索引行一起没）。无段落级删除--段落矛盾走 `update` 重写正文。
7. **`.licode/memory/` 下非 type 子目录不会被扫**：`store.listAll`/`rebuildIndex` 只遍历 `user/feedback/project/reference` 四个目录，`.dream-backup/`、`.dream.state`、`.dream.lock` 以 `.` 前缀放在 memory 根目录，不污染索引。
8. **dist 构建是 CLI 生效前提**（沿用 Phase 1/2 约束）。

---

## 2. 详细设计

### 2.1 总体机制：程序编排多步无工具 LLM + 程序 grep（C 方案）

不 fork agent、不给 LLM 工具。**程序当导演，LLM 当顾问**：程序负责读现有记忆、grep session 历史、写记忆文件；LLM 只负责判断并输出结构化结果。四阶段对应 2-3 次无工具 LLM 调用 + 1 次程序 grep：

```
触发(after:agentLoop, fire-and-forget)
  │
  ├─ Orient（LLM 1 次）：程序读全部现有记忆喂 LLM -> 输出"怀疑清单"
  │     [{slug, keywords[], reason}]  哪些记忆可能漂移/重复/需查证
  │
  ├─ Gather（程序，不调 LLM）：按怀疑清单的 keywords
  │     去 session 新消息(timestamp>lastConsolidatedAt)里 grep -> 捞证据片段
  │
  ├─ Consolidate（LLM 1 次）：现有记忆 + 证据片段 + 怀疑清单喂 LLM
  │     -> 输出操作清单 [create/update/append/delete] -> 程序落盘
  │
  └─ Prune（程序 + LLM 0-1 次）：rebuildIndex -> 校验行数/大小
        超限则 LLM 精简索引描述
```

**为什么是 C 而非 A/B**：A（单次无工具 LLM 只看现有记忆）丢失 Gather 的"回读 session 找漂移证据"核心能力；B（fork 带工具 agent）最忠实 CC 但要搭受限工具集 + 独立 agent loop + 权限沙箱，对个人 CLI 过重。C 保留 grep session 能力（程序做 grep），不用完整 agent loop，测试性接近 extractor，且 spec"复用提取的 LLM 配置"措辞支持单次调用风格。

### 2.2 组件变更

| 组件 | 变更 | 文件 |
|---|---|---|
| **MemoryDream**（新） | 四阶段编排引擎 + 触发条件检查 + 锁，内聚于单文件 | `packages/core/src/memory/dream.ts` |
| **MemoryExtractor** | 无改动（Dream 复用其 LLM 调用风格与 parseResponse 防线思路，但独立实现 parseDreamResponse） | - |
| **MemoryStore** | 无改动（复用 save/load/delete/listAll/loadIndex/rebuildIndex） | - |
| **提取 hook** | 开头加"Dream running 则让位"检查 | `packages/core/src/memory/hook.ts` |
| **CLI 接线** | 创建 `MemoryDream`（与 extractor/recall 同 apiKey/baseUrl/model）；`after:agentLoop` 注册 Dream hook；共享 `dreamStateRef` 给提取 hook；`isDreaming` state + `setIsDreaming` 传入 | `packages/cli/src/hooks.ts` |
| **DreamIndicator**（新） | 底部"整理中"卡片，照抄 `WaitingIndicator` | `packages/cli/src/components/dream-indicator.tsx` |
| **app.tsx** | 消息流与输入框之间加 `{isDreaming && <DreamIndicator />}` | `packages/cli/src/app.tsx` |
| **core 导出** | `MemoryDream`、`createMemoryDreamHook`、`DreamState`、`createMemoryDreamState` | `packages/core/src/index.ts` |

`dream.ts` 内部结构：

```ts
export interface DreamConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;          // 与提取/召回同模型级别
  minIntervalMs?: number;  // 默认 24h
  minNewSessions?: number; // 默认 5
  timeoutMs?: number;      // 单次 LLM 调用超时，默认 30_000（复用 recall 的 withTimeout）
}

export interface DreamState {
  /** Epoch ms of the last *successful* consolidation. 0 = never. */
  lastConsolidatedAt: number;
  /** In-process mutex: true while a dream is in flight. */
  running: boolean;
}

export function createMemoryDreamState(): DreamState;

export class MemoryDream {
  constructor(config?: DreamConfig);
  /** 检查触发条件（不调 LLM）：≥minIntervalMs 且 ≥minNewSessions 个新 session。 */
  shouldDream(sessionsDir: string): Promise<boolean>;
  /** 跑四阶段整理。best-effort，永不 reject。 */
  dream(store: MemoryStore, sessionsDir: string): Promise<void>;
}

/**
 * 返回 after:agentLoop hook：检查 shouldDream -> 获锁 -> fire-and-forget dream()。
 * onStateChange 用于通知前端 isDreaming（开始/结束）。
 */
export function createMemoryDreamHook(deps: {
  dream: MemoryDream;
  store: MemoryStore;
  state: DreamState;
  sessionsDir: string;
  onStateChange?: (running: boolean) => void;
}): (event: PipelineEvent) => Promise<void>;
```

设计要点：

- **`shouldDream` 只读不调 LLM**：读 `.dream.state` 的 `lastConsolidatedAt` + `ConversationManager.listSessions(sessionsDir)` 计数 `updatedAt > lastConsolidatedAt` 的 session，零模型成本门槛（对齐 extractor 的 `shouldExtract` 哲学）。
- **`dream()` 永不 reject**：任何阶段失败 catch 后写 `.licode/logs/dream.log`，best-effort（对齐 extractor 的错误风格）。
- **`onStateChange` 是 TUI 通路**：Dream running 变化时调，前端 `setIsDreaming`（见 §2.7）。不走 eventBus。

### 2.3 触发与生命周期

挂载点 `after:agentLoop`（`agent-loop-complete` 事件，与提取 hook 同位置，`blocking: false`）。每次 agent loop 完成：

1. 非 `agent-loop-complete` -> return
2. `state.running` -> return（互斥，Dream 跨轮期间不重复触发）
3. `shouldDream(sessionsDir)` -> false 则 return（≥24h 且 ≥5 新 session 双门槛）
4. 获取文件锁 `.licode/memory/.dream.lock`（写 pid + 时间戳；若锁存在且未过期 -> return，防多进程/多 worktree 并发）
5. `state.running = true`；`onStateChange?.(true)`（前端显示"整理中"）
6. fire-and-forget 跑 `dream(store, sessionsDir)`（**不 await**，hook 立即返回，用户不阻塞）
7. `dream()` 完成：`state.lastConsolidatedAt = Date.now()`、写 `.dream.state`、删锁、`state.running = false`、`onStateChange?.(false)`
8. `dream()` 失败：**不更新** `lastConsolidatedAt`（下次能重试）、删锁、`state.running = false`、`onStateChange?.(false)`、写日志

**与 Phase 1 提取 hook 的协调（Q2③）**：提取 hook 开头加 `if (dreamState.running) return;`--Dream 跑时提取直接让位。这比 Phase 2 预注的"自愈式 mtime 误判"干净：Dream 期间提取不跑，不会因 Dream 写文件触发 `hasChangesSince` 误判。Dream 结束后下一轮提取可能因 Dream 改过的文件 mtime 误判"主 Agent 已写"一次（rebuildIndex + 跳过一轮），自愈可接受（Phase 1 风险清单已记录）。

**锁文件**：`.licode/memory/.dream.lock`，内容 `{pid, acquiredAt}`。获取时若存在且 `now - acquiredAt < 锁超时`（如 30 分钟，防僵尸锁）-> return；过期则覆盖获取。Dream 结束/失败均删锁。

**状态文件**：`.licode/memory/.dream.state`，JSON `{ lastConsolidatedAt: <epoch ms> }`。`shouldDream` 读它，`dream()` 成功后写它。

**running 标志健壮性**：`dream()` 用 `try/finally`，`finally` 里确保 `running=false` + 删锁 + `onStateChange(false)`，防 LLM 崩/超时导致标志卡死（卡死会让提取永久让位、Dream 永不重触发）。单次 LLM 调用复用 recall 的 `withTimeout`（`Promise.race`）降级。

### 2.4 四阶段数据流

**Orient（定向，LLM 1 次）**：
- 程序读 `store.listAll()`（全部记忆正文）+ `store.loadIndex()`，格式化为"现有记忆"区块（复用 extractor `buildPrompt` 的现有记忆格式：`### slug\nname/description/content`）
- 调 LLM，输出**怀疑清单**：`[{slug, keywords[], reason}]`
- 指令：审视现有记忆，找出可能漂移（与当前状态矛盾）、重复、需查证的点；每点给 2-5 个搜索关键词（用于 grep session）；无则 `[]`

**Gather（收集，程序，不调 LLM）**：
- session 级粗筛：`ConversationManager.listSessions(sessionsDir)` 过滤 `updatedAt > lastConsolidatedAt`
- 消息级细筛：粗筛中的 session，`ConversationManager.load(file)` 后只看 `Date.parse(m.timestamp) > lastConsolidatedAt` 的消息
- 按怀疑清单的 `keywords` 在消息文本内容里匹配（`includes`，大小写不敏感）
- 命中消息取它 + 相邻 1 条作上下文；每关键词最多 5 个片段；每片段截到 500 字
- tool_use/tool_result 消息的 content 是数组/JSON，提取其文本部分参与匹配（或跳过纯结构消息）
- 输出：证据片段集合（按 slug 分组）

**Consolidate（合并，LLM 1 次）**：
- 程序把"现有记忆（索引+正文）+ Gather 捞的证据片段 + 怀疑清单"喂 LLM
- LLM 输出**操作清单**：`[{action, slug, type, name, description, content?, reason?}]`
- 程序逐条落盘：
  - `create/update/append` -> `store.save(memory, action)`（复用 Phase 1 action 语义）
  - `delete` -> 备份后 `store.delete(slug)`（见 §2.6）
- 指令对齐 CC 蓝本 Phase 3：优先合并进已有文件、避免重复、相对日期转绝对、矛盾则 update 重写或 delete、遵守四分类与"What NOT to save"

**Prune（修剪，程序 + LLM 0-1 次）**：
- 程序 `store.rebuildIndex()`
- 读 `MEMORY.md`，检查行数 <200、大小 <25KB
- 超限：调 LLM 一次，给当前索引行，让它重写每条 `description` 为更短（≤150 字符），程序按新 description 重写各记忆文件 frontmatter + rebuildIndex（best-effort，失败则保留原索引 + 日志告警）
- 未超限：跳过 LLM

### 2.5 prompt 设计

#### 2.5.1 Orient 怀疑清单 prompt

```text
You are performing a dream - a reflective pass over the memory system.
Review the existing memories and identify what may need consolidation.

## Existing memories (index + full content)
{indexContent + 全部记忆正文，格式同 extractor.buildPrompt}

## Instructions
审视现有记忆，找出需要整理的点，输出 JSON 数组（无需整理则 []）：
[{"slug":"user/food-preferences","keywords":["红烧排骨","喜欢"],"reason":"可能已漂移，需查证"}]

Rules:
- slug 必须来自上面的现有记忆
- 每点给 2-5 个搜索关键词，用于在历史会话中检索证据
- 重点找：可能漂移（与当前状态矛盾）、重复主题、信息失效、相对日期待转换
- 只输出 JSON，不要解释
```

#### 2.5.2 Consolidate 操作清单 prompt

```text
You are performing a dream - consolidate the memory system based on evidence.

## Existing memories (index + full content)
{现有记忆}

## Suspicions from Orient
{怀疑清单}

## Evidence gathered from recent sessions
{Gather 捞的证据片段，按 slug 分组}

## Instructions
基于证据整理记忆，输出 JSON 数组（无改动则 []）：
[{"action":"create|update|append|delete","slug":"<type>/<kebab-case>","type":"user|feedback|project|reference","name":"简短名称","description":"一句话描述","content":"完整正文"}]

Rules:
- create：新主题；update：改写已有文件正文（slug 须匹配现有文件）；append：向已有文件补充新段落；delete：删除整条失效/被合并的记忆文件
- delete 项用 reason 字段说明删除理由（不需 content）
- 新信息与现有记忆矛盾时，用 update 重写或 delete 删除，禁止矛盾并存
- 优先把新信息合并进已有 topic 文件，避免创建重复文件
- 把"昨天""上周"等相对日期转换为绝对日期
- 遵守 user/feedback/project/reference 四分类与"What NOT to save"（不存代码模式、git 历史、调试方案、任务进度）
- 只使用上述证据中的内容；不要臆测
```

**解析防线**（`parseDreamResponse`，对齐 extractor `parseResponse` + recall `parseResponse` 风格）：提取 JSON（容错 markdown 围栏）-> 数组校验 -> action 枚举（含 delete）-> create/update/append 项要求 slug 以 `${type}/` 开头 + name/description/content；delete 项要求 slug 匹配现有文件 + reason；非法单条丢弃，其余照常。delete 的 slug 必须真实存在于 `store.listAll()`（防幻觉删除）。

### 2.6 delete 保护与备份

Phase 3 的 delete 是文件级真删（`store.delete`，不可恢复）。Dream 是 LLM 自动判断，误删需有退路。

**备份策略（只备份待删文件 + 索引）**：
- Consolidate 落盘 delete 操作**前**：把待删文件复制到 `.licode/memory/.dream-backup/<type>/<slug>.md`，同时存一份当前 `MEMORY.md` 到 `.dream-backup/MEMORY.md`
- `update/create/append` 不备份（文件还在，可再改）
- `.dream-backup/` 不在 4 个 type 目录里，`listAll`/`rebuildIndex` 不会扫到，不污染索引
- 保留策略：固定目录 `.dream-backup/`，每次 Dream 清空旧备份只留最近一次（更早的没意义，记忆已被后续改动覆盖）

**不自动回滚**：Dream 失败时不从备份恢复已删文件（best-effort，对齐 extractor 风格），只回滚 `lastConsolidatedAt`（下次重试）。备份纯作**手动退路**--事后发现误删，手动从 `.dream-backup/` 捞回（未来可加 `/memory restore` 命令，本期不做）。

### 2.7 TUI 透明性：底部"整理中"卡片

Dream 后台跑时在对话窗口底部显示"整理中"卡片，完成自动消失。**不复用 eventBus**（eventBus per-turn，Dream 跨轮），改走 `useState` setter：

```
hooks.ts:
  const [isDreaming, setIsDreaming] = useState(false);
  const dreamStateRef = useRef(createMemoryDreamState());
  // 创建 Dream hook 时传入 onStateChange: setIsDreaming
  // dreamStateRef.current 共享给提取 hook（让位检查）
  useConversation 返回 isDreaming

app.tsx（消息流与输入框之间，照抄现有条件指示器模式）:
  <ChatView messages={messages} />
  ...
  {isDreaming && <DreamIndicator />}
  <InputBox ... />

新组件 DreamIndicator.tsx（照抄 WaitingIndicator.tsx，~20 行）:
  isActive 驱动 spinner + "🌙 记忆整理中..."，isActive=false 时 return null
```

`useState` setter 在组件生命周期内持久有效，不受 eventBus 每轮重建影响。Dream `onStateChange(true/false)` -> `setIsDreaming` -> 卡片显示/消失。

### 2.8 错误处理

| 场景 | 行为 |
|---|---|
| 不满足触发条件 | `shouldDream` 返回 false，零 LLM 成本 |
| 锁竞争（多进程） | 获取锁失败 -> return，不排队 |
| Orient/Gather/Consolidate 任一 LLM 失败/超时 | catch -> 写 `.licode/logs/dream.log` -> 不更新 lastConsolidatedAt -> 下次重试 |
| 解析失败 / 全部操作非法 | 空操作列表 -> 跳到 Prune（仍 rebuildIndex） |
| delete 的 slug 不存在（幻觉） | 该条丢弃，不删 |
| session 文件损坏 | `ConversationManager.listSessions`/`load` 已逐文件 try/catch 跳过损坏文件 |
| `dream()` 抛异常 | `try/finally`：finally 确保 running=false + 删锁 + onStateChange(false) |
| Prune 超限但 LLM 精简失败 | 保留原索引 + 日志告警 |
| Dream 写文件触发提取 hook | Dream running 时提取让位（不跑）；Dream 结束后下轮提取可能误判"主 Agent 已写"一次，自愈 |

### 2.9 测试

| 测试 | 断言 |
|---|---|
| `shouldDream` 门槛 | <24h -> false；≥24h 但 <5 新 session -> false；≥24h 且 ≥5 新 session -> true；空 sessions 目录 -> false |
| `shouldDream` 新增口径 | 旧 session 重新对话（updatedAt 刷新）计入新 session；完全未动的旧 session 不计 |
| Orient | mock LLM 返回怀疑清单 -> 解析为 [{slug,keywords,reason}]；prompt 含全部现有记忆正文；非法 slug 过滤 |
| Gather | 只搜 timestamp>lastConsolidatedAt 的消息；命中消息 + 相邻 1 条；每关键词 ≤5 片段、每片段 ≤500 字；搜不到 -> 空片段 |
| Consolidate | mock LLM 返回操作清单 -> create/update/append 调 store.save(action)、delete 调 store.delete；delete 前 备份到 .dream-backup；delete 幻觉 slug 被丢弃 |
| Consolidate 矛盾处理 | 已有"喜欢红烧排骨" + 证据"不喜欢了" -> mock LLM 输出 update -> 落盘正文被改写 |
| Prune | rebuildIndex 后行数/大小超限 -> 调 LLM 精简 description；未超限 -> 不调 LLM |
| `dream()` 永不 reject | LLM throw / 超时 / 解析失败 -> resolves undefined + 写日志 |
| hook：触发 | shouldDream false -> 不调 dream；true -> fire-and-forget 调 dream（不阻塞） |
| hook：互斥 | running 时第二次触发 -> return |
| hook：锁 | 锁存在且未过期 -> return；过期 -> 覆盖获取 |
| hook：状态回调 | dream 开始 -> onStateChange(true)；结束/失败 -> onStateChange(false) |
| 提取 hook 让位 | dreamState.running -> 提取 hook return，不调 shouldExtract |
| running 健壮性 | dream throw -> finally 里 running=false + 删锁 |
| 回归 | 现有 memory 测试全部通过 |

---

## 3. 配置

| 项 | 值 |
|---|---|
| 整理间隔 | `minIntervalMs` 默认 24h（可注入，仅供测试） |
| 最小新 session 数 | `minNewSessions` 默认 5（可注入，仅供测试） |
| LLM 模型 | 与提取/召回一致--CLI 把同一组 `apiKey/baseUrl/model` 传给 `MemoryDream` |
| 单次 LLM 超时 | `timeoutMs` 默认 30_000（复用 recall 的 `withTimeout`） |
| 锁超时 | 30 分钟（防僵尸锁） |
| 开关 | `LICODE_MEMORY_DREAM=off` 关闭（对齐 recall 的 `LICODE_MEMORY_RECALL` 风格，逃生通道） |
| 索引约束 | <200 行 / <25KB / 每条一行 / 每行 ≤150 字符（蓝本 Phase 4） |

---

## 4. 验证方式（Phase 3 验收标准）

1. 准备 ≥5 个 session 且距上次整理 ≥24h -> 提问结束触发 Dream（TUI 底部出现"🌙 记忆整理中..."卡片）
2. Dream 跑期间继续提问 -> 对话不阻塞；提取 hook 让位（日志可见"dream running, skip extraction"）
3. 已有重复记忆（如 `user/editor` 与 `user/ide` 内容相近）-> Dream 后合并为一个，另一个被 delete 且备份到 `.dream-backup/`
4. 旧记忆"喜欢红烧排骨" + 新 session 里说"不喜欢了"-> Dream 后同文件正文被改写，无矛盾并存
5. 旧记忆含"昨天"相对日期 -> Dream 后转为绝对日期
6. Dream 完成后"整理中"卡片消失；`MEMORY.md` 索引 <200 行 / <25KB
7. Dream 失败（断网/无效 apiKey）-> 不阻塞、不更新 lastConsolidatedAt（下次能重试）、卡片消失、错误写 `.licode/logs/dream.log`
8. 误删恢复：从 `.dream-backup/` 手动捞回被删文件 + rebuildIndex -> 记忆恢复
9. `LICODE_MEMORY_DREAM=off` 启动 -> 完全不触发 Dream
10. 全部新旧测试通过

---

## 5. 设计决策记录

| 决策 | 选择 | 原因 |
|---|---|---|
| 执行模型 | C（程序编排多步无工具 LLM + 程序 grep） | 保留 Gather grep session 能力（A 丢失）；不引入受限 agent 沙箱（B 过重）；spec"复用提取 LLM 配置"支持单次调用风格 |
| 触发挂载点 | after:agentLoop + fire-and-forget | 复用现有 hook 接线与 LLM 配置；不阻塞用户；否决 idle timer（只降并行概率却加定时器复杂度） |
| 触发口径 | 自上次整理以来新增 ≥5 session（updatedAt） | 累计口径一旦破 5 永远满足，时间成唯一闸门，失去"攒够新信号才整理"语义 |
| Gather 范围 | session updatedAt 粗筛 + 消息 timestamp 细筛 | 只消化新信号，不重复整理老对话；旧 session 重新对话只搜其新消息 |
| 关键词来源 | Orient LLM 输出结构化怀疑清单 | LLM 给的词比程序从描述抽取准；程序据此 grep |
| 产物格式 | 复用 extractor JSON 操作数组 + delete | 一致性、不误删（delete 显式）、匹配 Orient->怀疑->针对性改的流程；否决全量目标态+diff（误删风险） |
| delete 粒度 | 文件级（store.delete） | store 无段落级删除；段落矛盾走 update 重写正文 |
| Phase 边界 | Phase 3=内容驱动真删；Phase 4=热度驱动归档 | 维度不同不重叠；Phase 3 不碰 usageCount/lastUsedAt |
| delete 保护 | 只备份待删文件+索引，不自动回滚 | delete 是唯一不可逆操作；备份作手动退路；否决全目录快照（用户优化）与事务回滚（过重） |
| TUI 透明性 | 底部"整理中"卡片，useState setter 通路 | 用户要可见性；eventBus per-turn 不适用跨轮 Dream；照抄 WaitingIndicator 模式 |
| Dream 期间提取 | 让位（running 标志） | 比"自愈式 mtime 误判"干净；Dream 是更全面整理，并行只互相踩 |
| 锁 | 进程内 running + 文件锁 | 单进程 CLI 用 running 防并发；文件锁防多进程/多 worktree；过期覆盖防僵尸 |

---

## 6. 与 Phase 4 的衔接（预注）

- **Phase 4 反馈闭环**（spec §6.3）：frontmatter 增加 `usageCount`/`lastUsedAt`，Phase 2 召回注入即计数；>30 天未用移入 `archive/` 归档（可恢复）；Dream 整理时复核归档决定。
- **Phase 3 不碰 `usageCount`/`lastUsedAt`**：内容驱动的 delete 与热度驱动的 archive 维度不同。Phase 4 实现"Dream 复核归档"时，在本设计的 Consolidate 阶段扩展（读取 `lastUsedAt` 判断归档候选），届时 Dream 四阶段骨架已就绪。
- **⚠️ Phase 4 已识别的坑**（Phase 2 预注）：`recordUsage` 改写 frontmatter 更新 mtime -> Phase 1 `hasChangesSince(loopStartedAt)` 误判"主 Agent 已写"-> 提取被永久跳过。Phase 3 的"Dream 期间提取让位"用 running 标志协调，**不依赖 mtime**，规避了该坑的 Dream 侧；但 Phase 4 的计数埋点仍需单独处理（候选：计数写入后 `utimes` 恢复 mtime；或 mtime 检测排除仅 frontmatter 变化的文件）。
- **Dream 改写记忆后**：下一轮 side query（`MemoryRecall.select`）与索引层刷新（`createMemoryRecallHandler` 每轮读磁盘）自动拿到整理后的记忆，无需额外接线（Phase 2 预注已记录）。

---

## 7. 参考

- [记忆系统重构设计](./2026-07-27-memory-system-redesign-design.md) §6.2（Phase 3 蓝图）
- [Phase 1 实现计划](./2026-07-27-memory-phase1-implementation-plan.md)
- [Phase 2 详细设计](./2026-07-28-memory-phase2-design.md)
- 知乎文章《Claude Code 的 Memory》：https://zhuanlan.zhihu.com/p/2062191639829935034（本地副本 `~/Desktop/Claude Code的Memory.md`）--Auto Dream 四阶段 prompt 蓝本

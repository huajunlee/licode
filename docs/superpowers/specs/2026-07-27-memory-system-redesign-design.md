# 记忆系统重构设计：动态生产 + 动态召回 + 整理 + 反馈闭环

> **日期**：2026-07-27
> **状态**：已批准（brainstorming 产出）
> **前置文档**：[记忆模块渐进式改进方案](../../guide/memory-improvement-plan.md)（Step 1-2 已完成，本文档取代其 Step 3 及后续规划）
> **核心参考**：知乎文章《Claude Code 的 Memory》（本地副本 `~/Desktop/Claude Code的Memory.md`）——基于 Claude Code 泄漏源码与 Codex 源码的记忆系统对比分析

---

## 1. 背景与动机

### 用户痛点

1. **记忆没有动态更新能力**：用户先说"我喜欢红烧排骨"，后说"不喜欢了"，系统不会主动修改记忆文件，直到用户主动提醒。根因是两层问题叠加：
   - "我不喜欢"不含触发关键词（"我喜欢"），`shouldExtract()` 关键词门槛直接漏检；
   - 即使提取，`store.save()` 只做"字符串包含则跳过、否则追加"的 naive 合并，LLM 输出的 `update` action 被 `extractor.ts` 完全忽略，矛盾信息永远并存。
2. **越积越乱**：没有任何整理机制——无去重、无矛盾清理、无漂移修正、无遗忘。
3. **希望系统对齐业界最佳实践**（Claude Code / Codex）。

### 参考文章的核心论断

- 记忆 = **生产**（筛选后写入）+ **召回**（选择注入上下文）+ **整理**（定期巩固，如 Claude Code Auto Dream）。
- Claude Code 与 Codex **都不用 RAG**：语义近似但实际无关的召回是 RAG 硬伤；个人记忆数据量小，**LLM Friendly Wiki + 小模型探索**优于向量检索。
- Claude Code 生产双路径：主 Agent 直接写 + 后台 Extract Agent 抽取，互相去重。
- Claude Code 召回新方案：side query 按查询相关性选 ≤5 个文件，正文直接注入，主 Agent 专注任务、记忆作旁路系统。
- Codex 反馈闭环：引用计数（usage_count / last_usage）驱动候选保留，30 天未用退出——热度遗忘。

### 现状评估（代码调研结论）

存储层（四类型、frontmatter、索引文件、按主题分文件）已对齐 Claude Code，**保留**。差距在：

| 层 | 现状 | 差距 |
|---|---|---|
| 生产 | 仅后台抽取单路径；关键词门槛漏检纠正/决策类；update 语义缺失 | 缺主 Agent 写入路径、矛盾解决、写入约束 |
| 召回 | 仅启动时注入 MEMORY.md 索引（一行描述） | 正文永远进不了上下文；主 Agent 不知记忆目录存在；无按查询动态选择 |
| 整理 | 无 | 整个 Auto Dream 能力空白 |
| 反馈 | `createdAt/updatedAt` 是死数据 | 无使用追踪、无遗忘，记忆永生 |

---

## 2. 总体架构（目标态）

不引入 RAG / 向量检索，全部基于文件系统的 LLM Wiki：

```
┌──────────────────────── 生产 ────────────────────────┐
│ 路径 1: 主 Agent 直接写                                │
│   system prompt 新增 memory 指引层（目录/类型/规范）     │
│   → 用已有 Write/Edit 工具直接写记忆文件                │
│ 路径 2: 后台抽取（after:agentLoop，fire-and-forget）    │
│   → 轻量门槛 + LLM 提取（现有 MemoryExtractor 升级）    │
│ 协调: 主 Agent 本轮写过记忆 → 跳过后台抽取（防重复）      │
├──────────────────────── 召回 ────────────────────────┤
│ 启动: MEMORY.md 索引注入 system prompt（保留现状）      │
│ 查询时: side query 选 ≤5 个相关记忆 → 正文注入当轮      │
│ 兜底: 主 Agent 按 prompt 指引自行 Read/Grep 记忆目录    │
├──────────────────────── 整理 ────────────────────────┤
│ Dream: ≥24h + ≥5 sessions 触发，四阶段整理，锁防并发    │
├──────────────────────── 反馈 ────────────────────────┤
│ 召回即计数: 被注入记忆的 usageCount/lastUsedAt 更新     │
│ 遗忘: 长期未用 → archive/ 归档，移出索引（可恢复）      │
└──────────────────────────────────────────────────────┘
```

**实施分四个阶段**（对应方案 A：生产层先行，记忆质量是下游一切的基础）：

- **Phase 1（本设计详细展开，首个实现目标）**：生产层修复
- **Phase 2**：召回层升级（蓝图见 §6.1，实现前另行细化）
- **Phase 3**：整理层 Dream（蓝图见 §6.2）
- **Phase 4**：反馈闭环（蓝图见 §6.3）

---

## 3. Phase 1 详细设计：生产层修复

### 3.1 组件变更

| 组件 | 变更 | 文件 |
|---|---|---|
| **MemoryStore** | `save()` 支持 `create` / `update` / `append` 三种 action 语义；新增 `rebuildIndex()` 公开方法；索引链接改相对路径 | `packages/core/src/memory/store.ts` |
| **MemoryExtractor** | 门槛重构（移除关键词白名单，改冷却+问句排除）；提取 prompt 升级（含现有记忆正文、矛盾处理指令、类型约束、禁存清单）；进程内互斥 | `packages/core/src/memory/extractor.ts` |
| **系统提示词** | 新增 `memory` 指引层（§3.3），教主 Agent 何时/如何/不写什么 | `packages/core/src/conversation/templates/memory.md`（新增） |
| **接线** | system prompt 装配新层；after:agentLoop 钩子增加"主 Agent 已写则跳过"与索引重建逻辑 | `packages/cli/src/hooks.ts`、`cli.ts` |

### 3.2 数据流

```
用户消息 → agent loop
  │        └─ 主 Agent 可随时用 Write/Edit 写 .licode/memory/<type>/<slug>.md
  │           （用户说"记住这个" → 立即写）
  ▼
after:agentLoop hook（fire-and-forget）
  1. 互斥锁：已有提取在跑 → 直接返回
  2. 索引重建：memory 目录 mtime 晚于上次重建 → MemoryStore.rebuildIndex()
     （覆盖主 Agent 直接 Write 绕过 store.save() 的情况）
  3. 主 Agent 本轮已写记忆（目录内有文件 mtime ≥ 本轮 agent loop 开始时间）→ 跳过后台抽取
  4. shouldExtract：
     - 用户明确指令（"记住"/"remember"）→ 立即触发（绕过冷却）
     - 本轮无新用户消息 / 全部新用户消息疑似问句（复用现有 isQuestionLike()）→ 跳过
     - 距上次提取 < 5 分钟（同会话）→ 跳过
  5. extract：prompt = 指令 + 全部现有记忆（索引 + 正文）+ 最近对话
  6. LLM 输出 [{action, slug, type, name, description, content}]
     - action=create → 新建文件
     - action=update → 替换正文（保留 createdAt，刷新 updatedAt）
     - action=append → 追加（去重：已有相同段落则跳过）
  7. store 落盘 + 索引重建
```

设计要点说明：

- **提取 prompt 携带现有记忆正文而非仅索引**：LICode 的提取是单次无工具 LLM 调用（不同于 CC 的 fork agent 可自行 Read），LLM 必须看到旧记忆写了什么才能执行 update。个人记忆体量小（<25KB），全量塞入可行；若未来超限，按类型截断（user/feedback 优先）。
- **冷却窗口**替代关键词白名单：纠正类（"不对，以后都用 pnpm"）、决策类（"我们决定……"）不含关键词但记忆价值高；冷却（默认 5 分钟）+ 问句排除控制成本与噪声，明确指令（"记住"）始终立即触发。
- **action 语义真正落地**是"红烧排骨问题"的核心修复：LLM 看到"我不喜欢吃红烧排骨了"且 prompt 中有旧的 food-preferences 正文时，被指示输出 `update` 重写该文件，以最新信息为准。

### 3.3 提示词设计（以文章中的 Claude Code prompt 为蓝本）

#### 3.3.1 主 Agent 记忆指引层（新增 system prompt layer）

> 蓝本：文章 §生产 中 `loadMemoryPrompt()` 的 auto memory prompt。
> 与 CC 的差异：LICode 的 MEMORY.md 索引由 store 自动重建，因此指引中**不要求主 Agent 手动维护索引**（CC 要求两步写入）。

```markdown
# Memory

你有一个持久的、基于文件的记忆系统，位于 `<cwd>/.licode/memory/`。
该目录已存在——直接用 Write 工具写入（不要运行 mkdir 或检查其存在性）。

你应该随时间积累这个记忆系统，让未来的会话能够完整了解：
- 用户是谁
- 用户希望如何协作
- 哪些行为应该避免或重复
- 工作背后的上下文

如果用户明确要求你记住某件事，立即保存。
如果用户要求你忘记某件事，找到并删除相关条目。

## 记忆类型

- **user** — 用户角色、经验、偏好、目标
- **feedback** — 用户对协作方式的纠正或确认。
  只记录用户明确纠正过的行为、或用户确认过的非显然做法；
  必须包含规则本身、原因（**Why:**）和适用范围（**How to apply:**）
- **project** — 无法从代码/git 推导出的项目背景、决策、截止日期
- **reference** — 外部系统、看板、频道等入口

## 不要保存的内容

- 代码模式、约定、架构、文件路径或项目结构
- git 历史和最近的代码变更
- 调试解决方案和修复配方
- 已在项目文档中记录的内容
- 当前任务进度和临时会话状态

## 如何保存

用 Write 工具写入 `.licode/memory/<type>/<slug>.md`：

---
name: {{简短名称}}
description: {{一句话描述，用于相关性选择}}
type: {{user|feedback|project|reference}}
createdAt: {{ISO 时间}}
updatedAt: {{ISO 时间}}
---

{{记忆正文}}

- 按主题组织，而非按时间；一个主题一个文件
- 创建前先用 Read 检查同主题文件是否存在——更新它，而非新建重复文件
- 新信息与旧记忆矛盾时，直接改写旧文件，以最新信息为准
- 把"昨天""上周"等相对日期转换为绝对日期
- MEMORY.md 索引由系统自动重建，无需手动维护

## 使用记忆时

- 索引（MEMORY.md）已注入你的上下文；需要正文时用 Read 读取对应文件
- 记忆可能过期：涉及文件路径、函数、命令时，先对照当前代码/git 状态验证
```

#### 3.3.2 后台提取 prompt（升级版）

> 蓝本：文章的 Extract Agent prompt（"只使用最近 N 条消息""更新而非重复"）+ auto memory prompt 的类型约束与禁存清单。

```text
Analyze the most recent conversation messages and update the persistent memory system.

## Existing memories (index + full content)
{indexContent 与全部记忆正文}

## Recent conversation
{formatMessages(最近对话)}

## Instructions

从对话中识别值得跨会话保存的信息，输出 JSON 数组（无新信息则输出 []）：
[{"action":"create|update|append","slug":"<type>/<kebab-case>","type":"user|feedback|project|reference","name":"简短名称","description":"一句话描述","content":"完整正文"}]

Rules:
- create：新主题；update：改写已有文件正文（slug 必须匹配现有文件）；append：向已有文件补充新段落
- 新信息与现有记忆矛盾时，必须用 update 重写，以最新信息为准——禁止让矛盾并存
- feedback 类型只记录用户明确纠正过的行为或确认过的非显然做法，content 中必须包含规则、原因（Why:）和适用范围（How to apply:）
- 不要保存：代码模式与架构、git 历史、调试方案、当前任务进度、一次性问答、琐碎闲聊
- 用户在提问而非陈述事实时，跳过
- 把相对日期（"昨天""上周"）转换为绝对日期
- 只使用上述最近对话中的内容；不要臆测或补充对话中不存在的信息
```

与 CC 提取 prompt 的对应关系：「检查清单→更新而非重复」→ Rules 第 2 条；「只使用最近 N 条消息」→ 末条；「feedback 约束」→ 第 3 条。

### 3.4 错误处理

- **提取失败**：沿用现状——best-effort，stderr + `.licode/logs/extraction-errors.log`，永不阻塞用户。
- **LLM 输出非法**：JSON 解析失败 → 空数组；单条缺字段 / type 非法 / slug 不含类型前缀 → 丢弃该条，其余照常落盘。
- **主 Agent 写出格式不佳的记忆文件**：`store.parse()` 已有兜底（无 frontmatter 时整段视为 content）；索引重建时逐文件容错，单个坏文件不影响整体。
- **并发**：fire-and-forget 下两轮提取可能重叠 → 进程内互斥锁，同一时刻只允许一个提取运行，重叠请求直接跳过（不排队）。
- **记忆内容的信任级别**：记忆文件会进入后续会话上下文。Phase 1 不额外做注入防护，沿用现状的威胁模型（本地单用户、记忆由本机产生）；若未来支持导入外部记忆，再评估"记忆是信息而非指令"的 prompt 强化。

### 3.5 测试

| 测试 | 断言 |
|---|---|
| store: update 语义 | 替换正文、保留 createdAt、刷新 updatedAt、索引同步 |
| store: append 去重 | 相同段落不重复追加 |
| store: rebuildIndex | 主 Agent 直接 Write 的文件（未经 save()）被正确索引入 MEMORY.md |
| extractor: 门槛 | "不对，我以后都用 pnpm"（无关键词）→ 触发；纯问句 → 跳过；冷却窗口内 → 跳过；"记住这个" → 绕过冷却立即触发 |
| extractor: 矛盾处理 | 已有"喜欢红烧排骨"记忆 + 对话"我不喜欢红烧排骨了" → mock LLM 验证 prompt 中含旧正文；（LLM 集成测试打标可选）验证 update 落盘后正文不含"喜欢红烧排骨" |
| extractor: 互斥 | 并发触发两次 extract，第二次直接跳过 |
| hook: 主 Agent 已写跳过 | 本轮 memory 目录有文件变更 → 不调用 LLM |
| 回归 | 现有 memory 测试全部通过 |

---

## 4. 验证方式（Phase 1 验收标准）

1. 对 LICode 说"我喜欢红烧排骨" → 生成 user 记忆；再说"我其实不喜欢吃红烧排骨了" → **同一文件正文被改写**，不存在"喜欢/不喜欢"并存
2. 说"不对，我以后都用 pnpm 装依赖" → 自动生成 feedback 记忆，含 Why/How to apply
3. 问"现在几点了？" → 不触发提取
4. 连续闲聊 5 分钟内 → 最多提取一次；说"记住：我的编辑器是 Neovim" → 立即触发
5. 主 Agent 当轮已写记忆（用户明确说"记住"时）→ 后台抽取跳过（日志可见）
6. 主 Agent 直接 Write 的记忆文件 → 本轮结束后 MEMORY.md 索引自动包含它
7. 全部新旧测试通过

---

## 5. 设计决策记录

| 决策 | 选择 | 原因 |
|---|---|---|
| 检索技术 | 不用 RAG/向量 | 参考文章核心论断：个人记忆量小，LLM Wiki + 小模型探索优于向量召回 |
| 门槛方案 | 冷却+问句排除，移除关键词白名单 | 关键词漏检纠正/决策类（用户核心痛点）；冷却控制成本 |
| 提取上下文 | prompt 携带全部现有记忆正文 | 单次无工具调用下，LLM 必须看到旧正文才能 update；记忆体量小可承受 |
| 主 Agent 写入 | 复用已有 Write/Edit 工具 + prompt 指引 | 与 CC 一致；无需新工具 |
| 索引维护 | store 自动重建（mtime 检测覆盖直接 Write） | 降低主 Agent 负担；CC 的手动两步在 LICode 已有自动索引机制下无必要 |
| 实施切分 | 四阶段，Phase 1 先行 | 记忆质量是下游基础；每阶段独立可验证可回退 |
| 并发控制 | 进程内互斥，重叠跳过 | 单进程 CLI，无需 Codex 式 lease/lock 重量级方案 |

---

## 6. Phase 2-4 蓝图（实现前另行细化）

### 6.1 Phase 2：召回层升级

- **Step a（零模型成本）**：§3.3.1 指引层已包含"需要正文时用 Read 读取对应文件"（Phase 1 落地），主 Agent 可按索引自行深入——对齐 CC 旧方案。
- **Step b（side query）**：用户消息进入时，小模型（沿用提取所用模型级别）根据 MEMORY.md 索引的 frontmatter 清单选择 ≤5 个相关记忆文件，正文作为 attachment 注入当轮上下文——对齐 CC 新方案。可配置开关；side query 失败时降级为仅索引。
- 本会话新写入的记忆当轮即可被 side query 选中（消除"下次会话才可见"）。

### 6.2 Phase 3：整理层（Dream）

> 蓝本：文章的 Auto Dream 四阶段 prompt（Orient → Gather → Consolidate → Prune）。

- 触发：距上次整理 ≥24h 且 `.licode/sessions/` 积累 ≥5 个 session；锁文件防并发；失败回滚锁时间。
- 四阶段：定向（读索引与现有文件）→ 收集（漂移的旧记忆优先；只在有明确怀疑时窄范围 grep session，禁止遍历全部历史）→ 合并（重复合并、相对日期转绝对、矛盾删改）→ 修剪（索引 <200 行 / <25KB / 每条一行）。
- 实现为后台任务，复用提取的 LLM 配置。

### 6.3 Phase 4：反馈闭环

- frontmatter 增加 `usageCount` / `lastUsedAt`；Phase 2 side query 的注入即计数（LICode 控制注入点，无需 Codex 的 citation 块解析）。
- >30 天未使用 → 移入 `archive/` 子目录、移出索引（可恢复）；Dream 整理时复核归档决定。

---

## 7. 参考

- 知乎文章《Claude Code 的 Memory》：https://zhuanlan.zhihu.com/p/2062191639829935034 （本地副本 `~/Desktop/Claude Code的Memory.md`）
- [记忆模块渐进式改进方案](../../guide/memory-improvement-plan.md)（Step 1-2）
- [Phase 4 工程设计](./2026-06-02-phase4-engineering-design.md) Section 6

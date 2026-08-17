# LICode

> 记忆与决策的第二大脑 Agent —— 一个运行在终端里的 AI 编程助手。

LICode 能读懂你的代码库、执行 Shell 命令、编辑文件，还会**记住你**：它跨会话保存你的偏好与项目背景，把口述日记沉淀为长期记忆和人物档案，帮你做有依据、知边界的决策。它像一个有超级执行力的结对编程伙伴，而不是需要逐行指导的代码生成器。

技术栈：TypeScript · Node.js（pnpm monorepo：`core` / `cli` / `spec-kit`）· Ink 终端界面 · Zod 参数校验 · Vitest 测试（严格 TDD）· Anthropic 兼容 API · MCP 协议扩展。

---

## 核心特性

| 能力 | 说明 |
|------|------|
| **ReAct Agent 引擎** | 推理-行动循环：思考 → 调工具 → 看结果 → 继续，直到回复；步数 / token / 时长三重上限防死循环 |
| **双通道事件架构** | Pipeline 洋葱模型负责请求编排，EventBus 负责流式刷 UI，两条通道互不阻塞 |
| **跨会话记忆** | 主动记住 + 后台自动提取，按需召回、无关不打扰；做梦整理 + 自动归档防堆积与矛盾 |
| **第二大脑日记** | `/diary` 口述日记 → 独立模型结构化解析 → 自动沉淀为记忆与人物档案，或留待人审 |
| **决策顾问** | 汇聚历史决定 / 事实 / 人物 / 日记做有依据的分析；证据不足坦诚降级，复杂决策先规划再反思收敛 |
| **长对话上下文管理** | 校准式 token 计数、按轮次边界压缩、git blob 恢复被压缩全文、>64KB 大输出落盘 |
| **可扩展体系** | 内置 6 工具 + MCP 协议 + Skills 技能包 + Hooks 生命周期钩子 + Slash 命令 |
| **三层安全** | 系统提示词安全规则 + 权限守卫弹窗确认 + macOS 沙箱（仅 macOS） |

---

## 快速开始

### 环境要求

- **Node.js** >= 20
- **包管理器**：pnpm（推荐）、npm 或 yarn
- **LLM API Key**：Anthropic Messages API 兼容端点（Anthropic 官方、DeepSeek 等均可；OpenAI 原生格式不直接兼容，需第三方代理）

### 安装

```bash
git clone https://github.com/huajunlee/licode.git
cd LICode

# 安装依赖
pnpm install

# 构建所有包
pnpm build

# 设置 API Key（必填）
export ANTHROPIC_API_KEY="sk-your-api-key-here"

# 可选：指定 API 地址（使用第三方兼容 API 时）
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
```

### 第一次对话

```bash
# 启动 LICode（默认模型 deepseek-chat）
pnpm start

# 指定模型（如 DeepSeek v4 pro，带 think 模式）
pnpm start -- --model deepseek-v4-pro
```

你会看到**欢迎页面**（历史会话列表），直接输入问题按 `Enter` 即可。LICode 会自动扫描项目文件、调用 LLM 理解意图、流式输出，并在必要时调用工具（读文件、搜代码、执行命令等）。

### 恢复之前的会话

```bash
pnpm start -- --session abc123        # 会话 ID 支持前缀匹配
```

---

## 功能总览

### 自主 Agent 引擎

LICode 的核心是 **ReAct（Reasoning + Acting）循环**：

```
用户输入 → 调大模型 → 流式出招（thinking / token / tool-use）
    → 有工具调用？执行工具并注入结果 → 继续循环
    → 否则返回文本响应
```

三重刹车防止失控：最大步数 50 步、token 预算 200K、超时 10 分钟，任一触发即终止并返回已有结果。

### 双通道事件架构

LICode 运行时有**两条独立的事件通道**：

- **通道 A · Pipeline**（请求编排）：洋葱模型中间件链，只过 `user-message` 一个事件，负责「预处理 → 跑循环 → 后处理」。
- **通道 B · EventBus**（流式 UI）：循环内每步 emit token / 推理 / 工具调用事件，实时刷新界面。

唯一的桥是 `createAgentLoopMiddleware` 把 eventBus 注入 AgentLoop——**pipeline 包住 loop，loop 驱动 eventBus**，请求处理与 UI 渲染完全解耦。

### 长对话上下文管理

- **校准式 token 计数**：char-class 启发式估算 + 用模型真实返回的 input tokens 在线校准，越用越准、后端无关。
- **按轮次边界压缩**：token 超阈值（默认 85%）时按 UserMessage 边界切轮，tool 调用对天然不被切断；must-keep（报错 / 写文件）/ important（模型判）/ recent（最近 2 轮）三层选择性保留。
- **git blob 恢复**：被压缩的 Write/Edit 全文用 `git hash-object` 写成 git blob，返回 hash 指针，需要时可精确取回；不产生 commit、同内容天然去重。
- **大输出落盘**：>64KB 的工具输出写入 `.licode/overflow/` + 指针 + 预览，全文不灌进上下文。

### 跨会话记忆

记忆系统从「只进不出的记事本」升级为**会更新、会召回、会整理、不打扰**的完整闭环：

- **四类记忆**：`user`（画像）/ `feedback`（协作纠正）/ `project`（项目背景）/ `reference`（外部引用），一条一文件，`MEMORY.md` 自动维护索引。
- **双路径生产**：你说「记住：…」→ 主 Agent 当场写入；日常对话 → 后台 LLM 自动提取（5 分钟冷却、问句排除、mtime 检测防重复）。
- **两阶段召回**：每轮开始时 side-query 小模型选 ≤5 条相关记忆注入（透明显示为 `memory_recall` 卡片）；主模型也可主动调 `memory_fetch` 取回正文。无关问题零召回零成本。
- **做梦整理（dream）**：后台定期审记忆 → grep 找证据 → 合并 / 改写 / 删除 → 重建索引；>30 天未用的自动归档（可恢复）、置顶永不归档。
- **矛盾自动消解**：新信息与旧记忆冲突时整体改写旧文件，以最新为准。

### 第二大脑：日记 · 人物 · 决策

- **结构化日记**：`/diary` 进入日记模式 → `/diary-end` 保存，独立模型把口述拆成事实 / 决定 / 情绪 / 人物 / 候选记忆五类字段，相对时间转绝对日期。
- **三层提升**：高价值候选自动晋升为长期记忆；专有人名自动沉淀为人物档案（与日记双向链接）；低置信度候选留待 `/diary-curate` 人审。
- **决策顾问**：`decide` 汇聚历史决定 / 事实 / 人物 / 近期日记给分析——证据充足给倾向性建议（B 式），证据不足坦诚降级、判断权交还用户（C 式），杜绝编造。`decide_plan` + `decide_reflect` 处理复杂决策：先规划，再由独立小模型隔离反思，最多两轮收敛。保存决策走两步确认，直写日记不污染记忆。

### 工具与扩展

| 体系 | 说明 |
|------|------|
| **内置工具** | Read / Write / Edit / Bash / Glob / Grep（6 基础）+ decide 等（6 第二大脑） |
| **MCP 协议** | `.licode/mcp/config.json` 配置服务端，工具自动注册为 `mcp__{server}__{tool}` |
| **Skills 技能包** | `.licode/skills/` 自定义领域专长 + 专属工具 |
| **Hooks 钩子** | `before:agentLoop` / `after:agentLoop` 生命周期执行 Shell 命令或 in-process 函数 |
| **Slash 命令** | `/help`、`/clear`、`/context`、`/memory`、`/diary`、`/subagent` 等 |

---

## 命令与快捷键

### CLI 启动参数

| 参数 | 说明 |
|------|------|
| `--session <id>` | 恢复指定会话 |
| `--model <name>` | 指定模型（默认 `deepseek-chat`） |
| `--base-url <url>` | LLM API 地址 |
| `--help`, `-h` | 显示帮助 |

### Slash 命令

| 命令 | 说明 |
|------|------|
| `/help` | 列出所有命令 |
| `/clear` | 清空当前对话历史 |
| `/context` | 显示模型、token、消息数、会话信息 |
| `/memory`、`/memory-list`、`/memory-add`、`/memory-delete` | 记忆管理 |
| `/memory archive / restore / pin / unpin` | 记忆归档 / 恢复 / 置顶 |
| `/diary`、`/diary-end` | 进入 / 结束日记模式 |
| `/diary-list`、`/diary-find`、`/diary-show`、`/diary-curate` | 日记查看与人审整理 |
| `/subagent` | 开关子 Agent 功能 |

### 常用快捷键

| 按键 | 功能 |
|------|------|
| `Enter` | 发送消息 |
| `Ctrl+↑` / `Ctrl+↓` | 在推理卡片间切换焦点 |
| `↑` / `↓`（输入框） | 回溯 / 前进输入历史 |
| `Ctrl+Q` | 返回欢迎页（会话列表） |
| `Ctrl+C` | 退出 LICode |

---

## 配置

| 环境变量 | 说明 | 必填 |
|----------|------|------|
| `ANTHROPIC_API_KEY` | API 密钥 | 是 |
| `ANTHROPIC_BASE_URL` | API 地址（第三方兼容 API 时设置） | 否 |
| `LICODE_MEMORY_RECALL` | 设为 `off` 关闭每轮记忆召回（退回仅索引模式） | 否 |
| `LICODE_DIARY` | 设为 `off` 关闭第二大脑日记捕获（默认开） | 否 |
| `LICODE_DIARY_MODEL` | 日记结构化提取 side 模型（默认 `deepseek-chat`） | 否 |
| `LICODE_DIARY_CURATE_MODEL` | 整理（curation）side 模型（默认同 `LICODE_DIARY_MODEL`） | 否 |

项目级配置文件：`.licode/mcp/config.json`（MCP 服务端）、`.licode/hooks.json`（生命周期钩子）、`.licode/skills/`（技能包）、`CLAUDE.md`（项目指令，注入 system prompt）。

---

## 架构分层

```
┌─────────────────────────────────────────────────────────┐
│ CLI 交互层      Ink/React 双视图（欢迎页 ↔ 聊天界面）      │
│ 事件管线层      Pipeline 洋葱模型（仅过 user-message）      │
│ 流式 UI 通道    EventBus（loop 每步 emit → 界面刷新）       │
│ Agent 引擎层    AgentLoop（ReAct + token 校准 + 压缩）      │
│ 工具执行层      内置 6 工具 + MCP + Skills + SubAgent       │
│ LLM 适配层      LLMProvider（Anthropic 兼容流式接口）        │
└─────────────────────────────────────────────────────────┘
```

详细信息（含组件时序图）见 [用户指南 · 架构原理](docs/guide/user-guide.md#架构原理)。

---

## 目录结构

LICode 会在你的项目里创建 `.licode/` 工作目录（建议加入 `.gitignore`）：

```
你的项目/
├── .licode/                    ← LICode 工作目录
│   ├── sessions/               ← 会话存档（JSON）
│   ├── memory/                 ← 跨会话记忆（四类型 + MEMORY.md 索引）
│   │   └── archive/            ← dream 自动归档区（可恢复）
│   ├── journal/                ← 第二大脑日记（按日期目录 + 可读文件名）
│   ├── people/                 ← 人物档案（中文文件名）
│   ├── overflow/               ← >64KB 工具输出落盘
│   ├── mcp/config.json         ← MCP 服务端配置
│   ├── hooks.json              ← 生命周期钩子配置
│   ├── skills/                 ← 项目级技能包
│   └── worktrees/              ← 子 Agent 的 Git 隔离工作区
├── specs/                      ← Spec 驱动开发（spec.md / tasks.md / checklist.md）
└── CLAUDE.md                   ← 项目指令（注入 system prompt）
```

---

## 开发

```bash
pnpm install     # 安装依赖
pnpm build       # 构建所有包
pnpm start       # 启动 LICode
pnpm test        # 运行测试（Vitest）
```

Monorepo 三包：

- `packages/core` — Agent 引擎、记忆、日记、上下文管理等核心逻辑
- `packages/cli` — 终端界面（Ink）与 CLI 接线
- `packages/spec-kit` — Spec 驱动开发（`spec init` / `list` / `validate`）

> 多智能体协作（SubAgent + Git Worktree 隔离）core 层已实现并通过单测；CLI 默认未接线，属可选扩展。

---

## 文档

- [用户指南（docs/guide/user-guide.md）](docs/guide/user-guide.md) — 从零到一，含入门教程、架构原理、命令与配置参考
- [场景 Recipes（docs/guide/recipes/）](docs/guide/recipes/) — 9 个可复现的实际场景：代码审查、调试 bug、加功能、MCP 配置、多智能体、记忆偏好、Hooks、Spec 驱动、自定义 SystemPrompt

---

## 许可

暂未添加 LICENSE（待补）。欢迎 Fork 与贡献。

# LICode 用户指南

> LICode 是一个运行在终端里的 AI 编程助手。它能读懂你的代码库、执行 Shell 命令、编辑文件，
> 还能调用外部工具和多智能体协作。本指南帮你从零开始，逐步掌握所有功能。

---

## 目录

- [快速开始](#快速开始)
- [入门教程](#入门教程)
- [架构原理](#架构原理)
- [命令参考](#命令参考)
- [快捷键参考](#快捷键参考)
- [配置参考](#配置参考)
- [内置工具参考](#内置工具参考)
- [场景 Recipes](#场景-recipes)
- [常见问题](#常见问题)

---

## 快速开始

### 环境要求

- **Node.js** >= 18
- **包管理器**：pnpm（推荐）、npm 或 yarn
- **LLM API Key**：支持 Anthropic 兼容 API（如 Anthropic、DeepSeek、OpenAI 等）

### 安装

```bash
# 克隆仓库
git clone https://github.com/your-org/LICode.git
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
# 启动 LICode
pnpm start
# 启动deepseek v4 pro（有think mode）
pnpm start -- --model deepseek-v4-pro
```

你会看到**欢迎页面**，显示历史会话列表。直接输入你的问题，按 Enter 开始新对话：

```
> 帮我看看这个项目里有哪些主要文件
```

LICode 会自动：
1. 扫描你的项目文件
2. 调用 LLM 理解你的意图
3. 在终端里流式输出回复
4. 必要时自动调用工具（读文件、搜索代码等）

### 恢复之前的会话

```bash
# 启动时指定会话 ID
pnpm start -- --session abc123

# 或者在欢迎页输入
> --session abc123
```

会话 ID 支持前缀匹配——输入前几个字符即可。

---

## 入门教程：你的第一个 LICode 项目

下面我们通过一个**完整的真实项目**来学习 LICode 的核心用法。假设你有一个 Express + TypeScript 后端项目，我们要用 LICode 给它添加"用户昵称修改"功能。

> **为什么选这个例子？** 它涵盖了真实开发的全流程：读代码 → 改数据库 → 写 API → 加校验 → 写测试 → 迭代修改。学完这一个例子，你就掌握了 LICode 80% 的日常用法。

---

### 第一步：让 LICode 理解你的项目

打开项目目录，启动 LICode，用自然语言告诉它你的项目长什么样：

```
> 这是一个 Express + TypeScript 后端项目，使用 Prisma 做 ORM，
  PostgreSQL 做数据库，Jest 做测试。
  项目入口是 src/index.ts，路由在 src/routes/ 下，
  数据库 schema 在 prisma/schema.prisma。
```

LICode 会自动用 `read` 和 `glob` 工具扫描项目结构、读取关键文件，建立对项目的理解：

```
🤔 正在了解项目结构...
   读取 package.json → 确认依赖：Express, Prisma, Jest
   读取 prisma/schema.prisma → 发现 User 模型：id, email, passwordHash
   读取 src/routes/ → 已有 auth.ts, posts.ts
   理解完成：Express + Prisma + PostgreSQL 项目
```

> 💡 **这背后发生了什么？** LICode 使用 **ReAct（推理-行动）循环**：先"思考"需要了解什么，再调用工具获取信息，拿到结果后决定下一步行动。这跟你接手新项目时的行为一模一样——先看 `package.json`，再看入口文件，最后看具体模块。

---

### 第二步：提出功能需求

```
> 帮我添加"修改用户昵称"功能：
  1. 在 User 模型里加 nickname 字段（可选，最长 20 字符）
  2. 创建 PATCH /api/user/nickname 路由
  3. 校验：昵称不能为空字符串，不能包含特殊字符
  4. 写单元测试和集成测试
```

LICode 不会一口气全做完，而是**分步思考、逐步执行**：

```
🤔 正在分析需求...
   需要 4 步完成：
   Step 1: 修改 Prisma schema，添加 nickname 字段
   Step 2: 运行 prisma migrate 创建数据库迁移
   Step 3: 创建路由和校验逻辑
   Step 4: 编写测试

   先从 Step 1 开始...
```

---

### 第三步：观察 LICode 逐步执行

每一步你都会看到对应的**工具调用卡片**，实时了解它在做什么：

**Step 1 — 修改数据库 Schema：**

```
┌──────────────────────────────────────────────┐
│ ✓ edit  修改 prisma/schema.prisma            │
│   model User 新增:                           │
│   + nickname String? @db.VarChar(20)         │
└──────────────────────────────────────────────┘
```

**Step 2 — 创建数据库迁移：**

```
┌──────────────────────────────────────────────┐
│ ⚙ bash  执行 npx prisma migrate dev         │
│   --name add-user-nickname                   │
│   ✓ 迁移文件已创建:                            │
│     prisma/migrations/20260724_add_nickname/  │
│   ✓ 数据库已同步                              │
└──────────────────────────────────────────────┘
```

**Step 3 — 编写路由代码：**

```
┌──────────────────────────────────────────────┐
│ ✓ write  创建 src/routes/user.ts             │
│   - PATCH /api/user/nickname                 │
│   - Zod 校验：非空，无特殊字符                 │
│   - 只允许修改自己的昵称                       │
└──────────────────────────────────────────────┘
┌──────────────────────────────────────────────┐
│ ✓ edit   修改 src/index.ts                   │
│   + app.use('/api/user', userRouter)         │
└──────────────────────────────────────────────┘
```

**Step 4 — 编写并运行测试：**

```
┌──────────────────────────────────────────────┐
│ ✓ write  创建 src/routes/__tests__/user.test.ts │
│   测试用例：                                   │
│   - 正常修改昵称                               │
│   - 空字符串返回 400                           │
│   - 特殊字符返回 400                           │
│   - 超长昵称返回 400                           │
│   - 未登录返回 401                             │
└──────────────────────────────────────────────┘
┌──────────────────────────────────────────────┐
│ ⚙ bash  执行 npx jest -- user.test.ts       │
│   PASS  src/routes/__tests__/user.test.ts    │
│   ✓ 正常修改昵称 (32ms)                       │
│   ✓ 空字符串返回 400 (8ms)                    │
│   ✓ 特殊字符返回 400 (6ms)                    │
│   ✓ 超长昵称返回 400 (5ms)                    │
│   ✓ 未登录返回 401 (7ms)                      │
│   Tests: 5 passed, 5 total                   │
└──────────────────────────────────────────────┘
```

---

### 第四步：修改和迭代

测试通过了，但你想调整一下逻辑——昵称应该允许中文。直接在对话中纠正：

```
> 昵称应该允许中文，把"不允许特殊字符"的校验改成
  "只允许中文、英文、数字和下划线"
```

LICode 会用 `edit` 精确替换 Zod schema 中的正则表达式，然后重新跑测试验证：

```
┌──────────────────────────────────────────────┐
│ ✓ edit   修改 src/routes/user.ts:15          │
│   regex: /^[一-鿿\w]+$/              │
└──────────────────────────────────────────────┘
┌──────────────────────────────────────────────┐
│ ⚙ bash   执行 npx jest -- user.test.ts       │
│   ✓ 中文昵称测试通过                          │
│   Tests: 6 passed, 6 total                   │
└──────────────────────────────────────────────┘
```

> 💡 **这就是 LICode 的核心工作流**：描述需求 → LICode 规划并执行 → 你审查结果 → 纠正细节 → LICode 修改并验证。它像一个有超级执行力的结对编程伙伴，而不是一个需要你逐行指导的代码生成器。

---

### 第五步：理解 LICode 的思考过程

当 LICode 执行复杂操作时，屏幕上方会出现**可折叠的推理卡片**（Thinking Accordion）：

| 操作 | 快捷键 | 效果 |
|------|--------|------|
| 切换焦点 | `Ctrl+↑` / `Ctrl+↓` | 在不同卡片间移动 |
| 展开/收起 | `Enter`（焦点在卡片时） | 查看完整推理内容 |

展开推理卡片可以看到 LICode 的完整思考链：

```
🤔 正在分析逻辑...（展开后）

  用户要求修改昵称校验规则。
  当前规则：z.string().regex(/^[a-zA-Z0-9_]+$/)
  新需求：允许中文
  技术方案：将正则改为 /^[一-鿿\w]+$/
  
  影响分析：
  - 需要修改 src/routes/user.ts 第 15 行
  - 需要新增中文昵称测试用例
  - 不影响其他模块
  
  决定：修改 regex + 新增测试
```

---

### 第六步：查看工具调用状态

LICode 调用工具时，会显示**工具调用卡片**，有 4 种状态：

```
⏳ 等待中    ┌─────────────────────────────────────┐
            │ ⏳ grep  搜索 "fetch" 匹配           │
            └─────────────────────────────────────┘

⚙ 运行中    ┌─────────────────────────────────────┐
            │ ⚙ bash  执行 npm test               │
            └─────────────────────────────────────┘

✓ 成功      ┌─────────────────────────────────────┐
            │ ✓ read  读取 src/app.ts             │
            │   120 行已读取                        │
            └─────────────────────────────────────┘

✗ 失败      ┌─────────────────────────────────────┐
            │ ✗ bash  执行 npm run deploy         │
            │   Error: connection refused          │
            └─────────────────────────────────────┘
```

---

### 第七步：使用 Slash 命令管理会话

在聊天中直接输入以 `/` 开头的命令：

| 命令 | 用途 | 示例场景 |
|------|------|---------|
| `/help` | 查看所有命令及用法 | 忘了某个命令怎么用 |
| `/context` | 查看模型、token 用量、消息数 | 对话很长，看看还剩多少 token |
| `/clear` | 清空对话历史 | 上个任务结束，开始新任务 |
| `/subagent` | 开关子 Agent 功能 | 需要并行处理多个独立任务 |
| `/memory` | 管理已存储的偏好 | 查看/删除之前记住的设置 |

---

### 🎯 学完这个教程，你已经能够：

| 能力 | 你在教程中做过的事 |
|------|-------------------|
| 让 LICode 读懂项目 | 描述项目结构，LICode 自动扫描验证 |
| 提出功能需求 | 4 步需求，LICode 自动拆解执行 |
| 读懂工具调用卡片 | 观察 edit → bash → write → test 全流程 |
| 迭代修改代码 | 纠正校验规则，LICode 精确修改并重测 |
| 审查推理过程 | 展开推理卡片，查看完整思考链 |
| 使用 Slash 命令 | /help、/context、/clear 管理会话 |

---

### 接下来学什么？

- **想了解 LICode 的内部原理？** → 继续阅读下方的 [架构原理](#架构原理)
- **想看更多实际场景？** → 跳到 [场景 Recipes](#场景-recipes)，每个 Recipe 都有可复现的完整示范
- **想配置自定义行为？** → 查看 [配置参考](#配置参考)，了解 CLAUDE.md、Skills、Hooks

---

## 架构原理

了解 LICode 的内部原理，可以帮助你更好地使用和信任它。

### 整体架构

```
┌──────────────────────────────────────────────────────┐
│                    CLI 交互层                          │
│  Ink TUI → App(欢迎页/聊天界面) → useConversation     │
└───────────────────────┬──────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────┐
│                  EventPipeline（事件管线）              │
│  洋葱模型中间件链：                                     │
│  token计数 → 上下文压缩 → 记忆注入 → Hooks → AgentLoop  │
└───────────────────────┬──────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────┐
│                  AgentLoop（Agent 引擎）               │
│  ReAct 循环：用户输入 → LLM推理 → 工具调用 → 结果注入   │
└─────────┬─────────────────────────┬──────────────────┘
          │                         │
┌─────────▼──────────┐   ┌─────────▼──────────────────┐
│   LLMProvider      │   │   ToolRegistry + Executor   │
│   流式调用大模型     │   │   注册/校验/执行工具          │
└────────────────────┘   └─────────────────────────────┘
```

**分层说明：**

| 层 | 职责 | 关键组件 |
|----|------|---------|
| CLI 交互层 | 用户输入输出、界面渲染 | Ink/React 组件、useConversation Hook |
| 事件管线层 | 事件分发与中间件处理 | EventPipeline（洋葱模型） |
| Agent 引擎层 | 决策循环与任务编排 | AgentLoop（ReAct） |
| 工具执行层 | 文件、命令、搜索操作 | 6 内置工具 + MCP + Skills |
| LLM 适配层 | 大模型调用与 Token 管理 | LLMProvider、流式响应 |

### 1. CLI 交互层

LICode 使用 **Ink**（React for CLI）渲染终端界面。核心是一个**双视图状态机**：

```
欢迎页（选择会话/新建）  ←→  聊天界面（对话/工具/推理）
      ↑ Ctrl+Q 返回
```

**核心 Hook — `useConversation`：**

初始化时加载 LLM Provider、工具注册表、会话管理器和扩展系统。每次用户提交输入：
1. 先检查是否为 `/` 命令 → 路由到 CommandRouter
2. 否则创建 EventPipeline，注入中间件链
3. 生成 `user-message` 事件 → AgentLoop 拦截处理

### 2. EventPipeline（事件管线）

EventPipeline 采用**洋葱模型（Onion Model）**组织中间件：

```
        ┌──────────────────────────────┐
        │   tokenCountingMiddleware    │  ← 最外层：统计 token
        │  ┌────────────────────────┐  │
        │  │  contextMiddleware     │  │  ← 上下文压缩
        │  │ ┌────────────────────┐ │  │
        │  │ │  memoryMiddleware  │ │  │  ← 记忆注入
        │  │ │ ┌────────────────┐ │ │  │
        │  │ │ │  hookMiddleware│ │ │  │  ← 用户钩子
        │  │ │ │ ┌────────────┐ │ │ │  │
        │  │ │ │ │ AgentLoop  │ │ │ │  │  ← 最内层：Agent
        │  │ │ │ └────────────┘ │ │ │  │
        │  │ │ └────────────────┘ │ │  │
        │  │ └────────────────────┘ │  │
        │  └────────────────────────┘  │
        └──────────────────────────────┘

事件流向：外 → 内 → 外
```

每个中间件都可以在事件进入时做前置处理，在 `next()` 返回后做后置处理。

### 3. AgentLoop（Agent 引擎）

AgentLoop 是 LICode 的核心决策发动机，实现 **ReAct（Reasoning + Acting）** 模式。

**ReAct 循环时序：**

```
用户: "帮我读一下 src/app.ts"
         │
         ▼
   ┌─────────────┐
   │ addUserMsg   │  ← 用户消息加入历史
   └──────┬──────┘
          │
          ▼
   ┌─────────────┐      ┌───────────────────┐
   │ buildMessages│ ───→ │ LLM.stream()      │
   │ toLLMTools() │      │ 流式生成回复        │
   └─────────────┘      └────────┬──────────┘
                                 │
                    ┌────────────┴───────────┐
                    │    流式 chunk 类型       │
                    ├────────┬───────────────┤
                    │thinking│  token  │tool-use│
                    │ 推理中  │ 输出文字 │ 要调工具│
                    └────────┴────────┴───┬───┘
                                          │
                         ┌────────────────┴────────────┐
                         │  有 tool-use chunk？         │
                         └──────┬──────────┬───────────┘
                              是│          │否
                               ▼           ▼
                    ┌──────────────┐  ┌───────────────┐
                    │ToolExecutor  │  │返回 text 响应   │
                    │并行执行工具    │  │finalize + save │
                    └──────┬───────┘  └───────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │结果注入对话    │
                    │addToolMessages│
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │继续循环 ──────┘
                    │(直到终止条件)
                    └──────────────┘
```

**三步终止保护：**

| 保护机制 | 默认值 | 触发后行为 |
|----------|--------|-----------|
| 最大步数（maxSteps） | 50 步 | 抛出 TerminationError，返回已有结果 |
| Token 预算（maxTokens） | 200,000 tokens | 同上 |
| 超时（maxTimeMs） | 10 分钟 | 同上 |

### 4. LLMProvider（大模型适配层）

LICode 通过 `LLMProvider` 接口抽象大模型调用，当前支持 Anthropic 兼容 API。

**流式响应的 5 种 chunk 类型：**

| chunk 类型 | 含义 | 前端表现 |
|-----------|------|---------|
| `thinking` | 模型推理过程 | ThinkingAccordion 实时展示 |
| `token` | 输出文字片段 | StreamRenderer 逐字渲染 |
| `tool-use` | 请求调用工具 | ToolCallCards 显示工具名和参数 |
| `stop` | 停止生成 | 返回最终 usage 统计 |
| `error` | 流中断 | UI 显示红色错误信息 |

### 5. ToolRegistry（工具注册表）

所有工具（内置、MCP、Skills）统一注册到 `ToolRegistry`。

**工具注册流程：**

```
ToolRegistry.register(tool)
    │
    ├── 1. 存入 Map<name, Tool>
    ├── 2. Zod schema → JSON Schema (缓存)
    └── 3. 提供给 LLM 作为 function definition

LLM 调用工具时：
    │
    ├── 1. ToolExecutor 按名称查找工具
    ├── 2. Zod safeParse 校验参数
    ├── 3. PermissionGuard 权限检查
    └── 4. tool.execute(params, context)
```

### 6. ToolExecutor（工具执行器）

执行器负责参数校验、权限检查、并行执行：

- **参数校验**：用 Zod schema 自动验证 LLM 传回的参数
- **权限检查**：工具标记 `requiresApproval: true` 时触发 PermissionGuard
- **并行执行**：多个 tool-use 调用 `executeParallel()` → `Promise.all` 并发执行

### 7. 内置工具（6 个）

| 工具 | 功能 | 适用场景 |
|------|------|---------|
| **read** | 按行读取文件，支持 offset/limit | 查看代码、配置文件 |
| **write** | 创建或覆盖文件 | 新建文件、更新内容 |
| **edit** | 精确字符串替换 | 修改函数名、修改变量 |
| **bash** | 执行 Shell 命令 | 构建、测试、git 操作 |
| **glob** | 文件名模式匹配 | 查找特定类型文件 |
| **grep** | 文件内容正则搜索 | 搜索函数调用、引用 |

### 8. ConversationManager（对话管理器）

管理完整的消息历史，每条消息有明确的角色：

```
Message 类型：
  ┌──────────┐
  │ system   │  ← 系统提示词（角色、安全规则、工具说明）
  ├──────────┤
  │ user     │  ← 用户输入
  ├──────────┤
  │assistant │  ← LLM 文本回复（含 token 用量）
  ├──────────┤
  │assistant │  ← LLM 工具调用请求（ToolUseBlock[]）
  ├──────────┤
  │ user     │  ← 工具执行结果（ToolResultBlock[]）
  └──────────┘
```

**核心机制：**

- **Token 估算**：用 `TokenCounter` 估算消息 token 数
- **自动裁剪**：`trimToBudget(maxTokens)` 保留最新的 user-assistant 消息对，丢弃旧的
- **持久化**：`save()/load()` 将对话保存为 `.licode/sessions/{id}.json`

### 9. SystemPrompt（系统提示词）

系统提示词采用**分层架构**，按优先级组装，受 token 预算约束：

```
优先级    层                类型      来源
  ─────────────────────────────────────────
   0    role（角色定义）     always    内置模板
   1    safety（安全规则）   always    内置模板
   8    memory（用户偏好）   按需      自动提取
  10    tool-use（工具说明）  按需     内置模板
  15    skills（技能描述）   按需      用户/项目配置
  动态  CLAUDE.md           按需      项目根目录
  动态  spec files           按需      spec-kit 加载
```

**组装策略：** `always: true` 的层始终包含，可选层按优先级依次填充，最后一个可选层可能被截断。

### 10. Token 管理

**TokenCounter** 估算文本和消息数组的 token 消耗。

**TokenBudget** 追踪用量：
- 设定 `maxTokens` 上限
- 当用量超过 80% 阈值时标记 "near limit"
- 超过上限时触发上下文压缩

**上下文压缩**（ContextCompressor）：
```
消息数超过 maxTokens 时：
  1. 保留最近 50% 预算的消息
  2. Summarizer 用 LLM 摘要旧消息
  3. 将摘要作为 assistant 消息插入历史开头
  4. 发出 context-compressed 事件
```

### 11. TerminationPolicy（终止策略）

防止 Agent 陷入无限循环的三重保护：

```
TerminationPolicy.check(currentTokens)
    │
    ├── steps >= maxSteps ?   → 抛出 "达到最大步数"
    ├── tokens >= maxTokens ? → 抛出 "Token 预算耗尽"
    └── elapsed >= maxTimeMs ? → 抛出 "超时"
```

默认值：步数 50、Token 200K、时间 10 分钟。

### 12. Slash 命令系统

CommandRouter 拦截 `/` 开头的输入并路由到对应命令处理器：

| 命令 | 功能 | 实现状态 |
|------|------|---------|
| `/help` | 列出所有可用命令 | ✅ |
| `/clear` | 清空对话历史 | ✅ |
| `/context` | 显示模型、token、消息数、会话 ID | ✅ |
| `/memory` | 记忆管理 | ⚠️ 占位 |
| `/subagent` | 开关子 Agent 支持 | ✅ |

### 13. MCP 协议（Model Context Protocol）

通过 MCP 协议接入外部工具服务：

```
MCPClientManager
    │
    ├── 1. 读取 .licode/mcp/config.json 配置
    ├── 2. 连接各 MCP Server（StdioTransport）
    ├── 3. 握手 → tools/list → 发现工具
    └── 4. 工具适配 → mcpToolToAdapter → ToolRegistry

工具命名：mcp__{server_name}__{tool_name}
```

**配置示例：**

```json
{
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-filesystem"]
    }
  }
}
```

### 14. Skills 系统

用户和项目可以自定义技能包，存放在 `.licode/skills/` 目录下：

```
.licode/skills/
  └── my-skill/
      └── skill.md       ← YAML frontmatter + Markdown 描述
          ---
          name: my-skill
          version: 1.0.0
          tools:
            - name: deploy
              description: 部署到测试环境
              parameters:
                - name: env
                  type: string
                  default: staging
          ---
          # 技能描述正文（注入为 system prompt 层）
```

**加载流程：**
1. SkillLoader 扫描用户目录（`~/.licode/skills/`）和项目目录（`.licode/skills/`）
2. 项目级 skill 覆盖用户级同名 skill
3. 技能描述注入为系统提示词层（priority 15）
4. 技能工具注册到 ToolRegistry，命名空间 `skill__{toolName}`

### 15. Hooks 系统

在 Agent 生命周期的关键节点执行用户定义的 Shell 命令：

```json
// .licode/hooks.json
{
  "hooks": [
    {
      "name": "log-conversation",
      "events": ["agent-loop-complete"],
      "command": "echo '对话完成' >> licode.log",
      "position": "after:agentLoop",
      "blocking": false
    }
  ]
}
```

**生命周期节点：**
- `before:agentLoop` — Agent 开始处理前
- `after:agentLoop` — Agent 处理完成后

Hook 可以设为 `blocking: true`（阻塞等待完成）或非阻塞（fire-and-forget）。

### 16. Safety（安全机制）

**三层安全防护：**

| 层 | 机制 | 作用 |
|----|------|------|
| 系统提示词 | 内置安全规则 | 禁止危险命令、保护敏感信息、确认破坏操作 |
| 权限守卫 | PermissionGuard | 工具标记 `requiresApproval` 时弹窗确认 |
| 沙箱 | macOS sandbox-exec | 限制命令的读/写/网络权限 |

**权限检查流程：**
1. 检查 PermissionRule 白名单 → 匹配则放行
2. 检查会话缓存 → 同一工具+输入已批准过则放行
3. 弹窗询问用户 → allow-once / allow-session / deny

**沙箱（仅 macOS）：**
```
默认：拒绝所有操作
  ├── 允许：进程执行
  ├── 允许：读取所有文件
  └── 限制：写入仅限 cwd 及其子目录
```

### 17. Memory（记忆系统）

自动记录你的偏好和习惯，跨会话生效：

```
用户说: "记住：我喜欢用 pnpm 而不是 npm"
    │
    ▼
memoryMiddleware 拦截 user-message
    │
    ▼
MemoryExtractor 匹配 "remember/prefer/like..."
    │
    ▼
MemoryStore 保存为 .md 文件（含 YAML frontmatter）
    │
    ▼
下次会话 → MemoryLoader → 注入 system prompt 层（priority 8）
```

### 18. 多智能体（Multi-Agent）

复杂任务可以拆解给子 Agent 执行：

```
父 Agent
    │
    ├── 调用 Agent 工具（agent-tool）
    │       │
    │       ├── SubAgentManager 创建子 Agent
    │       ├── WorktreeManager 创建 git worktree 隔离环境
    │       └── 子 Agent 独立执行 AgentLoop
    │
    └── 收集子 Agent 结果
```

**Git Worktree 隔离：**
```
.licode/worktrees/
  └── licode/{agent-name}/     ← 独立的工作树
      ├── 独立分支 licode/{agent-name}
      └── 与主仓库文件系统隔离
```

子 Agent 在隔离环境中修改文件，不会影响主工作区。

### 19. 会话与 Spec

**会话管理：**
- `SessionManager` — 会话的增删改查
- `recoverLatestSession` — 启动时自动恢复最近会话
- 会话文件：`.licode/sessions/{id}.json` — 完整 JSON 序列化

**Spec 模式：**
- `licode spec init` — 创建 spec.md / tasks.md / checklist.md
- `licode spec list` — 列出所有 spec 及其状态
- `licode spec validate` — 验证 spec 文件的完整性
- `loadCLAUDE / loadSpecFiles` — 自动加载项目指令和规格文件

---

## 产物与目录结构

使用 LICode 时，它会在你的项目里创建一系列文件和目录。了解每个文件和目录的作用，可以帮助你更好地管理和维护项目。

### 完整目录结构总览

```
你的项目/
├── .licode/                          ← LICode 工作目录（建议加入 .gitignore）
│   ├── sessions/                     ← 会话存档
│   │   ├── abc123-def456.json        ← 会话文件（完整 JSON 序列化）
│   │   └── def789-ghi012.json
│   ├── memory/                       ← 跨会话记忆
│   │   ├── prefer-pnpm.md            ← 每条记忆一个 .md 文件
│   │   └── code-style-2spaces.md
│   ├── mcp/
│   │   └── config.json               ← MCP 服务端配置
│   ├── hooks.json                    ← 生命周期钩子配置
│   ├── skills/                       ← 项目级技能包
│   │   └── go-review/
│   │       └── skill.md
│   ├── worktrees/                    ← 子 Agent 的 Git 隔离工作区
│   │   └── licode/
│   │       └── core-migration/       ← 每个子 Agent 一个目录
│   └── logs/                         ← Hook 输出日志（如果你配置了）
│       └── conversations.log
├── specs/                            ← Spec 驱动开发的规格文件
│   └── 用户通知功能/
│       ├── spec.md                   ← 功能规格说明
│       ├── tasks.md                  ← 任务拆解清单
│       └── checklist.md              ← 验收检查项
├── CLAUDE.md                         ← 项目指令文件（注入 system prompt）
└── package.json                      ← 你的项目文件（LICode 会修改）
```

### 各目录/文件详解

#### 1. `.licode/sessions/{id}.json` — 会话文件

**何时创建**：每次对话自动保存。

**内容**：完整的对话历史，包含所有消息、工具调用结果、token 用量统计。

```json
{
  "id": "abc123-def456",
  "createdAt": "2026-07-24T10:00:00Z",
  "updatedAt": "2026-07-24T11:30:00Z",
  "messages": [
    { "role": "user", "content": "帮我添加修改昵称功能" },
    { "role": "assistant", "content": "好的，让我先了解项目结构...",
      "toolUses": [{ "name": "read", "input": { "path": "package.json" } }] },
    { "role": "user", "toolResults": [...] },
    { "role": "assistant", "content": "已完成！创建了以下文件..." }
  ],
  "tokenUsage": { "input": 12400, "output": 3800 }
}
```

**如何恢复**：启动 LICode 时加 `--session abc123` 参数，或在欢迎页输入 `--session abc123`。

> ⚠️ 会话文件可能包含敏感信息（代码、API 响应等），建议将 `.licode/sessions/` 加入 `.gitignore`。

---

#### 2. `.licode/memory/{name}.md` — 记忆文件

**何时创建**：当你说"记住"、"我习惯"、"我喜欢"等关键词时，LICode 自动提取并存储。

**文件格式**：每个记忆一个 Markdown 文件，包含 YAML frontmatter：

```markdown
---
name: prefer-pnpm
description: 用户偏好使用 pnpm 作为包管理器
metadata:
  type: user
---

用户习惯用 pnpm 而不是 npm 来管理依赖。
**Why:** pnpm 更快且节省磁盘空间。
**How to apply:** 所有包管理命令使用 pnpm，而不是 npm 或 yarn。
```

**如何生效**：下次启动 LICode 时，所有记忆文件自动加载并注入 system prompt（priority 8），影响 LICode 的行为。

**如何删除**：直接删除对应的 `.md` 文件，或使用 `/memory` 命令管理。

---

#### 3. `.licode/mcp/config.json` — MCP 配置

**何时创建**：手动创建（LICode 不会自动生成此文件）。

**作用**：定义 LICode 可以连接的外部 MCP 服务端，每个服务端提供一组工具。

```json
{
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-filesystem", "/allowed/path"]
    }
  }
}
```

**加载时机**：LICode 启动时读取，连接所有 MCP 服务端，发现工具后注册到 ToolRegistry。

---

#### 4. `.licode/hooks.json` — 生命周期钩子

**何时创建**：手动创建。

**作用**：在 Agent 生命周期的关键节点（启动前、完成后）自动执行 Shell 命令。

**产物示例**：如果 Hook 配置了日志输出，日志文件会写入 `.licode/logs/` 目录。

---

#### 5. `.licode/skills/{skill-name}/skill.md` — 技能包

**何时创建**：手动创建。

**作用**：为 LICode 添加领域专长（如 Go 代码审查、部署脚本），每项技能可以附带专属工具。

**加载时机**：LICode 启动时扫描 `.licode/skills/`，注入为 system prompt 层（priority 15）。

---

#### 6. `.licode/worktrees/` — Git Worktree 隔离区

**何时创建**：当父 Agent 调用子 Agent 时自动创建。

**作用**：每个子 Agent 获得独立的 Git worktree，在隔离环境中修改文件，不影响主工作区。

```
.licode/worktrees/licode/
├── core-migration/        ← 子 Agent "core-migration" 的工作区
│   ├── packages/core/     ← 只包含该子 Agent 需要修改的文件
│   └── ...
└── cli-migration/         ← 子 Agent "cli-migration" 的工作区
    └── ...
```

**清理**：子 Agent 任务完成后，worktree 可以被合并（merge）或丢弃（discard）。

---

#### 7. `specs/{spec-name}/` — Spec 规格文件

**何时创建**：运行 `licode spec init <name>` 命令时自动创建。

**目录结构**：

```
specs/用户通知功能/
├── spec.md          ← 功能规格：概述、需求、技术约束、验收标准
├── tasks.md         ← 任务清单：后端/前端/测试的 checkbox 列表
└── checklist.md     ← 验收检查项：上线前必须通过的检查点
```

**如何生效**：LICode 启动时自动加载所有 spec 文件，注入 system prompt。在对话中说"按 spec 执行"，LICode 就会读取并遵循。

---

#### 8. `CLAUDE.md` — 项目指令文件

**何时创建**：手动创建于项目根目录。

**作用**：定义项目级的编码规范、技术栈、约定。LICode 启动时自动读取并注入 system prompt。

**与 Skills 的区别**：

| | CLAUDE.md | Skills |
|---|---|---|
| 层级 | 项目全局 | 可复用模块 |
| 内容 | 编码规范、技术栈、约定 | 领域专长 + 专属工具 |
| 工具 | 不附带工具 | 可附带 Zod 定义的专属工具 |
| 优先级 | 动态加载 | priority 15 |

---

#### 9. 各功能产物速查表

| 你做了什么 | 产出了什么 | 存放在哪里 |
|-----------|-----------|-----------|
| 启动 LICode 对话 | 会话 JSON 文件 | `.licode/sessions/{id}.json` |
| 说"记住我习惯 xxx" | 记忆 .md 文件 | `.licode/memory/{name}.md` |
| 配置 MCP 服务端 | 无新文件（已手动创建） | `.licode/mcp/config.json` |
| 配置 Hooks | Hook 日志文件（可选） | `.licode/logs/` (由 Hook 命令决定) |
| 创建 Skill | skill.md + 工具注册 | `.licode/skills/{name}/skill.md` |
| 使用子 Agent | Git worktree 目录 | `.licode/worktrees/licode/{name}/` |
| 运行 `licode spec init` | spec + tasks + checklist | `specs/{name}/` |
| 编写 CLAUDE.md | 无新文件（已手动创建） | `./CLAUDE.md` |
| LICode 修改了你的代码 | 修改后的源文件 | 你的项目源文件（如 `src/`） |
| LICode 运行了测试 | 终端输出（不保存文件） | 仅在对话中显示 |

---

## 命令参考

### CLI 启动参数

| 参数 | 说明 | 示例 |
|------|------|------|
| `--session <id>` | 恢复指定会话 | `licode --session abc123` |
| `--model <name>` | 指定模型 | `licode --model deepseek-v4-pro` |
| `--base-url <url>` | LLM API 地址 | `licode --base-url https://api.openai.com/v1` |
| `--help`, `-h` | 显示帮助 | `licode --help` |

### Slash 命令

| 命令 | 说明 |
|------|------|
| `/help` | 列出所有可用命令 |
| `/clear` | 清空当前对话历史 |
| `/context` | 显示 token 用量和会话信息 |
| `/memory` | 记忆管理（即将推出） |
| `/subagent` | 开关子 Agent 功能 |

### Spec 子命令

| 命令 | 说明 |
|------|------|
| `licode spec init [name]` | 创建新的 spec 文件 |
| `licode spec list` | 列出所有 spec 及状态 |
| `licode spec status` | 显示 spec 统计 |
| `licode spec validate <name>` | 验证指定 spec |

---

## 快捷键参考

### 欢迎页

| 按键 | 功能 |
|------|------|
| `↑` / `↓` | 选择历史会话 |
| `Enter` | 进入选中的会话（输入为空时） |
| 输入文字 + `Enter` | 新建会话 |

### 聊天界面

| 按键 | 功能 |
|------|------|
| `Enter` | 发送消息 |
| `Ctrl+↑` / `Ctrl+↓` | 在推理卡片间切换焦点 |
| `Enter`（焦点在卡片时） | 展开/收起推理内容 |
| `↑` / `↓`（输入框） | 回溯/前进输入历史 |
| `Ctrl+Q` | 返回欢迎页（会话列表） |
| `Ctrl+C` | 退出 LICode |

---

## 配置参考

### 环境变量

| 变量 | 说明 | 必填 |
|------|------|------|
| `ANTHROPIC_API_KEY` | API 密钥 | ✅ 是 |
| `ANTHROPIC_BASE_URL` | API 地址（使用第三方兼容 API 时设置） | 否 |

### 项目配置文件

| 文件 | 用途 |
|------|------|
| `.licode/mcp/config.json` | MCP 服务端配置 |
| `.licode/hooks.json` | 生命周期钩子 |
| `.licode/skills/` | 项目级技能包 |
| `CLAUDE.md` | 项目指令（注入 system prompt） |

### 会话文件

会话存储在 `.licode/sessions/` 目录下，每个会话一个 JSON 文件：
```
.licode/sessions/
  abc123-def456.json
  def789-ghi012.json
  ...
```

---

## 内置工具参考

### read — 读取文件

```
参数：path（文件路径）、offset（起始行）、limit（行数）
示例：read { path: "src/app.ts", offset: 10, limit: 50 }
```

### write — 写入文件

```
参数：path（文件路径）、content（内容）
示例：write { path: "src/utils.ts", content: "export const foo = 1;" }
```

### edit — 精确替换

```
参数：path（文件路径）、old_string（原字符串）、new_string（新字符串）、replace_all（是否全部替换）
示例：edit { path: "src/app.ts", old_string: "var x = 1", new_string: "const x = 1" }
```

### bash — 执行命令

```
参数：command（命令）、timeout（超时，默认 120s）
示例：bash { command: "npm test -- --grep 'login'" }
```
> ⚠️ Bash 工具需要权限确认，LICode 会弹窗询问是否允许执行。

### glob — 文件名搜索

```
参数：pattern（匹配模式，支持 * 和 **）
示例：glob { pattern: "src/**/*.test.ts" }
```

### grep — 内容搜索

```
参数：pattern（正则表达式）、path（搜索目录）、include（文件过滤）
示例：grep { pattern: "useState", path: "src/", include: "*.tsx" }
```

---

## 场景 Recipes

以下 9 个 Recipes 展示了 LICode 在实际开发中的典型用法。每个 Recipe 都是可复现的示范。

| Recipe | 场景 | 涉及功能 |
|--------|------|---------|
| [Recipe 1](recipes/code-review.md) | 审查代码改动 | Agent 对话 + read/edit + Thinking |
| [Recipe 2](recipes/debug-bug.md) | 调试一个 bug | ReAct 循环 + grep/bash + 推理 |
| [Recipe 3](recipes/add-feature.md) | 给项目加新功能 | write/edit + 多轮工具调用 |
| [Recipe 4](recipes/mcp-config.md) | 配置外部 MCP 工具 | MCP 协议 + ToolRegistry + 权限 |
| [Recipe 5](recipes/multi-agent.md) | 并行拆解大任务 | 多智能体 + SubAgent + Worktree |
| [Recipe 6](recipes/memory-preferences.md) | 跨会话记忆偏好 | Memory + MemoryExtractor + 会话恢复 |
| [Recipe 7](recipes/hooks-lifecycle.md) | 用 Hooks 自动记录日志 | Hooks 生命周期 + Shell 脚本 |
| [Recipe 8](recipes/spec-driven.md) | Spec 驱动开发 | spec-kit + init/list/validate |
| [Recipe 9](recipes/system-prompt.md) | 自定义 SystemPrompt | CLAUDE.md + Skills + 分层注入 |

---

## 常见问题

### 入门与使用

**Q: LICode 支持哪些模型？**

支持所有兼容 Anthropic Messages API 的模型。默认使用 `deepseek-v4-pro`，可通过 `--model` 参数或 `ANTHROPIC_BASE_URL` 环境变量切换到其他 Provider（如 Anthropic 官方 API、OpenAI 兼容 API 等）。

```bash
# 使用 Anthropic 官方 API
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
licode --model claude-sonnet-5-20251001

# 使用 DeepSeek
export ANTHROPIC_BASE_URL="https://api.deepseek.com"
licode --model deepseek-v4-pro
```

**Q: LICode 会偷偷修改我的文件吗？**

不会。LICode 只有在你的明确指令下才会修改文件。写操作前 LICode 会解释要做什么，`bash` 工具需要权限确认。同时内置安全规则禁止执行 `rm -rf`、`sudo` 等危险命令。如果你不确定，可以在 LICode 执行前要求它先说明计划。

**Q: LICode 和 Claude Code / Cursor / Copilot 有什么区别？**

| 特性 | LICode | Claude Code | Cursor | Copilot |
|------|--------|-------------|--------|---------|
| 运行环境 | 终端 CLI | 终端 CLI | IDE 插件 | IDE 插件 |
| 自主执行 | ✅ 全自动 | ✅ 全自动 | ⚠️ 需确认 | ❌ 仅补全 |
| 多 Agent | ✅ 原生支持 | ✅ | ❌ | ❌ |
| MCP 协议 | ✅ | ✅ | ✅ | ❌ |
| 开源 | ✅ | ❌ | ❌ | ❌ |
| 适合场景 | 自主开发、CI/CD | 日常编码 | 代码补全 | 代码补全 |

LICode 的定位是"能自主完成复杂开发任务的终端 AI 助手"，而不是代码补全工具。

### 会话与数据

**Q: 会话保存在哪里？文件越来越大怎么办？**

会话保存在 `.licode/sessions/` 目录下，每个会话一个 JSON 文件。LICode 内置了**上下文压缩**机制：当对话消息的 token 数超过限制时，自动将旧消息用 LLM 摘要压缩，只保留最近的消息和摘要。你也可以定期手动清理旧的会话文件。

**Q: 如何让 LICode 记住我的偏好？**

直接在对话中说"记住我喜欢用 pnpm 而不是 npm"，LICode 的 MemoryExtractor 会自动匹配关键词并存储。存储的文件在 `.licode/memory/` 下，下次会话自动生效。详见 [Recipe 6](recipes/memory-preferences.md)。

**Q: 会话数据包含敏感信息吗？如何保护？**

会话 JSON 文件包含完整对话历史，可能包含代码片段、文件路径等。建议：
1. 将 `.licode/sessions/` 加入 `.gitignore`（LICode 默认不会提交它们，但建议手动确认）
2. 不要在对话中粘贴 API Key、密码等敏感信息
3. 定期清理不需要的会话文件

### 工具与扩展

**Q: 能否让 LICode 调用外部 API 或工具？**

可以，有两种方式：
1. **MCP 协议**：在 `.licode/mcp/config.json` 中配置 MCP 服务端，接入外部工具服务。详见 [Recipe 4](recipes/mcp-config.md)。
2. **Skills 系统**：在 `.licode/skills/` 下创建技能包，定义专属工具和角色。详见 [Recipe 9](recipes/system-prompt.md)。

**Q: LICode 的工具会不会执行危险命令？**

LICode 有三层安全防护：
1. **系统提示词**：内置安全规则，禁止执行 `rm -rf`、`sudo`、`chmod 777` 等危险命令
2. **权限守卫**：`bash` 工具标记 `requiresApproval: true`，执行前弹窗确认
3. **macOS 沙箱**（仅 macOS）：限制命令只能写入项目目录

**Q: 多个 Agent 如何协作？会互相冲突吗？**

父 Agent 遇到复杂任务时调用子 Agent，每个子 Agent 在独立的 **Git Worktree** 中工作，文件系统完全隔离，互不干扰。子 Agent 完成后，父 Agent 收集结果。详见 [Recipe 5](recipes/multi-agent.md)。

### 调试与排错

**Q: 启动报错 "API key not found"？**

检查环境变量是否设置正确：

```bash
# 确认变量已设置
echo $ANTHROPIC_API_KEY

# 如果为空，重新设置
export ANTHROPIC_API_KEY="sk-your-api-key-here"
```

**Q: LLM 返回空响应或乱码？**

可能原因：
1. API Base URL 不正确（检查 `ANTHROPIC_BASE_URL` 是否拼写错误）
2. 模型名称不匹配（不同 Provider 的模型名称不同）
3. 网络问题（检查是否能访问 API 地址）

用 `/context` 命令可以查看当前使用的模型和 API 地址。

**Q: LICode 似乎"卡住"了，怎么办？**

1. 按 `Ctrl+C` 可以中断当前的 LLM 请求或工具执行
2. 按 `Ctrl+Q` 返回欢迎页，再重新进入会话
3. 如果完全无响应，关闭终端重新启动，用 `--session` 恢复之前的会话

**Q: LICode 修改了错误的文件，如何回滚？**

由于 LICode 的所有修改都在你的 Git 仓库中进行，使用标准的 Git 回滚即可：

```bash
git diff                    # 查看 LICode 改了什么
git checkout -- <file>      # 回滚单个文件
git stash                   # 暂存所有改动
```

建议在让 LICode 做大范围修改之前，先 `git commit` 保存当前状态。

**Q: Token 消耗太快，如何控制？**

1. 用 `/context` 命令监控 token 用量
2. 对话过长时用 `/clear` 清空历史，开启新话题
3. 复杂任务拆分成多个短会话
4. 使用 `CLAUDE.md` 将项目约定写清楚，避免 LICode 反复询问

---

> 📖 想了解某个特定场景？查看 [场景 Recipes](#场景-recipes)
> 🔧 想扩展 LICode？配置 `.licode/mcp/config.json` 或 `.licode/skills/`
> 🐛 遇到问题？在对话中直接告诉 LICode，它会帮你排查

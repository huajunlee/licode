# Phase 1: 核心对话引擎 — 设计文档

**日期**: 2026-06-01
**状态**: 已确认
**范围**: LICode Phase 1 — 基础对话能力

---

## 0. 项目愿景与设计哲学

### 0.1 LICode 是什么

LICode 是一个类 Claude Code 的 CLI Agent——在终端中运行的 AI 编程助手。它通过大语言模型理解用户意图，调用工具执行代码操作，最终帮助用户完成软件工程任务。

LICode 的核心价值主张是 **可控性**：与商业闭源的 Claude Code 不同，LICode 的每一层都是可审计、可定制、可替换的。用户可以理解它的 System Prompt 如何工作、Agent Loop 如何决策、权限如何守卫——而不是面对一个黑盒。

### 0.2 最终目标（6 个 Phase 全部完成后）

```
用户输入需求
    │
    ▼
LICode 解释意图，制定计划（Spec 开发模式）
    │
    ▼
Agent 循环执行：调用工具 → 读取文件 → 编辑代码 → 运行测试
    │
    ▼
多 Agent 并行协作：SubAgent 分发子任务，Worktree 隔离环境
    │
    ▼
产出可工作的代码 + 测试 + 文档，全程跨会话记忆持久化
```

LICode 不是一次性问答机器人。它是一个 **自主编程代理**，能够：

- **理解项目上下文**：读取 CLAUDE.md、代码结构、git 历史，构建项目心智模型
- **执行复杂任务**：多文件编辑、重构、测试修复——而非单次回复
- **遵守工程纪律**：Spec 先行、权限防御、Token 预算管控——而非无约束地消耗资源
- **与开发者协作**：透明地展示它在做什么、为什么这样做、接下来要做什么

### 0.3 全阶段架构蓝图

```
┌─────────────────────────────────────────────────────────────────┐
│                        @licode/cli (Ink)                         │
│                      终端 UI · 流式渲染 · 交互                    │
├─────────────────────────────────────────────────────────────────┤
│                        @licode/spec-kit                          │
│                 Spec 三件套 · CLAUDE.md · 进度追踪               │
├─────────────────────────────────────────────────────────────────┤
│                         @licode/core                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │
│  │   LLM    │ │  Agent   │ │Extensions│ │  Safety  │ │Multi-  │ │
│  │ Provider │ │  Loop    │ │MCP/Skill │ │ Context  │ │ Agent  │ │
│  │          │ │  Tools   │ │ Commands │ │ Memory   │ │Worktree│ │
│  │  Phase 1 │ │  Phase 2 │ │  Phase 3 │ │  Phase 4 │ │ Phase 5│ │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

每个 Phase 在前一个 Phase 之上构建，依赖关系严格线性：没有 Phase 1 的对话引擎，Phase 2 的 Agent Loop 就无处运行；没有 Phase 2 的 Tool 系统，Phase 3 的 MCP/Skill 就没有执行载体。

### 0.4 核心设计原则

以下是贯穿所有 Phase 的设计原则。每一个模块的设计都必须对号入座：

**原则 1：可审计（Auditability）**

LICode 不是一个黑盒。它的 System Prompt 是分层可读的 `.md` 模板文件，它的 Agent Loop 每一步都发出事件，它的 Token 预算决策是可追溯的。任何人都能读懂 LICode 为什么做出了某个决定。这意味着：模板文件而非硬编码字符串、事件流而非静默内部状态、日志记录而非事后猜测。

**原则 2：可替换（Composability over Monolith）**

每一个模块通过接口暴露，允许替换实现。LLMProvider 是接口，不是具体类——未来可以从 Anthropic 切换到 OpenAI 或本地模型。Tool 通过注册表管理，Skill 通过文件系统挂载。LICode 是乐高，不是雕塑。

**原则 3：边界清晰（Clear Boundaries）**

core 包不引入 React/Ink，不依赖任何终端渲染。core 产出数据结构，cli 消费数据结构。这个边界意味着：相同的 core 可以驱动 CLI（Ink）、Web UI（浏览器）、IDE 插件（VS Code/JetBrains），不需要修改任何业务逻辑。

**原则 4：渐进式构建（Progressive Construction）**

Phase 1 不预留 Phase 3 的代码，但预留 Phase 3 的接口。比如 `ChatRequest.extensions` 在 Phase 1 是透传的 `Record<string, unknown>`——Phase 3 给它类型，Phase 1 不定义它。每个 Phase 的交付物是独立可验证的，不是半成品。

**原则 5：默认安全（Secure by Default）**

每一层都假定输入是不可信的。权限检查在工具执行之前，而非之后。Token 预算在超限之前裁剪，而非超限之后报错。安全不是 Phase 4 才做的事——Phase 1 的 SystemPrompt 已经有安全约束层。

### 0.5 Phase 1 在全局中的位置

Phase 1 是整个 LICode 大厦的地基。它不实现 Agent 行为——只实现"和 LLM 对话"这件事。但它的设计决定了后续所有 Phase 的质量：

| 如果 Phase 1 的... | 做好了 | 做坏了 |
|---|---|---|
| LLMProvider 接口 | 加 OpenAI 只需一个新适配器 | 需要重写所有 LLM 调用代码 |
| EventPipeline | 所有后续能力通过中间件插入 | Hook/Skill 找不到挂载点 |
| SystemPrompt 分层 | Token 预算精确裁剪不重要的内容 | 要么超限报错，要么删掉关键指令 |
| 会话持久化 | Phase 5 的多 Agent 直接复用 | 每个 SubAgent 各自实现存储 |

**Phase 1 完成标志：**
- 用户在终端输入文字，LLM 流式返回回复
- 支持多轮对话，消息历史正确维护
- 会话保存为 JSON 文件，关闭终端后重新打开可恢复对话
- System Prompt 分层组装，可按 token 预算裁剪
- 事件管道中间件可注册和消费

---

## 1. 架构总览

Phase 1 实现 LICode 的基础对话能力，包含 3 个核心模块和 1 个 CLI 渲染层：

```
@licode/core (纯逻辑，零 UI 依赖)
├── llm/           # LLM Provider 适配层
├── conversation/  # 对话管理 & System Prompt 组装
└── events/        # 事件管道 & 中间件

@licode/cli (Ink 终端渲染层)
└── components/    # Ink UI 组件
```

**关键设计决策:**

| 决策 | 选择 |
|------|------|
| 技术栈 | TypeScript + Node.js, pnpm monorepo |
| CLI 框架 | Ink 5 (React for CLI) |
| LLM 策略 | 适配器模式 + Anthropic 优先 |
| System Prompt | 分层组装（永远层 + 可裁剪层） |
| 会话持久化 | JSON 文件（`.licode/sessions/<id>.json`） |
| 架构模式 | 事件管道（Event Pipeline） |

---

## 2. 目录结构

```
licode/
├── packages/
│   ├── core/                       # @licode/core
│   │   ├── src/
│   │   │   ├── llm/
│   │   │   │   ├── provider.ts     # LLMProvider 接口定义
│   │   │   │   ├── anthropic.ts    # AnthropicProvider 实现
│   │   │   │   ├── stream.ts       # SSE 流解析工具
│   │   │   │   └── token-counter.ts
│   │   │   ├── conversation/
│   │   │   │   ├── manager.ts      # ConversationManager
│   │   │   │   ├── system-prompt.ts # SystemPrompt 分层组装
│   │   │   │   └── templates/      # System Prompt 模板 (.md)
│   │   │   │       ├── role.md
│   │   │   │       ├── safety.md
│   │   │   │       └── tool-use.md
│   │   │   ├── events/
│   │   │   │   ├── types.ts        # PipelineEvent 类型
│   │   │   │   ├── pipeline.ts     # EventPipeline 中间件链
│   │   │   │   └── middleware/     # 内置中间件
│   │   │   │       ├── logging.ts
│   │   │   │       ├── token-count.ts
│   │   │   │       └── error-handler.ts
│   │   │   └── index.ts            # 公开导出
│   │   └── package.json
│   └── cli/                        # @licode/cli
│       ├── src/
│       │   ├── app.tsx             # Ink 根组件
│       │   ├── components/
│       │   │   ├── chat-view.tsx
│       │   │   ├── stream-renderer.tsx
│       │   │   ├── input-box.tsx
│       │   │   └── status-bar.tsx
│       │   ├── hooks.ts            # useConversation hook
│       │   └── commands.ts         # 内置 Slash Command
│       └── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── package.json
```

---

## 3. LLM Provider 模块

采用的llm供应商模式为 **C（适配器模式 + Anthropic 优先）**：用 TypeScript interface 定义好 Provider 契约，但 Phase 1 只实现AnthropicAdapter。这样接口一次到位，工作量可控，后续加 OpenAI 不会需要重构。后续如果要接入其他的llm，只需要编写另一个适配器即可。

### 3.1 接口定义 (`llm/provider.ts`)

```typescript
interface LLMProvider {
  readonly name: string;
  readonly maxContextTokens: number;

  chat(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<StreamChunk>;
  countTokens(messages: Message[]): number;
}

type Message = SystemMessage | UserMessage | AssistantMessage;

interface SystemMessage {
  role: "system";
  content: string;
}

interface UserMessage {
  role: "user";
  content: string;
  timestamp: string;
}

interface AssistantMessage {
  role: "assistant";
  content: string;
  usage?: TokenUsage;
  timestamp: string;
}

interface TokenUsage {
  input: number;
  output: number;
}

type StreamChunk =
  | { type: "token"; text: string; index: number }
  | { type: "stop"; stopReason: string; usage: TokenUsage }
  | { type: "error"; error: Error };

interface ChatRequest {
  messages: Message[];
  model: string;
  maxTokens?: number;
  temperature?: number;
  extensions?: Record<string, unknown>;
}

interface ChatResponse {
  content: string;
  usage: TokenUsage;
  stopReason: string;
}
```

### 3.2 AnthropicProvider (`llm/anthropic.ts`)

Phase 1 唯一实现。关键行为：

- `stream()` 返回 `AsyncIterable<StreamChunk>`，使用 `for await` 消费 Anthropic 的 SSE 流
- `toAnthropicParams()` 负责格式转换：从内部 `Message[]` 提取 `system` 字段，将 `UserMessage`/`AssistantMessage` 映射为 Anthropic Messages API 格式
- `extensions` 字段透传 Anthropic 特有参数（`thinking`, `cache_control` 等），Phase 3 前不定义具体类型

```typescript
class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly maxContextTokens = 200_000;

  private client: Anthropic;

  constructor(config: { apiKey: string; baseUrl?: string });

  async chat(req: ChatRequest): Promise<ChatResponse>;
  async *stream(req: ChatRequest): AsyncIterable<StreamChunk>;
  countTokens(messages: Message[]): number;

  private toAnthropicParams(req: ChatRequest): Anthropic.MessageCreateParams;
  private extractSystem(messages: Message[]): string;
  private toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[];
  private toStreamChunk(event: unknown): StreamChunk;
}
```

### 3.3 TokenCounter (`llm/token-counter.ts`)

```typescript
class TokenCounter {
  /** 估算文本 token 数（基于字符比例的保守估计） */
  estimate(text: string): number;
  /** 估算消息数组 token 数 */
  estimateMessages(messages: Message[]): number;
}
```

Phase 1 使用启发式估算（英文约 4 字符/token，中文约 1.5 字符/token），Phase 4 升级为精确计数。

---

## 4. Conversation 模块

**会话文件持久化（推荐）** — 每次对话自动保存到 session JSON文件（.licode/sessions/<id>.json），支持会话恢复、replay、中断续聊。消息数组 + 元数据（token 计数、时间戳、模型信息

### 4.1 ConversationManager (`conversation/manager.ts`)

```typescript
interface ConversationMetadata {
  title?: string;
  tags?: string[];
  model: string;
  createdAt: string;
  updatedAt: string;
}

class ConversationManager {
  readonly id: string;
  private messages: Message[];
  private systemPrompt: SystemPrompt;
  metadata: ConversationMetadata;

  constructor(config: {
    id?: string;
    model: string;
    systemPrompt?: SystemPrompt;
  });

  // 消息操作
  addUserMessage(content: string): void;
  appendToAssistantMessage(token: string): void;
  finalizeAssistantMessage(usage: TokenUsage): void;

  // 构造发给 LLM 的完整消息列表
  buildMessages(tokenBudget?: number): Message[];

  // 裁剪历史消息到指定 token 预算
  trimToBudget(maxTokens: number): void;

  // 持久化
  async save(filePath?: string): Promise<void>;
  static async load(filePath: string): Promise<ConversationManager>;

  // 统计
  getTokenCount(): number;
  getMessageCount(): number;
  getMessages(): ReadonlyArray<Message>;
}
```

**关键行为：**

- `addUserMessage()` 将 user 消息 append 到内部数组
- `appendToAssistantMessage()` 流式累积 assistant 回复文本
- `finalizeAssistantMessage()` 在流结束时固定消息内容，记录 usage
- `buildMessages()` 先调用 `systemPrompt.assemble(budget)` 获得 system 消息，再拼接历史
- `save()` 写入 `.licode/sessions/{id}.json`
- `trimToBudget()` 从最早的 assistant 消息对开始裁剪，保留 system + 最近 N 轮

### 4.2 SystemPrompt (`conversation/system-prompt.ts`)

系统提示词选择了分层组装（推荐） — System Prompt 拆为基础层（角色定义、安全约束，永远发送）+ 能力层（工具描述、技能包，按需注入）+ 上下文层（项目文件、CLAUDE.md、记忆，动态拼接）。按 token 预算灵活裁切

```typescript
interface SystemPromptLayer {
  name: string;       // 模板文件名
  priority: number;   // 越小越靠前
  always: boolean;    // true = 永远发送，不参与裁剪
  content: string;    // 模板内容
}

class SystemPrompt {
  private layers: SystemPromptLayer[] = [];

  addLayer(layer: SystemPromptLayer): void;
  removeLayer(name: string): void;

  /**
   * 按 token 预算裁剪并拼接最终 System Prompt
   *
   * 算法：
   * 1. 永远层（role, safety）优先保证
   * 2. 可裁剪层按 priority 升序排列
   * 3. 从高到低填入，直到接近 budget
   */
  assemble(budget: number): string;
}
```

**预置分层（Phase 1 默认）：**

| 层名 | Priority | Always | 内容 |
|------|----------|--------|------|
| `role` | 0 | true | Agent 角色定义、能力描述、行为约束 |
| `safety` | 1 | true | 安全规则、禁止行为、合规约束 |
| `tool-use` | 10 | false | Tool 使用说明（Phase 2 启用） |
| `context` | 20 | false | 项目上下文、CLAUDE.md 内容 |

### 4.3 会话文件格式

```json
{
  "id": "019a3b2c-4d5e-6f7g-8h9i-0j1k2l3m4n5o",
  "createdAt": "2026-06-01T10:30:00Z",
  "updatedAt": "2026-06-01T11:45:00Z",
  "model": "claude-sonnet-4-6",
  "totalTokens": 45200,
  "messageCount": 24,
  "systemPromptLayers": ["role", "safety"],
  "messages": [
    {
      "role": "user",
      "content": "帮我写一个 CLI agent",
      "timestamp": "2026-06-01T10:30:00Z"
    },
    {
      "role": "assistant",
      "content": "好的，让我来设计...",
      "usage": { "input": 1500, "output": 300 },
      "timestamp": "2026-06-01T10:30:15Z"
    }
  ],
  "metadata": {
    "title": "LICode Phase 1 design",
    "tags": ["design", "cli-agent"]
  }
}
```

---

## 5. Events 模块

事件模块选择的是 **A（事件管道）**：

 \- 中间件模式天然适配后续 Phase 的 Hook、MCP、Skill 扩展

 \- 事件作为通用语言，所有消费者（渲染器、日志、Hook）共享同一事件流

 \- Phase 2 的 Agent Loop 就是事件管道的循环

### 5.1 事件类型 (`events/types.ts`)

```typescript
type PipelineEvent =
  | { type: "user-message"; content: string }
  | { type: "llm-token"; text: string; index: number }
  | { type: "llm-response-complete"; usage: TokenUsage }
  | { type: "stream-complete"; messages: Message[] }
  | { type: "error"; error: Error; context: string };
```

### 5.2 EventPipeline (`events/pipeline.ts`)

```typescript
type Middleware = (
  event: PipelineEvent,
  next: () => Promise<void>
) => Promise<void>;

class EventPipeline {
  private middlewares: Middleware[] = [];

  use(mw: Middleware): this;
  async run(events: AsyncIterable<PipelineEvent>): Promise<void>;
}
```

中间件洋葱模型，按注册顺序执行。每个中间件可：
- 处理事件后调用 `next()` 传递给下一个中间件
- 拦截事件（不调用 `next()`）
- 转换事件（修改 event 后调用 `next()`）

**Phase 1 预置中间件：**

```
pipeline
  .use(loggingMiddleware)        // 记录所有事件到日志
  .use(tokenCountingMiddleware)  // 累计 token 使用量
  .use(rendererMiddleware)       // 输出到终端（来自 @licode/cli）
  .use(errorHandlerMiddleware);  // 统一错误处理
```

### 5.2.1 事件与中间件的设计意图

事件管道是 LICode 架构的脊柱。它承担三个角色：

**角色一：模块解耦边界**

core 不引入 React/Ink——但 CLI 渲染器需要知道什么时候输出 token、什么时候展示错误。事件流就是这条边界线：core 向管道中推送事件，cli 从管道中消费事件。两端互不知道对方的存在，只认识 `PipelineEvent` 类型。

```
@licode/core                    @licode/cli
    │                               │
    │  emit(llm-token)              │  on(llm-token) → StreamRenderer
    │  emit(tool-execute-start)     │  on(tool-execute-start) → ToolCallCard
    │  emit(error)                  │  on(error) → ErrorToast
    │                               │
    └────────── EventPipeline ──────┘
```

**角色二：扩展点**

后续 Phase 的能力通过中间件插入，不需要修改现有模块：

| Phase | 中间件 | 注册时机 |
|-------|--------|----------|
| Phase 2 | `agentLoopMiddleware` | 在 `logging` 之后，`renderer` 之前 |
| Phase 3 | `hookMiddleware` | 在所有中间件外侧（拦截所有事件） |
| Phase 4 | `permissionMiddleware` | 在 `agentLoop` 和工具执行之间 |
| Phase 5 | `subAgentMiddleware` | 与 `agentLoop` 平级，根据事件类型分流 |

一个中间件就是一个 `(event, next) => Promise<void>` 函数——它可以在事件到达下游之前拦截、转换、或补充事件，也可以选择不调用 `next()` 来终止传递。

**角色三：复杂度封装**

管道不关心中间件的复杂度。`loggingMiddleware`（~10 行）和 `agentLoopMiddleware`（~200 行，Phase 2）对管道来说长得一模一样。这让简单模块保持简单，复杂模块的复杂度被封装在自己的目录中。

### 5.3 完整对话时序

```
User → CLI          → ConversationManager        → LLMProvider → EventPipeline
│                     │                             │              │
│ 输入消息            │                             │              │
├─► addUserMessage()  │                             │              │
│   buildMessages()   │                             │              │
│   (assemble system) │                             │              │
│                     ├─ stream(messages) ────────► │              │
│                     │                             │              │
│                     │◄─ AsyncIterable<StreamChunk> │              │
│                     │                             │              │
│   for each chunk:   │                             │              │
│   emit llm-token ──────────────────────────────────────────────►
│   appendToAssistant │                             │              │
│                     │                             │              │
│   finalizeAssistant │                             │              │
│   save() to JSON ───► disk                        │              │
│                     │                             │              │
│   emit stream-complete ────────────────────────────────────────►
```

---

## 6. CLI 渲染层

CLI框架选择了Ink (React for CLI) — React 组件渲染到终端，声明式 UI，生态丰富（ink-text-input, ink-spinner 等）。Claude Code本身就用 Ink。适合构建丰富的交互体验

### 6.1 组件树

```
App (根组件, 持有 ConversationManager)
├── ChatView       # 已完成的对话消息（user/assistant 颜色区分）
├── StreamRenderer  # 当前流式消息，逐 token 渲染
├── StatusBar      # 模型名、token 用量、会话 ID
└── InputBox       # 多行输入框，Ctrl+D 发送
```

### 6.2 关键组件

**App** (`app.tsx`)
- 初始化 `ConversationManager` 实例
- 监听输入提交事件，启动对话流程
- 掌管 `EventPipeline` 生命周期

**StreamRenderer** (`stream-renderer.tsx`)
- 订阅 `llm-token` 事件，逐 token 追加文本
- 使用 Markdown 转义（marked → terminal ANSI）实现粗体/代码块/列表

**useConversation** (`hooks.ts`)
```typescript
function useConversation(config: {
  model?: string;
  sessionId?: string;
  apiKey: string;
}): {
  messages: Message[];
  streaming: string;
  isLoading: boolean;
  tokenCount: number;
  handleSubmit: (input: string) => Promise<void>;
};
```
React hook 封装 ConversationManager，桥接 core 状态到 Ink 组件。

---

## 7. 依赖清单

**@licode/core:**
| 包 | 用途 |
|----|------|
| `@anthropic-ai/sdk` ^0.50 | Anthropic Messages API |
| `zod` ^3.23 | 运行时类型校验 |
| `uuid` ^10 | 会话 ID 生成 |

**@licode/cli:**
| 包 | 用途 |
|----|------|
| `@licode/core` (workspace:*) | 核心引擎 |
| `ink` ^5 | React for CLI |
| `react` ^19 | React |
| `ink-text-input` ^6 | 多行输入框 |
| `marked` ^14 | Markdown 解析 |
| `chalk` ^5 | 终端颜色 |

---

## 8. Phase 1 边界与不包含

Phase 1 明确**不包含**以下内容（留给后续 Phase）：

- Function Calling / Tool Use / Agent Loop（Phase 2）
- MCP 协议 / Skill 系统 / Hook 钩子（Phase 3）
- 权限防御 / 上下文压缩 / Token 预算管理 / 记忆系统（Phase 4）
- SubAgent / Worktree 隔离（Phase 5）
- Spec 开发模式工具包（Phase 6）

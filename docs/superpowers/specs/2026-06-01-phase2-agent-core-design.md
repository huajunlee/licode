# Phase 2: Agent 核心机制 — 设计文档

**日期**: 2026-06-01
**状态**: 已确认
**范围**: LICode Phase 2 — Function Calling、Tool 系统、ReAct 范式、Agent Loop

---

## 0. Phase 2 在全局中的位置

Phase 1 让 LICode "能说话"。Phase 2 让它"能动手"——Agent 不再只是回复文本，而是能够调用工具执行实际操作：读文件、写代码、运行命令，然后观察结果，决定下一步做什么。

Phase 2 依赖 Phase 1 的三大基础设施：
- **ConversationManager** — Agent Loop 在其中注入 tool_use 和 tool_result 消息
- **LLMProvider.stream()** — Agent Loop 从中读取 tool_use chunk
- **EventPipeline** — Agent Loop 作为中间件插入，向 UI 发送工具执行事件

| 如果 Phase 2 的... | 做好了 | 做坏了 |
|---|---|---|
| Tool 接口 | 加新工具只需写一个 zod schema + execute 函数 | 每个工具各自定义参数格式，互不兼容 |
| AgentLoop 中间件 | Phase 3 的 Hook/Skill 直接复用事件管道 | Phase 3 需要绕过 AgentLoop 单独处理工具 |
| 终止策略 | Agent 不会无限循环 | 用户面对失控的 Agent 只能 kill 进程 |
| 工具执行器 | 并行 Read 3 个文件只需等最慢的那个 | 串行执行浪费时间 |

**Phase 2 完成标志：**
- LLM 可以自主决定调用工具（Function Calling）
- 工具调用结果注入对话历史，LLM 基于结果继续推理（ReAct 范式）
- Agent Loop 在 LLM 不调用工具时自动终止
- 步数/token/时间三重安全网防止失控
- CLI 展示工具调用过程（ToolCallCard 组件）

---

## 1. 架构总览

Phase 2 在 `@licode/core` 中新增 `tools/` 和 `agent/` 两个模块：

```
@licode/core
├── llm/           # Phase 1 — 扩展 Message 类型和 StreamChunk
├── conversation/  # Phase 1 — 扩展消息 API
├── events/        # Phase 1 — 扩展事件类型
├── tools/         # Phase 2 新增
│   ├── types.ts        # Tool 接口 + ToolResult + ToolContext
│   ├── registry.ts     # ToolRegistry 注册表
│   ├── executor.ts     # ToolExecutor 并行执行
│   └── builtin/        # 内置工具集
│       ├── bash.ts     # Bash 命令执行
│       ├── read.ts     # 文件读取
│       ├── write.ts    # 文件写入
│       ├── edit.ts     # 文件编辑（字符串替换）
│       ├── glob.ts     # 文件搜索
│       └── grep.ts     # 内容搜索
└── agent/         # Phase 2 新增
    ├── loop.ts         # AgentLoop 类 + AgentLoopMiddleware
    ├── react.ts        # ReAct 循环逻辑
    ├── termination.ts  # 终止策略
    └── types.ts        # Agent 相关类型
```

**关键设计决策：**

| 决策 | 选择 |
|------|------|
| Tool 定义方式 | Zod Schema（写一次得类型 + JSON Schema） |
| Agent Loop 架构 | 作为 EventPipeline 中间件 |
| 终止策略 | LLM 自主退出 + 步数/token/时间三重硬限制 |
| Tool 执行方式 | 并行批量执行（Promise.all） |

**Agent Loop 在事件管道中的位置：**

```
EventPipeline
  .use(loggingMiddleware)
  .use(agentLoopMiddleware)    ← Agent Loop：拦截 user-message，run ReAct
  .use(rendererMiddleware)     ← 渲染器：只看到最终文本（不关心里面循环了几轮）
  .use(errorHandlerMiddleware)
```

---

## 2. 对 Phase 1 的改动

Phase 2 对 Phase 1 做最小侵入扩展——不重写，只加新类型和新参数。

### 2.1 Message 类型扩展 (`llm/provider.ts`)

```typescript
// 原联合类型新增两种 Tool 消息
type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolUseMessage       // ← Phase 2 新增
  | ToolResultMessage;   // ← Phase 2 新增

// tool_use 属于 assistant 角色（Anthropic Messages API 规范）
interface ToolUseMessage {
  role: "assistant";
  content: ToolUseBlock[];
}

interface ToolUseBlock {
  id: string;                     // Anthropic 要求的 tool_use id
  name: string;
  input: Record<string, unknown>;
}

// tool_result 属于 user 角色（Anthropic Messages API 规范）
interface ToolResultMessage {
  role: "user";
  content: ToolResultBlock[];
}

interface ToolResultBlock {
  tool_use_id: string;            // 关联到 tool_use.id
  content: string;                // 工具执行结果文本
  is_error?: boolean;
}
```

### 2.2 StreamChunk 扩展 (`llm/provider.ts`)

```typescript
type StreamChunk =
  | { type: "token"; text: string; index: number }
  | { type: "tool-use"; toolUse: ToolUseBlock }  // ← Phase 2 新增
  | { type: "stop"; stopReason: string; usage: TokenUsage }
  | { type: "error"; error: Error };
```

### 2.3 ChatRequest 扩展 (`llm/provider.ts`)

```typescript
interface ChatRequest {
  messages: Message[];
  model: string;
  maxTokens?: number;
  tools?: LLMToolDefinition[];  // ← Phase 2 新增
  extensions?: Record<string, unknown>;
}

// 发给 LLM 的工具定义（JSON Schema 格式，与 Anthropic API 对齐）
interface LLMToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;  // JSON Schema 对象
}
```

### 2.4 ConversationManager 扩展 (`conversation/manager.ts`)

```typescript
class ConversationManager {
  // Phase 1 方法保持不变...

  /** 新增：添加工具调用消息对（tool_use + tool_result） */
  addToolMessages(
    toolUses: ToolUseBlock[],
    results: ToolResult[]
  ): void;

  /** 新增：获取最近一个 assistant 消息（用于增量构建流式 tool_use） */
  getLastAssistantMessage(): AssistantMessage | ToolUseMessage | undefined;
}
```

### 2.5 事件类型扩展 (`events/types.ts`)

```typescript
type PipelineEvent =
  // Phase 1 事件（保持不变）
  | { type: "user-message"; content: string }
  | { type: "llm-token"; text: string; index: number }
  | { type: "llm-response-complete"; usage: TokenUsage }
  | { type: "stream-complete"; messages: Message[] }
  | { type: "error"; error: Error; context: string }

  // Phase 2 新增事件
  | { type: "agent-loop-start" }
  | { type: "agent-loop-step"; index: number; reasoning: string }
  | { type: "tool-use-detected"; toolUses: ToolUseBlock[] }
  | { type: "tool-execute-start"; toolName: string; input: Record<string, unknown> }
  | { type: "tool-execute-complete"; toolName: string; result: ToolResult }
  | { type: "agent-loop-complete"; message: string; usage: TokenUsage }
  | { type: "agent-loop-terminated"; reason: string; stats: TerminationStats };
```

---

## 3. Tool 系统

### 3.1 核心类型 (`tools/types.ts`)

```typescript
import { z, ZodTypeAny } from "zod";

interface Tool<TParams extends ZodTypeAny = ZodTypeAny> {
  /** 工具名称，与 LLM tool_use.name 匹配 */
  name: string;

  /** 人类可读描述，会发给 LLM */
  description: string;

  /** Zod schema —— 运行时校验 + 自动生成 JSON Schema */
  parameters: TParams;

  /** z.infer 推导出 TypeScript 类型 */
  inputType: z.infer<TParams>;

  /** 执行工具。input 已经通过 zod 校验 */
  execute(
    input: z.infer<TParams>,
    context: ToolContext
  ): Promise<ToolResult>;

  /** 是否需要用户批准（Phase 4 使用，Phase 2 默认 false） */
  requiresApproval?: boolean;
}

interface ToolContext {
  workingDirectory: string;
  sessionId: string;
  signal?: AbortSignal;
}

type ToolResult =
  | {
      status: "success";
      content: string;
      metadata?: Record<string, unknown>;
    }
  | {
      status: "error";
      error: string;
      errorType: "validation" | "execution" | "timeout";
    };
```

### 3.2 内置工具示例 (`tools/builtin/bash.ts`)

```typescript
import { z } from "zod";
import type { Tool } from "../types";

const BashParams = z.object({
  command: z.string().describe("The bash command to execute"),
  timeout: z.number().optional().default(120000).describe("Timeout in milliseconds"),
});

export const bashTool: Tool<typeof BashParams> = {
  name: "Bash",
  description:
    "Executes a bash command in the working directory. " +
    "Use for running tests, building, installing dependencies, " +
    "git operations, and file system queries.",
  parameters: BashParams,
  requiresApproval: true,

  async execute(input, context) {
    try {
      const result = await execAsync(input.command, {
        cwd: context.workingDirectory,
        timeout: input.timeout,
        signal: context.signal,
      });
      return {
        status: "success",
        content: result.stdout || result.stderr || "(no output)",
      };
    } catch (e) {
      return {
        status: "error",
        error: e.message,
        errorType: "execution",
      };
    }
  },
};
```

### 3.3 内置工具清单

| 工具 | 用途 | requiresApproval |
|------|------|------------------|
| `Bash` | 执行 Shell 命令 | true |
| `Read` | 读取文件内容（返回 cat -n 格式） | false |
| `Write` | 创建或覆盖文件 | false |
| `Edit` | 精确字符串替换编辑 | false |
| `Glob` | 按模式搜索文件路径 | false |
| `Grep` | 按关键词搜索文件内容 | false |

### 3.4 ToolRegistry (`tools/registry.ts`)

```typescript
class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): void;
  registerAll(tools: Tool[]): void;
  get(name: string): Tool | undefined;
  list(): string[];

  /** 生成发给 LLM 的工具描述列表 */
  toLLMTools(): LLMToolDefinition[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: zodToJsonSchema(t.parameters),
    }));
  }
}

// 全局单例
const toolRegistry = new ToolRegistry();

// Phase 2 启动时注册
toolRegistry.registerAll([
  bashTool, readTool, writeTool, editTool, globTool, grepTool,
]);
```

**注意：** `zodToJsonSchema()` 在注册阶段调用一次并缓存结果，不是每次发 LLM 请求时重新计算。

### 3.5 ToolExecutor (`tools/executor.ts`)

```typescript
class ToolExecutor {
  constructor(private registry: ToolRegistry) {}

  /** 并行执行多个 tool_use */
  async executeParallel(
    toolUses: ToolUseBlock[],
    options?: { signal?: AbortSignal }
  ): Promise<ToolResult[]> {
    return Promise.all(
      toolUses.map((tu) => this.executeOne(tu, options))
    );
  }

  private async executeOne(
    toolUse: ToolUseBlock,
    options?: { signal?: AbortSignal }
  ): Promise<ToolResult> {
    const tool = this.registry.get(toolUse.name);
    if (!tool) {
      return {
        status: "error",
        error: `Unknown tool: ${toolUse.name}`,
        errorType: "validation",
      };
    }

    // Zod 校验
    const parsed = tool.parameters.safeParse(toolUse.input);
    if (!parsed.success) {
      return {
        status: "error",
        error: parsed.error.message,
        errorType: "validation",
      };
    }

    return tool.execute(parsed.data, {
      workingDirectory: process.cwd(),
      sessionId: toolUse.id,
      signal: options?.signal,
    });
  }
}
```

---

## 4. Agent Loop

### 4.1 整体架构：作为 EventPipeline 中间件

AgentLoop 不独立于管道运行——它就是一个中间件。`createAgentLoopMiddleware` 返回一个标准的 `Middleware` 函数，与 `events/middleware/` 中的 `loggingMiddleware`、`tokenCountingMiddleware` 满足同一个接口：

```typescript
type Middleware = (
  event: PipelineEvent,
  next: () => Promise<void>
) => Promise<void>;
```

当 `user-message` 事件到达时，AgentLoop 拦截它，启动 ReAct 循环。循环结束前，下游中间件（渲染器）不接收事件。循环结束后，最终文本通过 `next()` 传递给渲染器。

这意味着：
- 渲染器不知道也不关心中间有几轮 tool_use——它只渲染最终回复
- 工具执行的进度通知通过独立的"心跳事件"通道发送（Phase 2 事件类型）
- Phase 3 的 Hook 系统可以在 Agent Loop 前后插入逻辑

**为什么 agent/ 独立于 events/middleware/？**

虽然接口相同，但复杂度差距悬殊：

| | loggingMiddleware | agentLoopMiddleware |
|---|---|---|
| 代码量 | ~10 行 | ~200+ 行 |
| 依赖 | 无 | ConversationManager、LLMProvider、ToolRegistry、ToolExecutor、TerminationPolicy |
| 是否调 `next()` | 总是立即调用 | 只在 ReAct 循环结束后调用一次 |
| 内部结构 | 线性 | while(true) 循环 + 分流 |

把 AgentLoop 塞进 `events/middleware/` 会让简单中间件的目录出现一个 200 行的庞然大物，破坏认知模型。`agent/` 独立目录承认它虽然接口上是一个 middleware，但本质上是一个完整的子系统。

从管道视角看，它们完全平等——管道不关心中间件的复杂度，只看签名：

```
EventPipeline
  .use(logging)        // events/middleware/logging.ts —— 简单中间件
  .use(agentLoop)      // agent/loop.ts —— 复杂中间件，接口相同
  .use(renderer)       // cli 注入的渲染中间件
  .use(errorHandler)   // events/middleware/error-handler.ts —— 简单中间件
```

这是中间件模式的核心价值：复杂度被封装在统一的接口后面。

### 4.2 AgentLoopMiddleware (`agent/loop.ts`)

```typescript
function createAgentLoopMiddleware(config: AgentConfig): Middleware {
  return async (event, next) => {
    if (event.type !== "user-message") {
      return next();
    }

    const loop = new AgentLoop(config);
    const finalEvent = await loop.run(event.content);
    await next(finalEvent);
  };
}
```

### 4.3 AgentLoop 类 (`agent/loop.ts`)

```typescript
interface AgentConfig {
  llm: LLMProvider;
  conversation: ConversationManager;
  tools: ToolRegistry;
  termination?: TerminationConfig;
  eventBus?: EventBus;
}

/** Agent Loop 内部事件总线 —— 向 UI 发送心跳事件 */
interface EventBus {
  emit(event: PipelineEvent): void;
}

class AgentLoop {
  private llm: LLMProvider;
  private conversation: ConversationManager;
  private tools: ToolRegistry;
  private executor: ToolExecutor;
  private termination: TerminationPolicy;
  private eventBus?: EventBus;

  constructor(config: AgentConfig) {
    this.llm = config.llm;
    this.conversation = config.conversation;
    this.tools = config.tools;
    this.executor = new ToolExecutor(config.tools);
    this.termination = new TerminationPolicy(config.termination ?? {});
    this.eventBus = config.eventBus;
  }

  async run(userInput: string): Promise<PipelineEvent> {
    this.conversation.addUserMessage(userInput);
    this.eventBus?.emit({ type: "agent-loop-start" });

    while (true) {
      this.termination.check(this.conversation.getTokenCount());

      const messages = this.conversation.buildMessages();
      const toolDefs = this.tools.toLLMTools();

      const response = await collectResponse(this.llm, messages, toolDefs);

      // 判断响应类型
      if (response.type === "text") {
        // 无 tool_use → 循环结束
        this.conversation.finalizeAssistantMessage(response.usage);
        this.eventBus?.emit({
          type: "agent-loop-complete",
          message: response.content,
          usage: response.usage,
        });
        return {
          type: "stream-complete",
          messages: this.conversation.getMessages(),
        };
      }

      if (response.type === "tool-use") {
        // 有 tool_use → 通知 UI → 并行执行 → 注入结果 → 继续循环
        this.eventBus?.emit({
          type: "tool-use-detected",
          toolUses: response.toolUses,
        });

        const results = await this.executor.executeParallel(
          response.toolUses
        );

        this.conversation.addToolMessages(response.toolUses, results);
        this.termination.incrementStep();
        continue;
      }
    }
  }
}
```

### 4.4 ReAct 循环 (`agent/react.ts`)

```typescript
type CollectResult =
  | { type: "text"; content: string; usage: TokenUsage }
  | { type: "tool-use"; toolUses: ToolUseBlock[]; usage: TokenUsage };

// collectResponse — 在一次 LLM 调用中同时处理文本 token 和 tool_use chunk
async function collectResponse(
  llm: LLMProvider,
  messages: Message[],
  tools: LLMToolDefinition[]
): Promise<CollectResult> {
  const textChunks: string[] = [];
  const toolUses: ToolUseBlock[] = [];
  let usage: TokenUsage = { input: 0, output: 0 };

  for await (const chunk of llm.stream({
    messages,
    tools,                      // tools[] 每次都发给 LLM
    maxTokens: 4096,
  })) {
    switch (chunk.type) {
      case "token":
        textChunks.push(chunk.text);
        break;
      case "tool-use":
        toolUses.push(chunk.toolUse);
        break;
      case "stop":
        usage = chunk.usage;
        break;
    }
  }

  if (toolUses.length > 0) {
    return { type: "tool-use", toolUses, usage };
  }
  return { type: "text", content: textChunks.join(""), usage };
}
```

**关键澄清：** `tools` 数组在每次 LLM 请求时都作为参数发送——LLM 从第一轮就能看到所有可用工具。不存在"先检测再获取"的过程。事件流中的 `tool-use-detected` 是一个 Agent Loop 内部事件，用于通知 CLI 渲染 ToolCallCard 组件，不是发给 LLM 的。

### 4.5 ReAct 步骤的数据结构

```typescript
// 每一步的元数据（不参与 LLM 消息，仅用于追踪和调试）
interface AgentStep {
  index: number;
  reasoning: string;            // LLM 思考文本（可空）
  actions: ToolUseBlock[];      // 本轮要执行的工具调用
  observations: ToolResult[];   // 工具执行结果
}
```

ReAct 步骤之间不通过状态共享——LLM 通过消息历史中的 tool_use 和 tool_result 消息获取上一步的 Observation。这是 Anthropic Messages API 的标准模式。

### 4.6 终止策略 (`agent/termination.ts`)

```typescript
interface TerminationConfig {
  maxSteps: number;      // 默认 50
  maxTokens: number;     // 默认 200_000
  maxTimeMs: number;     // 默认 600_000（10 分钟）
}

class TerminationPolicy {
  private steps = 0;
  private startTime = Date.now();

  constructor(private config: TerminationConfig) {}

  /** 每步开始前调用，超限时抛出 TerminationError */
  check(currentTokens: number): void {
    if (this.steps >= this.config.maxSteps) {
      throw new TerminationError(
        `Reached max steps (${this.config.maxSteps}). Stopping agent loop.`
      );
    }
    if (currentTokens >= this.config.maxTokens) {
      throw new TerminationError(
        `Token budget exhausted (${currentTokens}/${this.config.maxTokens}).`
      );
    }
    if (Date.now() - this.startTime > this.config.maxTimeMs) {
      throw new TerminationError("Agent loop timed out.");
    }
  }

  incrementStep(): void { this.steps++; }

  getStats(): TerminationStats {
    return {
      steps: this.steps,
      timeMs: Date.now() - this.startTime,
    };
  }
}

/** 终止时的统计数据 */
interface TerminationStats {
  steps: number;
  timeMs: number;
}

class TerminationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminationError";
  }
}
```

AgentLoop 捕获 `TerminationError` 后，发出 `agent-loop-terminated` 事件（包含终止原因和统计数据），然后优雅退出——不会 crash 整个进程。

---

## 5. 完整对话时序

```
User     CLI             AgentLoopMiddleware      LLM           ToolExecutor
 │        │                    │                    │                │
 │ 输入    │                    │                    │                │
 ├───────►│ user-message       │                    │                │
 │        ├───────────────────►│                    │                │
 │        │                    │ emit loop-start    │                │
 │        │                    │                    │                │
 │        │                    │ stream(msgs+tools) │                │
 │        │                    ├───────────────────►│                │
 │        │                    │                    │                │
 │        │                    │◄── token chunks ───┤                │
 │        │◄── llm-token ──────┤                    │                │
 │        │                    │                    │                │
 │        │                    │◄── tool_use chunks─┤                │
 │        │◄── tool-use-detected                    │                │
 │ "调用  │                    │                    │                │
 │  Bash" │                    │                    │                │
 │        │                    │ executeParallel()  │                │
 │        │                    ├────────────────────────────────────►
 │        │◄── tool-execute-start("Bash")          │                │
 │        │◄── tool-execute-complete("Bash")       │                │
 │        │                    │                    │                │
 │        │                    │ stream(msgs+tools  │                │
 │        │                    │   + tool results)  │                │
 │        │                    ├───────────────────►│                │
 │        │                    │                    │                │
 │        │                    │◄── token chunks ───┤                │
 │  "Done"│◄── llm-token × N ──┤                    │                │
 │        │◄── agent-loop-complete                  │                │
```

---

## 6. CLI 新增组件

### ToolCallCard (`cli/src/components/tool-call-card.tsx`)

在 ChatView 和 StreamRenderer 之间渲染，展示当前正在执行或已完成的工具调用：

```typescript
const ToolCallCard: React.FC<{
  toolName: string;
  status: "pending" | "running" | "done" | "error";
  detail?: string;
  result?: string;
}> = ({ toolName, status, detail, result }) => (
  <Box
    borderStyle="round"
    borderColor={status === "error" ? "red" : "blue"}
    padding={1}
  >
    <Text color="cyan">⚙ {toolName}</Text>
    {detail && <Text dimColor>{detail}</Text>}
    {status === "running" && <Spinner />}
    {status === "done" && result && (
      <Text dimColor>{truncate(result, 200)}</Text>
    )}
  </Box>
);
```

---

## 7. 依赖清单

Phase 2 新增依赖（在 Phase 1 基础上）：

| 包 | 用途 |
|----|------|
| `zod` ^3.23 | Tool 参数定义 + JSON Schema 生成（已在 Phase 1 引入，Phase 2 正式使用） |
| `zod-to-json-schema` ^3.23 | zod schema → JSON Schema 转换 |

Phase 1 已有依赖无需变更。

---

## 8. Phase 2 边界与不包含

- MCP 协议工具发现（Phase 3）
- Skill 技能包注册（Phase 3）
- Hook 生命周期（Phase 3）
- 权限审批流——`requiresApproval` 字段定义但 Phase 2 不强制检查（Phase 4）
- SubAgent 分发（Phase 5）
- Worktree 隔离（Phase 5）

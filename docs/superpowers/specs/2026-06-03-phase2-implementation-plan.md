# Phase 2 实现计划：Agent 核心机制

**日期**: 2026-06-03
**设计文档**: `docs/superpowers/specs/2026-06-01-phase2-agent-core-design.md`
**前置**: Phase 1（核心对话引擎）已完成

---

## Context

Phase 1 让 LICode "能说话"。Phase 2 让它"能动手"——Agent 不再只是回复文本，而是能够调用工具执行实际操作。这是 LICode 从聊天机器人变成 Agent 的关键一步。

核心交付：Tool 系统（zod 定义 + ToolRegistry + ToolExecutor）+ Agent Loop（ReAct 循环 + 终止策略）+ 对 Phase 1 的 5 处最小侵入扩展。

---

## 实现顺序（依赖关系）

```
1. Phase 1 改动 (修改 5 个已有文件 + 新增 1 个依赖)
   ↓
2. tools/ 模块 (type → registry → executor → builtin)
   ↓
3. agent/ 模块 (termination → react → loop)
   ↓
4. cli/ 改动 (ToolCallCard + useConversation 升级)
   ↓
5. 集成收尾 (启动流程 + 公开导出 + 端到端验证)
```

---

## Step 1: Phase 1 改动 —— 最小侵入扩展

**目标**: 扩展 Phase 1 的类型和类，让 LLM 能理解 tool_use、消息历史能容纳工具消息。

### 1.1 新增依赖 — `packages/core/package.json`
- 添加 `zod-to-json-schema` ^3.23（zod → JSON Schema 转换）

### 1.2 Message 类型扩展 — `packages/core/src/llm/provider.ts`
- `Message` 联合类型新增 `ToolUseMessage` 和 `ToolResultMessage`
- 新增 `ToolUseBlock` 接口（`id`, `name`, `input`）
- 新增 `ToolResultBlock` 接口（`tool_use_id`, `content`, `is_error?`）
- `StreamChunk` 联合类型新增 `{ type: "tool-use"; toolUse: ToolUseBlock }`
- `ChatRequest` 接口新增 `tools?: LLMToolDefinition[]`
- 新增 `LLMToolDefinition` 接口（`name`, `description`, `input_schema`）

### 1.3 AnthropicProvider 流解析扩展 — `packages/core/src/llm/anthropic.ts`
- `toAnthropicParams()` 新增 `tools` 参数映射
- `toStreamChunk()` 新增 `content_block_start`（检测 tool_use block）事件处理
- SSE 事件 `content_block_start` 携带 `type: "tool_use"` → 构造 `{ type: "tool-use", toolUse: {...} }` chunk
- `toAnthropicMessages()` 新增 `ToolUseMessage` → Anthropic `tool_use` block 映射
- `toAnthropicMessages()` 新增 `ToolResultMessage` → Anthropic `tool_result` block 映射

### 1.4 ConversationManager 扩展 — `packages/core/src/conversation/manager.ts`
- 新增 `addToolMessages(toolUses, results)` — 将 tool_use + tool_result 消息对追加到历史
  - tool_use: role `assistant`，content 为 `ToolUseBlock[]`
  - tool_result: role `user`，content 为 `ToolResultBlock[]`
- 新增 `getLastAssistantMessage()` — 返回最近的 assistant 或 tool_use 消息
- `buildMessages()` 保持原有逻辑，但返回的 messages 现在可能包含 Tool 消息

### 1.5 事件类型扩展 — `packages/core/src/events/types.ts`
- `PipelineEvent` 联合类型新增 7 个 Agent 事件：
  - `agent-loop-start`
  - `agent-loop-step`（`index`, `reasoning`）
  - `tool-use-detected`（`toolUses`）
  - `tool-execute-start`（`toolName`, `input`）
  - `tool-execute-complete`（`toolName`, `result`）
  - `agent-loop-complete`（`message`, `usage`）
  - `agent-loop-terminated`（`reason`, `stats`）

### 1.6 验证
- Phase 1 的单元测试仍然通过（新增类型不影响已有功能）
- 手动验证：AnthropicProvider 能正确解析含 tool_use 的 SSE 响应

---

## Step 2: `tools/` 模块 —— Tool 系统

**目标**: 定义 Tool 接口，实现 ToolRegistry 和 ToolExecutor，实现 6 个内置工具。

### 2.1 核心类型 — `packages/core/src/tools/types.ts`
- `Tool<TParams>` 泛型接口（`name`, `description`, `parameters`, `execute()`, `requiresApproval?`）
- `ToolContext` 接口（`workingDirectory`, `sessionId`, `signal?`）
- `ToolResult` 联合类型（`success | error`，error 分 `validation | execution | timeout`）

### 2.2 ToolRegistry — `packages/core/src/tools/registry.ts`
- `ToolRegistry` 类
  - `register(tool)` / `registerAll(tools)` — 注册
  - `get(name)` — 按名查找
  - `list()` — 列出所有工具名
  - `toLLMTools()` — 生成 `LLMToolDefinition[]`（每工具调用 `zodToJsonSchema(parameters)`，结果缓存）
  - `unregister(name)` — 移除工具（Phase 3 的 /subagent off 需要）
  - `filterForAgent(whitelist)` — 按白名单过滤（Phase 5 需要）

### 2.3 ToolExecutor — `packages/core/src/tools/executor.ts`
- `ToolExecutor` 类
  - `executeParallel(toolUses, options?)` — `Promise.all` 并行执行
  - `executeOne(toolUse, options?)` — 单个执行：
    1. 从 registry 查 Tool
    2. Zod `safeParse` 校验参数
    3. 校验失败 → 返回 error（validation）
    4. 校验通过 → 调用 `tool.execute(parsed, context)`
    5. 异常 → 返回 error（execution）

### 2.4 内置工具 — `packages/core/src/tools/builtin/`

**bash.ts:**
- Zod schema: `{ command: string, timeout?: number }`
- `execute()`: `execAsync()` 执行命令，返回 stdout/stderr
- `requiresApproval: true`

**read.ts:**
- Zod schema: `{ file_path: string, offset?: number, limit?: number }`
- `execute()`: 读取文件，返回 cat -n 格式（行号前缀）
- 安全检查：确保路径是绝对路径，限制在 working directory 内

**write.ts:**
- Zod schema: `{ file_path: string, content: string }`
- `execute()`: `writeFile()` 创建或覆盖文件
- 返回确认信息

**edit.ts:**
- Zod schema: `{ file_path: string, old_string: string, new_string: string, replace_all?: boolean }`
- `execute()`: 读取文件 → 精确字符串替换（唯一匹配） → 写回
- 非唯一匹配时返回错误

**glob.ts:**
- Zod schema: `{ pattern: string, path?: string }`
- `execute()`: `fdir` 或 Node.js glob 扫描文件路径

**grep.ts:**
- Zod schema: `{ pattern: string, path?: string, include?: string }`
- `execute()`: 使用 `child_process.exec` 调用系统 grep 或 Node 实现

- `index.ts` — 导出 `builtinTools` 数组（6 个 Tool）

### 2.5 单元测试
- 测试 `ToolRegistry.register()` / `get()` / `toLLMTools()`
- 测试 `ToolExecutor.executeOne()`：成功、未知工具、参数校验失败
- 测试 `ToolExecutor.executeParallel()` 并行执行
- 测试 `Read` 工具正确返回行号格式
- 测试 `Edit` 工具精确替换逻辑

---

## Step 3: `agent/` 模块 —— Agent Loop

**目标**: 实现 ReAct 循环、终止策略、AgentLoopMiddleware。

### 3.1 终止策略 — `packages/core/src/agent/termination.ts`
- `TerminationConfig` 接口（`maxSteps=50`, `maxTokens=200000`, `maxTimeMs=600000`）
- `TerminationStats` 接口（`steps`, `timeMs`）
- `TerminationPolicy` 类
  - `check(currentTokens)` — 超限时抛出 `TerminationError`
  - `incrementStep()` — 步数+1
  - `getStats()` — 返回统计
- `TerminationError` 类 — 继承 Error

### 3.2 ReAct 循环 — `packages/core/src/agent/react.ts`
- `CollectResult` 联合类型（`text | tool-use`）
- `collectResponse(llm, messages, tools)` — 核心函数：
  1. 调用 `llm.stream({ messages, tools, maxTokens: 4096 })`
  2. `for await` 遍历 chunk：
     - `token` → 累加到 `textChunks`
     - `tool-use` → 累加到 `toolUses`
     - `stop` → 记录 `usage`
  3. `toolUses.length > 0` → 返回 `{ type: "tool-use", toolUses, usage }`
  4. 否则 → 返回 `{ type: "text", content, usage }`

### 3.3 AgentLoop — `packages/core/src/agent/loop.ts`
- `AgentConfig` 接口（`llm`, `conversation`, `tools`, `termination?`, `eventBus?`）
- `EventBus` 接口（`emit(event)`）
- `AgentLoop` 类
  - `run(userInput)` — `while(true)` 循环：
    1. `termination.check()` — 终止检查
    2. `collectResponse()` — 调用 LLM
    3. `response.type === "text"`:
       - `finalizeAssistantMessage()`
       - emit `agent-loop-complete`
       - return `{ type: "stream-complete" }`
    4. `response.type === "tool-use"`:
       - emit `tool-use-detected`
       - emit `tool-execute-start`（每个 tool_use）
       - `executor.executeParallel()` 执行工具
       - emit `tool-execute-complete`（每个结果）
       - `addToolMessages()` 注入结果
       - `termination.incrementStep()`
       - `continue`
  - 捕获 `TerminationError` → emit `agent-loop-terminated` → return
  - 捕获其他异常 → emit `error` → return

### 3.4 AgentLoopMiddleware — `packages/core/src/agent/loop.ts`
- `createAgentLoopMiddleware(config)` — 返回 `Middleware`：
  - 如果 `event.type !== "user-message"` → 调用 `next()` 放行
  - 如果是 user-message → 创建 AgentLoop 实例 → `loop.run()` → `next(finalEvent)`

### 3.5 单元测试
- 测试 `TerminationPolicy`——步数超限、token 超限、时间超限
- Mock LLMProvider，测试 `collectResponse()` 文本响应和 tool_use 响应
- Mock ToolRegistry，测试 `AgentLoop.run()` 完整流程
- 测试 `agent-loop-terminated` 事件在超限时发出

---

## Step 4: CLI 改动 —— ToolCallCard + 升级 useConversation

### 4.1 ToolCallCard 组件 — `packages/cli/src/components/tool-call-card.tsx`
- Props: `{ toolName, status, detail?, result? }`
- 渲染：`Box` 带边框，`cyan` 颜色的工具名图标
- status `running` → 显示 `<Spinner />`
- status `done` → 显示结果（截断到 200 字符）
- status `error` → 红色边框 + 错误信息

### 4.2 升级 useConversation — `packages/cli/src/hooks.ts`
- Phase 1 的 `useConversation` 替换 `generateChatEvents` / `EventPipeline`：
  - Phase 1 中的 `generateChatEvents` 产生的 `llm-token` 事件不再直接发给 renderer
  - 新流程：pipeline 中插入 `agentLoopMiddleware`，Agent Loop 内部处理 token 和 tool_use
  - renderer 只消费 `agent-loop-complete` 事件获取最终文本
  - `ToolCallCard` 消费 `tool-use-detected`、`tool-execute-*` 事件更新 UI
- 新增 state：`activeToolCalls: ToolCallState[]`
- `activeToolCalls` 更新逻辑：
  - `tool-use-detected` → 添加 `{ name, status: "pending" }`
  - `tool-execute-start` → 状态改为 `"running"`
  - `tool-execute-complete` → 状态改为 `"done"` 或 `"error"`
- 新的 pipe 组装：
  ```typescript
  pipeline
    .use(loggingMiddleware)
    .use(createAgentLoopMiddleware({ llm, conversation, tools: toolRegistry, eventBus }))
    .use(rendererMiddleware)
    .use(errorHandlerMiddleware);
  ```

### 4.3 启动时注册工具 — `packages/cli/src/app.tsx`
- 初始化 `ToolRegistry`，注册 6 个内置工具
- 初始化 `ToolExecutor`，传入 AgentLoop
- 初始化 `AgentLoop`（含 `TerminationPolicy`）

### 4.4 验证（手动测试）
- 启动 LICode，输入"列出当前目录的文件"
- 观察 ToolCallCard 展示 Bash 工具调用过程
- 观察 Agent 是否在工具执行后继续推理
- 测试 Agent 主动终止（问一个不需要工具的问题）
- 测试终止策略（设 maxSteps=2，看是否触发终止事件）

---

## Step 5: 集成收尾

### 5.1 `@licode/core` 公开导出更新 — `packages/core/src/index.ts`
```typescript
// Phase 2 新增
export { ToolRegistry } from './tools/registry';
export { ToolExecutor } from './tools/executor';
export type { Tool, ToolResult, ToolContext } from './tools/types';
export { bashTool, readTool, writeTool, editTool, globTool, grepTool } from './tools/builtin';
export { AgentLoop, createAgentLoopMiddleware } from './agent/loop';
export type { AgentConfig, EventBus } from './agent/loop';
export { TerminationPolicy, TerminationError } from './agent/termination';
export type { TerminationConfig, TerminationStats } from './agent/termination';
export { collectResponse } from './agent/react';
export type { CollectResult } from './agent/react';
```

### 5.2 端到端验证
1. `pnpm build` 无错误
2. 启动 CLI，问"当前目录有什么文件？"
3. 验证 Agent 调用 Bash 工具、观察结果、用中文回复
4. 验证 ToolCallCard 正确展示
5. 连续 3 轮对话（含 tool_use），验证消息历史正确
6. 设置 `maxSteps=2`，触发终止，验证 `agent-loop-terminated` 事件

---

## 验证清单

- [ ] Phase 1 单元测试全部通过（改动后无回归）
- [ ] `AnthropicProvider.stream()` 正确解析 tool_use SSE chunk
- [ ] `ToolRegistry.toLLMTools()` 正确生成 JSON Schema
- [ ] `ToolExecutor.executeParallel()` 并行执行多个工具
- [ ] 6 个内置工具各自通过单元测试
- [ ] `collectResponse()` 正确区分 text 和 tool-use 响应
- [ ] `AgentLoop.run()` ReAct 循环正确（文本退出 + tool_use 循环）
- [ ] `TerminationPolicy` 三重安全网正确触发
- [ ] CLI: ToolCallCard 展示工具调用进度
- [ ] CLI: Agent 自主决定"该调工具"和"该回复文本"
- [ ] CLI: 多轮 tool_use 循环正确

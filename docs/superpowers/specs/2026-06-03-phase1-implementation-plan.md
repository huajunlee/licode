# Phase 1 实现计划：核心对话引擎

**日期**: 2026-06-03
**设计文档**: `docs/superpowers/specs/2026-06-01-phase1-core-conversation-design.md`

---

## Context

Phase 1 是 LICode 大厦的地基。只实现"和 LLM 对话"这件事，但设计质量决定后续所有 Phase。交付物是 `@licode/core` 和 `@licode/cli` 两个包，通过 pnpm monorepo 组织。

关键技术决策：TypeScript + Node.js + Ink 5（React for CLI）+ Anthropic API 适配器模式 + System Prompt 分层组装 + 会话 JSON 持久化 + 事件管道中间件。

---

## 实现顺序（依赖关系）

```
1. 项目脚手架 (0 依赖)
   ↓
2. llm/ 模块 (仅依赖 @anthropic-ai/sdk)
   ↓
3. conversation/ 模块 (依赖 llm/ 的 Message 类型)
   ↓
4. events/ 模块 (依赖 conversation/ 的类型)
   ↓
5. cli/ 包 (依赖以上全部)
```

---

## Step 1: 项目脚手架

**目标**: 搭建 pnpm monorepo，两个空包可相互引用。

### 1.1 根目录配置
- 创建 `package.json`（pnpm workspace）
- 创建 `pnpm-workspace.yaml`（声明 `packages/*`）
- 创建 `tsconfig.base.json`（公共 TS 配置：strict、ESM、target ES2022）
- 创建 `.gitignore`（含 `.licode/`、`.superpowers/`、`node_modules/`）

### 1.2 `@licode/core` 包
- 创建 `packages/core/package.json`（name: `@licode/core`，依赖 `@anthropic-ai/sdk`、`zod`、`uuid`）
- 创建 `packages/core/tsconfig.json`（extends base）
- 创建 `packages/core/src/index.ts`（空导出，后续填充）

### 1.3 `@licode/cli` 包
- 创建 `packages/cli/package.json`（name: `@licode/cli`，依赖 `@licode/core`、`ink`、`react`、`ink-text-input`、`marked`、`chalk`）
- 创建 `packages/cli/tsconfig.json`（extends base，jsx: react-jsx）
- 创建 `packages/cli/src/app.tsx`（最小 Ink App 占位）
- 创建 `packages/cli/bin/licode.ts`（CLI 入口：`#!/usr/bin/env node`，调用 Ink render）

### 1.4 验证
- `pnpm install` 成功
- `pnpm -C packages/core build` 成功（空包）
- `pnpm -C packages/cli build` 成功

---

## Step 2: `llm/` 模块 — LLM Provider 适配层

**目标**: 定义 `LLMProvider` 接口，实现 `AnthropicProvider`，提供启发式 `TokenCounter`。

### 2.1 类型定义 — `packages/core/src/llm/provider.ts`
- `Message` 联合类型（`SystemMessage | UserMessage | AssistantMessage`）
- `TokenUsage` 接口（`input`, `output`）
- `StreamChunk` 联合类型（`token | stop | error`）
- `ChatRequest` 接口（`messages`, `model`, `maxTokens?`, `temperature?`, `extensions?`）
- `ChatResponse` 接口（`content`, `usage`, `stopReason`）
- `LLMProvider` 接口（`name`, `maxContextTokens`, `chat()`, `stream()`, `countTokens()`）

### 2.2 AnthropicProvider — `packages/core/src/llm/anthropic.ts`
- `AnthropicProvider` 类实现 `LLMProvider`
- `stream()` 使用 `client.messages.stream()` 返回 `AsyncIterable<StreamChunk>`
- `chat()` 使用 `client.messages.create()` 返回 `Promise<ChatResponse>`
- 私有方法：`toAnthropicParams()` — 从内部 Message[] 提取 system + 映射消息格式
- 私有方法：`extractSystem()` — 从 Message[] 中提取 system 消息
- 私有方法：`toAnthropicMessages()` — User/Assistant 消息映射为 Anthropic 格式
- 私有方法：`toStreamChunk()` — Anthropic SSE event → StreamChunk
- SSE 事件类型处理：`content_block_delta`（text token）、`content_block_start`（预留 tool_use）、`message_stop`
- 错误处理：流中断时 yield `{ type: "error" }` chunk

### 2.3 流解析工具 — `packages/core/src/llm/stream.ts`
- 辅助函数：`collectStream()` — 消费 `AsyncIterable<StreamChunk>`，返回完整文本 + usage
- 辅助函数：`mergeChunks()` — 将 token chunks 拼接为字符串

### 2.4 TokenCounter — `packages/core/src/llm/token-counter.ts`
- `TokenCounter` 类
- `estimate(text)` — 启发式估算（英文 ~4 chars/token，中文 ~1.5 chars/token）
- `estimateMessages(messages)` — 遍历消息累加

### 2.5 单元测试
- Mock Anthropic SDK，测试 `AnthropicProvider.stream()` 返回正确的 StreamChunk 序列
- 测试 `toAnthropicParams()` 格式转换正确性
- 测试 `TokenCounter.estimate()` 边界情况

### 2.6 验证
- 写一个临时 Node 脚本，用真实 API Key 调用 `AnthropicProvider.stream()`，验证流式输出
- 验证 `chat()` 非流式调用也正常

---

## Step 3: `conversation/` 模块 — 对话管理 & System Prompt

**目标**: 实现 `SystemPrompt` 分层组装，实现 `ConversationManager` 消息管理和 JSON 持久化。

### 3.1 SystemPrompt — `packages/core/src/conversation/system-prompt.ts`
- `SystemPromptLayer` 接口（`name`, `priority`, `always`, `content`）
- `SystemPrompt` 类
  - `addLayer(layer)` — 注册分层
  - `removeLayer(name)` — 移除分层
  - `assemble(budget)` — 按 token 预算裁剪拼接
    - 永远层优先保证
    - 可裁剪层按 priority 升序填入
    - budget 参数使用 TokenCounter 估算

### 3.2 System Prompt 模板文件 — `packages/core/src/conversation/templates/`
- `role.md` — Agent 角色定义模板（LICode 是什么、能力范围、行为约束）
- `safety.md` — 安全规则模板（不执行危险命令、不泄露敏感信息）
- `tool-use.md` — 工具使用说明模板（Phase 2 启用，Phase 1 预留）

### 3.3 ConversationManager — `packages/core/src/conversation/manager.ts`
- `ConversationMetadata` 接口
- `ConversationManager` 类
  - `id` — UUID
  - `messages` — `Message[]`
  - `systemPrompt` — `SystemPrompt` 实例
  - `metadata` — `ConversationMetadata`
  - `addUserMessage(content)` — 追加 `UserMessage`
  - `appendToAssistantMessage(token)` — 流式累积（如果当前最后一条不是 assistant → 新建；否则追加 text）
  - `finalizeAssistantMessage(usage)` — 固定消息内容 + 记录 usage
  - `buildMessages(tokenBudget?)` — 调用 `systemPrompt.assemble(budget)` → 返回 `[SystemMessage, ...history]`
  - `trimToBudget(maxTokens)` — 从最早的消息对开始裁剪
  - `save(filePath?)` — 写入 `.licode/sessions/{id}.json`
  - `static load(filePath)` — 从 JSON 恢复实例
  - `getTokenCount()` / `getMessageCount()` / `getMessages()` — 统计和访问

### 3.4 会话目录初始化
- `save()` 自动创建 `.licode/sessions/` 目录（如果不存在）
- 会话文件名：`{id}.json`

### 3.5 单元测试
- 测试 `SystemPrompt.assemble(budget)` 裁剪逻辑
- 测试 `ConversationManager.addUserMessage()` / `appendToAssistantMessage()` 消息序列
- 测试 `ConversationManager.save()` / `load()` 往返一致
- 测试 `trimToBudget()` 正确保留 system + 最近消息

---

## Step 4: `events/` 模块 — 事件管道

**目标**: 定义 PipelineEvent 类型，实现 EventPipeline 中间件链，提供 3 个内置中间件。

### 4.1 事件类型 — `packages/core/src/events/types.ts`
- `PipelineEvent` 联合类型（5 种事件：`user-message`、`llm-token`、`llm-response-complete`、`stream-complete`、`error`）
- `Middleware` 类型 —— `(event, next) => Promise<void>`

### 4.2 EventPipeline — `packages/core/src/events/pipeline.ts`
- `EventPipeline` 类
  - `middlewares` — `Middleware[]`
  - `use(mw)` — 注册中间件，返回 `this`（链式调用）
  - `run(events)` — 对每个事件依次执行中间件链
    - 洋葱模型：`executeChain(event, 0)` → 递归调用 `next()`

### 4.3 内置中间件 — `packages/core/src/events/middleware/`
- `logging.ts` — `loggingMiddleware`：`console.log` 事件类型和时间戳
- `token-count.ts` — `tokenCountingMiddleware`：累计 token 使用量，存到闭包变量中
- `error-handler.ts` — `errorHandlerMiddleware`：捕获 `error` 事件，格式化输出，不向上抛

### 4.4 生成事件的辅助函数 — `packages/core/src/events/generator.ts`
- `async function* generateChatEvents(input, conversationManager, llmProvider)` — AsyncGenerator
  1. yield `{ type: "user-message" }`
  2. 调用 `llmProvider.stream()`，for each token chunk yield `{ type: "llm-token" }`
  3. 调用 `conversationManager.appendToAssistantMessage()` 累积
  4. stream 完成后：`conversationManager.finalizeAssistantMessage()`
  5. 调用 `conversationManager.save()`
  6. yield `{ type: "stream-complete" }`
  7. 异常时 yield `{ type: "error" }`

### 4.5 单元测试
- 测试 `EventPipeline` 中间件按顺序执行
- 测试中间件调用 `next()` 和不调用 `next()` 的拦截行为
- 测试 `generateChatEvents()` 产生正确的事件序列
- Mock LLMProvider，测试错误事件

---

## Step 5: `@licode/cli` — Ink 渲染层

**目标**: 终端 UI——用户输入，流式展示 AI 回复，保存消息历史。

### 5.1 `useConversation` Hook — `packages/cli/src/hooks.ts`
- 输入：`{ model, sessionId, apiKey }`
- 内部状态：`messages`、`streaming`、`isLoading`、`tokenCount`、`error`
- `handleSubmit(input)`：
  1. 初始化 `AnthropicProvider` + `SystemPrompt` + `ConversationManager` + `EventPipeline`
  2. 调用 `generateChatEvents()` 产生事件流
  3. 管道运行：对流中的每个 `llm-token` 更新 `streaming` state
  4. 流完成：移动 `streaming` 到 `messages`、更新 `tokenCount`
  5. 错误：设置 `error` state
- 返回 `{ messages, streaming, isLoading, tokenCount, error, handleSubmit }`

### 5.2 App 根组件 — `packages/cli/src/app.tsx`
- 使用 `useConversation` hook
- 渲染组件树：
  ```
  <Box flexDirection="column">
    <ChatView messages={messages} />
    <StreamRenderer text={streaming} />
    <StatusBar model={...} tokens={tokenCount} />
    <InputBox onSubmit={handleSubmit} loading={isLoading} />
  </Box>
  ```

### 5.3 ChatView — `packages/cli/src/components/chat-view.tsx`
- 渲染已完成的 `Message[]`
- user 消息：绿色前缀 `>`，左对齐
- assistant 消息：白色正文，支持 Markdown
- Tool 消息（预留，Phase 2 展示）

### 5.4 StreamRenderer — `packages/cli/src/components/stream-renderer.tsx`
- 渲染当前流式文本
- 使用 `marked` 解析 Markdown → 纯文本（Phase 1 不做终端 ANSI 高亮）
- 闪烁光标指示"正在生成"

### 5.5 InputBox — `packages/cli/src/components/input-box.tsx`
- 使用 `ink-text-input` 组件
- 支持多行输入（粘贴多行文本）
- Enter 提交、Ctrl+D 发送
- 提交时禁用输入（loading 状态）

### 5.6 StatusBar — `packages/cli/src/components/status-bar.tsx`
- 底部一行显示：模型名 · Token 用量 · 会话 ID（截短）
- 颜色：dim

### 5.7 CLI 入口 — `packages/cli/bin/licode.ts`
- `#!/usr/bin/env node`
- 读取环境变量 `ANTHROPIC_API_KEY`
- 调用 `render(<App apiKey={...} />)`

### 5.8 验证（手动测试）
- 启动 LICode：`node packages/cli/bin/licode.ts`
- 输入一句话，看流式回复
- 输入第二句话，验证多轮对话（历史正确维护）
- 退出，重新启动，验证会话恢复
- 检查 `.licode/sessions/` 下是否有 JSON 文件

---

## Step 6: 集成与收尾

### 6.1 `@licode/core` 公开导出 — `packages/core/src/index.ts`
```typescript
export { AnthropicProvider } from './llm/anthropic';
export type { LLMProvider, ChatRequest, ChatResponse, StreamChunk, Message } from './llm/provider';
export { TokenCounter } from './llm/token-counter';
export { ConversationManager } from './conversation/manager';
export { SystemPrompt } from './conversation/system-prompt';
export type { SystemPromptLayer } from './conversation/system-prompt';
export { EventPipeline } from './events/pipeline';
export type { PipelineEvent, Middleware } from './events/types';
export { generateChatEvents } from './events/generator';
```

### 6.2 最终端到端验证
1. `pnpm install && pnpm build`
2. 设置 `ANTHROPIC_API_KEY`
3. 启动 CLI，输入对话
4. 验证流式输出正确
5. 验证多轮历史正确
6. 验证 `.licode/sessions/` JSON 文件生成正确
7. 检查无 console 报错或 warning

---

## 验证清单

- [ ] `pnpm install` 无错误
- [ ] `pnpm build` 两个包均编译通过
- [ ] `TokenCounter.estimate()` 基本合理（偏差 < 50%）
- [ ] `AnthropicProvider.stream()` 流式输出正常
- [ ] `AnthropicProvider.chat()` 非流式输出正常
- [ ] `SystemPrompt.assemble(budget)` 在 token 紧张时正确裁剪
- [ ] `ConversationManager.save()` 生成合法 JSON
- [ ] `ConversationManager.load()` 恢复会话后可继续对话
- [ ] `EventPipeline` 中间件按序执行
- [ ] CLI: 输入文本 → 流式渲染 → 消息历史展示
- [ ] CLI: 多轮对话正确累积
- [ ] CLI: 无未捕获异常

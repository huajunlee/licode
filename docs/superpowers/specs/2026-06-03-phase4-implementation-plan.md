# Phase 4 实现计划：工程化能力

**日期**: 2026-06-03
**设计文档**: `docs/superpowers/specs/2026-06-02-phase4-engineering-design.md`
**前置**: Phase 1（核心对话）+ Phase 2（Agent 核心）+ Phase 3（能力扩展）已完成

---

## Context

Phase 1-3 让 LICode 能对话、能动手、能扩展。Phase 4 让它"能生产"——权限防御、上下文管理、跨会话记忆、会话持久化、Agent 沙箱。这些不是用户直接可见的功能，但缺了它们 LICode 无法在真实项目中安全可靠地运行。

核心设计原则：**对已有代码最小侵入。** 权限检查通过 ToolExecutor 回调实现，沙箱通过 Sandbox 接口 + Bash Tool 替换实现，上下文压缩通过 EventPipeline 中间件实现，记忆通过 SystemPrompt context 层注入，会话在 Phase 1 基础上增强。

**Phase 4 零新依赖。** 沙箱用 macOS `sandbox-exec` 系统命令，记忆用 Node.js 内置 `fs`。

---

## 实现顺序（依赖关系）

```
1. Phase 1 改动 (SystemPrompt + ConversationManager + events 类型)
   ↓
2. Phase 2 改动 (ToolExecutor + SandboxedBashTool)
   ↓
3. safety/ 模块 (PermissionGuard + Sandbox 接口 + macOS 实现)
   ↓
4. context/ 模块 (TokenBudget → Summarizer → Compressor → Overflow)
   ↓
5. memory/ 模块 (types → store → loader → extractor)
   ↓
6. session/ 模块 (manager → recovery)
   ↓
7. CLI 集成 (PermissionUI + 启动流程 + pipeline 组装)
   ↓
8. 集成收尾 (公开导出 + 端到端验证)
```

---

## Step 1: Phase 1 改动

**目标**: 为 System Prompt 完整保留、上下文压缩、会话增强做准备。

### 1.1 SystemPrompt 改造 — `packages/core/src/conversation/system-prompt.ts`
- `assemble(budget: number)` → `assemble()` — 移除 token 预算参数
- 分层按 priority 排序拼接，全部保留
- 分层机制保留——用于按能力加载不同层（如 Phase 5 SubAgent 精简 System Prompt）
- Phase 1 中引用 `assemble(budget)` 的调用处改为 `assemble()`

### 1.2 ConversationManager 扩展 — `packages/core/src/conversation/manager.ts`
- 新增 `getSystemPrompt()` — 返回当前 `systemPrompt.assemble()` 的完整文本（供 Compressor 计算 token）
- 新增 `replaceMessages(messages)` — 替换内部消息数组（压缩后使用）
- Phase 3 已有的 `clear()` 和 `getStats()` 保持不变

### 1.3 事件类型扩展 — `packages/core/src/events/types.ts`
- `PipelineEvent` 联合类型新增：
  - `{ type: "context-compressed"; method?: "trim" | "summarize" }`

### 1.4 验证
- Phase 1 已有单元测试通过（`assemble()` 无参调用）
- Phase 2 已有单元测试通过（ConversationManager 新增方法不影响旧行为）

---

## Step 2: Phase 2 改动

**目标**: ToolExecutor 支持权限检查回调，Bash 工具切换为沙箱版本。

### 2.1 ToolExecutor 权限检查 — `packages/core/src/tools/executor.ts`
- `executeOne()` 在 Zod 校验前插入权限检查：
  1. 从 `AsyncContext`（Node.js `AsyncLocalStorage`）获取 `PermissionGuard` 实例
  2. 如果存在 guard：调用 `guard.check(tool, input, context)`
  3. `decision.action === "deny"` → 返回 error（不执行工具）
  4. `decision.action === "allow"` / `"ask"` → 继续执行
  5. 如果 guard 不存在 → 跳过权限检查（向后兼容，Phase 4 启动时注入

### 2.2 AsyncContext 工具 — `packages/core/src/tools/async-context.ts`
- `AsyncLocalStorage` 单例实例
- `setAsyncContext(key, value)` — 存入
- `getAsyncContext(key)` — 取出
- 类型安全：`Map<string, unknown>` 存储

### 2.3 SandboxedBashTool — `packages/core/src/tools/builtin/bash.ts`
- 原有 `bashTool` 改为 `SandboxedBashTool` 类
- 构造接收 `Sandbox | null`
- `execute()` 方法：
  - 如果 `sandbox?.isAvailable()` → 通过 `sandbox.execute()` 执行命令
  - 否则 → 降级为直接 `execAsync()`（PermissionGuard 仍在生效）
- 保持 `Bash` 工具名和 Zod schema 不变（对 ToolRegistry 透明）

### 2.4 验证
- Phase 2 ToolExecutor 单元测试通过（无 guard 时跳过检查）
- Mock PermissionGuard，测试 deny 决策正确阻止执行

---

## Step 3: `safety/` 模块 — 权限防御 + Agent 沙箱

### 3.1 类型定义 — `packages/core/src/safety/types.ts`
- `PermissionDecision` 联合类型（`allow | deny | ask`）
- `PermissionRequest` 接口（`toolName`, `description`, `input`, `options`）
- `PermissionUI` 接口（`ask(request): Promise<PermissionDecision>`）
- `PermissionRule` 接口（`pattern`, `decision`, `match(toolName, input)`）

### 3.2 PermissionGuard — `packages/core/src/safety/permissions.ts`
- `PermissionGuard` 类：
  - `sessionCache: Map<string, PermissionDecision>`（会话级记忆）
  - `rules: PermissionRule[]`（全局规则，如 always-deny `rm -rf /`）
  - `check(tool, input, context)` — 四步决策链：
    1. `!tool.requiresApproval` → allow
    2. `matchRule()` 匹配全局规则 → 返回规则决策
    3. `sessionCache.get(cacheKey)` → 返回缓存决策
    4. `ui.ask({ toolName, description, input, options })` → 终端交互
  - `remember(key, decision)` — 存入会话缓存
  - `matchRule(toolName, input)` — 按注册顺序匹配全局规则
  - `cacheKey(toolName, input)` — 生成缓存键（工具名 + 命令/路径摘要）
- `permissionMiddleware(guard)` — 返回 Middleware：
  - `setAsyncContext("permissionGuard", guard)` → `next()`

### 3.3 Sandbox 接口 — `packages/core/src/safety/sandbox.ts`
- `Sandbox` 接口：
  - `name: string`
  - `execute(command, context): Promise<SandboxResult>`
  - `isAvailable(): boolean`
- `SandboxContext` 接口（`workingDirectory`, `allowedPaths`, `allowNetwork`, `env`, `timeoutMs`）
- `SandboxResult` 接口（`exitCode`, `stdout`, `stderr`, `sandboxIntervention?`）

### 3.4 macOS Seatbelt 实现 — `packages/core/src/safety/macos-sandbox.ts`
- `MacOSSandbox` 类实现 `Sandbox`：
  - `name = "macos-seatbelt"`
  - `isAvailable()` → `process.platform === "darwin"`
  - `execute(command, ctx)`：
    1. `buildProfile(ctx)` — 动态生成 Seatbelt profile
       - `(allow default)` + `(deny file-write*)` + 白名单路径
       - `/tmp`、`/private/tmp`、`/dev`、`/usr` 读写
       - 按 `allowNetwork` 开关 socket
    2. `spawn("sandbox-exec", ["-p", profile, "bash", "-c", command])`
    3. 等待退出，检测 stderr 中的沙箱拒绝信息
  - `detectIntervention(stderr)` — 匹配 `deny` 和 `sandbox` 关键词

### 3.5 沙箱选择器 — `packages/core/src/safety/sandbox-selector.ts`
- `createSandbox()` 函数：
  - 候选列表：`[new MacOSSandbox()]`
  - Linux seccomp / Docker / Windows 预留为注释（未来实现）
  - 遍历候选 → 返回第一个 `isAvailable()` 的
  - 全部不可用 → `console.warn + return null`

### 3.6 单元测试
- 测试 `PermissionGuard.check()` 四步决策链
- 测试 `permissionMiddleware` 正确注入 AsyncContext
- 测试 `MacOSSandbox.isAvailable()` 在 macOS 上返回 true
- Mock `PermissionUI`，测试用户选择 allow / deny / session
- 测试 `buildProfile()` 白名单正确限制

---

## Step 4: `context/` 模块 — 压缩 + Token 管理 + 溢写

### 4.1 TokenBudget — `packages/core/src/context/token-budget.ts`
- `TokenBudget` 类：
  - `modelMaxTokens: number`
  - `static RESERVED_OUTPUT = 4096`
  - `static COMPRESS_THRESHOLD = 0.85`
  - `shouldCompress(usedTokens)` — 是否超过 85% 阈值
  - `historyBudget(systemTokens)` — 对话历史可用预算
  - `count(text)` — 使用 Phase 1 的 TokenCounter 估算
  - `countMessages(messages)` — 遍历累加

### 4.2 Summarizer — `packages/core/src/context/summarizer.ts`
- `Summarizer` 类：
  - `summarize(messages: Message[])` — 调用 LLM 生成早期对话摘要
  - 将 messages 拼接为文本
  - 发送给 LLM 生成摘要（maxTokens: 500）
  - 返回 `{ role: "user", content: "[Earlier in this conversation]: <summary>" }`

### 4.3 ContextCompressor — `packages/core/src/context/compressor.ts`
- `ContextCompressor` 类：
  - `compress(conversation)` — 三步压缩策略：
    1. 计算 System Prompt token 数 → 超模型窗口 → 抛异常
    2. 对话历史未超预算 → 返回 `{ compressed: false }`
    3. Step 1: `trimOldest(history, historyBudget)` — 从最早消息对开始裁剪
    4. 裁剪后满足预算 → `replaceMessages(trimmed)` → 返回 `{ method: "trim" }`
    5. 裁剪后仍超限 → `summarizer.summarize(summaryCandidates)` → 摘要插入最前面 → `{ method: "summarize" }`
  - `trimOldest(messages, budget)`:
    - 从 index 0 开始移除 (user + assistant) 消息对
    - 保留最近若干轮
    - 返回 `{ trimmed, summaryCandidates }`
- `CompressResult` 接口（`compressed`, `messages`, `method?`）

### 4.4 contextMiddleware — `packages/core/src/context/compressor.ts`
- `contextMiddleware(compressor, conversation, eventBus)` — 返回 Middleware：
  - 事件类型为 `user-message` 时 → `compressor.compress(conversation)`
  - 压缩发生 → emit `{ type: "context-compressed", method }`

### 4.5 ContextOverflow — `packages/core/src/context/overflow.ts`
- `ContextOverflow` 类：
  - `static OVERFLOW_LENGTH = 10_000`
  - `overflowDir` — `.licode/overflow/`
  - `maybeOverflow(result)`:
    - 结果内容 ≥ 10K → 写入溢写文件
    - 返回截断版本（前 500 字符 + 文件路径引用）
    - 不超长 → 原样返回

### 4.6 单元测试
- 测试 `TokenBudget.shouldCompress()` 阈值判断
- 测试 `ContextCompressor.compress()` 三步策略（不超限 / 裁剪 / 摘要）
- 测试 `Summarizer.summarize()` 用 mock LLM
- 测试 `ContextOverflow.maybeOverflow()` 超长和正常场景
- 测试 `contextMiddleware` 在 `user-message` 事件时触发

---

## Step 5: `memory/` 模块 — 跨会话记忆

### 5.1 记忆类型 — `packages/core/src/memory/types.ts`
- `MemoryType` 类型：`"user" | "feedback" | "project" | "reference"`
- `Memory` 接口（`path`, `type`, `description`, `content`, `createdAt`, `updatedAt`）

### 5.2 MemoryStore — `packages/core/src/memory/store.ts`
- `MemoryStore` 类：
  - `constructor(baseDir)` — 用户级 (`~/.licode/memory/`) 或项目级 (`.licode/memory/`)
  - `save(memory)`:
    1. 确保目录存在（`mkdir -p`）
    2. 写入 Markdown 文件（YAML frontmatter + content body）
    3. 更新 `MEMORY.md` 索引（新增/更新入口行）
  - `load(path)` — 读取单个记忆文件，解析 frontmatter
  - `delete(path)` — 删除文件 + 从 MEMORY.md 移除入口
  - `search(query)` — 遍历 MEMORY.md 做 `includes` 文本匹配（Phase 4 不做向量搜索）
  - `listAll()` — 列出所有记忆
  - `loadIndex()` — 读取 MEMORY.md 全文（注入 System Prompt）
- 文件 I/O 全部使用 Node.js 内置 `fs/promises`

### 5.3 MemoryLoader — `packages/core/src/memory/loader.ts`
- `loadMemories(store, systemPrompt)`:
  - 调用 `store.loadIndex()`
  - 无内容 → 跳过
  - 有内容 → 添加 `SystemPromptLayer`
    - `name: "memory"`, `priority: 5`, `always: false`
    - content: `# User Memory\n\n${indexContent}`

### 5.4 MemoryExtractor — `packages/core/src/memory/extractor.ts`
- `MemoryExtractor` 类：
  - `shouldExtract(messages)` — 启发式判断：
    - 消息中包含 "remember" / "记住" / "别忘了" → 提取
    - 用户消息中有纠正模式（"no", "don't", "stop"） → 提取 feedback
    - 否则 → 不提取（减少不必要的 LLM 调用）
  - `extract(messages, store)`:
    1. 拼接提示词（要求 LLM 分析并输出 JSON）
    2. 调用 `llm.chat()` 分析对话
    3. 解析 LLM 返回的 JSON → `Memory[]`
    4. 逐个 `store.save()`
  - `parseMemoryFindings(response)` — 解析 LLM JSON 输出（容错处理 "none"）

### 5.5 单元测试
- 测试 `MemoryStore.save()` + `load()` 往返一致
- 测试 `MemoryStore.delete()` 正确移除入口
- 测试 `MemoryStore.loadIndex()` 返回 MEMORY.md 内容
- 测试 `loadMemories()` 正确注入 SystemPromptLayer
- 测试 `MemoryExtractor.shouldExtract()` 启发式判断
- Mock LLM，测试 `MemoryExtractor.extract()` 解析 JSON 输出

---

## Step 6: `session/` 模块 — 多会话管理 + 中断恢复

### 6.1 SessionManager — `packages/core/src/session/manager.ts`
- `SessionManager` 类：
  - `sessionDir` — `.licode/sessions/`
  - `create(metadata)` — 创建 ConversationManager 新实例 + save
  - `resume(id)` — 调用 `ConversationManager.load()`
  - `list(filter?)` — 扫描 `sessionDir` 下所有 JSON，解析元数据
    - filter: `{ status?: "active" | "completed" | "archived" }`
  - `delete(id)` — 删除 JSON 文件
  - `recoverFromCrash()` — 等同于 `list({ status: "active" })`，返回中断的会话列表
- `SessionSummary` 接口（`id`, `title?`, `createdAt`, `updatedAt`, `messageCount`, `model`, `status`）
- `SessionMetadata` 接口（`title?`, `tags?`, `model`）

### 6.2 会话状态标记 — `packages/core/src/session/persistence.ts`
- `SessionData` 接口（在 Phase 1 的 JSON 格式上扩展）：
  - 新增 `status: "active" | "completed" | "archived"`
  - 新增 `lastCompletedAt: string | null`
- `ConversationManager.save()` 在 Phase 1 基础上写入 status 字段
  - Agent Loop 开始时 → `status = "active"`
  - Agent Loop 完成后 → `status = "completed"`, `lastCompletedAt = now`
- 会话文件大小时自动管理：
  - 超过 1000 条消息 → 保存摘要版（最近 100 条 + 早期摘要）

### 6.3 中断恢复 — `packages/core/src/session/recovery.ts`
- `tryRecover(sessionManager)` — 交互流程：
  1. 调用 `sessionManager.list({ status: "active" })`
  2. 无中断会话 → 创建新会话
  3. 有中断会话 → 返回中断会话列表（由 CLI 询问用户是否恢复）
  4. 用户确认 → `resume(id)`
  5. 用户拒绝 → `create()`

### 6.4 单元测试
- 测试 `SessionManager.create()` + `resume()` 往返
- 测试 `SessionManager.list()` 状态过滤
- 测试 `SessionManager.delete()` 删除
- 测试 `tryRecover()` 无中断 / 有中断的场景

---

## Step 7: CLI 集成

### 7.1 CLIPermissionUI — `packages/cli/src/components/permission-dialog.tsx`
- `CLIPermissionUI` 类实现 `PermissionUI`：
  - `ask(request)`:
    1. 暂停正常输入
    2. 显示审批界面：
       ```
       ⚠ Bash wants to run:
         $ rm -rf node_modules

       Allow? [y]es / [n]o / [s] yes, remember for this session
       ```
    3. 等待用户按键（`y`/`n`/`s`）
    4. 返回 `PermissionDecision`

### 7.2 启动流程更新 — `packages/cli/src/app.tsx`
- `initializeLICode()` 完整流程：
  1. Phase 1: LLM + SystemPrompt + ConversationManager
  2. **Phase 4**: `loadMemories()` 注入 System Prompt
  3. **Phase 4**: `tryRecover()` 检查中断会话
  4. Phase 2: ToolRegistry + `SandboxedBashTool(sandbox)` + 内置工具
  5. Phase 3: MCP + Skill + Hook + Command（代码不变）
  6. **Phase 4**: `createSandbox()` + `PermissionGuard` + `CLIPermissionUI`
  7. **Phase 4**: `TokenBudget` + `Summarizer` + `ContextCompressor` + `ContextOverflow`
  8. **Phase 4**: `MemoryExtractor` 实例化
  9. `assemblePipeline()` 组装

### 7.3 assemblePipeline 扩展 — `packages/core/src/extensions/hooks/manager.ts`
- Phase 3 的 `assemblePipeline` 扩展参数：
  - 接受 `permissionGuard` 和 `contextCompressor` 参数
  - 在 `tokenCounting` 之后插入 `permissionMiddleware(guard)`
  - 在 `permissionGuard` 之后、`agentLoop` 之前插入 `contextMiddleware(compressor, conversation, eventBus)`
- 最终管道结构：
  ```
  .use("hook:before:logging", ...)
  .use("logging", loggingMiddleware)
  .use("hook:after:logging", ...)
  .use("tokenCounting", tokenCountingMiddleware)
  .use("permissionGuard", permissionMiddleware(guard))          // Phase 4
  .use("contextCompressor", contextMiddleware(compressor, ...)) // Phase 4
  .use("hook:before:agentLoop", ...)
  .use("agentLoop", agentLoopMiddleware)
  .use("hook:after:agentLoop", ...)
  .use("renderer", rendererMiddleware)
  .use("errorHandler", errorHandlerMiddleware)
  ```

### 7.4 Agent Loop 完成后 — MemoryExtractor 调用
- `AgentLoop.run()` 完成后（返回 `stream-complete` 事件前）：
  - 调用 `memoryExtractor.shouldExtract(messages)`
  - 如果 true → `memoryExtractor.extract(messages, memoryStore)`
  - 提取在后台执行，不阻塞管道

### 7.5 溢写集成 — ToolExecutor
- `ToolExecutor.executeOne()` 返回结果后：
  - 调用 `overflow.maybeOverflow(result)`
  - 超长结果自动截断 + 写入文件

### 7.6 验证（手动测试）
- 启动 LICode，输入需要 Bash 的命令，验证权限弹窗
- 选择 "remember for this session" 后再试同样的命令，验证不再弹窗
- 长对话（>50轮），验证上下文压缩发生时 UI 通知
- 关闭终端，重新启动，验证中断恢复提示
- 检查 `~/.licode/memory/` 下是否有自动提取的记忆文件
- 检查超长工具输出是否溢写到 `.licode/overflow/`

---

## Step 8: 集成收尾

### 8.1 `@licode/core` 公开导出更新 — `packages/core/src/index.ts`
```typescript
// Phase 4 Safety
export { PermissionGuard, permissionMiddleware } from './safety/permissions';
export type { PermissionDecision, PermissionUI, PermissionRequest } from './safety/types';
export type { Sandbox, SandboxContext, SandboxResult } from './safety/sandbox';
export { MacOSSandbox } from './safety/macos-sandbox';
export { createSandbox } from './safety/sandbox-selector';

// Phase 4 Context
export { ContextCompressor, contextMiddleware } from './context/compressor';
export type { CompressResult } from './context/compressor';
export { TokenBudget } from './context/token-budget';
export { ContextOverflow } from './context/overflow';
export { Summarizer } from './context/summarizer';

// Phase 4 Memory
export { MemoryStore } from './memory/store';
export { loadMemories } from './memory/loader';
export { MemoryExtractor } from './memory/extractor';
export type { Memory, MemoryType } from './memory/types';

// Phase 4 Session
export { SessionManager } from './session/manager';
export type { SessionSummary, SessionMetadata } from './session/manager';
export { tryRecover } from './session/recovery';
```

### 8.2 端到端验证
1. `pnpm build` 无错误
2. Phase 1-3 所有单元测试通过（回归检查）
3. Bash 工具执行前终端弹窗审批
4. macOS 上沙箱生效（测试越权 `rm` → 被 sandbox-exec 拦截）
5. 无沙箱 OS 降级正常（PermissionGuard 仍在生效）
6. 长对话自动压缩（观察 `context-compressed` 事件）
7. 跨会话记忆：关闭重启后仍记得用户偏好
8. 中断恢复：会话列表展示 + 选择恢复

---

## 验证清单

- [ ] Phase 1-3 所有单元测试通过（回归检查）
- [ ] `SystemPrompt.assemble()` 不再接受 budget 参数
- [ ] `ConversationManager.getSystemPrompt()` / `replaceMessages()` 正确
- [ ] `ToolExecutor.executeOne()` 正确回调 PermissionGuard
- [ ] `PermissionGuard.check()` 四步决策链正确
- [ ] `CLIPermissionUI` 终端交互正确（y/n/s）
- [ ] `MacOSSandbox.execute()` 在 macOS 上正确限制文件写入
- [ ] `ContextCompressor.compress()` 三步策略正确（不超限/裁剪/摘要）
- [ ] `ContextOverflow.maybeOverflow()` 超长输出正确截断
- [ ] `MemoryStore.save()` / `load()` / `delete()` 往返正确
- [ ] `MemoryLoader` 正确注入 System Prompt
- [ ] `MemoryExtractor.shouldExtract()` 触发逻辑合理
- [ ] `SessionManager.create()` / `resume()` / `list()` / `delete()` 正确
- [ ] `tryRecover()` 中断会话恢复流程正确
- [ ] `assemblePipeline` 正确注入 permission 和 context 中间件
- [ ] 整体启动流程正确：记忆 → 恢复 → 工具 → 扩展 → guard → 压缩 → pipeline

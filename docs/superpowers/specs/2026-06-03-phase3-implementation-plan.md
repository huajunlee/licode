# Phase 3 实现计划：能力扩展协议

**日期**: 2026-06-03
**设计文档**: `docs/superpowers/specs/2026-06-01-phase3-extensions-design.md`
**前置**: Phase 1（核心对话引擎）+ Phase 2（Agent 核心机制）已完成

---

## Context

Phase 1 让 LICode "能说话"，Phase 2 让它"能动手"。Phase 3 让它"能扩展"——Agent 的能力不再局限于 6 个内置工具，而是可以通过 MCP 协议、Skill 技能包、Slash Command 和 Hook 四个扩展协议无限扩展。

核心设计原则：**Phase 2 零改动。** 所有新能力通过 ToolRegistry 和 EventPipeline 的已有接口接入。四个子系统（MCP、Skill、Command、Hook）互不依赖，可以并行构建。

---

## 实现顺序（依赖关系）

```
1. 共享基础设施 (新增依赖 + EventPipeline 命名中间件)
   ↓
2. 四个子系统并行 (MCP / Skill / Command / Hook 互不依赖)
   ├── 2a. MCP Client
   ├── 2b. Skill 技能包
   ├── 2c. Slash Command
   └── 2d. Hook 钩子
   ↓
3. CLI 集成 (启动流程 + InputBox 拦截 / 命令 + pipeline 组装)
   ↓
4. 集成收尾 (公开导出 + 端到端验证)
```

---

## Step 1: 共享基础设施

**目标**: 新增依赖、EventPipeline 支持命名中间件、创建 extensions 目录骨架。

### 1.1 新增依赖 — `packages/core/package.json`
- 添加 `@modelcontextprotocol/sdk` ^1.0（MCP JSON-RPC 客户端）
- 添加 `js-yaml` ^4（YAML frontmatter 解析 skill.md）
- 添加 `@types/js-yaml` ^4（TypeScript 类型）

### 1.2 EventPipeline 命名中间件支持 — `packages/core/src/events/pipeline.ts`
- `use()` 方法新增重载：`use(name: string, mw: Middleware): this`
- 保持向后兼容：`use(mw: Middleware): this`（自动生成名字或使用无名字注册）
- 内部 `middlewares` 从 `Middleware[]` 改为 `Array<{ name: string; mw: Middleware }>`
- `run()` 行为不变——按注册顺序执行

### 1.3 创建 extensions 目录骨架
- `packages/core/src/extensions/mcp/` — 空占位
- `packages/core/src/extensions/skills/` — 空占位
- `packages/core/src/extensions/commands/` — 空占位
- `packages/core/src/extensions/hooks/` — 空占位

### 1.4 验证
- Phase 2 单元测试全部通过（命名中间件向后兼容）
- `pnpm install` 新依赖成功

---

## Step 2a: MCP Client 模块

**目标**: 实现 MCPClientManager、传输层（stdio + SSE）、MCP → Tool 适配器。

### 2a.1 传输层 — `packages/core/src/extensions/mcp/transport.ts`
- `MCPTransport` 接口（`connect`, `send`, `onMessage`, `disconnect`）
- `StdioTransport` 类：
  - 构造：`command`, `args`, `env`
  - `connect()`: `spawn(command, args)` → 通过 stdin/stdout 通信
  - 缓冲管理：拼接 JSON-RPC 消息（换行分隔的 JSON）
- `SSETransport` 类：
  - 构造：`url`, `headers`
  - `connect()`: HTTP POST 到 /message 端点 + GET /sse 接收事件
  - 简单实现即可，不需要完整的 EventSource 客户端

### 2a.2 MCP 连接 — `packages/core/src/extensions/mcp/client.ts`
- `MCPServerConnection` 类：
  - `start()`:
    1. `transport.connect()`
    2. 发送 `initialize` 请求 → 接收 `initialized` 响应
    3. 发送 `tools/list` 请求 → 接收工具列表
    4. 每个 MCP Tool → `mcpToolToAdapter()` 包装
  - `callTool(name, args)`: 发送 `tools/call` 请求 → 接收结果
  - `stop()`: `transport.disconnect()`
  - JSON-RPC 消息格式：`{ jsonrpc: "2.0", id, method, params }`
- `MCPClientManager` 类：
  - `servers: Map<string, MCPServerConnection>`
  - `initialize(config)`: 遍历 `config.mcpServers` → 每个调用 `connect()` → `start()`
  - `getTools()`: 遍历所有 servers → 收集其工具（扁平化为 `Tool[]`）
  - `listServers()`: 返回服务器状态列表
  - `disconnect(name)`: 断开单个服务器
  - 连接失败的服务器记录错误但不阻止其他服务器连接

### 2a.3 MCP → Tool 适配器 — `packages/core/src/extensions/mcp/adapter.ts`
- `mcpToolToAdapter(mcpTool, serverName, connection)`:
  - 工具名：`mcp__${serverName}__${mcpTool.name}`
  - 描述：`[MCP:${serverName}] ${mcpTool.description}`
  - parameters: `jsonSchemaToZod(mcpTool.inputSchema)` — JSON Schema → Zod schema
  - execute: 调用 `connection.callTool()`，结果映射到 `ToolResult`

### 2a.4 配置解析 — `packages/core/src/extensions/mcp/config.ts`
- `loadMCPConfig()`: 读取 `.licode/mcp.json`
- `MCPServerConfig` 接口（`name`, `transport`, `command?`, `args?`, `url?`, `headers?`, `env?`）
- 环境变量支持：`headers` 中的 `${VAR}` 替换为 `process.env.VAR`
- 文件不存在 → 返回空配置（不报错）

### 2a.5 单元测试
- 测试 `StdioTransport` 启动子进程并通信
- 测试 `MCPServerConnection.start()` 握手流程
- 测试 `mcpToolToAdapter()` 包装正确性
- 测试 `loadMCPConfig()` 解析正确

---

## Step 2b: Skill 技能包模块

**目标**: 实现 SkillLoader、skill.md 解析器、Skill → Tool 适配器。

### 2b.1 Skill 解析 — `packages/core/src/extensions/skills/parser.ts`
- `parseYamlFrontmatter(raw)`:
  - 正则提取 `---\n...\n---` 之间的 YAML
  - 使用 `js-yaml` 解析 frontmatter
  - 返回 `{ frontmatter, body }`
- `skillParamsToZod(params)`:
  - 将 YAML 参数定义 → Zod schema
  - 基础类型映射：`string` → `z.string()`, `number` → `z.number()`, `boolean` → `z.boolean()`
  - 保留 `.describe()` 和 `.default()`

### 2b.2 SkillLoader — `packages/core/src/extensions/skills/loader.ts`
- `SkillLoader` 类：
  - `loadAll()`:
    1. 扫描 `~/.licode/skills/`（用户级）
    2. 扫描 `.licode/skills/`（项目级）
    3. 每个子文件夹 → `loadSkill(dir)`
    4. 项目级覆盖用户级同名 Skill
  - `loadSkill(dir)`:
    1. 检查 `skill.md` 是否存在
    2. `parseYamlFrontmatter()`
    3. 返回 `Skill` 对象
- `Skill` 接口（`name`, `version`, `description`, `tools`, `dir`）
- `SkillToolDef` 接口（`name`, `description`, `parameters`, `script`）

### 2b.3 Skill → Tool 适配器 — `packages/core/src/extensions/skills/adapter.ts`
- `skillToolToAdapter(skillTool, skillDir)`:
  - 工具名：`skill__${skillTool.name}`
  - `execute()`: `spawn(scriptPath)` → stdin 传 JSON → 等待退出 → 返回结果
  - 状态码 0 = success，非 0 = error
- `skillToPromptLayer(skill)`:
  - 返回 `SystemPromptLayer`
  - `name: "skill:${skill.name}"`, `priority: 15`
  - content: skill.md 的 Markdown 正文

### 2b.4 单元测试
- 测试 `parseYamlFrontmatter()` 正确提取 frontmatter 和 body
- 测试 `SkillLoader.loadSkill()` 加载示例 Skill 文件夹
- 测试 `skillToolToAdapter()` 包装正确性
- 测试项目级覆盖用户级逻辑

---

## Step 2c: Slash Command 模块

**目标**: 实现 Command 接口、CommandRouter、4 个内置命令。

### 2c.1 Command 注册表 — `packages/core/src/extensions/commands/registry.ts`
- `SlashCommand` 接口（`name`, `description`, `args?`, `execute()`）
- `CommandContext` 接口（`conversation`, `toolRegistry`, `workingDirectory`）
- `CommandResult` 联合类型（`prompt | action | error`）

### 2c.2 CommandRouter — `packages/core/src/extensions/commands/router.ts`
- `CommandRouter` 类：
  - `register(cmd)` / `registerAll(cmds)` — 注册
  - `list()` — 返回所有注册的命令
  - `route(input, context)`:
    1. 不以 `/` 开头 → 返回 null（走正常对话）
    2. 以 `/` 开头 → 解析命令名 + 参数
    3. 查找命令 → 找到就执行
    4. 找不到 → 返回 error（`Unknown command: /xxx`）

### 2c.3 内置命令 — `packages/core/src/extensions/commands/builtin/`

**help.ts:**
- 遍历 `commandRouter.list()` → 格式化为 `/name — description`
- 返回 `{ type: "action", message }`

**clear.ts:**
- 调用 `context.conversation.clear()`（需要在 ConversationManager 新增此方法）
- 返回 `{ type: "action", message: "Conversation cleared." }`

**context.ts:**
- 调用 `context.conversation.getTokenCount()` / `getMessageCount()`
- 格式化输出：模型名 · Token 用量 · 消息数 · 会话 ID
- 返回 `{ type: "action", message }`

**memory.ts:**
- Phase 4 实现具体逻辑，Phase 3 返回占位信息
- `{ type: "action", message: "Memory management will be available in a future update." }`

### 2c.4 验证
- 测试 `CommandRouter.route()` 正确拦截 `/help` 并返回命令列表
- 测试 `/nonexistent` 返回错误
- 测试普通文本（不以 / 开头）返回 null

---

## Step 2d: Hook 钩子模块

**目标**: 实现 Hook 类型、HookManager（按 position 分组 + 事件匹配）、hookMiddleware。

### 2d.1 Hook 类型 — `packages/core/src/extensions/hooks/types.ts`
- `HookPosition` 类型：`` `before:${string}` | `after:${string}` ``
- `HookConfig` 接口（`events`, `command`, `position?`, `timeout?`, `blocking?`）
- `RegisteredHook` 接口（extends HookConfig + `name`, `resolvedPosition`）

### 2d.2 HookManager — `packages/core/src/extensions/hooks/manager.ts`
- `HookManager` 类：
  - `groups: Map<HookPosition, RegisteredHook[]>`
  - `load(configs)`:
    1. 遍历 configs
    2. `resolvePosition(config.position ?? "before:agentLoop")`
    3. 按 position 分组存入 `groups`
  - `getHooksAt(position)` — 返回该位置的 Hook 数组
  - `getPositions()` — 返回所有有注册 Hook 的位置
  - `onEvent(event, hooks)`:
    1. `hooks.filter(h => matches(h.events, event.type))`
    2. 每个匹配的 Hook → `spawn(command)` → stdin 传 event JSON
    3. blocking Hook → 等待退出
    4. 非阻塞 → fire and forget
    5. `Promise.allSettled` — Hook 异常不向上传播
  - `matches(patterns, eventType)`:
    - 正则匹配：`*` → `.*`

### 2d.3 resolvePosition — 别名解析
- `"pre-agent"` → `"before:agentLoop"`
- `"post-agent"` → `"after:agentLoop"`
- `"post-render"` → `"after:renderer"`
- 其他直接透传

### 2d.4 hookMiddleware — `packages/core/src/extensions/hooks/manager.ts`
- `hookMiddleware(hooks, position)`:
  - `getHooksAt(position)` → 如果为空数组，返回透传中间件 `(event, next) => next()`
  - 否则返回标准中间件：`hooks.onEvent(event, hooksAtPosition)` → `next()`
  - 始终调用 `next()`，不拦截事件

### 2d.5 单元测试
- 测试 `HookManager.load()` 正确按 position 分组
- 测试 `matches()` 通配符逻辑
- 测试 `hookMiddleware` 在无注册 Hook 位置返回透传
- 测试 Hook 脚本失败不影响管道

---

## Step 3: CLI 集成

**目标**: 将 Phase 3 的四个子系统集成到启动流程和 CLI 交互中。

### 3.1 InputBox 集成 CommandRouter — `packages/cli/src/components/input-box.tsx`
- 提交输入前先经 `commandRouter.route(input, context)`
- 如果不是命令（返回 null）→ 正常进入 EventPipeline
- 如果是命令 `{ type: "prompt" }` → 将 prompt 内容作为 Agent Loop 输入
- 如果是命令 `{ type: "action" }` → 显示 message
- 如果是命令 `{ type: "error" }` → 显示错误

具体交互流程：
```typescript
async function handleInput(input: string, ctx: AppContext) {
  const cmdResult = await ctx.commandRouter.route(input, ctx.commandContext);
  if (cmdResult === null) {
    // 普通对话
    ctx.pipeline.run(generateEvents(input));
  } else if (cmdResult.type === "prompt") {
    // 命令返回的 prompt 注入 Agent
    ctx.pipeline.run(generateEvents(cmdResult.content));
  } else {
    // action 或 error → 显示消息
    ctx.showMessage(cmdResult.message, cmdResult.type);
  }
}
```

### 3.2 Pipeline 组装 — `packages/cli/src/app.tsx`
- 使用 `assemblePipeline(hookManager, agentConfig)` 替代手动 `.use()` 链
- `assemblePipeline` 为每个有 hook 注册的位置自动插入 `hookMiddleware`
- 管道结构：
  ```
  .use("logging", loggingMiddleware)
  .use("tokenCounting", tokenCountingMiddleware)
  .use("hook:before:agentLoop", ...)    // (如有注册)
  .use("agentLoop", agentLoopMiddleware)
  .use("hook:after:agentLoop", ...)     // (如有注册)
  .use("renderer", rendererMiddleware)
  .use("errorHandler", errorHandlerMiddleware)
  ```

### 3.3 启动流程 — `packages/cli/src/app.tsx`
完整的 `initializeLICode()` 函数：
1. Phase 1: LLM + SystemPrompt + ConversationManager
2. Phase 2: ToolRegistry + 内置工具
3. Phase 3a: MCPClientManager.initialize() → 注册 MCP 工具
4. Phase 3b: SkillLoader.loadAll() → 注册 Skill 工具 + 注入 Prompt
5. Phase 3c: HookManager.load() → 按 position 分组
6. Phase 3d: CommandRouter 注册内置命令
7. Phase 2+3: assemblePipeline()

### 3.4 ConversationManager 扩展 — `packages/core/src/conversation/manager.ts`
- 新增 `clear()` 方法：清空消息数组（/clear 命令需要）
- 新增 `getStats()` 方法：返回 `{ tokenCount, messageCount, model, sessionId }`（/context 命令需要）

### 3.5 验证（手动测试）
1. 启动 LICode，输入 `/help` → 显示命令列表
2. 输入 `/clear` → 对话历史清空
3. 输入 `/context` → 显示统计信息
4. 配合一个测试 MCP 服务器 → 检查工具列表是否包含 `mcp__` 前缀的工具
5. 放入一个测试 Skill 文件夹 → 检查工具列表是否包含 `skill__` 前缀的工具
6. 配置一个 Hook（`events: ["*"], command: "echo test"`），验证事件触发时执行

---

## Step 4: 集成收尾

### 4.1 `@licode/core` 公开导出更新 — `packages/core/src/index.ts`
```typescript
// Phase 3 MCP
export { MCPClientManager } from './extensions/mcp/client';
export type { MCPServerConfig, ServerStatus } from './extensions/mcp/client';
export { StdioTransport, SSETransport } from './extensions/mcp/transport';
export type { MCPTransport } from './extensions/mcp/transport';

// Phase 3 Skill
export { SkillLoader } from './extensions/skills/loader';
export { skillToolToAdapter, skillToPromptLayer } from './extensions/skills/adapter';

// Phase 3 Command
export { CommandRouter } from './extensions/commands/router';
export type { SlashCommand, CommandContext, CommandResult } from './extensions/commands/registry';

// Phase 3 Hook
export { HookManager, hookMiddleware, resolvePosition, assemblePipeline } from './extensions/hooks/manager';
export type { HookConfig, HookPosition, RegisteredHook } from './extensions/hooks/types';
```

### 4.2 端到端验证
1. `pnpm build` 无错误
2. 所有 Phase 2 单元测试通过（回归检查）
3. `/help`、`/clear`、`/context` 命令正常工作
4. MCP 工具在工具列表中可见（如果有配置的服务器）
5. Skill 工具在工具列表中可见（如果 .licode/skills/ 下有 Skill）
6. Hook 在事件触发时执行且不影响 Agent 正常运行

---

## 验证清单

- [ ] Phase 2 单元测试全部通过（Phase 3 无回归）
- [ ] EventPipeline 命名中间件向后兼容
- [ ] `MCPClientManager.initialize()` 成功连接 stdio 服务器
- [ ] `mcpToolToAdapter()` 正确映射 JSON Schema → Zod
- [ ] `SkillLoader.loadAll()` 正确扫描 + 解析 + 覆盖逻辑
- [ ] `skillToolToAdapter()` 正确包装脚本执行为 Tool
- [ ] `CommandRouter.route()` 正确拦截 `/` 命令
- [ ] `/help`、`/clear`、`/context` 命令正常工作
- [ ] `HookManager` 正确按 position 分组 + 事件匹配
- [ ] `hookMiddleware` 透传优化：无 Hook 位置不插入中间件
- [ ] Hook 执行失败不影响 Agent 正常运行
- [ ] 启动流程正确：MCP → Skill → Hook → Command → Pipeline

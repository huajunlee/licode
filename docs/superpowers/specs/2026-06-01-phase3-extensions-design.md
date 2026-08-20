# Phase 3: 能力扩展协议 — 设计文档

**日期**: 2026-06-01
**状态**: 已确认
**范围**: LICode Phase 3 — MCP 协议、Skill 技能包、Slash Command 命令框架、Hook 生命周期钩子

---

## 0. Phase 3 在全局中的位置

Phase 1 让 LICode "能说话"，Phase 2 让它"能动手"。Phase 3 让它"能扩展"——Agent 的能力不再局限于 6 个内置工具，而是可以通过 MCP 协议、Skill 技能包、Slash Command 和 Hook 四个扩展协议无限扩展。

Phase 3 依赖 Phase 2 的两个基础设施：
- **ToolRegistry** — MCP 和 Skill 的工具最终都注册到这里，AgentLoop 不关心工具来源
- **EventPipeline** — Hook 作为中间件插入，Command 在 CLI 层解析后触发 Agent Loop

**Phase 3 的核心设计原则：Phase 2 零改动。** 所有新能力通过已有接口接入。ToolRegistry 不知道 MCP 或 Skill 的存在——它只管接收 Tool 实例。EventPipeline 不知道 Hook 的存在——它只管执行中间件链。

| 如果 Phase 3 的... | 做好了 | 做坏了 |
|---|---|---|
| MCP Client 适配 | 加一个 MCP 服务器 = 自动获得一批工具 | 每个 MCP 服务器需要手动写适配代码 |
| Skill 加载器 | 放一个文件夹就启用一个 Skill | 需要修改 LICode 源码才能加新功能 |
| Command 路由 | 用户 /help 列出所有可用命令 | 命令和正常对话混在一起，LLM 混淆 |
| Hook 管理器 | 用户自定义自动化工作流 | Hook 失败导致 Agent 崩溃 |

**Phase 3 完成标志：**
- MCP 服务器连接后，其工具自动出现在 LLM 可用工具列表中
- Skill 文件夹放入 `.licode/skills/` 后，启动即可用
- `/help`、`/clear`、`/context` 命令可正常工作
- Hook 脚本在匹配事件时自动触发

---

## 1. 架构总览

Phase 3 在 `@licode/core` 中新增 `extensions/` 模块，包含四个子系统：

```
@licode/core/src/extensions/
├── mcp/           # MCP 协议客户端
│   ├── client.ts        # MCPClientManager 连接管理 + 工具发现
│   ├── transport.ts     # Transport 层（stdio / SSE）
│   ├── adapter.ts       # MCP tool → Tool 接口适配器
│   └── config.ts        # MCP 服务器配置解析（.licode/mcp.json）
├── skills/        # Skill 技能包系统
│   ├── loader.ts        # SkillLoader 扫描 + 解析 Skill 目录
│   ├── parser.ts        # Skill 定义解析（YAML frontmatter）
│   ├── adapter.ts       # Skill → Tool 接口适配器
│   └── registry.ts      # Skill 注册表
├── commands/      # Slash Command 命令框架
│   ├── router.ts        # CommandRouter 解析 + 路由 /command
│   ├── registry.ts      # Command 注册表
│   └── builtin/         # 内置 Slash Command
│       ├── help.ts
│       ├── clear.ts
│       ├── context.ts
│       └── memory.ts
└── hooks/         # Hook 生命周期钩子
    ├── manager.ts       # HookManager 事件匹配 + 脚本执行
    ├── loader.ts        # Hook 加载（从 settings.json）
    └── types.ts         # Hook 配置类型
```

**关键设计决策：**

| 决策 | 选择 |
|------|------|
| MCP 实现范围 | 仅 MCP Client |
| Skill 加载机制 | 文件系统约定目录（用户级 + 项目级） |
| Hook 触发模型 | 事件匹配模式 + Shell 脚本 |
| 架构集成方式 | 统一工具注册模型（MCP/Skill → ToolRegistry，Hook → EventPipeline） |

**四个子系统的接入方式：**

```
                    ┌─────────────────────┐
                    │    ToolRegistry     │
                    │   (Phase 2 核心)     │
                    └─────────┬───────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
    ┌─────▼─────┐     ┌──────▼──────┐     ┌─────▼─────┐
    │   MCP     │     │    Skill    │     │  Builtin  │
    │  Adapter  │     │   Loader    │     │   Tools   │
    │           │     │            │     │ (Phase 2) │
    │ 外部服务器  │     │ 本地 Skill  │     │           │
    │ 工具 动态   │     │ 目录 扫描   │     │            │
    │ 注册/注销  │     │ 包装为 Tool │     │            │
    └───────────┘     └────────────┘     └───────────┘

Hook 系统作为 EventPipeline 的分布式中间件，按 position 插入管道各处：

    EventPipeline
      ├── hook:before:agentLoop (通知类 Hook，看到工具调用)
      ├── logging
      ├── tokenCounting
      ├── agentLoop
      ├── hook:after:agentLoop (CI/CD 类 Hook，只看到最终结果)
      ├── renderer
      └── errorHandler

Slash Command 在 CLI 层解析，注入上下文后触发 Agent Loop：

    User: "/review" → CommandRouter → 注入 prompt → AgentLoop.run()
```

---

## 2. 对 Phase 1 & 2 的改动

Phase 3 对已有代码的改动为零。ToolRegistry 和 EventPipeline 的接口不需要任何修改。

仅需新增启动流程：LICode 启动时依次初始化 MCP → Skill → Command → Hook，将它们的产物注册到已有基础设施中。

```
启动顺序:
  1. 初始化 Phase 1（LLM, Conversation, SystemPrompt）
  2. 初始化 Phase 2（ToolRegistry, 内置工具）
  3. 初始化 MCP（连接服务器 → 注册工具）
  4. 初始化 Skill（扫描目录 → 注册工具 + SystemPrompt 层）
  5. 初始化 Hook（加载配置 → 注册中间件）
  6. 初始化 Command（注册内置命令）
  7. 组装 EventPipeline
```

---

## 3. MCP Client

### 3.1 概述

LICode 作为 MCP 客户端，连接到外部 MCP 服务器，发现它们提供的工具，并将这些工具包装为 LICode 的 `Tool` 接口，注册到 ToolRegistry。

### 3.2 MCPClientManager (`mcp/client.ts`)

```typescript
class MCPClientManager {
  private servers: Map<string, MCPServerConnection> = new Map();

  /** 从配置文件初始化所有 MCP 服务器连接 */
  async initialize(config: MCPConfig): Promise<void>;

  /** 连接单个服务器 */
  async connect(config: MCPServerConfig): Promise<void>;

  /** 断开单个服务器 */
  async disconnect(name: string): Promise<void>;

  /** 获取所有已连接服务器提供的工具 */
  getTools(): Tool[];

  /** 列出所有服务器状态 */
  listServers(): ServerStatus[];
}

interface MCPServerConfig {
  name: string;
  transport: "stdio" | "sse";
  command?: string;             // stdio 模式
  args?: string[];              // stdio 模式
  url?: string;                 // SSE 模式
  headers?: Record<string, string>;  // SSE 模式
  env?: Record<string, string>;
}

interface ServerStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}
```

### 3.3 MCPServerConnection

```typescript
class MCPServerConnection {
  readonly name: string;
  private transport: MCPTransport;
  private tools: Tool[] = [];

  /** 建立连接，握手，发现工具 */
  async start(): Promise<void> {
    await this.transport.connect();
    // MCP 协议握手: initialize → initialized
    await this.handshake();
    // 列出服务器提供的工具: tools/list
    const serverTools = await this.listTools();
    // 包装为 Tool 接口
    this.tools = serverTools.map((t) => mcpToolToAdapter(t, this.name));
  }

  /** 执行工具调用 —— 发送 tools/call 请求 */
  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<MCPToolResult>;

  async stop(): Promise<void>;
}
```

### 3.4 传输层 (`mcp/transport.ts`)

```typescript
interface MCPTransport {
  connect(): Promise<void>;
  send(message: JSONRPCMessage): Promise<void>;
  onMessage(handler: (msg: JSONRPCMessage) => void): void;
  disconnect(): Promise<void>;
}

// stdio 传输 —— 启动子进程，通过 stdin/stdout 通信（本地 MCP 服务器）
class StdioTransport implements MCPTransport {
  constructor(command: string, args: string[], env?: Record<string, string>);
}

// SSE 传输 —— 通过 HTTP SSE 连接远程 MCP 服务器
class SSETransport implements MCPTransport {
  constructor(url: string, headers?: Record<string, string>);
}
```

### 3.5 MCP → Tool 适配器 (`mcp/adapter.ts`)

```typescript
// 将 MCP 服务器提供的 tool 包装为 LICode Tool 接口
// 适配器持有对连接的引用，确保工具执行时可访问
function mcpToolToAdapter(
  mcpTool: MCPTool,
  serverName: string,
  connection: MCPServerConnection
): Tool {
  return {
    // 命名空间隔离：mcp__<server>__<tool>
    name: `mcp__${serverName}__${mcpTool.name}`,
    description: `[MCP:${serverName}] ${mcpTool.description}`,
    parameters: jsonSchemaToZod(mcpTool.inputSchema),

    async execute(input, context) {
      const result = await connection.callTool(mcpTool.name, input);
      return {
        status: result.isError ? "error" : "success",
        content: result.content.map((c) => c.text).join("\n"),
      };
    },
  };
}
```

### 3.6 MCP 配置文件

```json
// .licode/mcp.json
{
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@anthropic-ai/mcp-server-filesystem", "/path/to/allowed"],
      "env": {}
    },
    "database": {
      "transport": "sse",
      "url": "http://localhost:3001/sse",
      "headers": {
        "Authorization": "Bearer ${DB_TOKEN}"
      }
    }
  }
}
```

环境变量支持 `${VAR}` 语法，在连接时替换为实际值。

---

## 4. Skill 技能包系统

### 4.1 概述

Skill 是本地文件系统中的文件夹，包含一个 `skill.md` 定义文件和可选的 `scripts/` 脚本目录。LICode 启动时扫描两个约定的目录：

- `~/.licode/skills/` — 用户级 Skill（对所有项目可用）
- `.licode/skills/` — 项目级 Skill（仅对当前项目可用）

每个 Skill 可以定义多个工具，同时其 `skill.md` 的 Markdown 正文会被注入 System Prompt。

### 4.2 Skill 目录结构

```
web-access/                  # Skill 文件夹名
├── skill.md                 # Skill 定义文件
└── scripts/                 # 可执行脚本（可选）
    ├── search.py
    └── fetch.sh
```

### 4.3 skill.md 格式

```markdown
---
name: web-access
description: Search the web and fetch page content
version: 1.0.0
tools:
  - name: web_search
    description: Search the web using a search engine
    parameters:
      query:
        type: string
        description: "Search query"
      max_results:
        type: number
        default: 10
    script: scripts/search.py

  - name: web_fetch
    description: Fetch and parse a web page
    parameters:
      url:
        type: string
        description: "URL to fetch"
    script: scripts/fetch.sh
---

# Web Access Skill

This skill enables LICode to search the web and fetch web page
content. Use it when the user asks for up-to-date information
or needs to access online resources.

## Usage

- When to use `web_search`: user asks about current events,
  documentation, or anything beyond your knowledge cutoff
- When to use `web_fetch`: user provides a URL and wants
  to extract information from it
```

YAML frontmatter 定义工具的元数据（名称、参数），Markdown 正文是指给 LLM 的使用说明。

### 4.4 SkillLoader (`skills/loader.ts`)

```typescript
class SkillLoader {
  /** 扫描所有 Skill 目录，返回 Skill 实例列表 */
  async loadAll(): Promise<Skill[]> {
    const dirs = [
      path.join(os.homedir(), ".licode", "skills"),   // 用户级
      path.join(process.cwd(), ".licode", "skills"),   // 项目级
    ];

    const skills: Skill[] = [];
    for (const dir of dirs) {
      if (!(await exists(dir))) continue;
      for (const entry of await readdir(dir)) {
        const skillDir = path.join(dir, entry);
        if ((await stat(skillDir)).isDirectory()) {
          const skill = await this.loadSkill(skillDir);
          if (skill) skills.push(skill);
        }
      }
    }
    return skills;
  }

  /** 加载单个 Skill 文件夹 */
  private async loadSkill(skillDir: string): Promise<Skill | null> {
    const defPath = path.join(skillDir, "skill.md");
    if (!(await exists(defPath))) return null;

    const raw = await readFile(defPath, "utf-8");
    const { frontmatter, body } = parseYamlFrontmatter(raw);

    return {
      name: frontmatter.name,
      version: frontmatter.version,
      description: body,
      tools: frontmatter.tools ?? [],
      dir: skillDir,
    };
  }
}

interface SkillToolDef {
  name: string;
  description: string;
  parameters: Record<string, {
    type: string;
    description?: string;
    default?: unknown;
  }>;
  script: string;             // 指向 scripts/ 下的可执行文件
}

interface Skill {
  name: string;
  version: string;
  description: string;        // skill.md 的 Markdown 正文
  tools: SkillToolDef[];      // YAML frontmatter 中定义的工具列表
  dir: string;                // Skill 文件夹路径
}
```

### 4.5 Skill → Tool 适配器 (`skills/adapter.ts`)

```typescript
// Skill 中定义的每个 tool 包装为 Tool 接口
function skillToolToAdapter(skillTool: SkillToolDef, skillDir: string): Tool {
  return {
    name: `skill__${skillTool.name}`,   // 命名空间隔离
    description: skillTool.description,
    parameters: skillParamsToZod(skillTool.parameters),

    async execute(input, context) {
      // 调用 scripts/ 下的可执行文件，通过 stdin 传 JSON
      const scriptPath = path.join(skillDir, skillTool.script);
      const proc = spawn(scriptPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      proc.stdin.write(JSON.stringify(input));
      proc.stdin.end();

      const { stdout, stderr } = await waitForExit(proc, context.signal);
      return {
        status: proc.exitCode === 0 ? "success" : "error",
        content: stdout || stderr,
      };
    },
  };
}

// 将 Skill 的 Markdown 正文注入 System Prompt
function skillToPromptLayer(skill: Skill): SystemPromptLayer {
  return {
    name: `skill:${skill.name}`,
    priority: 15,
    always: false,
    content: skill.description,
  };
}
```

### 4.6 项目级覆盖用户级

如果用户级和项目级存在同名 Skill，项目级覆盖用户级。LLM 优先使用项目级版本的指令。

---

## 5. Slash Command 命令框架

### 5.1 概述

Slash Command 是用户在 CLI 中以 `/xxx` 开头的特殊输入。CommandRouter 在 CLI 层拦截这些输入，执行对应的命令。命令可以产生副作用（如 `/clear` 清空对话）或注入 prompt 给 Agent Loop（如 `/review` 触发代码审查）。

### 5.2 Command 接口 (`commands/registry.ts`)

```typescript
interface SlashCommand {
  /** 命令名（不含 /） */
  name: string;

  /** 简短描述，在 /help 中展示 */
  description: string;

  /** 命令参数定义（可选） */
  args?: {
    name: string;
    description: string;
    required?: boolean;
  }[];

  /** 执行命令 */
  execute(args: string[], context: CommandContext): Promise<CommandResult>;
}

interface CommandContext {
  conversation: ConversationManager;
  toolRegistry: ToolRegistry;
  workingDirectory: string;
}

type CommandResult =
  | { type: "prompt"; content: string }   // 注入 prompt 给 Agent
  | { type: "action"; message: string }   // 直接执行副作用
  | { type: "error"; message: string };
```

### 5.3 CommandRouter (`commands/router.ts`)

```typescript
class CommandRouter {
  private registry: Map<string, SlashCommand> = new Map();

  register(cmd: SlashCommand): void;
  registerAll(cmds: SlashCommand[]): void;
  list(): SlashCommand[];

  /** 解析并路由用户输入。
   *  如果输入以 / 开头，解析命令名和参数，执行命令。
   *  如果输入不是 / 开头，返回 null（走正常 Agent 对话）。 */
  async route(
    input: string,
    context: CommandContext
  ): Promise<CommandResult | null> {
    if (!input.startsWith("/")) return null;

    const parts = input.slice(1).split(/\s+/);
    const name = parts[0];
    const args = parts.slice(1);

    const cmd = this.registry.get(name);
    if (!cmd) {
      return {
        type: "error",
        message: `Unknown command: /${name}. Type /help for available commands.`,
      };
    }

    return cmd.execute(args, context);
  }
}
```

### 5.4 CLI 集成点

```typescript
// 在用户提交输入时，先经过 CommandRouter
async function handleInput(input: string, ctx: AppContext) {
  const cmdResult = await commandRouter.route(input, ctx);
  if (cmdResult) {
    if (cmdResult.type === "prompt") {
      // 将命令生成的 prompt 注入 Agent Loop
      await agentLoop.run(cmdResult.content);
    } else {
      // 显示命令结果
      showMessage(cmdResult.message);
    }
  } else {
    // 普通对话 → 走 EventPipeline → Agent Loop
    pipeline.run(generateEvents(input));
  }
}
```

### 5.5 内置命令

| 命令 | 描述 | 类型 | 实现 |
|------|------|------|------|
| `/help` | 列出所有可用命令 | action | 遍历 registry.list() 格式化输出 |
| `/clear` | 清空当前对话历史 | action | 调用 conversation.clear() |
| `/context` | 显示 token 使用情况 | action | 调用 conversation.getStats() 格式化输出 |
| `/memory` | 管理持久化记忆 | action | Phase 4 实现具体逻辑，Phase 3 搭好框架 |

---

## 6. Hook 生命周期钩子

### 6.1 概述

Hook 消费事件流，在匹配到特定事件时执行外部脚本。Hook 通过 `settings.json` 配置，支持通配符匹配事件类型，支持阻塞和非阻塞两种模式。

Hook 作为 EventPipeline 中间件运行，但与 Phase 2 的 `agentLoopMiddleware` 不同——Hook 不是单个中间件，而是根据配置分布在管道的不同位置。管道中的每个中间件有唯一名称，Hook 通过 `position: "before:<name>"` 或 `position: "after:<name>"` 指定自己插入在哪个中间件的前面或后面。

**为什么 Hook 需要灵活的位置？**

不同用途的 Hook 关心不同的事件范围：

- 一个"通知"Hook（`tool-execute-start`）需要放在 `agentLoop` 之前，才能看到 Agent 循环内部的工具调用事件
- 一个"CI/CD"Hook（`agent-loop-complete`）应该放在 `agentLoop` 之后——它只关心任务是否完成，不需要看到循环内部的细节
- 一个"Token 审计"Hook（`llm-token`）需要放在 `agentLoop` 之前，记录每一次 LLM 调用的原始 token

如果所有 Hook 堆在最前面，CI/CD Hook 会被 Agent 循环内部的 token 事件和工具调用事件淹没。如果所有 Hook 堆在最后面，Token 审计 Hook 根本看不到事件——因为 `agentLoopMiddleware` 在循环结束前不调用 `next()`。

### 6.2 Hook 配置 (`hooks/types.ts`)

```typescript
/** Hook 在管道中的位置：before:<中间件名> 或 after:<中间件名> */
type HookPosition = `before:${string}` | `after:${string}`;

interface HookConfig {
  /** 事件匹配模式（支持通配符 *） */
  events: string[];          // e.g. ["tool-execute-*", "user-message"]

  /** 执行的命令 */
  command: string;           // e.g. "node ~/.licode/hooks/log-tool-calls.js"

  /**
   * Hook 在管道中的插入位置。
   *
   * 格式：before:<middleware> 或 after:<middleware>
   *
   * 预置别名（语法糖）：
   *   "pre-agent"   = "before:agentLoop"
   *   "post-agent"  = "after:agentLoop"
   *   "post-render" = "after:renderer"
   *
   * 默认为 "before:agentLoop"（能看到最完整的事件流）。
   */
  position?: HookPosition;

  /** 执行超时（毫秒），默认 30 秒 */
  timeout?: number;

  /** 是否等待 Hook 完成后再继续（默认 false = 异步 fire-and-forget） */
  blocking?: boolean;
}

interface RegisteredHook extends HookConfig {
  name: string;
  /** 解析后的位置，如 "before:agentLoop" */
  resolvedPosition: HookPosition;
}
```

配置文件示例：

```json
{
  "hooks": {
    "notifyOnBash": {
      "events": ["tool-execute-start"],
      "command": "sh ~/.licode/hooks/notify-on-bash.sh",
      "position": "pre-agent",
      "blocking": true
    },
    "ciTrigger": {
      "events": ["agent-loop-complete"],
      "command": "sh ~/.licode/hooks/ci-trigger.sh",
      "position": "post-agent"
    },
    "logAllEvents": {
      "events": ["*"],
      "command": "node ~/.licode/hooks/event-logger.js",
      "position": "before:agentLoop"
    },
    "auditTokens": {
      "events": ["llm-token"],
      "command": "node ~/.licode/hooks/audit-tokens.js",
      "position": "before:tokenCounting"
    }
  }
}
```

### 6.3 HookManager (`hooks/manager.ts`)

```typescript
class HookManager {
  /** 按 position 分组的 Hook 集合 */
  private groups: Map<HookPosition, RegisteredHook[]> = new Map();

  /** 从配置文件加载所有 Hook，按 position 分组 */
  load(configs: Record<string, HookConfig>): void {
    for (const [name, config] of Object.entries(configs)) {
      const resolvedPosition = resolvePosition(config.position ?? "before:agentLoop");
      const hook: RegisteredHook = { name, ...config, resolvedPosition };

      const group = this.groups.get(resolvedPosition) ?? [];
      group.push(hook);
      this.groups.set(resolvedPosition, group);
    }
  }

  /** 获取指定位置的所有 Hook */
  getHooksAt(position: HookPosition): RegisteredHook[] {
    return this.groups.get(position) ?? [];
  }

  /** 获取所有需要插入 Hook 的位置 */
  getPositions(): HookPosition[] {
    return [...this.groups.keys()];
  }

  /** 当事件触发时调用 —— 匹配所有给定 Hook 并执行 */
  async onEvent(event: PipelineEvent, hooks: RegisteredHook[]): Promise<void> {
    const matched = hooks.filter((h) =>
      this.matches(h.events, event.type)
    );

    const tasks = matched.map(async (hook) => {
      const proc = spawn(hook.command, [], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: hook.timeout ?? 30000,
      });
      // 事件 JSON 通过 stdin 传入
      proc.stdin.write(JSON.stringify(event));
      proc.stdin.end();

      if (hook.blocking) {
        await waitForExit(proc);
      }
      // 非阻塞 Hook 不等待——fire and forget
    });

    // 阻塞 Hook 等待完成，非阻塞 Hook 并行执行
    await Promise.allSettled(tasks);
  }

  /** 通配符匹配：tool-execute-* 匹配 tool-execute-start 和 tool-execute-complete */
  private matches(patterns: string[], eventType: string): boolean {
    return patterns.some((p) => {
      const regex = new RegExp("^" + p.replace(/\*/g, ".*") + "$");
      return regex.test(eventType);
    });
  }
}

/** 解析 position 别名 */
function resolvePosition(raw: string): HookPosition {
  const aliases: Record<string, HookPosition> = {
    "pre-agent": "before:agentLoop",
    "post-agent": "after:agentLoop",
    "post-render": "after:renderer",
  };
  return aliases[raw] ?? (raw as HookPosition);
}
```

### 6.4 hookMiddleware 与管道组装

```typescript
// hookMiddleware —— 创建绑定到特定 Hook 组的中间件
function hookMiddleware(hooks: HookManager, position: HookPosition): Middleware {
  const hooksAtPosition = hooks.getHooksAt(position);
  if (hooksAtPosition.length === 0) {
    // 该位置无 Hook 注册 —— 透传中间件（零开销）
    return (event, next) => next();
  }
  return async (event, next) => {
    await hooks.onEvent(event, hooksAtPosition);
    await next();
  };
}

// Pipeline 组装 —— 每个中间件有名字，Hook 按 position 找到插入点
function assemblePipeline(hookManager: HookManager, ...) {
  const pipeline = new EventPipeline();

  // 收集 hookManager 需要插入的所有位置
  const hookPositions = new Set(hookManager.getPositions());

  // 每个管道中间件插入前，检查是否有 Hook 注册在 "before:<该中间件>"
  // 插入后，检查是否有 Hook 注册在 "after:<该中间件>"

  // before:logging
  insertHooksAt(pipeline, hookManager, "before:logging");
  pipeline.use("logging", loggingMiddleware);
  // after:logging
  insertHooksAt(pipeline, hookManager, "after:logging");

  // before:tokenCounting
  insertHooksAt(pipeline, hookManager, "before:tokenCounting");
  pipeline.use("tokenCounting", tokenCountingMiddleware);
  insertHooksAt(pipeline, hookManager, "after:tokenCounting");

  // before:agentLoop
  insertHooksAt(pipeline, hookManager, "before:agentLoop");
  pipeline.use("agentLoop", createAgentLoopMiddleware({...}));
  // after:agentLoop  ← CI/CD Hook 在这里，只看到 agent-loop-complete
  insertHooksAt(pipeline, hookManager, "after:agentLoop");

  // before:renderer
  insertHooksAt(pipeline, hookManager, "before:renderer");
  pipeline.use("renderer", rendererMiddleware);
  // after:renderer
  insertHooksAt(pipeline, hookManager, "after:renderer");

  // before:errorHandler
  insertHooksAt(pipeline, hookManager, "before:errorHandler");
  pipeline.use("errorHandler", errorHandlerMiddleware);
  insertHooksAt(pipeline, hookManager, "after:errorHandler");

  return pipeline;
}

// 辅助函数：如果该位置有注册的 Hook 则插入
function insertHooksAt(
  pipeline: EventPipeline,
  hookManager: HookManager,
  position: HookPosition
): void {
  const middleware = hookMiddleware(hookManager, position);
  pipeline.use(`hook:${position}`, middleware);
}
```

**管道最终结构示例：**

```
pipeline
  .use("hook:before:agentLoop", ...)   // notifyOnBash, logAllEvents 在此
  .use("logging", loggingMiddleware)
  .use("tokenCounting", tokenCountingMiddleware)
  .use("hook:after:tokenCounting", ...) // auditTokens 在此（如果有注册）
  .use("agentLoop", agentLoopMiddleware)
  .use("hook:after:agentLoop", ...)     // ciTrigger 在此
  .use("renderer", rendererMiddleware)
  .use("errorHandler", errorHandlerMiddleware)
```

**设计要点：** HookManager 只消费事件，不修改事件。`hookMiddleware` 始终调用 `next()`——Hook 失败不会阻断 Agent 的正常执行。没有注册 Hook 的位置不插入中间件（返回透传函数），零开销。需要修改事件的 Hook（如权限审批）属于 Phase 4 的 Permission Guard，是不同的概念。

---

## 7. 启动集成流程

```typescript
// packages/cli/src/app.tsx —— App 组件初始化
async function initializeLICode(config: LICodeConfig) {
  // ===== Phase 1: 核心对话 =====
  const llm = new AnthropicProvider({ apiKey: config.apiKey });
  const systemPrompt = new SystemPrompt();
  systemPrompt.addLayer(ROLE_LAYER);
  systemPrompt.addLayer(SAFETY_LAYER);
  const conversation = new ConversationManager({
    model: config.model,
    systemPrompt,
  });

  // ===== Phase 2: Agent 核心 =====
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerAll([
    bashTool, readTool, writeTool, editTool, globTool, grepTool,
  ]);

  // ===== Phase 3: 扩展协议 =====

  // 1. MCP —— 连接外部服务器，注册其工具
  const mcpManager = new MCPClientManager();
  await mcpManager.initialize(loadMCPConfig());
  toolRegistry.registerAll(mcpManager.getTools());

  // 2. Skill —— 扫描本地 Skill 目录，注册工具 + 注入 Prompt
  const skillLoader = new SkillLoader();
  const skills = await skillLoader.loadAll();
  for (const skill of skills) {
    for (const toolDef of skill.tools) {
      toolRegistry.register(skillToolToAdapter(toolDef, skill.dir));
    }
    systemPrompt.addLayer(skillToPromptLayer(skill));
  }

  // 3. Hook —— 加载配置，按 position 分组
  const hookManager = new HookManager();
  hookManager.load(settings.hooks ?? {});

  // 4. Command —— 注册内置命令
  const commandRouter = new CommandRouter();
  commandRouter.registerAll([
    helpCommand, clearCommand, contextCommand, memoryCommand,
  ]);

  // ===== 组装 EventPipeline —— 使用 assemblePipeline() =====
  const pipeline = assemblePipeline(hookManager, {
    llm, conversation, tools: toolRegistry,
  });

  return { pipeline, conversation, commandRouter };
}
```

---

## 8. 四个子系统对比

| 子系统 | 接入方式 | 产物 | 触发时机 |
|--------|----------|------|----------|
| **MCP** | 向 ToolRegistry 注册工具 | Tool 实例 | 启动时连接，LLM 调用时执行 |
| **Skill** | 向 ToolRegistry 注册工具 + 向 SystemPrompt 注册说明层 | Tool 实例 + SystemPromptLayer | 启动时扫描，LLM 调用时执行 |
| **Slash Command** | CLI 层拦截 `/xxx` 输入 | prompt 注入 或 副作用动作 | 用户输入 `/command` 时触发 |
| **Hook** | 作为 EventPipeline 的分布式中间件，按 position 插入管道各处 | Shell 脚本执行 | 匹配事件发生时触发 |

---

## 9. 依赖清单

Phase 3 新增依赖：

| 包 | 用途 |
|----|------|
| `@modelcontextprotocol/sdk` ^1.0 | MCP 协议客户端实现（JSON-RPC、传输层） |
| `js-yaml` ^4 | YAML frontmatter 解析（skill.md） |

Phase 1 & 2 已有依赖无需变更。

---

## 10. Phase 3 边界与不包含

- MCP Server 端实现（LICode 不对外暴露为 MCP 服务器）
- 权限检查——MCP 和 Skill 注册的工具和内置工具一样，Phase 3 不做执行前审批（Phase 4）
- 记忆持久化的 skill 实现——`/memory` 命令框架搭好但存储逻辑在 Phase 4
- SubAgent 的 MCP 隔离——Phase 5 的 Worktree 隔离中 MCP 连接需要特殊处理

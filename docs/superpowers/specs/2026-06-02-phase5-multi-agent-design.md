# Phase 5: 多 Agent 协作 — 设计文档

**日期**: 2026-06-02
**状态**: 已确认
**范围**: LICode Phase 5 — SubAgent 子任务分发、Git Worktree 并行隔离、Agent Teams 协作基础设施

---

## 0. Phase 5 在全局中的位置

Phase 1-4 让单个 Agent 能对话、能使用工具、能扩展能力、能安全运行。Phase 5 让多个 Agent 能协作——主 Agent 可以将复杂任务分发给 SubAgent，并行执行，在隔离的文件系统环境中工作，最终合并结果。

Phase 5 依赖 Phase 1-4 的全部基础设施：
- **Phase 1** — ConversationManager（每个 SubAgent 独立实例）、EventPipeline
- **Phase 2** — ToolRegistry（Agent Tool 注册于此）、ToolExecutor（并行执行 SubAgent）
- **Phase 3** — 零改动
- **Phase 4** — PermissionGuard（SubAgent 继承主 Agent 权限）、Sandbox

**核心设计原则：SubAgent 就是 Tool。** 从 ToolRegistry 的视角，Agent Tool 和 Bash/Read 没有任何区别——都有一个 `name`、`description`、`parameters` 和 `execute()` 函数。SubAgent 只是在 execute 内部启动了一个 AgentLoop。

**Phase 5 完成标志：**
- `Agent` Tool 可注册/注销，LLM 可自主决定何时调用 SubAgent
- One-shot SubAgent：创建 → 执行 → 返回结果 → 销毁
- Persistent SubAgent：创建后跨多次调用保持状态
- Git Worktree 隔离：SubAgent 在独立工作树中编辑文件，成功合并，失败丢弃
- 多个 SubAgent 并行执行（ToolExecutor 的 Promise.all）
- `/subagent on|off|status` 命令可用

---

## 1. 架构总览

Phase 5 在 `@licode/core` 中新增 `multi-agent/` 模块：

```
@licode/core/src/multi-agent/
├── subagent.ts       # SubAgentManager + SubAgentInstance
├── agent-tool.ts     # Agent Tool (Tool 接口实现)
├── worktree.ts       # Git Worktree 管理器
└── types.ts          # SubAgent 相关类型
```

**关键设计决策：**

| 决策 | 选择 |
|------|------|
| SubAgent 调度 | Agent 即 Tool + One-shot & Persistent 双模式 |
| 文件系统隔离 | 可选 Git Worktree（非 git 项目可用 SubAgent 但无隔离） |
| SubAgent 开关 | settings.json 配置 + /subagent CLI 命令 |
| 并行执行 | ToolExecutor 的 Promise.all（Phase 2 已有） |

**SubAgent 在系统中的位置：**

```
主 Agent Loop
  │
  ├── LLM 决定: Agent({ task: "审查安全", isolation: "worktree" })
  │
  ├── ToolExecutor 调用 Agent Tool
  │     │
  │     ├── SubAgentManager.execute()
  │     │     │
  │     │     ├── SubAgentInstance.run()
  │     │     │     ├── 独立的 ConversationManager
  │     │     │     ├── 独立的 AgentLoop
  │     │     │     │     ├── LLM 调用 → tool_use → 执行 → ... 循环
  │     │     │     │     └── 返回最终文本
  │     │     │     └── 返回 ToolResult
  │     │     └── 返回给主 Agent Loop
  │     │
  │     └── 结果注入主 Agent 消息历史
  │
  └── 主 Agent 继续推理
```

---

## 2. 对已有 Phase 的改动

### 2.1 Phase 2 改动

ToolRegistry 扩展调用：启动时根据配置注册 Agent Tool。

```typescript
// 启动初始化
if (settings.subagent?.enabled !== false) {
  const subAgentManager = new SubAgentManager(llm, toolRegistry, sandbox);
  toolRegistry.register(createAgentTool(subAgentManager, settings.subagent));
}
```

ToolExecutor 零改动——Agent Tool 和其他工具执行方式完全相同。

### 2.2 Phase 4 改动

PermissionGuard 在 SubAgent 中复用——SubAgent 使用与主 Agent 相同的 Guard 实例。当 SubAgent 需要执行 Bash 时，Guard 检查流程相同（可能需要用户审批）。

### 2.3 Phase 1 & 3

零改动。

---

## 3. SubAgent 调度器 (multi-agent/)

### 3.1 两种模式

**One-shot SubAgent**（无状态）：

```
Agent({ task: "检查 src/auth.ts 的安全漏洞" })
  → SubAgentManager 创建匿名实例
  → SubAgentInstance.run()
  → 返回结果
  → 实例销毁，ConversationManager 丢弃
```

适用场景：独立的分析、搜索、一次性代码审查。

**Persistent SubAgent**（有状态）：

```
Agent({ agent: "code-reviewer", task: "审查 PR #42" })
  → SubAgentManager 查找或创建 "code-reviewer"
  → SubAgentInstance.run()
  → 返回结果，但实例保留（ConversationManager 保留）
  → 会话持久化到 .licode/agents/code-reviewer.json

Agent({ agent: "code-reviewer", task: "再审一遍" })
  → 恢复之前的 ConversationManager
  → 基于之前的对话历史继续
  → 返回结果，实例保留
```

适用场景：长期协作的 CI/CD 检查员、持续的结对编程伙伴。主 Agent 重启后可恢复。

### 3.2 SubAgentManager (`multi-agent/subagent.ts`)

```typescript
class SubAgentManager {
  /** 持久化 SubAgent 池 */
  private pool: Map<string, SubAgentInstance> = new Map();

  constructor(
    private llm: LLMProvider,
    private toolRegistry: ToolRegistry,
    private sandbox: Sandbox | null,
    private config: SubAgentConfig
  ) {}

  /**
   * 执行 SubAgent 任务。
   * 如果 agent 名称已存在 → 持久化模式，恢复之前的 ConversationManager
   * 如果 agent 名称为空 → One-shot 模式，用完即销毁
   */
  async execute(
    input: AgentToolInput,
    context: ToolContext
  ): Promise<ToolResult> {
    if (input.agent) {
      // 持久化模式：获取或创建
      let instance = this.pool.get(input.agent);
      if (!instance) {
        instance = await this.createOrLoad(input.agent, context);
        this.pool.set(input.agent, instance);
      }
      const result = await instance.run(input.task);
      return result;
    } else {
      // One-shot 模式：创建 → 执行 → 销毁
      const instance = this.createAnonymous(context);
      const result = await instance.run(input.task);
      instance.dispose();
      return result;
    }
  }

  /** 列出所有持久化 SubAgent */
  listAgents(): AgentSummary[];

  /** 手动销毁持久化 SubAgent */
  async destroy(name: string): Promise<void>;

  /** 清理超时的持久化 SubAgent */
  cleanupStale(timeoutMs?: number): void;
}

interface AgentSummary {
  name: string;
  createdAt: string;
  lastUsedAt: string;
  messageCount: number;
  status: "active" | "idle";
}
```

### 3.3 AgentToolInput

```typescript
interface AgentToolInput {
  /** 持久化 Agent 名（可选，不指定则为 One-shot） */
  agent?: string;

  /** 子任务描述 */
  task: string;

  /** 是否使用 Worktree 隔离 */
  isolation?: "none" | "worktree";

  /** 允许使用的工具白名单（默认继承全部） */
  tools?: string[];

  /** 最大步数限制（覆盖默认值，默认 25） */
  maxSteps?: number;
}
```

### 3.4 SubAgentInstance

```typescript
interface SubAgentInstanceConfig {
  name?: string;
  conversation: ConversationManager;
  llm: LLMProvider;
  toolRegistry: ToolRegistry;
  worktreeManager: WorktreeManager;
  eventBus?: EventBus;
  isolation?: "none" | "worktree";
  tools?: string[] | null;
  maxSteps?: number;
  maxTokens?: number;
  maxTimeMs?: number;
}

class SubAgentInstance {
  readonly name: string;
  private conversation: ConversationManager;
  private llm: LLMProvider;
  private config: SubAgentInstanceConfig;
  private worktreeManager: WorktreeManager;
  private createdAt: Date;
  private lastUsedAt: Date;
  private worktreeCtx: WorktreeContext | null = null;

  constructor(config: SubAgentInstanceConfig) {
    this.name = config.name ?? `anon-${uuid()}`;
    this.conversation = config.conversation;
    this.llm = config.llm;
    this.config = config;
    this.worktreeManager = config.worktreeManager;
    this.createdAt = new Date();
    this.lastUsedAt = new Date();
  }

  /**
   * 执行任务的核心逻辑。
   * 内部等价于主 Agent 的 AgentLoop：
   *   while (true) {
   *     stream = await llm.stream(messages, tools)
   *     if (stream has tool_use) → execute tools → continue
   *     if (stream has text) → done
   *   }
   *
   * 区别：
   *   - 独立的 ConversationManager（上下文隔离）
   *   - 精简的 System Prompt（不需要全部工具指令）
   *   - 更保守的终止策略（默认 maxSteps=25, maxTokens=50K）
   */
  async run(task: string): Promise<ToolResult> {
    this.conversation.addUserMessage(task);
    this.lastUsedAt = new Date();

    // 如果启用 Worktree，创建隔离工作目录
    if (this.config.isolation === "worktree") {
      if (await WorktreeManager.isGitRepo()) {
        this.worktreeCtx = await this.worktreeManager.create(this.name);
      }
    }

    const agentLoop = new AgentLoop({
      llm: this.llm,
      conversation: this.conversation,
      tools: this.config.toolRegistry.filterForAgent(this.config.tools ?? null),
      termination: new TerminationPolicy({
        maxSteps: this.config.maxSteps ?? 25,
        maxTokens: this.config.maxTokens ?? 50_000,
        maxTimeMs: this.config.maxTimeMs ?? 300_000,
      }),
      eventBus: this.config.eventBus,
    });

    try {
      const result = await agentLoop.run(task);

      // Worktree: 成功后合并
      if (this.worktreeCtx && result.type === "agent-loop-complete") {
        const mergeResult = await this.worktreeManager.merge(this.name);
        if (!mergeResult.success) {
          return {
            status: "error",
            error: `Merge conflict in: ${mergeResult.conflictFiles?.join(", ")}`,
            errorType: "execution",
          };
        }
      }

      return {
        status: "success",
        content: result.message,
        metadata: {
          agent: this.name,
          steps: agentLoop.termination.getStats().steps,
          durationMs: agentLoop.termination.getStats().timeMs,
        },
      };
    } catch (e) {
      // Worktree: 失败则丢弃
      if (this.worktreeCtx) {
        await this.worktreeManager.discard(this.name);
      }
      return {
        status: "error",
        error: e.message,
        errorType: "execution",
      };
    }
  }

  /** 从持久化文件恢复 */
  static async load(name: string): Promise<SubAgentInstance | null>;

  /** 保存到 .licode/agents/{name}.json */
  async save(): Promise<void>;

  /** 销毁: 清理 Worktree + 移除会话文件 */
  dispose(): void;
}
```

### 3.5 主 Agent 与 SubAgent 运行逻辑对比

两者共用同一个 `AgentLoop` 类（Phase 2 实现），核心逻辑完全相同——`while(true) { stream → check tool_use → execute or done }`，TerminationPolicy 也是同一个类。差异仅在于构造时传入的配置参数不同：

| 差异项 | 主 Agent | SubAgent |
|--------|----------|----------|
| System Prompt | 完整分层（role + safety + tool-use + context + memory + skills） | 精简分层（role + safety + tool-use） |
| 终止参数 | maxSteps=50, maxTokens=200K | maxSteps=25, maxTokens=50K（更保守） |
| 工具集 | ToolRegistry 的全部工具（含 MCP、Skill） | 可选的工具白名单（默认继承全部） |
| 输出方式 | 流式 token → EventPipeline → CLI 渲染器（用户实时看到） | AgentLoop 返回值 → 打包为 ToolResult → 注入主 Agent 消息历史 |
| 事件流 | 完整事件（llm-token、tool-use-detected、tool-execute-*）全部流到 CLI | 仅心跳事件通知主 Agent，中间步骤的 token 和 tool_use 不渲染到终端 |
| LLM 实例 | 独立的 AnthropicProvider | 可共享主 Agent 的实例，也可独立创建 |
| 启动方式 | CLI App 初始化后直接进入 | 主 Agent 调用 Agent Tool 时触发 |

```
AgentLoop 类（Phase 2）—— 同一个类，两套配置

主 Agent:
  loop = new AgentLoop({
    systemPrompt: full,         // 完整分层
    maxSteps: 50,
    tools: toolRegistry.all(),  // 全部工具
  })
  loop.run() → stream tokens → EventPipeline → CLI 渲染器

SubAgent:
  loop = new AgentLoop({
    systemPrompt: slim,         // 精简分层
    maxSteps: 25,
    tools: toolRegistry.subset(whitelist),  // 可选白名单
  })
  loop.run() → return ToolResult → ToolExecutor → 主 Agent 消息历史
```

SubAgent 不需要 Fork 进程、不需要重写 AgentLoop——Phase 2 设计的接口通用性足以覆盖两种场景。

### 3.6 上下文隔离机制

SubAgent 拥有独立的：
- **ConversationManager** — 自己的消息数组，SubAgent 内部执行了多少轮 ReAct 完全不暴露给主 Agent
- **SystemPrompt** — 精简版本（不含 Memory 层，不含 Skill 描述，仅 role + safety + tool-use）
- **TerminationPolicy** — 独立的步数和 token 计数

主 Agent 只收到 `ToolResult` ——最终文本。SubAgent 的中间步骤对主 Agent 透明。

---

## 4. Git Worktree 隔离 (multi-agent/worktree.ts)

### 4.1 WorktreeManager

```typescript
class WorktreeManager {
  /** worktree 存放目录 */
  private worktreeDir: string;  // .claude/worktrees/

  /**
   * 创建 Git Worktree。
   * 流程：
   * 1. 在当前 HEAD 基础上创建临时分支 wt-{id}
   * 2. git worktree add .claude/worktrees/wt-{id} wt-{id}
   * 3. 返回工作树路径
   */
  async create(agentId: string): Promise<WorktreeContext> {
    const branch = `wt-${agentId}`;
    const worktreePath = path.join(this.worktreeDir, `wt-${agentId}`);

    await execGit(`git branch ${branch}`);
    await execGit(`git worktree add ${worktreePath} ${branch}`);

    return { path: worktreePath, branch };
  }

  /**
   * 合并 Worktree 变更到原分支。
   * 流程：
   * 1. git -C worktreePath add -A
   * 2. git -C worktreePath commit -m "SubAgent: {agentId} changes"
   * 3. 切回原分支，git merge wt-{id}
   * 4. git branch -d wt-{id}
   */
  async merge(agentId: string): Promise<MergeResult>;

  /**
   * 丢弃 Worktree（SubAgent 失败时调用）。
   * 流程：
   * 1. git worktree remove --force worktreePath
   * 2. git branch -D wt-{id}
   */
  async discard(agentId: string): Promise<void>;

  /** 列出所有活跃的 worktree */
  async list(): Promise<WorktreeContext[]>;

  /** 检查当前项目是否为 git 仓库 */
  static async isGitRepo(): Promise<boolean>;
}

interface WorktreeContext {
  path: string;
  branch: string;
}

interface MergeResult {
  success: boolean;
  conflictFiles?: string[];
  error?: string;
}
```

### 4.2 Worktree 的隔离边界

| 隔离项 | 说明 |
|--------|------|
| 文件系统 | 独立的 git worktree，读/写完全隔离 |
| 并行编辑 | 多个 SubAgent 同时编辑不同文件无冲突 |
| 失败恢复 | SubAgent 出错 → 直接丢弃 worktree，原分支不受影响 |
| 合并策略 | 成功时自动 commit + merge；冲突时返回冲突文件列表给主 Agent |

### 4.3 非 git 项目

如果项目不是 git 仓库，且 SubAgent 请求了 `isolation: "worktree"`：

1. WorktreeManager 返回 null，SubAgent 降级为共享主工作目录
2. 发出事件 `{ type: "worktree-unavailable", reason: "not a git repository" }`
3. 主 Agent 可以选择继续（无隔离）或修改策略

---

## 5. Agent Tool 注册 (multi-agent/agent-tool.ts)

### 5.1 Tool 定义

```typescript
import { z } from "zod";

const AgentParams = z.object({
  agent: z.string().optional()
    .describe("Name of a persistent SubAgent. If omitted, creates a one-shot SubAgent."),

  task: z.string()
    .describe("The task for this SubAgent to complete. Be specific and include context."),

  isolation: z.enum(["none", "worktree"]).optional().default("none")
    .describe("Filesystem isolation: 'worktree' uses git worktree for parallel edits."),

  tools: z.array(z.string()).optional()
    .describe("Allowed tool names for this SubAgent. Defaults to all available tools."),

  maxSteps: z.number().optional().default(25)
    .describe("Maximum agent loop steps (default 25, more conservative than main agent)."),
});

function createAgentTool(
  manager: SubAgentManager,
  config: SubAgentConfig
): Tool<typeof AgentParams> {
  return {
    name: "Agent",
    description:
      "Spawn a SubAgent to handle a complex subtask independently. " +
      "The SubAgent has its own conversation context and can use tools. " +
      "Use this for tasks that require multiple steps of reasoning or " +
      "parallel execution with other SubAgents. " +
      "For file-editing tasks, use isolation: 'worktree' to prevent conflicts.",

    parameters: AgentParams,

    async execute(input, context) {
      return manager.execute(input, context);
    },
  };
}
```

### 5.2 ToolExecutor 的并行执行

Phase 2 的 ToolExecutor 天然支持：LLM 一次返回多个 tool_use 时，Promise.all 并发执行。

```typescript
// LLM 在一次回复中同时发出多个 Agent tool_use:
// Tool Use 1: Agent({ task: "检查 src/auth.ts 安全漏洞" })
// Tool Use 2: Agent({ task: "检查 src/payment.ts 安全漏洞" })
// Tool Use 3: Agent({ task: "审查 src/config.ts 配置" })

// ToolExecutor.executeParallel() → 三个 SubAgent 并发执行
// 各自独立的 ConversationManager，上下文互不干扰
```

---

## 6. SubAgent 开关 (配置 & CLI)

### 6.1 配置入口

```json
// settings.json
{
  "subagent": {
    "enabled": true,
    "defaultIsolation": "none",
    "maxConcurrent": 4,
    "idleTimeoutMs": 1800000
  }
}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | true | false = 不注册 Agent Tool |
| `defaultIsolation` | "none" \| "worktree" | "none" | SubAgent 的默认隔离策略 |
| `maxConcurrent` | number | 4 | 并行 SubAgent 数量上限 |
| `idleTimeoutMs` | number | 1800000 | 持久化 SubAgent 空闲超时（30 分钟） |

### 6.2 启动时的条件注册

```typescript
const subagentConfig = settings.subagent ?? { enabled: true };

if (subagentConfig.enabled) {
  const subAgentManager = new SubAgentManager(llm, toolRegistry, sandbox);
  const agentTool = createAgentTool(subAgentManager, subagentConfig);
  toolRegistry.register(agentTool);
}

// 关闭时: ToolRegistry 中没有 Agent Tool → LLM 无法调用 SubAgent
// 打开时: Agent Tool 正常注册 → LLM 可按需 spawn SubAgent
```

### 6.3 CLI 命令

```
/subagent on      # 启用 SubAgent（注册 Agent Tool）
/subagent off     # 禁用 SubAgent（从 ToolRegistry 移除 Agent Tool）
/subagent status  # 显示当前状态: 已启用, 2 个持久化 SubAgent 活跃
```

关闭 SubAgent 不销毁已有的持久化 SubAgent 实例——只移除 ToolRegistry 中的注册，不接受新调用。已持久化的会话文件仍在 `.licode/agents/`。

---

## 7. 完整 SubAgent 调用时序

```
主 Agent                   ToolExecutor           SubAgentManager        SubAgent Loop
  │                            │                        │                     │
  │ LLM: Agent({task:"X"})     │                        │                     │
  ├───────────────────────────►│                        │                     │
  │                            │ Agent Tool.execute()   │                     │
  │                            ├───────────────────────►│                     │
  │                            │                        │ createOrLoad()      │
  │                            │                        ├────────────────────►│
  │                            │                        │                     │
  │                            │                        │  SubAgent.run()     │
  │                            │                        │  → addUserMessage   │
  │                            │                        │  → AgentLoop.start  │
  │                            │                        │     → LLM.stream    │
  │                            │                        │     → tool_use      │
  │                            │                        │     → execute tools │
  │                            │                        │     → ...           │
  │                            │                        │     → text response │
  │                            │                        │◄────────────────────┤
  │                            │                        │                     │
  │                            │◄── ToolResult ─────────┤                     │
  │◄── tool_result ────────────┤                        │                     │
  │                            │                        │                     │
  │ LLM 看到结果, 继续推理      │                        │                     │
```

---

## 8. 依赖清单

Phase 5 新增依赖：

| 包 | 用途 |
|----|------|
| 无（全部使用已有依赖） | 无 |

Git Worktree 使用系统 `git` 命令，不依赖 npm 包。

---

## 9. Phase 5 边界与不包含

- Agent Teams 网状协作——Phase 5 只含树形主-从结构，Agent 之间不直接通信
- SubAgent 动态发现和协商——主 Agent 显式指定 tasks
- SubAgent 的 MCP 连接继承——SubAgent 共享主 Agent 的 ToolRegistry（含 MCP 工具），但自身不独立初始化 MCP
- 跨主 Agent 的 SubAgent——每主 Agent 拥有独立的 SubAgent 池
- 远程 SubAgent（运行在另一台机器上）

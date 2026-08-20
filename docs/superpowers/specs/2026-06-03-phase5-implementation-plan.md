# Phase 5 实现计划：多 Agent 协作

**日期**: 2026-06-03
**设计文档**: `docs/superpowers/specs/2026-06-02-phase5-multi-agent-design.md`
**前置**: Phase 1-4 已完成

---

## Context

Phase 1-4 让单个 Agent 能对话、使用工具、扩展能力、安全可靠地运行。Phase 5 让多个 Agent 能协作——主 Agent 将复杂任务分发给 SubAgent，并行执行，在隔离的文件系统环境中工作，最终合并结果。

核心设计原则：**SubAgent 就是 Tool。** 从 ToolRegistry 的视角，Agent Tool 和 Bash/Read 没有任何区别。两者共用同一个 `AgentLoop` 类——区别只在于构造配置不同（System Prompt 精简、终止参数保守、输出打包为 ToolResult）。

**Phase 5 零新依赖。** Worktree 使用系统 `git` 命令，Agent Loop 复用 Phase 2 实现。

---

## 实现顺序（依赖关系）

```
1. multi-agent/types.ts (零依赖)
   ↓
2. multi-agent/worktree.ts (依赖 types + 系统 git)
   ↓
3. multi-agent/subagent.ts (依赖 worktree + Phase 2 AgentLoop + Phase 4 ToolRegistry)
   ↓
4. multi-agent/agent-tool.ts (依赖 subagent.ts → Tool 接口)
   ↓
5. CLI 集成 (启动流程 + /subagent 命令 + SubAgent 开关)
   ↓
6. 集成收尾 (公开导出 + 端到端验证)
```

---

## Step 1: 类型定义

**目标**: 定义 SubAgent 核心类型，供后续模块引用。

### 1.1 — `packages/core/src/multi-agent/types.ts`
- `AgentToolInput` 接口：
  - `agent?: string` — 持久化 Agent 名（不指定 = One-shot）
  - `task: string` — 子任务描述
  - `isolation?: "none" | "worktree"` — 隔离级别
  - `tools?: string[]` — 工具白名单
  - `maxSteps?: number` — 最大步数（默认 25）
- `SubAgentConfig` 接口：
  - `enabled: boolean` — 全局开关
  - `defaultIsolation: "none" | "worktree"`
  - `maxConcurrent: number` — 并行上限
  - `idleTimeoutMs: number` — 空闲超时
- `SubAgentInstanceConfig` 接口：
  - `name?: string` / `conversation: ConversationManager` / `llm: LLMProvider`
  - `toolRegistry: ToolRegistry` / `worktreeManager: WorktreeManager`
  - `eventBus?: EventBus` / `isolation?: "none" | "worktree"`
  - `tools?: string[] | null` / `maxSteps?` / `maxTokens?` / `maxTimeMs?`
- `AgentSummary` 接口（`name`, `createdAt`, `lastUsedAt`, `messageCount`, `status`）
- `WorktreeContext` 接口（`path`, `branch`）
- `MergeResult` 接口（`success`, `conflictFiles?`, `error?`）

### 1.2 验证
- TypeScript 编译通过

---

## Step 2: Git Worktree 管理器

**目标**: 实现 WorktreeManager——创建、合并、丢弃 worktree，检查非 git 项目降级。

### 2.1 — `packages/core/src/multi-agent/worktree.ts`
- `WorktreeManager` 类：
  - `worktreeDir: string` — `.claude/worktrees/`
  - `create(agentId)`:
    1. `git branch wt-${agentId}` — 基于当前 HEAD 创建临时分支
    2. `git worktree add .claude/worktrees/wt-${agentId} wt-${agentId}`
    3. 返回 `{ path, branch }`
  - `merge(agentId)`:
    1. `git -C <path> add -A`
    2. `git -C <path> commit -m "SubAgent: ${agentId} changes"`（无变更时跳过）
    3. 切回原分支，`git merge wt-${agentId}`
    4. `git branch -d wt-${agentId}`
    5. `git worktree remove <path>`
    6. 冲突时返回冲突文件列表
  - `discard(agentId)`:
    1. `git worktree remove --force <path>`
    2. `git branch -D wt-${agentId}`
  - `list()` — 通过 `git worktree list` 解析
  - `static isGitRepo()` — 检查 `.git` 目录是否存在 + 是否可执行 `git rev-parse --git-dir`

### 2.2 execGit 辅助函数
- `execGit(cmd: string, cwd?: string)` — 用 `child_process.execSync` 或 `spawn` 封装：
  - 错误时抛出有意义的消息（而非 git 原始报错）
  - 超时保护（30 秒）

### 2.3 单元测试
- Mock `execGit`，测试 `create()` / `merge()` / `discard()` 流程
- 测试 `merge()` 冲突时返回冲突文件列表
- 测试 `discard()` 强制清理

---

## Step 3: SubAgent 调度器

**目标**: 实现 SubAgentManager（One-shot + Persistent 双模式）+ SubAgentInstance（复用 AgentLoop 类）。

### 3.1 SubAgentInstance — `packages/core/src/multi-agent/subagent.ts`

核心在于它复用了 Phase 2 的 AgentLoop 类——传入不同的配置参数：

```typescript
class SubAgentInstance {
  readonly name: string;
  private conversation: ConversationManager;
  private config: SubAgentInstanceConfig;
  private worktreeManager: WorktreeManager;
  private worktreeCtx: WorktreeContext | null = null;
  private createdAt: Date;
  private lastUsedAt: Date;

  constructor(config: SubAgentInstanceConfig);

  async run(task: string): Promise<ToolResult> {
    // 1. 添加用户消息（task）
    this.conversation.addUserMessage(task);

    // 2. 如果启用 Worktree → 创建隔离目录
    if (this.config.isolation === "worktree" && await WorktreeManager.isGitRepo()) {
      this.worktreeCtx = await this.worktreeManager.create(this.name);
      this.conversation.setWorkingDirectory?.(this.worktreeCtx.path);
    }

    // 3. 创建 AgentLoop 实例——和主 Agent 完全相同的类
    const agentLoop = new AgentLoop({
      llm: this.config.llm,
      conversation: this.conversation,
      tools: this.filterTools(),    // 白名单过滤或全部
      termination: new TerminationPolicy({
        maxSteps: this.config.maxSteps ?? 25,
        maxTokens: this.config.maxTokens ?? 50_000,
        maxTimeMs: this.config.maxTimeMs ?? 300_000,
      }),
      eventBus: this.config.eventBus,  // 心跳事件通知主 Agent
    });

    try {
      const result = await agentLoop.run(task);

      if (this.worktreeCtx) {
        const mergeResult = await this.worktreeManager.merge(this.name);
        if (!mergeResult.success) {
          return { status: "error", error: `Merge conflict`, errorType: "execution" };
        }
      }

      return {
        status: "success",
        content: result.message,
        metadata: { agent: this.name, steps: agentLoop.termination.getStats().steps, durationMs: agentLoop.termination.getStats().timeMs },
      };
    } catch (e) {
      if (this.worktreeCtx) await this.worktreeManager.discard(this.name);
      return { status: "error", error: e.message, errorType: "execution" };
    }
  }

  private filterTools(): ToolRegistry {
    // 如果有工具白名单 → 过滤；否则返回全部
    if (!this.config.tools || this.config.tools.length === 0) return this.config.toolRegistry;
    return this.config.toolRegistry.filterForAgent(this.config.tools);
  }

  /** 从持久化文件恢复 */
  static async load(name: string, baseConfig: Omit<SubAgentInstanceConfig, 'conversation'>): Promise<SubAgentInstance | null>;

  /** 保存到 .licode/agents/{name}.json */
  async save(): Promise<void>;

  /** 销毁: 清理 Worktree + 移除会话文件 */
  dispose(): void;
}
```

### 3.2 SubAgentManager — `packages/core/src/multi-agent/subagent.ts`

- `SubAgentManager` 类：
  - `pool: Map<string, SubAgentInstance>` — 持久化 SubAgent 池
  - `execute(input: AgentToolInput, context: ToolContext)`:
    1. `input.agent` 存在 → 持久化模式
       - `pool.get(input.agent)` → 找到 → 直接 `run(task)`
       - 未找到 → `SubAgentInstance.load(input.agent)` → 找到文件 → 反序列化 → 加入池 → `run(task)`
       - 文件也不存在 → 创建新实例 → 加入池 → `run(task)` + `save()`
    2. `input.agent` 为空 → One-shot 模式
       - 创建匿名实例 → `run(task)` → `dispose()`
  - `createOrLoad(name, context)` — 从 `.licode/agents/{name}.json` 恢复，或新建
  - `createAnonymous(context)` — 创建匿名 `SubAgentInstance`
  - `listAgents()` — 遍历 pool + 扫描 `.licode/agents/` 目录
  - `destroy(name)` — 从 pool 移除 + `dispose()` + 删除文件
  - `cleanupStale(timeoutMs?)` — 清理超时的持久化 SubAgent

### 3.3 SubAgent System Prompt Builder

为 SubAgent 构建精简的 System Prompt：
- `createSubAgentSystemPrompt()`:
  - 仅包含 `role` + `safety` + `tool-use` 层
  - 不包含 `memory`、`skills`、`context` 层
  - 主 Agent 的 system prompt 中 skill 描述、memory 等内容不需要注入 SubAgent

### 3.4 ToolRegistry 扩展 — `packages/core/src/tools/registry.ts`
- 新增 `filterForAgent(whitelist: string[] | null): ToolRegistry`:
  - `null` → 返回所有工具
  - 非空数组 → 返回只包含白名单工具的新 ToolRegistry 实例
  - 白名单中的工具名不在注册表中 → 忽略（不报错）

### 3.5 并发控制
- `SubAgentManager` 内部维护一个并发计数器
- 超过 `maxConcurrent` 时，新请求排队等待
- 使用一个简单的 Promise 队列

### 3.6 单元测试
- 测试 `SubAgentInstance.run()` 成功返回 ToolResult
- 测试 One-shot 模式：执行完 dispose 后 ConversationManager 被清理
- 测试 Persistent 模式：第二次调用复用同一个 ConversationManager
- Mock AgentLoop，验证 `run()` 传入正确参数
- 测试 Worktree 成功时 merge，失败时 discard
- 测试并发控制超过上限时的排队行为

---

## Step 4: Agent Tool 注册

**目标**: 将 SubAgent 包装为 Tool，注册到 ToolRegistry。

### 4.1 — `packages/core/src/multi-agent/agent-tool.ts`
- Zod schema `AgentParams`:
  - `agent: z.string().optional()` — 持久化 Agent 名
  - `task: z.string()` — 子任务描述
  - `isolation: z.enum(["none", "worktree"]).optional().default("none")`
  - `tools: z.array(z.string()).optional()` — 工具白名单
  - `maxSteps: z.number().optional().default(25)`
- `createAgentTool(manager, config): Tool<typeof AgentParams>`:
  - `name: "Agent"`
  - `description`: 解释 SubAgent 用途和 isolation 参数
  - `execute(input, context)` → 委托 `manager.execute(input, context)`

### 4.2 条件注册逻辑
- 在启动流程中：
  ```typescript
  const subagentConfig = settings.subagent ?? { enabled: true };
  if (subagentConfig.enabled) {
    const subAgentManager = new SubAgentManager(llm, toolRegistry, sandbox, subagentConfig);
    toolRegistry.register(createAgentTool(subAgentManager, subagentConfig));
  }
  ```
- 关闭时：`Agent` Tool 不在 ToolRegistry → LLM 无法调用

### 4.3 单元测试
- 测试 `createAgentTool()` 返回合法的 Tool 实例
- 测试 `AgentParams` Zod 校验

---

## Step 5: CLI 集成

### 5.1 SubAgent 开关命令 — `packages/cli/src/components/input-box.tsx` 扩展
新增 3 个 Slash Command（Phase 3 CommandRouter 注册）：

**`/subagent on`:**
- 如果 Agent Tool 未注册 → `toolRegistry.register(createAgentTool(manager, config))`
- 消息: "SubAgent enabled."

**`/subagent off`:**
- 如果 Agent Tool 已注册 → `toolRegistry.unregister("Agent")`
- 不销毁已有持久化 SubAgent 实例
- 消息: "SubAgent disabled. Persistent SubAgents preserved."

**`/subagent status`:**
- 显示：`subagent.enabled` 状态
- 列出活跃的持久化 SubAgent（池中的 + 文件中的）

### 5.2 启动流程更新 — `packages/cli/src/app.tsx`
在 `initializeLICode()` 中添加：
```
Phase 5:
  1. 创建 WorktreeManager 实例
  2. 读取 settings.json 的 subagent 配置
  3. 如果 enabled → SubAgentManager + createAgentTool → ToolRegistry.register
  4. 注册 /subagent 命令到 CommandRouter
```

### 5.3 验证（手动测试）
1. 启动 LICode，输入 `/subagent status` → 显示 "SubAgent enabled. 0 persistent agents."
2. 输入 `/subagent off` → 验证 Agent Tool 被移除
3. 输入 `/subagent on` → 验证 Agent Tool 重新注册
4. 让 LLM 调用 Agent Tool → 观察 ToolCallCard 展示 SubAgent 执行
5. 输入 `/subagent status` → 显示持久化 SubAgent 列表
6. 非 git 项目 + `isolation: "worktree"` → 验证降级为共享目录

---

## Step 6: 集成收尾

### 6.1 `@licode/core` 公开导出更新 — `packages/core/src/index.ts`
```typescript
// Phase 5 Multi-Agent
export { SubAgentManager, SubAgentInstance } from './multi-agent/subagent';
export type { AgentSummary } from './multi-agent/subagent';
export { createAgentTool } from './multi-agent/agent-tool';
export { WorktreeManager } from './multi-agent/worktree';
export type { WorktreeContext, MergeResult } from './multi-agent/worktree';
export type { AgentToolInput, SubAgentConfig, SubAgentInstanceConfig } from './multi-agent/types';
```

### 6.2 端到端验证
1. `pnpm build` 无错误
2. Phase 1-4 所有单元测试通过（回归检查）
3. LLM 可自主调用 `Agent` Tool 执行子任务
4. One-shot SubAgent 执行完毕自动清理
5. Persistent SubAgent 跨调用保持状态
6. Git Worktree: 创建 → 编辑 → merge → 清理
7. Worktree 冲突时 SubAgent 返回错误给主 Agent
8. `/subagent on|off|status` 命令全部正常
9. 非 git 项目 SubAgent 降级运行（无 Worktree 隔离）
10. 并行多个 SubAgent 正确执行

---

## 验证清单

- [ ] Phase 1-4 所有单元测试通过（回归检查）
- [ ] `WorktreeManager.create()` / `merge()` / `discard()` 正确
- [ ] `WorktreeManager.isGitRepo()` 在 git 和非 git 目录正确
- [ ] `SubAgentInstance.run()` 正确复用 AgentLoop 类
- [ ] One-shot SubAgent 执行完 dispose 后 ConversationManager 清理
- [ ] Persistent SubAgent 第二次调用复用同一个 ConversationManager
- [ ] Worktree 成功场景：create → run → merge → 清理
- [ ] Worktree 失败场景：create → run → error → discard → 清理
- [ ] `SubAgentManager.execute()` 正确分流 One-shot vs Persistent
- [ ] `ToolRegistry.filterForAgent(whitelist)` 正确过滤
- [ ] `createAgentTool()` 返回符合 Tool 接口的实例
- [ ] `/subagent on` 正确注册 Agent Tool
- [ ] `/subagent off` 正确移除 Agent Tool（保留持久化实例）
- [ ] `/subagent status` 显示正确信息
- [ ] 并行多 SubAgent 无冲突
- [ ] ContextCompressor 正确计算 SubAgent 内的 token（独立的 TokenBudget）
- [ ] PermissionGuard 在 SubAgent 中正确复用

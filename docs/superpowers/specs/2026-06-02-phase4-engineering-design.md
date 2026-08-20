# Phase 4: 工程化能力 — 设计文档

**日期**: 2026-06-02
**状态**: 已确认
**范围**: LICode Phase 4 — 权限防御、上下文压缩、Token 管理、上下文溢写、跨会话记忆、会话持久化、Agent 沙箱

---

## 0. Phase 4 在全局中的位置

Phase 1 让 LICode "能说话"，Phase 2 让它"能动手"，Phase 3 让它"能扩展"。Phase 4 让它"能生产"——权限防御、上下文管理、跨会话记忆、会话持久化，这些不是用户直接可见的功能，但缺了它们 LICode 无法在真实项目中安全可靠地运行。

Phase 4 依赖 Phase 1-3 的基础设施：
- **Phase 1** — ConversationManager、SystemPrompt、EventPipeline
- **Phase 2** — ToolExecutor（Phase 4 在执行前插入权限检查）、Agent Loop
- **Phase 3** — Phase 3 零改动

**Phase 4 的核心设计原则：对已有代码最小侵入。** 权限检查通过 ToolExecutor 回调实现，上下文压缩通过 EventPipeline 中间件实现，记忆通过 SystemPrompt context 层注入。

| 如果 Phase 4 的... | 做好了 | 做坏了 |
|---|---|---|
| PermissionGuard | 用户始终知道 Agent 在做什么，按需拦截 | Agent 静默执行危险命令 |
| Sandbox | OS 级别阻止越权操作 | 权限系统误判 → 系统受损 |
| ContextCompressor | 长对话自动压缩，System Prompt 完整保留 | 压缩删掉了安全规则，或超出 token 限制后 crash |
| Memory | 跨会话记住用户偏好 | 每次对话都从零开始 |
| Session | 中断后恢复，多会话管理 | 崩溃后无法恢复，历史丢失 |

**Phase 4 完成标志：**
- 危险工具（Bash）执行前用户终端审批
- macOS Seatbelt 沙箱生效，限制文件写入范围
- 对话历史超限时自动压缩（裁剪 + LLM 摘要）
- 跨会话记忆存储和自动注入
- 中断会话可恢复
- 工具输出过长时自动溢写文件

---

## 1. 架构总览

Phase 4 在 `@licode/core` 中新增 `safety/`、`context/`、`memory/`、`session/` 四个模块：

```
@licode/core/src/
├── safety/         # Phase 4 新增
│   ├── permissions.ts    # PermissionGuard 中间件
│   ├── sandbox.ts        # Sandbox 接口 + macOS Seatbelt 实现
│   ├── policy.ts         # 权限策略（allow/deny/ask）
│   └── types.ts          # 权限 + 沙箱相关类型
├── context/        # Phase 4 新增
│   ├── compressor.ts     # ContextCompressor 压缩器
│   ├── token-budget.ts   # TokenBudget 预算管理
│   ├── overflow.ts       # 上下文溢写
│   └── summarizer.ts     # LLM 摘要生成
├── memory/         # Phase 4 新增
│   ├── store.ts          # MemoryStore 文件存储
│   ├── loader.ts         # MemoryLoader 注入 System Prompt
│   ├── extractor.ts      # MemoryExtractor 自动提取
│   └── types.ts          # 记忆类型定义
└── session/        # Phase 4 新增
    ├── persistence.ts    # 会话 JSON 持久化增强
    ├── recovery.ts       # 中断恢复
    └── manager.ts        # 多会话管理器
```

**关键设计决策：**

| 决策 | 选择 |
|------|------|
| 权限模型 | 每次弹窗 + 会话记忆 + 规则匹配 |
| 沙箱策略 | 跨平台 Sandbox 接口 + macOS Seatbelt 首实现 |
| 压缩策略 | System Prompt 永完整 + 裁剪最早消息 + LLM 摘要 |
| 记忆存储 | 文件系统 Markdown（YAML frontmatter + MEMORY.md 索引） |
| 会话数据 | JSON 文件持久化（Phase 1 增强） |

**子系统在管道中的位置：**

```
EventPipeline
  .use(hookMiddleware(hooks, "before:logging"))       // Phase 3
  .use(loggingMiddleware)                              // Phase 1
  .use(tokenCountingMiddleware)                        // Phase 1
  .use(permissionMiddleware(permissionGuard))          // Phase 4: 注入到 AsyncContext
  .use(contextMiddleware(contextCompressor))           // Phase 4: 每轮前检查并压缩
  .use(agentLoopMiddleware({...}))                     // Phase 2
  .use(rendererMiddleware)                             // Phase 1
  .use(errorHandlerMiddleware);                        // Phase 1
```

---

## 2. 对已有 Phase 的改动

### 2.1 Phase 1 改动

**SystemPrompt — 移除 budget 裁剪，保留按能力分层：**

```typescript
class SystemPrompt {
  // Phase 1 的 assemble(budget: number) 改为 assemble()
  // 不再按 token 预算裁剪 System Prompt —— 它永远完整
  // 分层机制保留 —— 用于按能力加载不同层（如 SubAgent 不需要全部工具指令）

  assemble(): string {
    return this.layers
      .sort((a, b) => a.priority - b.priority)
      .map((l) => l.content)
      .join("\n\n");
  }
}
```

**ConversationManager — 新增压缩钩子：**

```typescript
class ConversationManager {
  // Phase 1 方法保持不变

  /** Phase 4 新增：获取 System Prompt（用于压缩器计算 token） */
  getSystemPrompt(): string;

  /** Phase 4 新增：替换消息列表（压缩后使用） */
  replaceMessages(messages: Message[]): void;
}
```

### 2.2 Phase 2 改动

**ToolExecutor — 执行前回调 PermissionGuard：**

```typescript
class ToolExecutor {
  // Phase 2 的 executeParallel / executeOne 保持不变

  private async executeOne(
    toolUse: ToolUseBlock,
    options?: { signal?: AbortSignal }
  ): Promise<ToolResult> {
    const tool = this.registry.get(toolUse.name);
    if (!tool) {
      return { status: "error", error: `Unknown tool: ${toolUse.name}`, errorType: "validation" };
    }

    // ★ Phase 4 新增: 权限检查
    // AsyncContext 使用 Node.js AsyncLocalStorage 实现
    // PermissionGuard 由 permissionMiddleware 在管道中注入
    const guard = getAsyncContext("permissionGuard");
    if (guard) {
      const decision = await guard.check(tool, toolUse.input, {
        workingDirectory: process.cwd(),
        sessionId: toolUse.id,
        signal: options?.signal,
      });
      if (decision.action === "deny") {
        return { status: "error", error: decision.reason, errorType: "execution" };
      }
    }

    // 校验 + 执行（Phase 2 原有逻辑）
    const parsed = tool.parameters.safeParse(toolUse.input);
    // ...
  }
}
```

### 2.3 Phase 2 & 1 事件类型扩展

PipelineEvent 联合类型新增：`{ type: "context-compressed"; method?: "trim" | "summarize" }`。

### 2.4 Phase 3 改动

无。

---

## 3. 权限防御 (safety/)

### 3.1 PermissionGuard (`safety/permissions.ts`)

```typescript
type PermissionDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "ask"; toolName: string; input: unknown; description: string };

class PermissionGuard {
  /** 会话级许可记忆 */
  private sessionCache: Map<string, PermissionDecision> = new Map();

  /** 全局规则 */
  private rules: PermissionRule[] = [];

  constructor(private ui: PermissionUI) {}

  /**
   * 检查工具调用是否需要审批。
   * ToolExecutor 在执行每个工具前调用此方法。
   */
  async check(
    tool: Tool,
    input: unknown,
    context: ToolContext
  ): Promise<PermissionDecision> {
    // 1. 工具不要求审批 → 直接放行
    if (!tool.requiresApproval) return { action: "allow" };

    // 2. 检查全局规则
    const rule = this.matchRule(tool.name, input);
    if (rule) return rule;

    // 3. 检查会话缓存（"remember for this session"）
    const cached = this.sessionCache.get(this.cacheKey(tool.name, input));
    if (cached) return cached;

    // 4. 走 UI 审批
    return this.ui.ask({
      toolName: tool.name,
      description: tool.description,
      input,
      options: ["allow-once", "allow-session", "deny"],
    });
  }

  /** 记住本次会话的决策 */
  remember(key: string, decision: PermissionDecision): void;
  private matchRule(toolName: string, input: unknown): PermissionDecision | null;
  private cacheKey(toolName: string, input: unknown): string;
}
```

### 3.2 PermissionUI 接口

```typescript
// core 定义接口，cli 实现交互
interface PermissionUI {
  ask(request: PermissionRequest): Promise<PermissionDecision>;
}

interface PermissionRequest {
  toolName: string;
  description: string;
  input: unknown;
  options: ("allow-once" | "allow-session" | "deny")[];
}
```

CLI 实现 —— 终端交互：

```
⚙ Bash wants to run:
  $ rm -rf node_modules

Allow? [y]es / [n]o / [s] yes, remember for this session
```

### 3.3 permissionMiddleware

```typescript
function permissionMiddleware(guard: PermissionGuard): Middleware {
  return async (event, next) => {
    // 将 Guard 注入当前请求的 AsyncContext，供 ToolExecutor 使用
    setAsyncContext("permissionGuard", guard);
    await next();
  };
}
```

---

## 4. Agent 沙箱 (safety/sandbox.ts)

### 4.1 设计动机

PermissionGuard 是应用层审批——用户说 yes 工具才能跑。但审批可能会误判（用户习惯性按 y），权限规则可能有漏洞。沙箱是 OS 级保护——即使应用层审批通过，操作系统也会阻止越权操作。两道防线，防御纵深。

Node.js 没有原生的安全沙箱 API。`vm` 模块明确标注不是安全边界，`vm2` 库已因安全漏洞弃用。沙箱依赖 OS 的能力。

### 4.2 跨平台接口

```typescript
interface Sandbox {
  readonly name: string;

  /**
   * 在受控环境中执行命令。
   * 即使命令本身是恶意或危险的，沙箱应确保：
   * - 文件系统访问限制在 allowedPaths 内
   * - 网络访问受 allowNetwork 控制
   * - 进程超时后强制终止
   */
  execute(command: string, context: SandboxContext): Promise<SandboxResult>;

  /** 此沙箱在当前 OS 上是否可用 */
  isAvailable(): boolean;
}

interface SandboxContext {
  workingDirectory: string;
  allowedPaths: string[];
  allowNetwork: boolean;
  env: Record<string, string>;
  timeoutMs: number;
}

interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** 是否被沙箱拦截 */
  sandboxIntervention?: string;
}
```

### 4.3 macOS Seatbelt 实现

```typescript
// macOS 使用 sandbox-exec + Seatbelt profile
// Seatbelt 是 macOS 的强制访问控制（MAC）框架，内核级沙箱
class MacOSSandbox implements Sandbox {
  readonly name = "macos-seatbelt";

  isAvailable(): boolean {
    return process.platform === "darwin";
  }

  async execute(command: string, ctx: SandboxContext): Promise<SandboxResult> {
    const profile = this.buildProfile(ctx);

    const proc = spawn("sandbox-exec", [
      "-p", profile,
      "bash", "-c", command,
    ], {
      cwd: ctx.workingDirectory,
      timeout: ctx.timeoutMs,
      env: ctx.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const { stdout, stderr, exitCode } = await waitForExit(proc);

    return {
      exitCode: exitCode ?? 1,
      stdout,
      stderr,
      sandboxIntervention: this.detectIntervention(stderr),
    };
  }

  private buildProfile(ctx: SandboxContext): string {
    return `
      (version 1)
      (allow default)
      (deny file-write*)
      ${ctx.allowedPaths.map((p) => `(allow file-write* (subpath "${p}"))`).join("\n")}
      (allow file-write* (subpath "/tmp"))
      (allow file-write* (subpath "/private/tmp"))
      (allow file-read* (subpath "/dev"))
      (allow file-read* (subpath "/usr"))
      ${ctx.allowNetwork ? "(allow network*)" : "(deny network*)"}
    `;
  }

  private detectIntervention(stderr: string): string | undefined {
    if (stderr.includes("deny") && stderr.includes("sandbox")) {
      return stderr;
    }
    return undefined;
  }
}
```

### 4.4 Bash 工具中的集成

```typescript
class SandboxedBashTool implements Tool<typeof BashParams> {
  constructor(private sandbox: Sandbox | null) {}

  async execute(input, context) {
    if (this.sandbox && this.sandbox.isAvailable()) {
      const result = await this.sandbox.execute(input.command, {
        workingDirectory: context.workingDirectory,
        allowedPaths: [context.workingDirectory],
        allowNetwork: true,
        env: process.env as Record<string, string>,
        timeoutMs: input.timeout ?? 120000,
      });

      return {
        status: result.exitCode === 0 ? "success" : "error",
        content: result.stdout || result.stderr || "(no output)",
      };
    }

    // 降级 —— 无沙箱时直接执行（PermissionGuard 仍在生效）
    const result = await execAsync(input.command, {
      cwd: context.workingDirectory,
      timeout: input.timeout,
    });
    return {
      status: "success",
      content: result.stdout || result.stderr || "(no output)",
    };
  }
}
```

### 4.5 启动时沙箱选择

```typescript
function createSandbox(): Sandbox | null {
  const candidates: Sandbox[] = [
    new MacOSSandbox(),
    // new LinuxSeccompSandbox(),  // 未来实现
    // new DockerSandbox(),        // 未来实现
    // new WindowsSandbox(),       // 未来实现
  ];

  for (const sandbox of candidates) {
    if (sandbox.isAvailable()) {
      return sandbox;
    }
  }

  console.warn("[Safety] No OS sandbox available. Falling back to PermissionGuard only.");
  return null;
}
```

### 4.6 防御纵深

```
┌──────────────────────────────────┐
│            用户审批               │  ← 第一道: PermissionGuard.ask()
│   "Bash wants to run: rm -rf /"  │
│   → 用户看到并拒绝                │
├──────────────────────────────────┤
│           会话级记忆               │  ← 第二道: "remember for this session"
│   重复的请求不会反复弹窗            │
├──────────────────────────────────┤
│           OS 沙箱                  │  ← 第三道: sandbox-exec / seccomp
│   进程只能访问白名单路径             │     内核拦截越权系统调用
├──────────────────────────────────┤
│           审计日志                 │  ← 第四道: 所有操作记录到日志
│   事后可查谁在什么时候做了什么       │
└──────────────────────────────────┘
```

---

## 5. 上下文压缩与 Token 管理 (context/)

### 5.1 核心原则

**System Prompt 永远完整，不参与裁剪，不计入压缩配额。** System Prompt 定义 Agent 的人格——角色、安全规则、工具使用规范。裁剪 System Prompt = 改变 Agent 行为。压缩只针对对话历史。

### 5.2 ContextCompressor (`context/compressor.ts`)

```typescript
class ContextCompressor {
  constructor(
    private llm: LLMProvider,
    private budget: TokenBudget,
    private summarizer: Summarizer
  ) {}

  /**
   * 压缩对话历史以控制在 token 预算内。
   * 返回值表示是否发生了压缩。
   */
  async compress(conversation: ConversationManager): Promise<CompressResult> {
    const systemPrompt = conversation.getSystemPrompt();
    const systemTokens = this.budget.count(systemPrompt);

    // 安全检查：System Prompt 超出模型窗口 → 拒绝运行
    if (systemTokens > this.budget.modelMaxTokens) {
      throw new Error(
        `System prompt (${systemTokens} tokens) exceeds model limit ` +
        `(${this.budget.modelMaxTokens} tokens).`
      );
    }

    // 对话历史可用预算
    const historyBudget =
      this.budget.modelMaxTokens - systemTokens - TokenBudget.RESERVED_OUTPUT;

    let history = conversation.getMessages();
    let historyTokens = this.budget.countMessages(history);

    // 不超限 → 什么都不做
    if (historyTokens <= historyBudget) {
      return { compressed: false, messages: history };
    }

    // Step 1: 裁剪最早的消息对
    const { trimmed, summaryCandidates } = this.trimOldest(history, historyBudget);

    if (summaryCandidates.length === 0) {
      conversation.replaceMessages(trimmed);
      return { compressed: true, messages: trimmed, method: "trim" };
    }

    // Step 2: 裁剪后仍超限 → LLM 摘要
    const summaryMsg = await this.summarizer.summarize(summaryCandidates);
    const finalMessages = [summaryMsg, ...trimmed];
    conversation.replaceMessages(finalMessages);
    return { compressed: true, messages: finalMessages, method: "summarize" };
  }
}

interface CompressResult {
  compressed: boolean;
  messages: Message[];
  method?: "trim" | "summarize";
}
```

### 5.3 三步压缩策略

```
Step 0: System Prompt 永远完整 —— 不参与任何裁剪
────────────────────────────────────────────
Step 1: 裁剪最早的消息对
  从第 1 对 (user + assistant + tool) 开始删除
  直到对话历史 token 数 ≤ 预算
  
  裁剪后超限的消息移入 summaryCandidates
────────────────────────────────────────────
Step 2: LLM 摘要（仅当裁剪不够时）
  将被裁剪的消息发送给 LLM 生成摘要
  摘要作为一条 user 消息注入对话历史最前面
  格式: "[Earlier in this conversation]: ..."

不超限 → 什么都不做（零开销）
超限 → 裁剪（零 LLM 调用）
裁剪不够 → 摘要（一次 LLM 调用）
```

### 5.4 Summarizer (`context/summarizer.ts`)

```typescript
class Summarizer {
  constructor(private llm: LLMProvider) {}

  /** 用一次 LLM 调用生成早期对话的摘要 */
  async summarize(messages: Message[]): Promise<Message> {
    const text = messages
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n");

    const response = await this.llm.chat({
      messages: [{
        role: "user",
        content:
          `Summarize the following conversation excerpt concisely. ` +
          `Focus on: key decisions made, ongoing tasks, important context ` +
          `that future turns will need.\n\n${text}`,
      }],
      maxTokens: 500,
    });

    return {
      role: "user",
      content: `[Earlier in this conversation]: ${response.content}`,
    };
  }
}
```

### 5.5 TokenBudget (`context/token-budget.ts`)

```typescript
class TokenBudget {
  /** 模型最大上下文窗口 */
  readonly modelMaxTokens: number;

  /** 响应预留 token */
  static readonly RESERVED_OUTPUT = 4096;

  /** 压缩阈值 */
  static readonly COMPRESS_THRESHOLD = 0.85;

  constructor(modelMaxTokens: number) {
    this.modelMaxTokens = modelMaxTokens;
  }

  /** 需要压缩？ */
  shouldCompress(usedTokens: number): boolean {
    return usedTokens > this.modelMaxTokens * TokenBudget.COMPRESS_THRESHOLD;
  }

  /** 对话历史可用预算 */
  historyBudget(systemTokens: number): number {
    return this.modelMaxTokens - systemTokens - TokenBudget.RESERVED_OUTPUT;
  }

  count(text: string): number;
  countMessages(messages: Message[]): number;
}
```

### 5.6 上下文溢写 (`context/overflow.ts`)

```typescript
class ContextOverflow {
  /** 单条工具结果超过此长度时，写入文件 */
  static readonly OVERFLOW_LENGTH = 10_000;

  private overflowDir: string;

  /**
   * 检查工具结果是否需要溢写。
   * 超长输出 → 写入 .licode/overflow/ 目录 → 返回文件路径引用
   * 正常长度 → 原样返回
   */
  async maybeOverflow(result: ToolResult): Promise<ToolResult> {
    if (result.status !== "success") return result;
    if (result.content.length <= ContextOverflow.OVERFLOW_LENGTH) {
      return result;
    }

    const file = path.join(this.overflowDir, `result-${uuid()}.txt`);
    await writeFile(file, result.content);

    return {
      status: "success",
      content:
        result.content.slice(0, 500) +
        `\n\n[Output truncated. Full content written to ${file}. ` +
        `Use Read tool to access if needed.]`,
    };
  }
}
```

### 5.7 contextMiddleware

```typescript
function contextMiddleware(
  compressor: ContextCompressor,
  conversation: ConversationManager,
  eventBus: EventBus
): Middleware {
  return async (event, next) => {
    if (event.type === "user-message") {
      const result = await compressor.compress(conversation);
      if (result.compressed) {
        eventBus.emit({
          type: "context-compressed",
          method: result.method,
        } as PipelineEvent);
      }
    }
    await next();
  };
}
```

---

## 6. 跨会话记忆 (memory/)

### 6.1 概述

记忆以 Markdown 文件形式存储，每个记忆一个文件，YAML frontmatter 标注类型和元数据。`MEMORY.md` 索引导航所有记忆。
LLM 通过 System Prompt 的 context 层注入 MEMORY.md 的内容。

### 6.2 记忆类型 (`memory/types.ts`)

```typescript
type MemoryType = "user" | "feedback" | "project" | "reference";

interface Memory {
  path: string;          // 文件路径 slug
  type: MemoryType;
  description: string;   // 一句话描述
  content: string;       // 记忆正文
  createdAt: string;
  updatedAt: string;
}
```

### 6.3 目录结构

```
~/.licode/memory/
├── MEMORY.md              # 索引入口（注入 System Prompt）
├── user/                  # 用户角色、偏好、知识背景
│   ├── role.md
│   └── preferences.md
├── feedback/              # 用户校正和反馈
│   └── no-mocks.md
├── project/               # 项目决策、目标、约束
│   └── licode-init.md
└── reference/             # 外部系统引用
    └── bugs-linear.md

.licode/memory/            # 项目级记忆（可选）
└── MEMORY.md
```

### 6.4 记忆文件格式

```markdown
---
name: user-role
description: User is a full-stack developer, prefers TypeScript
type: user
createdAt: 2026-06-01T10:00:00Z
---

The user is a full-stack TypeScript developer working on LICode.
They prefer concise answers, no emojis, and architectural
discussions before implementation.
```

### 6.5 MEMORY.md 索引

```markdown
- [User role](user/role.md) — Full-stack TS developer, prefers concise answers
- [No mocks](feedback/no-mocks.md) — Integration tests must hit real database
- [LICode context](project/licode-init.md) — Design decisions for LICode
- [Bug tracker](reference/bugs-linear.md) — Pipeline bugs in Linear "INGEST"
```

### 6.6 MemoryStore (`memory/store.ts`)

```typescript
class MemoryStore {
  private baseDir: string;

  constructor(baseDir: string);

  /** 写入记忆 —— 创建或更新记忆文件 + 更新 MEMORY.md */
  async save(memory: Memory): Promise<void>;

  /** 读取单个记忆 */
  async load(path: string): Promise<Memory | null>;

  /** 删除记忆 */
  async delete(path: string): Promise<void>;

  /** 搜索记忆 */
  async search(query: string): Promise<Memory[]>;

  /** 列出所有记忆 */
  async listAll(): Promise<Memory[]>;

  /** 加载索引入口内容（用于注入 System Prompt） */
  async loadIndex(): Promise<string>;
}
```

### 6.7 MemoryLoader —— 注入 System Prompt

```typescript
// 启动时将 MEMORY.md 注入 System Prompt 的 context 层
async function loadMemories(
  store: MemoryStore,
  systemPrompt: SystemPrompt
): Promise<void> {
  const indexContent = await store.loadIndex();
  if (indexContent.length === 0) return;

  systemPrompt.addLayer({
    name: "memory",
    priority: 5,            // 高优先级，紧随 role 和 safety
    always: false,          // Token 极其紧张时可裁剪
    content: `# User Memory\n\nThe following memories are from previous conversations with the user:\n\n${indexContent}`,
  });
}
```

### 6.8 MemoryExtractor (`memory/extractor.ts`)

```typescript
class MemoryExtractor {
  constructor(private llm: LLMProvider) {}

  /**
   * 判断是否值得从当前对话中提取记忆。
   * 触发条件：
   *  1. 用户明确说 "remember X"
   *  2. 用户纠正了 Agent 的行为
   *  3. 用户透露了新的偏好/角色信息
   */
  shouldExtract(messages: Message[]): boolean;

  /**
   * 用 LLM 分析对话并生成记忆条目。
   * 每次 Agent Loop 完成后调用。
   */
  async extract(messages: Message[], store: MemoryStore): Promise<Memory[]> {
    const prompt = `Analyze this conversation and identify information that should be remembered for future sessions.

Look for:
1. User role, preferences, knowledge (→ type: user)
2. Corrections or feedback from the user (→ type: feedback)
3. Project decisions, goals, constraints (→ type: project)
4. References to external systems (→ type: reference)

For each finding, output JSON:
{ "type": "...", "slug": "...", "description": "...", "content": "..." }
If nothing qualifies, output: { "none": true }`;

    const response = await this.llm.chat({
      messages: [...messages, { role: "user", content: prompt }],
      maxTokens: 1000,
    });

    const findings = parseMemoryFindings(response.content);
    const saved: Memory[] = [];
    for (const f of findings) {
      const memory: Memory = {
        path: `${f.type}/${f.slug}.md`,
        type: f.type,
        description: f.description,
        content: f.content,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await store.save(memory);
      saved.push(memory);
    }
    return saved;
  }
}
```

---

## 7. 会话持久化 (session/)

### 7.1 概述

Phase 1 已实现 `ConversationManager.save()` / `.load()`。Phase 4 在此基础上增强多会话管理和中断恢复。

### 7.2 SessionManager (`session/manager.ts`)

```typescript
class SessionManager {
  private sessionDir: string;  // .licode/sessions/

  /** 创建新会话 */
  async create(metadata: SessionMetadata): Promise<ConversationManager>;

  /** 恢复会话 */
  async resume(id: string): Promise<ConversationManager>;

  /** 列出所有会话 */
  async list(filter?: SessionFilter): Promise<SessionSummary[]>;

  /** 删除会话 */
  async delete(id: string): Promise<void>;

  /** 从上次中断处恢复 */
  async recoverFromCrash(): Promise<ConversationManager | null>;
}

interface SessionSummary {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  model: string;
  status: "active" | "completed" | "archived";
}

interface SessionMetadata {
  title?: string;
  tags?: string[];
  model: string;
}
```

### 7.3 中断恢复 (`session/recovery.ts`)

```typescript
// 会话 JSON 中包含状态标记
interface SessionData {
  id: string;
  status: "active" | "completed" | "archived";
  lastCompletedAt: string | null;
  messages: Message[];
  metadata: SessionMetadata;
}

// 启动时检查中断会话
async function tryRecover(sessionManager: SessionManager): Promise<ConversationManager> {
  const interrupted = await sessionManager.list({ status: "active" });
  if (interrupted.length > 0) {
    // CLI: "Found {N} interrupted session(s). Resume? [y/n]"
    const toResume = await askUser(interrupted);
    if (toResume) {
      return sessionManager.resume(toResume.id);
    }
  }
  return sessionManager.create({ model: "claude-sonnet-4-6" });
}
```

### 7.4 自动保存机制

```typescript
// 每次 Agent Loop 完成后，ConversationManager 自动调用 save()
// conversation.save() → 写入 .licode/sessions/{id}.json
// 写入频率: Agent Loop 每完成一轮（不是每个 token）

// 会话文件大小管理:
// - 自动压缩的对话（超过 1000 条消息的会话）保存完整版 + 摘要版
// - 摘要版只含最近 100 条消息 + 早期摘要
```

---

## 8. 启动集成流程

```typescript
async function initializeLICode(config: LICodeConfig) {
  // ===== Phase 1: 核心对话 =====
  const llm = new AnthropicProvider({ apiKey: config.apiKey });
  const systemPrompt = new SystemPrompt();
  systemPrompt.addLayer(ROLE_LAYER);
  systemPrompt.addLayer(SAFETY_LAYER);

  // ===== Phase 4: 记忆注入 =====
  const userMemoryStore = new MemoryStore(path.join(os.homedir(), ".licode", "memory"));
  const projectMemoryStore = new MemoryStore(path.join(process.cwd(), ".licode", "memory"));
  await loadMemories(userMemoryStore, systemPrompt);
  await loadMemories(projectMemoryStore, systemPrompt);

  const conversation = await tryRecover(sessionManager);

  // ===== Phase 2: Agent 核心 =====
  const toolRegistry = new ToolRegistry();
  const sandbox = createSandbox();
  toolRegistry.registerAll([
    new SandboxedBashTool(sandbox), readTool, writeTool, editTool, globTool, grepTool,
  ]);

  // ===== Phase 3: 扩展协议 =====
  // (MCP, Skill, Command, Hook — 代码不变)

  // ===== Phase 4: 安全 + 上下文管理 =====
  const permissionGuard = new PermissionGuard(new CLIPermissionUI());
  const tokenBudget = new TokenBudget(llm.maxContextTokens);
  const summarizer = new Summarizer(llm);
  const contextCompressor = new ContextCompressor(llm, tokenBudget, summarizer);
  const overflow = new ContextOverflow(path.join(process.cwd(), ".licode", "overflow"));
  const memoryExtractor = new MemoryExtractor(llm);

  // ===== 组装 EventPipeline =====
  const pipeline = assemblePipeline(hookManager, {
    llm, conversation, tools: toolRegistry,
    permissionGuard, contextCompressor,
  });

  return { pipeline, conversation, commandRouter };
}
```

---

## 9. 依赖清单

Phase 4 新增依赖：

| 包 | 用途 |
|----|------|
| 无 | 全部使用已有依赖 |

Phase 4 不引入新的第三方依赖。沙箱使用 macOS 系统命令 `sandbox-exec`，记忆使用 Node.js 内置 `fs` 模块。

---

## 10. Phase 4 边界与不包含

- 跨机器/跨设备的记忆同步 —— 仅本地文件系统
- 云端会话备份
- Linux seccomp / Docker / Windows 沙箱的具体实现 —— 仅定义接口 + macOS 实现
- 记忆的语义搜索（向量数据库）—— Phase 4 只做 MEMORY.md 文本匹配
- SubAgent 的权限继承和沙箱隔离 —— Phase 5

# Phase 6: Spec 开发模式 — 设计文档

**日期**: 2026-06-02
**状态**: 已确认
**范围**: LICode Phase 6 — Vibe Coding 全流程、Spec 三件套、CLAUDE.md 项目指令

---

## 0. Phase 6 在全局中的位置

Phase 1-5 让 LICode 成为一个完整的 Agent 引擎。Phase 6 赋予它方法论——Spec 开发模式（spec.md / tasks.md / checklist.md 三件套 + CLAUDE.md 项目指令）是 LICode 组织和指导开发流程的方式。

### 0.1 核心场景

Phase 6 不是 LICode 自身开发的文档系统。它是 **LICode 为用户的项目** 生成和管理 Spec 工作流文件的能力：

```
用户: "我想做一个 Todo App"
  ↓
LICode 执行 /brainstorming → 讨论需求
  ↓
LICode 在用户的项目目录下生成三件套:
  docs/specs/todo-app/
  ├── spec.md        # 需求规格 + 验收标准
  ├── tasks.md       # 任务分解 + 依赖关系
  └── checklist.md   # 质量检查清单
  ↓
LICode 对照三件套逐步实现
  ↓
每完成一个 task，LICode 更新 tasks.md 的 checkbox
  ↓
最后 LICode 执行 validate，确认全部通过
```

LICode 自己吃自己的狗粮：我们在设计 LICode 时用同样的流程（`docs/superpowers/specs/` 下的 Phase 1-6 文档），用户拿到 LICode 后也用同样的流程做他们的项目。

### 0.2 Phase 6 与前 5 个 Phase 的本质区别

| | Phase 1-5 | Phase 6 |
|---|---|---|
| **位置** | `@licode/core` 内部引擎 | `@licode/spec-kit` 工作流工具 |
| **性质** | Agent 能力（对话、工具、扩展、安全、多 Agent） | 开发方法论（计划、执行、检查） |
| **对引擎的影响** | 修改 core 代码 | 零侵入——只通过 System Prompt 注入 + CLI 命令 |
| **用户视角** | 用户感受不到 Phase 2 的 ToolExecutor 内部实现 | 用户直接使用 /brainstorming → spec init → validate |

**Phase 6 依赖 Phase 1-5 的全部能力：**
- **Phase 1** — SystemPrompt 分层机制（spec 文件注入为 context 层）
- **Phase 2** — Agent Loop（LICode Agent 能够执行 spec 中定义的 tasks）
- **Phase 3** — Slash Command（`/brainstorming`、`/writing-plans`）
- **Phase 4** — 上下文压缩（spec 文件可能很大但必须完整保留）
- **Phase 5** — SubAgent（大 spec 可拆为多个 SubAgent 并行执行）

**Phase 6 完成标志：**
- `licode spec init [name]` 在项目目录生成三件套
- `licode spec validate [name]` 校验完成度
- `licode spec status` 展示所有活跃 Spec 的仪表盘
- `licode spec list` 列出所有 Spec
- LICode Agent 启动时自动加载项目的活跃 Spec 和 CLAUDE.md 到 System Prompt

---

## 1. 架构总览

### 1.1 目录结构

```
licode/（LICode 自身的仓库）
├── packages/
│   ├── core/      # Phase 1-5 引擎
│   ├── cli/       # Phase 1-5 CLI
│   └── spec-kit/   # Phase 6 工作流工具
│       └── src/
│           ├── init.ts         # licode spec init 命令
│           ├── validate.ts     # licode spec validate 命令
│           ├── status.ts       # licode spec status 命令
│           ├── list.ts         # licode spec list 命令
│           └── loaders.ts      # SpecLoader —— 读取用户项目的 spec 文件
├── templates/     # 三件套 + CLAUDE.md 模板
│   ├── spec.md
│   ├── tasks.md
│   ├── checklist.md
│   └── CLAUDE.md
└── docs/superpowers/specs/  # LICode 自身的 Spec 文档（Phase 1-6）

用户使用 LICode 的项目：
├── docs/specs/                   # ← spec-kit init 生成的
│   └── login-system/
│       ├── spec.md
│       ├── tasks.md
│       └── checklist.md
└── CLAUDE.md                     # ← LICode 自动读取并注入 System Prompt
```

### 1.2 关键设计决策

| 决策 | 选择 |
|------|------|
| 工具形态 | CLI 命令 + 模板文件（LICode 子命令） |
| Spec 注入方式 | 启动时读入 System Prompt context 层 |
| 文件格式 | 纯 Markdown（人可读写，Agent 可解析） |
| 对引擎侵入 | 零——不需要改 core 的任何代码 |

---

## 2. 三件套文件格式

### 2.1 spec.md —— 需求规格

```markdown
# [功能名称]

**日期**: YYYY-MM-DD
**状态**: draft | review | approved | implemented
**负责人**: @username

## 概述
[一段话描述要做什么、为什么做]

## 用户故事
- 作为 [角色]，我想要 [功能]，以便 [价值]

## 验收标准
- [ ] [可测试的条件]
- [ ] [可测试的条件]

## 技术约束
- [技术栈、性能要求、兼容性]

## 非目标
- [明确不做什么]
```

### 2.2 tasks.md —— 任务分解

```markdown
# Tasks

## 1. [任务组名称]
- [ ] 1.1 [具体任务] — 预计: 2h — 依赖: 无
- [ ] 1.2 [具体任务] — 预计: 1h — 依赖: 1.1
- [ ] 1.3 [具体任务] — 预计: 3h — 依赖: 1.2

## 2. [任务组名称]
- [ ] 2.1 [具体任务] — 预计: 2h — 依赖: 1.3
- [ ] 2.2 [具体任务] — 预计: 1h — 依赖: 无
```

### 2.3 checklist.md —— 质量检查清单

```markdown
# Checklist

## 功能完整性
- [ ] 所有验收标准通过
- [ ] 边界情况已处理

## 代码质量
- [ ] 类型检查通过 (tsc --noEmit)
- [ ] Lint 通过
- [ ] 测试通过

## 安全性
- [ ] 无命令注入风险
- [ ] 敏感信息不硬编码

## 文档
- [ ] 新 API 有文档
- [ ] 更新 CHANGELOG
```

---

## 3. CLAUDE.md 项目指令

### 3.1 概述

CLAUDE.md 位于项目根目录，LICode Agent 在每次对话中通过 System Prompt 的 context 层自动读取其内容。它告诉 Agent "这个项目是什么样的、有什么约定、当前在做什么"。

### 3.2 格式示例

```markdown
# CLAUDE.md

## 项目概述
LICode —— 类 Claude Code 的 CLI Agent。

## 技术栈
- TypeScript + Node.js
- pnpm monorepo
- Ink 5 (React for CLI)

## 项目结构
- packages/core —— 核心引擎
- packages/cli —— CLI 入口
- packages/spec-kit —— Spec 工具包

## 编码规范
- 不需要写注释，除非 WHY 不显而易见
- 不提前抽象——三个相似行好过不成熟的封装
- 只在系统边界做校验

## 当前阶段
Phase 1-5 设计完成，Phase 6 设计中。
```

### 3.3 双重用途

CLAUDE.md 既是 LICode 自身开发的指令文件，也是 LICode 为用户项目注入上下文的方式：

```
LICode 仓库的 CLAUDE.md → LICode Agent 开发 LICode 时读取
用户项目的 CLAUDE.md → LICode Agent 帮用户开发时读取
```

---

## 4. Spec 文件注入 System Prompt

### 4.1 SpecLoader (`spec-kit/src/loaders.ts`)

```typescript
/**
 * 读取用户项目的活跃 Spec 文件，注入到 System Prompt。
 * 在 LICode 启动时调用。
 */
async function loadSpecFiles(systemPrompt: SystemPrompt): Promise<void> {
  const specDir = path.join(process.cwd(), "docs", "specs");
  if (!(await exists(specDir))) return;

  // 找到最新的 spec 目录
  const specs = (await readdir(specDir))
    .filter((d) => d.startsWith("202"))
    .sort()
    .reverse();

  // 最多加载 3 个活跃 spec（避免 System Prompt 膨胀）
  for (const specName of specs.slice(0, 3)) {
    const specPath = path.join(specDir, specName);
    const files = await readdir(specPath);

    const content: string[] = [];
    for (const file of files) {
      const raw = await readFile(path.join(specPath, file), "utf-8");
      content.push(`### ${file}\n\n${raw}`);
    }

    systemPrompt.addLayer({
      name: `spec:${specName}`,
      priority: 12,  // 在 role/safety/memory 之后，tool-use 之前
      always: false,
      content: `# Active Spec: ${specName}\n\n${content.join("\n\n---\n\n")}`,
    });
  }
}
```

### 4.2 CLAUDE.md 注入

```typescript
// CLAUDE.md 的注入更简单——启动时读取，注入 System Prompt
async function loadCLAUDE(systemPrompt: SystemPrompt): Promise<void> {
  const claudePath = path.join(process.cwd(), "CLAUDE.md");
  if (!(await exists(claudePath))) return;

  const content = await readFile(claudePath, "utf-8");

  systemPrompt.addLayer({
    name: "claude",
    priority: 10,        // 在 role/safety 之后
    always: true,       // 项目指令不应该被裁剪
    content: `# Project Instructions (CLAUDE.md)\n\n${content}`,
  });
}
```

### 4.3 System Prompt 分层中的 Spec 位置

```
priority 0:  role        (always)  ← Agent 角色定义
priority 1:  safety      (always)  ← 安全规则
priority 5:  memory      (optional) ← 跨会话记忆
priority 10: claude      (always)  ← CLAUDE.md 项目指令
priority 12: spec        (optional) ← Spec 三件套
priority 15: skills      (optional) ← Skill 描述
priority 20: context     (optional) ← 其他上下文
```

---

## 5. CLI 命令

### 5.1 命令清单

```
licode spec init [name]       # 在用户项目中生成三件套
licode spec validate [name]   # 校验完成度和通过率
licode spec status            # 仪表盘展示所有活跃 Spec 进度
licode spec list              # 列出所有 Spec
```

### 5.2 `spec init [name]`

```typescript
// 在用户项目的 docs/specs/YYYY-MM-DD-[name]/ 下生成三件套
async function specInit(name: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const dir = path.join(process.cwd(), "docs", "specs", `${today}-${slugify(name)}`);

  await mkdir(dir, { recursive: true });

  // 从 LICode 内置模板复制，做变量替换
  await writeFile(path.join(dir, "spec.md"), renderTemplate("spec", { name, date: today }));
  await writeFile(path.join(dir, "tasks.md"), renderTemplate("tasks", { name, date: today }));
  await writeFile(path.join(dir, "checklist.md"), renderTemplate("checklist", { name, date: today }));

  console.log(`Spec initialized: ${dir}`);
  console.log(`  ├── spec.md`);
  console.log(`  ├── tasks.md`);
  console.log(`  └── checklist.md`);
}
```

### 5.3 `spec validate [name]`

```typescript
// 校验一个 Spec 的完成状态
async function specValidate(name?: string): Promise<ValidationResult> {
  const spec = await loadSpec(name);  // 不指定则取最新的

  const tasks = parseCheckboxes(spec.tasksMd);
  const checklist = parseCheckboxes(spec.checklistMd);
  const acceptance = parseAcceptanceCriteria(spec.specMd);

  return {
    tasksCompleted: tasks.filter(t => t.checked).length,
    tasksTotal: tasks.length,
    tasksPercentage: tasks.length > 0
      ? Math.round((tasks.filter(t => t.checked).length / tasks.length) * 100)
      : 0,
    checklistPassed: checklist.filter(c => c.checked).length,
    checklistTotal: checklist.length,
    acceptanceMet: acceptance.filter(a => a.checked).length,
    acceptanceTotal: acceptance.length,
  };
}
```

### 5.4 `spec status`

```typescript
// 仪表盘展示
async function specStatus(): Promise<void> {
  const specs = await listAllSpecs();
  for (const spec of specs) {
    const result = await specValidate(spec.name);
    console.log(`\n${spec.name}`);
    console.log(`  Tasks:     ${result.tasksCompleted}/${result.tasksTotal} (${result.tasksPercentage}%)`);
    console.log(`  Checklist: ${result.checklistPassed}/${result.checklistTotal}`);
    console.log(`  Acceptance: ${result.acceptanceMet}/${result.acceptanceTotal}`);
  }
}
```

---

## 6. Agent 更新 Spec 文件

LICode Agent 在执行 spec 中的 tasks 时，可以：
1. 完成任务后通过 Edit 工具更新 `tasks.md` 的 checkbox
2. 通过检查清单后更新 `checklist.md`
3. 验收标准满足后更新 `spec.md`

这是 LICode Agent 使用 Phase 2 的 Edit 工具改 spec 文件——不是 Phase 6 特殊机制。Agent 知道"当前 spec 文件在哪里"是因为它们被注入到了 System Prompt。

---

## 7. 完整 Vibe Coding 工作流

```
Step 1: 需求
  用户: "我想做 X"
  LICode: /brainstorming → 讨论需求、约束、技术选型

Step 2: Spec 生成
  LICode: spec init X
  → 用户项目 docs/specs/2026-06-02-X/ 下生成三件套

Step 3: 计划
  LICode: /writing-plans → 细化任务，填充 tasks.md

Step 4: 执行
  LICode: 对照三件套逐步实现
  → 启动时自动注入 spec 文件到 System Prompt
  → Agent 知道"当前在做什么、还差什么"
  → 每完成一个 task，Agent 更新 tasks.md

Step 5: 检查
  LICode: spec validate → 统计完成度
  → 未完成的 checklist 项提示用户

Step 6: 迭代
  → 用户反馈 → 更新 spec.md → 继续执行
```

---

## 8. 依赖清单

Phase 6 新增依赖：无。

`spec-kit` 只使用 Node.js 内置的 `fs` 和 `path` 模块。

---

## 9. Phase 6 边界与不包含

- Spec 文件的 Git 自动提交（用户可以自己管理）
- Spec 文件模板的热更新（模版随 LICode 版本一起发布）
- 可视化 Spec 管理界面（Phase 6 只做 CLI）
- Spec 之间的依赖关系管理（每个 Spec 独立）
- 远程 Spec 模板下载（内置模板已足够）

# Phase 6 实现计划：Spec 开发模式

**日期**: 2026-06-03
**设计文档**: `docs/superpowers/specs/2026-06-02-phase6-spec-design.md`
**前置**: Phase 1-5 已完成

---

## Context

Phase 1-5 让 LICode 成为一个完整的 Agent 引擎。Phase 6 赋予它方法论——Spec 开发模式（spec.md / tasks.md / checklist.md 三件套 + CLAUDE.md）是 LICode 组织和指导开发流程的方式。

核心场景：用户说"帮我做一个 Todo App"，LICode 通过 /brainstorming 讨论需求后，在**用户的项目目录**下生成三件套，然后对照三件套逐步实现，每完成一步更新 checkbox。

Phase 6 与前 5 个 Phase 的本质区别：不修改 `@licode/core` 引擎。通过 System Prompt 注入 + CLI 命令 + Markdown 模板实现。零引擎侵入。

**Phase 6 零新依赖。** 只使用 Node.js 内置 `fs` 和 `path` 模块。

---

## 实现顺序（依赖关系）

```
1. 模板文件 (零依赖)
   ↓
2. spec-kit 包脚手架 (零依赖)
   ↓
3. loaders.ts (依赖 fs/path + Phase 1 SystemPrompt 类型)
   ↓
4. CLI 命令 (依赖 loaders.ts)
   ↓
5. CLI 集成 (启动流程 + 模板路径解析)
   ↓
6. 集成收尾 (LICode 自身使用三件套)
```

---

## Step 1: 模板文件

**目标**: 创建三件套模板和 CLAUDE.md 模板，作为 `spec init` 的生成基础。

### 1.1 模板文件 — `licode/templates/`

**`spec.md` 模板:**
```markdown
# {{name}}

**日期**: {{date}}
**状态**: draft
**负责人**: @

## 概述
[描述要做什么、为什么做]

## 用户故事
- 作为 [角色]，我想要 [功能]，以便 [价值]

## 验收标准
- [ ] [可测试的条件]

## 技术约束
- [技术栈、性能要求、兼容性]

## 非目标
- [明确不做什么]
```

**`tasks.md` 模板:**
```markdown
# Tasks — {{name}}

**日期**: {{date}}

## 1. Setup
- [ ] 1.1 [初始化项目/环境] — 预计: 1h — 依赖: 无

## 2. Core
- [ ] 2.1 [核心功能] — 预计: 3h — 依赖: 1.1

## 3. Polish
- [ ] 3.1 [边界情况] — 预计: 2h — 依赖: 2.1
```

**`checklist.md` 模板:**
```markdown
# Checklist — {{name}}

## 功能完整性
- [ ] 所有验收标准通过
- [ ] 边界情况已处理

## 代码质量
- [ ] 类型检查通过
- [ ] Lint 通过
- [ ] 测试通过

## 安全性
- [ ] 输入校验
- [ ] 无敏感信息硬编码

## 文档
- [ ] README 更新
- [ ] API 文档更新
```

**`CLAUDE.md` 模板:**
```markdown
# CLAUDE.md

## 项目概述
[项目的一句话描述]

## 技术栈
- [语言/框架]

## 项目结构
- [目录说明]

## 编码规范
- [团队规范]

## 当前阶段
[正在做什么]
```

### 1.2 模板渲染函数
- 在 `spec-kit` 包内实现 `renderTemplate(name, vars)`：
  - 读取模板文件
  - `{{name}}` → 替换为 `vars.name`
  - `{{date}}` → 替换为 `vars.date`
  - 简单字符串替换即可（不需要完整的模板引擎）

### 1.3 验证
- 模板文件存在
- 渲染后不包含未替换的 `{{...}}` 占位符（除了 markdown 中不属于模板语法的 `{{`）

---

## Step 2: `@licode/spec-kit` 包脚手架

**目标**: 搭建新包的 monorepo 结构。

### 2.1 包配置
- `packages/spec-kit/package.json`:
  - name: `@licode/spec-kit`
  - 依赖（仅 devDependencies 的 TypeScript）
  - 零 runtime 依赖
  - `"bin": { "licode-spec": "./bin/spec.js" }`（或集成到 CLI 主入口）
- `packages/spec-kit/tsconfig.json`（extends base）

### 2.2 目录结构
```
packages/spec-kit/
├── bin/
│   └── spec.js             # CLI 入口（注册到 licode CLI）
├── src/
│   ├── init.ts              # spec init 命令
│   ├── validate.ts          # spec validate 命令
│   ├── status.ts            # spec status 命令
│   ├── list.ts              # spec list 命令
│   ├── loaders.ts           # SpecLoader + CLAUDE.md loader
│   ├── parser.ts            # Checkbox 解析器
│   └── index.ts             # 公开导出
├── package.json
└── tsconfig.json
```

### 2.3 更新 pnpm-workspace.yaml
- 已声明 `packages/*`，无需修改

### 2.4 验证
- `pnpm install` 成功
- `pnpm -C packages/spec-kit build` 成功（空包）

---

## Step 3: SpecLoader

**目标**: 实现 `loadSpecFiles()` 和 `loadCLAUDE()`，将用户项目的 Spec 和 CLAUDE.md 注入 System Prompt。

### 3.1 — `packages/spec-kit/src/loaders.ts`

**`loadCLAUDE(systemPrompt: SystemPrompt): Promise<void>`**
- 检查 `CLAUDE.md` 是否存在于 `process.cwd()`
- 读取内容
- 添加 `SystemPromptLayer`:
  - `name: "claude"`, `priority: 10`, `always: true`
  - content: `# Project Instructions (CLAUDE.md)\n\n${content}`
- 文件不存在 → 跳过（无日志，不是错误）

**`loadSpecFiles(systemPrompt: SystemPrompt): Promise<void>`**
- 检查 `docs/specs/` 是否存在于 `process.cwd()`
- 扫描子目录，过滤以 `202` 开头（YYYY-MM-DD 格式），按字母序倒排
- 最多加载 3 个活跃 Spec
- 每个 Spec：读入 `spec.md` + `tasks.md` + `checklist.md` 三个文件
  - 缺的文件跳过（不报错）
  - 拼接为：`# Active Spec: ${name}\n\n### spec.md\n\n...\n\n---\n\n### tasks.md\n\n...`
- 添加 `SystemPromptLayer`:
  - `name: "spec:${specName}"`, `priority: 12`, `always: false`
- `docs/specs/` 不存在 → 跳过

### 3.2 Checkbox 解析器 — `packages/spec-kit/src/parser.ts`
- `parseCheckboxes(md: string): CheckboxItem[]`:
  - 正则匹配 `- [ ]` 和 `- [x]` 模式
  - 返回 `{ text: string, checked: boolean, line: number }[]`
  - 大小写不敏感：`[x]` 和 `[X]` 都视为 checked
- `parseAcceptanceCriteria(specMd: string): CheckboxItem[]`:
  - 匹配 `## 验收标准` 标题下的 checkbox 列表
- `computeStats(checkboxes: CheckboxItem[]): { completed, total, percentage }`:
  - 简单的计数 + 百分比

### 3.3 单元测试
- 测试 `parseCheckboxes()` 正确解析 checked 和 unchecked
- 测试 `parseAcceptanceCriteria()` 只在验收标准区域匹配
- 测试 `loadCLAUDE()` 正确注入 SystemPromptLayer
- 测试 `loadSpecFiles()` 正确扫描目录（用临时文件）

---

## Step 4: CLI 命令

**目标**: 实现 `licode spec init|validate|status|list` 四个子命令。

### 4.1 — `packages/spec-kit/src/init.ts`
- `specInit(name: string): Promise<void>`:
  1. `slugify(name)` — 空格→短横，移除非字母数字
  2. 目标目录：`docs/specs/${date}-${slug}/`
  3. `mkdir(dir, { recursive: true })`
  4. 从 LICode 内置模板目录读取模板文件
  5. 渲染 + 写入三件套
  6. 输出：`Spec initialized: docs/specs/2026-06-03-todo-app/`

### 4.2 — `packages/spec-kit/src/validate.ts`
- `specValidate(name?: string): Promise<ValidationResult>`:
  1. 不指定 name → 取最新 Spec
  2. 读入三件套
  3. `parseCheckboxes(tasksMd)` → tasks 统计
  4. `parseCheckboxes(checklistMd)` → checklist 统计
  5. `parseAcceptanceCriteria(specMd)` → acceptance 统计
  6. 返回 `ValidationResult`
- `ValidationResult` 接口:
  ```typescript
  {
    tasksCompleted: number, tasksTotal: number, tasksPercentage: number,
    checklistPassed: number, checklistTotal: number,
    acceptanceMet: number, acceptanceTotal: number,
  }
  ```

### 4.3 — `packages/spec-kit/src/status.ts`
- `specStatus(): Promise<void>`:
  1. 调用 `listAllSpecs()` 获取所有 Spec
  2. 每个 Spec → 调用 `specValidate(name)` 获取统计
  3. 格式化输出仪表盘：
     ```
     todo-app (2026-06-03)
       Tasks:     7/12 (58%)
       Checklist: 5/8 (62%)
       Acceptance: 3/5 (60%)

     login-system (2026-06-01)
       Tasks:     12/12 (100%) ✓
       Checklist: 8/8 (100%) ✓
       Acceptance: 5/5 (100%) ✓
     ```

### 4.4 — `packages/spec-kit/src/list.ts`
- `specList(): Promise<void>`:
  1. 扫描 `docs/specs/` 目录
  2. 读每个 Spec 的 `spec.md` → 解析标题和状态
  3. 格式化输出：
     ```
     todo-app        (2026-06-03)  draft       3 files
     login-system    (2026-06-01)  implemented  3 files
     ```

### 4.5 命令注册
- 通过 LICode CLI 主入口注册子命令：
  ```typescript
  // packages/cli/src/app.tsx 或主 CLI 入口
  import { specInit, specValidate, specStatus, specList } from '@licode/spec-kit';

  // 注册到命令系统
  commands.register({
    name: 'spec',
    description: 'Manage spec-driven development workflow',
    subcommands: {
      init: { handler: specInit },
      validate: { handler: specValidate },
      status: { handler: specStatus },
      list: { handler: specList },
    },
  });
  ```

### 4.6 单元测试
- 测试 `specInit()` 生成的三件套文件存在
- 测试 `slugify()` 正确处理中文、空格
- 测试 `specValidate()` 统计正确
- 测试 `specStatus()` 和 `specList()` 格式化输出正确（文字对比）

---

## Step 5: CLI 集成

**目标**: 将 Spec 加载注入 LICode 启动流程。

### 5.1 — `packages/cli/src/app.tsx` 启动流程更新
- 在 `initializeLICode()` 中添加：
  ```
  Phase 6:
    1. loadCLAUDE(systemPrompt)          // 注入 CLAUDE.md
    2. loadSpecFiles(systemPrompt)       // 注入活跃 Spec 三件套
  ```
- 执行顺序：在 Phase 4 的 `loadMemories()` 之后，Phase 2 的 `ToolRegistry.register()` 之前
- 完整启动顺序：
  ```
  1. Phase 1: LLM + SystemPrompt + ConversationManager
  2. Phase 4: loadMemories() + tryRecover()
  3. Phase 6: loadCLAUDE() + loadSpecFiles()   ← Phase 6 注入在此
  4. Phase 2: ToolRegistry + 内置工具
  5. Phase 5: SubAgentManager + Agent Tool（条件）
  6. Phase 3: MCP + Skill + Hook + Command
  7. Phase 4: PermissionGuard + ContextCompressor + Sandbox
  8. assemblePipeline()
  ```

### 5.2 模板文件路径解析
- `spec-kit` 中的模板读取需要知道 LICode 的安装路径
- 使用 `path.resolve(__dirname, "../../../templates")` 或一个环境变量 `LICODE_HOME`
- 或者——将模板内容内联为 TypeScript 字符串常量（对于简单模板，避免运行时文件查找）

**建议**：模板内联为 TypeScript 常量。对于三件套这种简单模板（每个 < 20 行），内联比文件找查找更可靠。

```typescript
// packages/spec-kit/src/templates.ts
export const SPEC_TEMPLATE = `# {{name}}
...`;

export const TASKS_TEMPLATE = `# Tasks — {{name}}
...`;

export const CHECKLIST_TEMPLATE = `# Checklist — {{name}}
...`;

export const CLAUDE_TEMPLATE = `# CLAUDE.md
...`;
```

### 5.3 验证（手动测试）
1. 在一个测试项目目录下运行 LICode
2. 检查 System Prompt 是否包含 CLAUDE.md 内容（如果存在）
3. 运行 `licode spec init test-feature`
4. 验证 `docs/specs/` 下生成三件套
5. 重启 LICode，验证 System Prompt 是否包含三件套内容（活跃 Spec）
6. 运行 `licode spec status` → 验证仪表盘
7. 修改 tasks.md 勾选几个 checkbox，再运行 `licode spec validate` → 验证统计更新

---

## Step 6: 集成收尾

### 6.1 `@licode/spec-kit` 公开导出 — `packages/spec-kit/src/index.ts`
```typescript
// Spec 命令
export { specInit } from './init';
export { specValidate } from './validate';
export { specStatus } from './status';
export { specList } from './list';

// 加载器
export { loadSpecFiles, loadCLAUDE } from './loaders';

// 解析器
export { parseCheckboxes, parseAcceptanceCriteria } from './parser';

// 类型
export type { ValidationResult, CheckboxItem } from './types';
```

### 6.2 根 package.json 更新
- 添加 scripts：
  ```json
  {
    "scripts": {
      "spec": "node packages/cli/bin/licode.js spec"
    }
  }
  ```

### 6.3 端到端验证
1. `pnpm build` 所有包无错误
2. Phase 1-5 所有单元测试通过（回归检查——Phase 6 零侵入）
3. 创建一个测试项目：
   - 写入 `CLAUDE.md`
   - 创建 `docs/specs/2026-06-03-demo/spec.md` + `tasks.md` + `checklist.md`
   - 启动 LICode
   - 验证 System Prompt 包含 CLAUDE.md 和三件套内容
4. 运行 `licode spec init test` → 生成三件套
5. 运行 `licode spec status` → 显示进度
6. 运行 `licode spec list` → 列表正确
7. 手动勾选 checkbox → 运行 `licode spec validate` → 统计正确

---

## 验证清单

- [ ] Phase 1-5 所有单元测试通过（回归检查）
- [ ] 四个模板文件存在且可渲染
- [ ] `spec-kit` 包编译通过（零 runtime 依赖）
- [ ] `parseCheckboxes()` 正确解析 `- [ ]` 和 `- [x]`
- [ ] `loadCLAUDE()` — 有文件时注入，无文件时跳过
- [ ] `loadSpecFiles()` — 有目录时注入最多 3 个活跃 Spec，无目录时跳过
- [ ] `specInit("test feature")` — 生成 `docs/specs/YYYY-MM-DD-test-feature/` 下三件套
- [ ] `specValidate()` — 统计正确
- [ ] `specStatus()` — 所有 Spec 的仪表盘输出正确
- [ ] `specList()` — 列表正确
- [ ] 启动时 CLAUDE.md 正确注入 System Prompt（priority 10, always true）
- [ ] 启动时活跃 Spec 正确注入 System Prompt（priority 12, always false）
- [ ] 无 Spec 文件时启动不受影响（跳过，不报错）

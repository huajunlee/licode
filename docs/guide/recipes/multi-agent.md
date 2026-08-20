# Recipe 5：并行拆解大任务

> **目标**：把一个大型重构任务拆成多个子 Agent 并行处理。
>
> **使用功能**：多智能体、SubAgent、Git Worktree 隔离、`/subagent` 命令

---

## 场景描述

你有一个 monorepo，包含 5 个包。需要把所有包里的 `require()` 改为 ES Module 的 `import`。5 个包互不依赖，可以并行处理。

## 步骤

### 1. 确认子 Agent 功能已开启

```
> /subagent status
  子 Agent 功能：开启
```

如果关闭了，用 `/subagent on` 开启。

### 2. 描述总任务

```
> 帮我把 monorepo 里所有包从 CommonJS 迁移到 ES Module。
  项目有 5 个独立的包：
  - packages/core
  - packages/cli
  - packages/utils
  - packages/database
  - packages/api

  每个包需要：
  1. 将 require() 改为 import
  2. 将 module.exports 改为 export
  3. 更新 package.json 添加 "type": "module"
  4. 更新对应的测试

  用子 Agent 并行处理这 5 个包
```

### 3. LICode 分发子 Agent

LICode 会为每个包创建一个子 Agent，在独立的 Git Worktree 中工作：

```
┌──────────────────────────────────────────┐
│ ⚙ Agent  core     迁移 packages/core     │
│   创建 worktree licode/core-migration     │
└──────────────────────────────────────────┘
┌──────────────────────────────────────────┐
│ ⚙ Agent  cli      迁移 packages/cli      │
│   创建 worktree licode/cli-migration      │
└──────────────────────────────────────────┘
┌──────────────────────────────────────────┐
│ ⚙ Agent  utils    迁移 packages/utils    │
│   创建 worktree licode/utils-migration    │
└──────────────────────────────────────────┘
...（共 5 个子 Agent 并行运行）
```

### 4. 子 Agent 各自完成任务

每个子 Agent 独立执行 AgentLoop，在自己的 Worktree 中修改文件：

```
Agent core:
  ✓ 修改 packages/core/package.json
  ✓ 转换 45 个 .js 文件
  ✓ 更新测试，23 个测试通过

Agent cli:
  ✓ 修改 packages/cli/package.json
  ✓ 转换 18 个 .js 文件
  ...
```

### 5. 汇总结果

所有子 Agent 完成后，父 Agent 汇总：

```
5 个包迁移完成：
  core:   45 个文件转换，23/23 测试通过
  cli:    18 个文件转换，12/12 测试通过
  utils:  32 个文件转换，8/8 测试通过
  database: 15 个文件转换，20/20 测试通过
  api:    28 个文件转换，15/15 测试通过

总计：138 个文件转换，全部测试通过 ✅
```

---

## 产物说明

| 产物 | 类型 | 存放位置 | 说明 |
|------|------|---------|------|
| Git Worktree 目录 | 自动创建 | `.licode/worktrees/licode/{agent-name}/` | 每个子 Agent 的独立工作区 |
| Worktree Git 分支 | 自动创建 | `licode/{agent-name}`（本地分支） | 自动创建的分支，任务完成后可合并或删除 |
| 修改后的源文件 | 文件修改 | 各 package 目录 | 5 个包共 138 个文件被转换 |
| 会话存档 | JSON 文件 | `.licode/sessions/{id}.json` | 父 Agent + 所有子 Agent 的对话和工具调用记录 |

> ⚠️ **注意**：Worktree 目录在任务完成后**不会自动删除**。确认结果无误后，需要手动清理 worktree 和分支，或让 LICode 帮你清理：
> ```
> > 帮我清理掉这次迁移创建的 worktree 和分支
> ```

---

## Worktree 目录结构

```
.licode/worktrees/licode/
├── core-migration/            ← 子 Agent 1 的工作区
│   └── packages/core/         ← 只包含该 Agent 需要修改的目录
│       ├── package.json       ← "type": "module"
│       └── src/               ← 45 个 .js → import/export
├── cli-migration/             ← 子 Agent 2 的工作区
│   └── packages/cli/
│       └── ...
├── utils-migration/           ← 子 Agent 3
├── database-migration/        ← 子 Agent 4
└── api-migration/             ← 子 Agent 5
```

---

## 执行前后对比

**执行前**：
```
packages/core/package.json  →  "type": "commonjs"
packages/core/src/*.js      →  require() / module.exports
（共 5 个包，138 个文件使用 CommonJS）
```

**执行后**：
```
packages/core/package.json  →  "type": "module"
packages/core/src/*.js      →  import / export
（共 5 个包，138 个文件转换为 ES Module，78 个测试全部通过）
```

---

## 关键要点

- 子 Agent 在独立的 Git Worktree 中工作，互不干扰
- 用 `/subagent status` 查看当前状态，`/subagent on/off` 控制开关
- 适合"多个独立模块"的并行任务，不适合有强依赖关系的任务
- 每个子 Agent 有自己的 AgentLoop，有独立的步数/Token/超时限制

---

## 常见问题排查

**Q: 子 Agent 创建失败？**
- 确保项目是 Git 仓库（Worktree 依赖 Git）：`git status`
- 确保 `/subagent` 已开启：`/subagent status`
- 检查是否有未提交的改动（建议先 `git commit` 再开子 Agent）

**Q: 多个子 Agent 的结果如何合并？**
- 父 Agent 会自动收集所有子 Agent 的结果并汇总
- 如果某个子 Agent 失败，父 Agent 会报告哪个包出了问题

**Q: Worktree 目录占用过多磁盘空间？**
- 任务完成后清理：`git worktree prune` + 删除 `.licode/worktrees/` 目录
- 每个 worktree 是 Git 的硬链接，不会完整复制仓库

# Recipe 7：用 Hooks 自动记录日志

> **目标**：在 Agent 生命周期的关键节点自动运行 Shell 脚本，实现日志记录、通知等。
>
> **使用功能**：Hooks 生命周期、HookManager、Shell 脚本

---

## 场景描述

你希望每次 LICode 完成一次对话后，自动记录到日志文件；在每次 Agent 启动前，检查是否有未提交的 git 改动。

## 步骤

### 1. 创建 Hooks 配置文件

在项目根目录创建 `.licode/hooks.json`：

```json
{
  "hooks": [
    {
      "name": "log-conversation-complete",
      "events": ["agent-loop-complete"],
      "command": "echo \"[$(date -Iseconds)] 对话完成\" >> .licode/logs/conversations.log",
      "position": "after:agentLoop",
      "blocking": false
    },
    {
      "name": "check-git-status",
      "events": ["agent-loop-start"],
      "command": "git status --porcelain | head -5",
      "position": "before:agentLoop",
      "blocking": true,
      "timeout": 10000
    },
    {
      "name": "notify-on-error",
      "events": ["agent-loop-terminated", "error"],
      "command": "osascript -e 'display notification \"LICode 出错\" with title \"LICode\"'",
      "position": "after:agentLoop",
      "blocking": false
    }
  ]
}
```

### 2. 重新启动 LICode 加载 Hooks

```
> LICode v0.1.0
  ...
  已加载 3 个 Hooks：
  - log-conversation-complete (after:agentLoop)
  - check-git-status (before:agentLoop)
  - notify-on-error (after:agentLoop)
```

### 3. Hooks 自动执行

**每次对话开始前**（before:agentLoop），`check-git-status` 自动运行：

```
┌──────────────────────────────────────────┐
│ 🔧 Hook: check-git-status               │
│ M src/app.ts                              │
│ ?? new-file.md                            │
└──────────────────────────────────────────┘
```

你可以看到当前有哪些未提交的改动。

**每次对话完成后**（after:agentLoop），`log-conversation-complete` 写入日志：

```
# .licode/logs/conversations.log
[2026-07-24T10:32:15+08:00] 对话完成
[2026-07-24T10:45:02+08:00] 对话完成
```

**出错时**，`notify-on-error` 弹出 macOS 系统通知。

### 4. 高级用法：串联多个 Hook

```json
{
  "name": "auto-commit-after-feature",
  "events": ["agent-loop-complete"],
  "command": "bash -c 'if git diff --name-only | grep -q \"src/\"; then git add -A && git commit -m \"feat: auto-commit by LICode\"; fi'",
  "position": "after:agentLoop",
  "blocking": true
}
```

> ⚠️ 自动提交要谨慎使用，建议保持 `blocking: true` 以便查看结果。

---

## 产物说明

| 产物 | 类型 | 存放位置 | 说明 |
|------|------|---------|------|
| Hooks 配置 | 手动创建 | `.licode/hooks.json` | 定义 3 个生命周期钩子 |
| Git 状态输出 | 终端输出 | 终端显示 | `check-git-status` 的实时输出 |
| 对话日志 | 自动生成 | `.licode/logs/conversations.log` | `log-conversation-complete` 写入的文件 |
| 系统通知 | macOS 通知 | 通知中心 | `notify-on-error` 弹出的 macOS 通知 |
| 会话存档 | JSON 文件 | `.licode/sessions/{id}.json` | 包含 Hook 执行的记录 |

> 💡 Hook 命令的输出**默认显示在终端**中。如果用 `>>` 重定向到文件，产物会写入你指定的路径。日志目录 `.licode/logs/` 是手动创建的，LICode 不会自动创建它。

---

## 配置后的文件结构

```
你的项目/
├── .licode/
│   ├── hooks.json              ← 你的 Hook 配置
│   └── logs/
│       └── conversations.log   ← Hook 输出的日志文件
├── .licode/hooks.json          ← 项目根目录也可以放置
└── ...
```

---

## 执行前后对比

**配置前**：
- 每次对话没有日志记录
- 不知道对话前有没有未提交的改动
- 出错时没有通知

**配置后**：
- 每次对话开始前自动执行 `git status --porcelain`，显示未提交改动
- 每次对话完成后自动追加日志到 `.licode/logs/conversations.log`
- Agent 出错时弹出 macOS 系统通知

**日志文件示例**（`.licode/logs/conversations.log`）：
```
[2026-07-24T10:32:15+08:00] 对话完成
[2026-07-24T10:45:02+08:00] 对话完成
[2026-07-24T11:03:28+08:00] 对话完成
```

---

## 关键要点

- Hook 的 `events` 支持 shell 风格通配符匹配
- `blocking: true` 的 Hook 会阻塞 Agent，等它执行完才继续
- `blocking: false` 的 Hook 是 fire-and-forget，不影响 Agent 流程
- `timeout` 默认 30 秒，适合大多数场景；耗时长的操作适当增加
- 支持的 position：`before:agentLoop`、`after:agentLoop`

---

## 常见问题排查

**Q: Hook 配置后没有生效？**
- 确认 `.licode/hooks.json` 是合法 JSON：`cat .licode/hooks.json | python -m json.tool`
- 确认 `events` 字段与生命周期的实际事件名匹配（注意大小写）
- 重启 LICode 重新加载配置

**Q: Hook 命令执行失败？**
- 手动在终端运行 Hook 的 `command`，确认命令本身没问题
- 检查 `timeout` 是否太短（默认 30 秒），耗时命令适当增加
- 如果 Hook 用到了环境变量（如 `$PATH`），确认 LICode 继承了你的 shell 环境

**Q: `blocking: true` 的 Hook 卡住了？**
- 检查命令是否在等待输入（如 `git commit` 没有 `-m` 会打开编辑器）
- 给 Hook 设置 `timeout` 避免永久阻塞
- 如果确实卡住，按 `Ctrl+C` 中断 Hook 执行

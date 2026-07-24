# Recipe 9：自定义 SystemPrompt

> **目标**：通过 CLAUDE.md、Skills 和模板文件定制 LICode 的行为和角色。
>
> **使用功能**：SystemPrompt 分层架构、CLAUDE.md、Skills 系统

---

## 场景描述

你有一个 Go 语言项目，想让 LICode 遵循团队特定的编码规范和项目约定。

## 步骤

### 1. 编写项目级 CLAUDE.md

在项目根目录创建 `CLAUDE.md`：

```markdown
# 项目编码规范

## 语言和框架
- 后端用 Go 1.22，使用标准库 net/http + gorilla/mux
- 数据库操作用 sqlx
- 测试用 testing 包 + testify

## 代码风格
- 函数命名用 PascalCase
- 错误处理：每个函数返回 (result, error)，调用方必须检查 error
- 不使用 panic，用 error 传递错误
- 日志用 log/slog 结构化日志

## 项目结构
- cmd/      入口文件
- internal/ 内部包（不对外暴露）
- pkg/      可复用库
- api/      OpenAPI 规范

## 约定
- PR 标题格式：type(scope): description（如 feat(auth): add login）
- 所有公开函数必须有 GoDoc 注释
- 数据库迁移用 golang-migrate
```

### 2. LICode 自动加载 CLAUDE.md

下次启动 LICode 时，它会自动读取并注入为 system prompt 层：

```
> 帮我创建一个新的 API 路由
```

LICode 会自动：
- 使用 Go 1.22 + gorilla/mux 的语法
- 函数返回 `(result, error)` 并检查错误
- 使用 `slog` 结构化日志
- 文件放在 `internal/` 目录下
- 加上 GoDoc 注释

### 3. 创建项目级 Skill

在 `.licode/skills/go-review/` 下创建 `skill.md`：

```markdown
---
name: go-review
version: 1.0.0
tools:
  - name: lint
    description: 运行 golangci-lint 检查代码
    parameters:
      - name: path
        type: string
        default: "./..."
  - name: test-race
    description: 运行带竞态检测的测试
    parameters:
      - name: package
        type: string
        default: "./..."
---

# Go 代码审查技能

你是 Go 代码审查专家。审查时关注：
1. 错误处理是否完整（不能忽略 error）
2. 是否有 goroutine 泄漏风险
3. 是否有竞态条件
4. 是否遵循 Go 惯用法（effective Go）
```

### 4. 使用 Skill

Skill 的描述会自动注入 system prompt，工具自动注册：

```
> 用 go-review 技能审查 internal/auth/
```

LICode 会：
1. 以 "Go 代码审查专家" 的角色审查代码
2. 自动调用 `skill__lint` 运行 golangci-lint
3. 自动调用 `skill__test-race` 运行竞态检测
4. 按 skill 中定义的 4 个维度输出审查结果

### 5. 各层 SystemPrompt 的协作

启动 LICode 时，system prompt 按优先级组装：

```
System Prompt 最终内容：
┌──────────────────────────────────────────────┐
│ ① role.md（always）                          │
│   "你是 LICode，一个运行在终端的 AI 编程助手."  │
├──────────────────────────────────────────────┤
│ ② safety.md（always）                        │
│   "禁止执行危险命令，保护敏感信息..."           │
├──────────────────────────────────────────────┤
│ ③ CLAUDE.md（动态加载）                       │
│   "后端用 Go 1.22，函数用 PascalCase..."      │
├──────────────────────────────────────────────┤
│ ④ 用户记忆（priority 8）                     │
│   "用户偏好：缩进用 tab，部署到 AWS..."        │
├──────────────────────────────────────────────┤
│ ⑤ tool-use.md（priority 10）                 │
│   "你可以使用以下工具..."                     │
├──────────────────────────────────────────────┤
│ ⑥ Skills 描述（priority 15）                 │
│   "你是 Go 代码审查专家..."                   │
├──────────────────────────────────────────────┤
│ ⑦ Spec 文件（动态加载）                       │
│   "当前 spec: 用户通知功能，任务清单..."        │
└──────────────────────────────────────────────┘
```

> Token 预算不足时，priority 高的层优先保留，低的层可能被截断。

---

## 产物说明

| 产物 | 类型 | 存放位置 | 说明 |
|------|------|---------|------|
| 项目指令 | 手动创建 | `./CLAUDE.md` | 项目级编码规范、技术栈约定 |
| 技能包 | 手动创建 | `.licode/skills/go-review/skill.md` | Go 代码审查技能 + 2 个专属工具 |
| 工具注册 | 内存 | ToolRegistry（不持久化） | 启动时注册 `skill__lint` 和 `skill__test-race` |
| 组装后的 SystemPrompt | 内存 | 不保存文件 | 7 层按优先级组装，每次 LLM 调用时动态生成 |

> 💡 CLAUDE.md 和 Skills 都是**手动创建的文件**。LICode 不会自动创建它们，但启动时会自动读取并注入 system prompt。

---

## 文件结构与 System Prompt 映射

```
你的项目/
├── CLAUDE.md                          ──→ System Prompt 第③层（动态加载）
└── .licode/
    └── skills/
        └── go-review/
            └── skill.md               ──→ System Prompt 第⑥层（priority 15）
                ---                     ──→ 工具: skill__lint, skill__test-race
                name: go-review
                tools:
                  - name: lint
                  - name: test-race
                ---
```

---

## System Prompt 各层来源一览

```
System Prompt 最终内容（按优先级从高到低排列）：
┌──────────────────────────────────────────────────────────────┐
│ 层    │ 来源              │ 优先级    │ 会被裁剪？           │
├──────────────────────────────────────────────────────────────┤
│ ①    │ role.md（内置）    │ always    │ ❌ 永不裁剪          │
│ ②    │ safety.md（内置）  │ always    │ ❌ 永不裁剪          │
│ ③    │ CLAUDE.md         │ 动态加载   │ ⚠️ Token 不足时可能  │
│ ④    │ 用户记忆           │ priority 8│ ⚠️ 优先级低时裁剪     │
│ ⑤    │ tool-use.md       │ priority 10│ ⚠️                 │
│ ⑥    │ Skills 描述        │ priority 15│ ⚠️ 优先级高时优先裁剪 │
│ ⑦    │ Spec 文件          │ 动态加载   │ ⚠️                 │
└──────────────────────────────────────────────────────────────┘
```

**Token 预算分配策略**：always 层（①+②）始终完整保留 → 剩余 token 按优先级从低到高分配给③④⑤ → ⑥⑦在预算充足时追加，不足时截断或跳过。

---

## 关键要点

- `CLAUDE.md` 是项目级的指令文件，自动加载
- Skills 可以定义专属工具和角色描述，适合团队共享
- always 层（role + safety）不会被裁剪，确保核心安全规则始终在位
- 优先级数字越大 = 越容易被裁剪，把必须保留的内容放在低优先级

---

## 常见问题排查

**Q: CLAUDE.md 修改后没有生效？**
- 重启 LICode（CLAUDE.md 在启动时加载，运行中修改不会自动重载）
- 确认 CLAUDE.md 在项目根目录（与 `package.json` 同级）
- 用 `/context` 确认 LICode 读取到了文件

**Q: Skill 工具注册失败？**
- 检查 `skill.md` 的 YAML frontmatter 格式（`---` 分隔符必须正确）
- 确认工具的 `parameters` 字段格式与 Zod schema 兼容
- 查看 LICode 启动日志中的 Skill 加载信息

**Q: System Prompt 太长导致 token 不够用？**
- 精简 CLAUDE.md，只保留最关键的约定
- 将 Skill 描述控制在 500 字以内
- 过多的 Spec 文件会占用大量 token，只保留当前活跃的 spec

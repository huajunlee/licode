# Recipe 6：跨会话记忆偏好

> **目标**：让 LICode 记住你的编码偏好和项目习惯，跨会话生效。
>
> **使用功能**：Memory 系统、MemoryExtractor、会话恢复

---

## 场景描述

你在多个项目中使用 LICode，希望它记住你的技术栈偏好和代码风格，不用每个新会话都重复说明。

## 步骤

### 1. 在日常对话中自然表达偏好

```
> 记住：我习惯用 pnpm 而不是 npm，运行测试用 vitest 而不是 jest
```

LICode 的 MemoryExtractor 会自动匹配 "记住" 关键词：

```
🧠 已记录偏好：
  - 包管理器：pnpm（而非 npm）
  - 测试框架：vitest（而非 jest）
```

### 2. 记录更多偏好

```
> 我喜欢用 zod 做参数校验，项目里统一用 camelCase 命名
> 记住：我一般用 Node.js 22，部署到 Vercel
> 记住：我的项目缩进用 2 空格，不用 tab
```

每条都会被自动提取和存储。

### 3. 查看已存储的记忆

```
> /context
  Model: deepseek-v4-pro
  Tokens: 1,250
  Messages: 12
  Session: abc123-def456

  已存储的记忆：
  - 包管理器：pnpm
  - 测试框架：vitest
  - 参数校验：zod
  - 命名风格：camelCase
  - Node 版本：22
  - 部署平台：Vercel
  - 缩进：2 空格
```

### 4. 记忆跨会话生效

关闭 LICode，第二天新开会话：

```
> 帮我新建一个 API 路由文件
```

LICode 会自动：
- 用 `write` 创建文件（文件内容使用 2 空格缩进、camelCase 命名）
- 用 `bash` 执行 `pnpm vitest`（而不是 `npm jest`）
- 参数校验用 `zod`

不需要你再次说明这些偏好。

---

## 产物说明

| 产物 | 类型 | 存放位置 | 说明 |
|------|------|---------|------|
| 记忆文件 | 自动创建 | `.licode/memory/prefer-pnpm.md` | 包管理器偏好 |
| 记忆文件 | 自动创建 | `.licode/memory/prefer-vitest.md` | 测试框架偏好 |
| 记忆文件 | 自动创建 | `.licode/memory/prefer-zod.md` | 参数校验偏好 |
| 记忆文件 | 自动创建 | `.licode/memory/naming-camelCase.md` | 命名风格偏好 |
| 记忆文件 | 自动创建 | `.licode/memory/node-version-22.md` | Node 版本偏好 |
| 记忆文件 | 自动创建 | `.licode/memory/deploy-vercel.md` | 部署平台偏好 |
| 记忆文件 | 自动创建 | `.licode/memory/indent-2spaces.md` | 缩进偏好 |

> 💡 每条"记住"指令自动创建一个 `.md` 文件（含 YAML frontmatter + 偏好描述）。**文件内容是人类可读的**，你可以直接打开编辑或删除。

---

## 记忆文件格式详解

`.licode/memory/prefer-pnpm.md` 的实际内容：

```markdown
---
name: prefer-pnpm
description: 用户偏好使用 pnpm 作为包管理器
metadata:
  type: user
---

用户习惯用 pnpm 而不是 npm 来管理依赖。
**Why:** pnpm 更快且节省磁盘空间。
**How to apply:** 所有包管理命令使用 pnpm，而不是 npm 或 yarn。
关联：[[prefer-vitest]]
```

**字段说明**：

| 字段 | 作用 |
|------|------|
| `name` | 唯一标识符（kebab-case） |
| `description` | 一行摘要，用于判断何时加载这条记忆 |
| `metadata.type` | `user`（用户偏好）/ `project`（项目约束）/ `feedback`（用户反馈） |
| 正文 | 具体偏好说明 + **Why**（原因）+ **How to apply**（应用方式） |
| `[[link]]` | 关联其他记忆（如 prefer-pnpm 关联 prefer-vitest） |

---

## 记忆目录结构

```
.licode/memory/
├── MEMORY.md                    ← 记忆索引文件
├── prefer-pnpm.md               ← 包管理器偏好
├── prefer-vitest.md             ← 测试框架偏好
├── prefer-zod.md                ← 参数校验偏好
├── naming-camelCase.md          ← 命名风格偏好
├── node-version-22.md           ← Node 版本偏好
├── deploy-vercel.md             ← 部署平台偏好
└── indent-2spaces.md            ← 缩进偏好
```

---

## 关键要点

- 使用 "记住" / "remember" / "我习惯" / "我喜欢" 等关键词触发自动记忆
- 记忆存储在 `.licode/memory/` 下，每个偏好一个 `.md` 文件
- 下次会话启动时自动注入为 system prompt 层（priority 8）
- 如果某条记忆不再适用，可以手动删除对应的 `.md` 文件，或编辑修改内容

---

## 常见问题排查

**Q: 说了"记住"但没有保存？**
- 确保触发词在句首或独立成句："记住：xxx"（不是"你记住啊 xxx 很重要"）
- 用 `/context` 查看已存储的记忆列表确认是否成功

**Q: 记忆没有在新会话中生效？**
- 确认 `.licode/memory/` 目录下有对应的 `.md` 文件
- 记忆注入 priority 为 8，如果 system prompt 的 token 预算不足，低优先级内容可能被裁剪
- 重启 LICode 重新加载记忆

**Q: 如何修改/删除已存储的记忆？**
- 直接编辑或删除 `.licode/memory/` 下的 `.md` 文件
- 编辑后下次会话自动生效，无需重启

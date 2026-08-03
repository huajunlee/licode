# Recipe 6：跨会话记忆偏好

> **目标**：让 LICode 记住你的编码偏好和项目习惯，跨会话生效、按需召回、自动整理。
>
> **使用功能**：Memory 系统（生产 + 召回 + 做梦整理）、`/memory-*` 命令

---

## 场景描述

你在多个项目中使用 LICode，希望它记住你的技术栈偏好和代码风格，不用每个新会话都重复说明；并且希望无关问题不被记忆打扰，长期不用的记忆自动归档不堆积。

> 💡 本 Recipe 对应的原理见 [架构原理 §17](../user-guide.md#17-memory记忆系统)、[亮点 1](../user-guide.md#亮点-1跨会话持久记忆系统) 与 [面试 Q1-Q7](../user-guide.md#亮点-1-名词解释与深挖问答)。

---

## 步骤

### 1. 两种方式让 LICode 记住偏好

**方式 A：明确指令（主 Agent 当场直写）**

```
> 记住：我习惯用 pnpm 而不是 npm，运行测试用 vitest 而不是 jest
```

主 Agent 按 memory-guide 指引，当场用 Write 工具写入记忆文件，无需等后台提取。

**方式 B：日常对话（后台自动提取，不再依赖关键词）**

```
> 不对，以后都用 pnpm
> 我一般用 Node.js 22，部署到 Vercel
```

这些不含"记住"关键词的话，也会在每轮对话结束后由 `after:agentLoop` hook 的后台 LLM 自动提取（5 分钟冷却、问句不提取、互斥锁防并发）。旧版靠关键词匹配会漏掉这类纠正，Phase 1 起改为冷却 + 问句排除，不再依赖关键词。

### 2. 改口不用怕：矛盾自动消解

```
> （之前）记住：我喜欢红烧排骨
> （后来）红烧排骨不喜欢了
```

提取时 LICode 把**已有的记忆全文**都给 LLM 看。LLM 发现"不喜欢了"和旧的"喜欢"冲突，输出 `update` 整体改写旧文件（保留 createdAt、刷新 updatedAt），以最新为准--不会出现"喜欢/不喜欢"两条矛盾并存。

### 3. 相关记忆按需召回（无关问题不打扰）

每轮对话开始时（首次调用大模型之前），LICode 用 side-query 小模型从索引中选 ≤5 条**相关**记忆，把**正文**注入当轮上下文：

```
你说"今晚吃什么好？"
   -> side query 选中 user/食物偏好
   -> 对话流显示 [调用工具: memory_recall] 卡片（召回透明可见）
   -> LICode 回答时避开你不喜欢的、推荐你偏好的
```

**无关问题零召回零成本**：问"帮我重构这个函数"时，一条记忆都不会选（严格过滤 prompt：默认不召回，需满足明确的相关性条件）。

### 4. 查看与管理记忆

```
> /memory-list          ← 列出所有记忆（按类型分组）
> /memory-delete <slug> ← 删除某条
> /memory-pin <slug>    ← 置顶：永不被 dream 自动归档
> /memory-archive <slug>← 手动归档（软删除）
> /memory-restore <slug>← 恢复已归档的记忆
```

### 5. 做梦整理：旧记忆自动归档不堆积

记忆库会定期"做梦"整理（`MemoryDream`，零 LLM 门：距上次 ≥24h 且 ≥5 个新会话才触发，fire-and-forget 不阻塞你）：

- **Orient**：审现有记忆，找漂移/重复/失效/相对日期
- **Gather**：grep 近期会话找证据
- **Consolidate**：基于证据合并/改写/删除 + 自动归档 >30 天未被召回的记忆
- **Prune**：重建索引

被归档的记忆移到 `archive/` 区，可用 `/memory-restore` 恢复；`/memory-pin` 标记的永不归档。

---

## 产物说明

### 记忆目录结构（四类分目录）

```
.licode/memory/
├── MEMORY.md                    ← 索引（每条一行 "- [名称](path) - 描述"，自动重建，勿手改）
├── .dream.state                 ← 做梦整理状态（lastConsolidatedAt）
├── user/                        ← 用户偏好/角色/目标
│   └── 食物偏好.md
├── feedback/                    ← 协作纠正（必含 Why / How to apply）
│   └── 用pnpm.md
├── project/                     ← 项目背景/决策
├── reference/                   ← 外部系统入口
└── archive/                     ← dream 自动归档区（可恢复）
```

### 单条记忆文件格式

`.licode/memory/feedback/用pnpm.md` 的实际内容（YAML frontmatter + 正文）：

```markdown
---
name: 用pnpm
description: 用户偏好使用 pnpm 作为包管理器
type: feedback
createdAt: 2026-08-01
updatedAt: 2026-08-01
usageCount: 3
lastUsedAt: 2026-08-02T10:00:00.000Z
pinned: false
---

所有包管理命令使用 pnpm，而不是 npm 或 yarn。
**Why:** 用户明确要求过；pnpm 更快且节省磁盘空间。
**How to apply:** 安装、添加、移除依赖时一律使用 pnpm。
关联：[[用vitest]]
```

**字段说明**：

| 字段 | 作用 |
|------|------|
| `name` | 简短名称（可用中文，如"用pnpm"） |
| `description` | 一行摘要，用于 MEMORY.md 索引行与召回判断 |
| `type` | `user`/`feedback`/`project`/`reference` 四分类 |
| `createdAt`/`updatedAt` | 时间戳（相对日期已归一化为绝对日期） |
| `usageCount`/`lastUsedAt` | 被召回注入的累计次数与最近时间（dream 归档判定依据） |
| `pinned` | `true` 时永不被 dream 自动归档 |
| 正文 | 具体说明 + **Why**（原因）+ **How to apply**（应用方式）+ `[[link]]` 关联 |

> 💡 **文件名与 slug 解耦**：文件名用 `cleanName`（保留中文，人可读），程序内部用 slug（`toSlug`，中文 hash 兜底）。所以文件名是"用pnpm.md"而 slug 可能是"feedback/jx3k"。重命名文件不破坏程序引用。

---

## 关键要点

- **两种写入路径**：明确指令主 Agent 直写 / 日常对话后台自动提取（不再依赖关键词）
- **矛盾自动消解**：提取携带现有记忆正文，冲突时 update 整体改写
- **召回严格过滤**：默认不召回，仅相关记忆注入正文，无关问题零成本
- **每轮剪除防累积**：历史里任意时刻最多一对召回消息，token 不膨胀
- **失败零干扰**：side query 失败/超时退回仅索引模式，对话不受影响
- **做梦整理**：>30 天未用自动归档（可恢复），pinned 永不归档
- **四类分目录**：user/feedback/project/reference，一个主题一个 .md 文件

---

## 常见问题排查

**Q: 说了偏好但没记住？**
- 明确指令确保"记住：xxx"独立成句
- 日常对话提取有 5 分钟冷却，且全是问句不提取；稍等或用"记住："直写
- 用 `/memory-list` 确认是否成功

**Q: 记忆没在新会话中生效？**
- 确认 `.licode/memory/{type}/` 下有对应 .md 文件且 MEMORY.md 索引已重建
- 召回是"按需"的：只有相关问题才会注入，无关问题不注入是正常行为
- `LICODE_MEMORY_RECALL=off` 会关闭召回（退回仅索引模式），检查是否误设

**Q: 如何修改/删除已存储的记忆？**
- 直接编辑或删除 `.licode/memory/{type}/` 下的 .md 文件，索引会自动重建
- 或用 `/memory-delete`、`/memory-archive` 命令

**Q: 想让某条记忆永久保留不被归档？**
- 用 `/memory-pin <slug>` 置顶，pinned 记忆硬条件排除，永不被 dream 自动归档

# 记忆模块渐进式改进方案

> **状态**：Step 1 已完成，Step 2-3 规划中
>
> **设计文档**：[Phase 4 工程设计](../superpowers/specs/2026-06-02-phase4-engineering-design.md) Section 6

---

## 背景

LICode 的记忆模块当前是最小可用版本（MVP），与设计文档存在以下差距：

| 问题 | 现状 | 目标 |
|------|------|------|
| 提取方式 | 正则匹配固定句式 | LLM 分析完整对话 |
| 存储结构 | 扁平 `.md` 文件 | 分类子目录 + 索引 |
| 同类合并 | 每次新建文件 | 追加到同一文件 |
| 注入方式 | 全量正文注入 System Prompt | 只注入 MEMORY.md 索引 |
| 记忆范围 | 仅项目级 | 项目级 + 全局级 |
| 管理能力 | 仅 list / add | list / add / delete / search |

本方案采用**渐进式策略**，分 3 步推进，每步独立可验证、可回退。

---

## 总体路线

```
Step 1: 存储层重构（项目级）          ✅ 已完成
  ├── 分类目录 + MEMORY.md 索引
  ├── Memory 类型升级
  ├── MemoryStore API 扩展（load/delete/listAll/loadIndex）
  ├── /memory delete 子命令
  └── 正则提取不改，输出适配新结构

Step 2: LLM 提取 + 管道调整            📋 规划中
  ├── 正则 → LLM 意图识别
  ├── 记忆智能合并/更新
  ├── memoryMiddleware 移到 hook:after:agentLoop
  └── fire-and-forget 后台提取

Step 3: 全局记忆 + 高级功能            💡 规划中
  ├── ~/.licode/memory/ 全局记忆
  ├── 两级记忆合并加载
  ├── /memory search 文本搜索
  └── feedback / project / reference 类型支持
```

---

## Step 1：存储层重构（已完成）

### 目标

重构 `MemoryStore` 和 `MemoryLoader`，建立分类目录 + MEMORY.md 索引的骨架。

### 新目录结构

```
.licode/memory/
├── MEMORY.md                  # 索引入口（注入 System Prompt）
├── user/                      # 用户身份、偏好、知识
│   ├── identity.md            # 身份信息
│   └── food-preferences.md    # 食物偏好
├── feedback/                  # 用户纠正（预留）
├── project/                   # 项目决策（预留）
└── reference/                 # 外部引用（预留）
```

### MEMORY.md 索引

这是注入 System Prompt 的内容，每行一条记忆：

```markdown
# User Memory

The following memories are from previous conversations:

- [身份信息](user/identity.md) — The user's name is huajun, full-stack developer.
- [食物偏好](user/food-preferences.md) — Prefers 葱爆大虾、红烧肉、梅菜扣肉.
```

### 记忆文件格式

```markdown
---
name: food-preferences
description: Prefers 葱爆大虾、红烧肉、梅菜扣肉
type: user
createdAt: 2026-07-25T10:00:00Z
updatedAt: 2026-07-25T14:30:00Z
---

The user likes 吃葱爆大虾、香煎排骨、红烧肉和梅菜扣肉.
还喜欢吃梅菜扣肉.
```

### 内存模型

```typescript
type MemoryType = "user" | "feedback" | "project" | "reference";

interface Memory {
  slug: string;          // 文件路径，如 "user/food-preferences"
  type: MemoryType;      // 记忆类型
  name: string;          // 简短名称，如 "食物偏好"
  description: string;   // 一句话描述，用于 MEMORY.md 索引行
  content: string;       // 记忆正文
  createdAt: string;     // 创建时间 ISO
  updatedAt: string;     // 更新时间 ISO
}
```

### MemoryStore API

| 方法 | 签名 | 说明 |
|------|------|------|
| `save(memory)` | `(memory: Memory) => Promise<void>` | 写入文件 + 更新 MEMORY.md，同 slug 追加合并 |
| `load(slug)` | `(slug: string) => Promise<Memory \| null>` | 读取单个记忆 |
| `delete(slug)` | `(slug: string) => Promise<void>` | 删除文件 + 更新索引 |
| `listAll()` | `() => Promise<Memory[]>` | 列出全部记忆 |
| `loadIndex()` | `() => Promise<string>` | 读取 MEMORY.md 全文 |
| `list()` | deprecated | 内部调用 listAll()，兼容旧代码 |

### MemoryLoader

注入 `MEMORY.md` **索引**（而非全量正文），priority 从 8 提升到 5：

```typescript
systemPrompt.addLayer({
  name: "memory",
  priority: 5,
  always: false,
  content: indexContent,  // MEMORY.md 全文
});
```

### 斜杠命令

| 命令 | 说明 |
|------|------|
| `/memory-list` | 按类型分组显示所有记忆 |
| `/memory-add <内容>` | 手动添加记忆 |
| `/memory-delete <slug>` | 删除指定记忆 |

### 未改动部分

- 正则提取机制（`MemoryExtractor` 仍用正则，输出适配新 `Memory` 类型）
- 管道位置（`memoryMiddleware` 仍在 Agent Loop 之前）
- 全局记忆（仅项目级 `.licode/memory/`）

### 验收清单

- [x] 26 个 memory 新测试通过
- [x] 92 个已有测试通过，零回归
- [x] 零 TypeScript 编译错误（记忆模块）
- [x] 启动后 `.licode/memory/` 目录结构正确
- [x] 正则触发 "记住我..." → 新结构文件生成 + MEMORY.md 更新
- [x] 同 slug 追加不产生新文件
- [x] `/memory-list` 按类型分组显示
- [x] `/memory-delete <slug>` 正确删除并更新索引
- [x] System Prompt 注入 MEMORY.md 索引（非全量正文）

### 相关文件

| 文件 | 变更 |
|------|------|
| `packages/core/src/memory/types.ts` | `Memory` + `MemoryType` + `toSlug()` |
| `packages/core/src/memory/store.ts` | 完整重写 |
| `packages/core/src/memory/loader.ts` | 注入索引，priority 5 |
| `packages/core/src/memory/extractor.ts` | 输出 Memory 类型 |
| `packages/core/src/memory/middleware.ts` | 无改动（类型自动适配） |
| `packages/core/src/extensions/commands/builtin/memory.ts` | +delete 子命令 |
| `packages/core/src/extensions/commands/builtin/context.ts` | 适配新 API |
| `packages/core/src/index.ts` | 导出新类型 |

---

## Step 2：LLM 提取 + 管道调整（规划中）

### 目标

用 LLM 分析完整对话替代正则匹配，捕获自然语言中的记忆意图。

### 洋葱模型变化

**当前（Step 1）：**

```
用户消息
  → memoryMiddleware（正则，Agent Loop 之前）
  → agentLoopMiddleware（LLM 对话 + 工具）
  → 返回响应
```

**目标（Step 2）：**

```
用户消息
  → agentLoopMiddleware（LLM 对话 + 工具）
  → hook:after:agentLoop
      └── memoryExtractionHook（LLM 提取，fire-and-forget，不阻塞）
  → 返回响应
```

### 关键变更

1. **MemoryExtractor 重写**：
   - `shouldExtract(messages)` — 启发式判断（轻量，不调 LLM），检查消息中是否有记忆相关触发词
   - `extract(messages, store)` — 调用 LLM 分析完整对话 → 输出 JSON → 匹配已有文件 slug → 追加或新建
   - `shouldExtract` 返回 false 时零开销

2. **管道位置调整**：
   - 从 Agent Loop **之前**移到 **之后**的 `hook:after:agentLoop`
   - 提取在后台执行，fire-and-forget
   - 用户不会感知到提取延迟

3. **LLM 提取 Prompt 示例**：

```
Analyze this conversation and identify information to remember:

1. User role, preferences, knowledge (→ type: user)
2. Corrections or feedback (→ type: feedback)
3. Project decisions, goals, constraints (→ type: project)
4. References to external systems (→ type: reference)

For each finding, output JSON:
{ "type": "...", "name": "...", "description": "...", "content": "..." }
If nothing qualifies, output: { "none": true }

Existing memory files (match if applicable):
- [身份信息](user/identity.md) — The user's name is huajun
- [食物偏好](user/food-preferences.md) — Prefers 葱爆大虾...
```

4. **Hook 系统扩展**（待定）：
   - 当前 `HookManager` 只支持 shell 命令钩子
   - Step 2 需要 in-process 函数钩子
   - 两种方案：扩展 HookManager 支持函数钩子，或直接在 `hook:after:agentLoop` 位置添加独立中间件

### 验收标准

- 自然语言 "哦对了，我平时比较喜欢用 Rust 写后端" → 自动提取为记忆
- 同类记忆自动合并到同一文件
- 提取不阻塞用户看到回复
- 非记忆相关的对话不触发提取（`shouldExtract` 返回 false）
- 正则提取逻辑完全移除

---

## Step 3：全局记忆 + 高级功能（规划中）

### 目标

支持跨项目的全局记忆，以及搜索、类型管理等高级功能。

### 关键变更

1. **两级记忆存储**：
   ```
   ~/.licode/memory/     # 用户全局记忆（跨所有项目）
   .licode/memory/       # 项目级记忆（当前项目）
   ```

2. **启动时两级合并加载**：
   ```typescript
   const globalStore = new MemoryStore(`${os.homedir()}/.licode/memory`);
   const projectStore = new MemoryStore(`.licode/memory`);
   await loadMemories(globalStore, systemPrompt);
   await loadMemories(projectStore, systemPrompt);
   ```

3. **命令增强**：
   - `/memory search <query>` — 文本搜索（遍历 MEMORY.md + frontmatter）
   - `/memory types` — 按类型列出记忆
   - `/memory global list|add|delete` — 管理全局记忆

4. **提取类型扩展**：
   - MemoryExtractor 支持生成 `feedback`、`project`、`reference` 类型记忆
   - 用户纠正 Agent 行为时自动生成 `feedback` 记忆
   - 项目初始化/技术选型对话自动生成 `project` 记忆

### 验收标准

- 全局记忆跨项目生效
- `/memory search pnpm` 返回相关记忆
- 两级记忆不冲突（项目级覆盖全局级）
- feedback / project / reference 类型正确分类

---

## 设计决策记录

| 决策 | 选择 | 原因 |
|------|------|------|
| 注入方式 | MEMORY.md 索引 | 节省 token，类似 OpenAI 做法 |
| 文件粒度 | 按主题分文件 | 更精确的索引描述 |
| 合并策略 | 同 slug 追加 | Step 1 正则不智能，至少不碎片化 |
| 第一步提取 | 保留正则 | 存储层和提取层独立演进 |
| LLM 提取位置 | hook:after:agentLoop | 利用 Phase 3 Hook 机制，管道结构清晰 |
| 提取时机 | fire-and-forget | 不阻塞用户响应 |
| priority | 5 | 紧随 role(0) 和 safety(1)，高于工具指令(10) |

---

## 参考

- [Phase 4 工程设计文档](../superpowers/specs/2026-06-02-phase4-engineering-design.md)
- [Phase 4 实现计划](../superpowers/specs/2026-06-03-phase4-implementation-plan.md)
- [Recipe 6：跨会话记忆偏好](recipes/memory-preferences.md)

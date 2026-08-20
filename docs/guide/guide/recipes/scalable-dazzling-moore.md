# 渐进式记忆模块改进方案

## Context

LICode 的记忆模块当前是最小可用版本（MVP），与设计文档 `docs/superpowers/specs/2026-06-02-phase4-engineering-design.md` Section 6 存在显著差距：
- 正则匹配代替 LLM 提取，捕获率低
- 记忆文件扁平存储，无分类目录和索引
- 同类记忆无法合并（用户 2 条美食记忆分散在不同文件）
- System Prompt 注入全量正文，记忆数量增长后 token 会膨胀
- 无全局记忆、无删除/搜索能力

本方案采用渐进式策略，分 3 步推进，每步独立可验证、可回退。

## 总体路线

```
Step 1: 存储层重构（项目级）      ← 本次实施
  ├─ 分类目录 + MEMORY.md 索引
  ├─ Memory 类型升级
  ├─ MemoryStore API 扩展
  └─ 正则提取不改，输出适配新结构

Step 2: LLM 提取 + 管道调整      ← 后续
  ├─ 正则 → LLM 意图识别
  ├─ 记忆合并/更新
  └─ memoryMiddleware 位置调整到 hook:after:agentLoop

Step 3: 全局记忆 + 高级功能      ← 后续
  ├─ ~/.licode/memory/ 全局记忆
  ├─ 两级记忆合并加载
  └─ /memory delete / search
```

---

## Step 1：存储层重构（项目级记忆）

### 目标

重构 `MemoryStore` 和 `MemoryLoader`，建立分类目录 + MEMORY.md 索引的骨架。不改变提取机制（正则），不改变管道位置。

### 边界

| 做 | 不做 |
|----|------|
| 新目录结构 `{type}/{slug}.md` | 全局记忆 `~/.licode/memory/` |
| MEMORY.md 索引文件 | LLM 提取 |
| Memory 类型升级 | 管道结构调整 |
| MemoryLoader 注入索引 | 记忆合并/去重（追加即可） |
| save 时同 slug 追加合并 | 智能判断归属文件 |
| /memory delete 子命令 | /memory search |
| 删除旧格式记忆文件 | 迁移脚本 |
| 更新所有测试 | - |

### 新目录结构

```
.licode/memory/
├── MEMORY.md                  # 索引入口（注入 System Prompt）
├── user/
│   ├── identity.md            # 身份信息
│   └── food-preferences.md    # 食物偏好
├── feedback/                  # 用户纠正（空目录，预留）
├── project/                   # 项目决策（空目录，预留）
└── reference/                 # 外部引用（空目录，预留）
```

### 实现步骤

#### 1.1 重定义 Memory 类型 — `packages/core/src/memory/types.ts`

```typescript
export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface Memory {
  /** 文件路径 slug，如 "user/food-preferences"（不含 .md） */
  slug: string;
  /** 记忆类型 */
  type: MemoryType;
  /** 简短名称，如 "食物偏好" */
  name: string;
  /** 一句话描述，用于 MEMORY.md 索引行 */
  description: string;
  /** 记忆正文 */
  content: string;
  /** 创建时间 ISO */
  createdAt: string;
  /** 更新时间 ISO */
  updatedAt: string;
}
```

#### 1.2 重写 MemoryStore — `packages/core/src/memory/store.ts`

**构造函数**保持 `constructor(dir: string)`。

**save(memory: Memory)**：
1. 确保 `{dir}/{type}/` 子目录存在
2. 如果目标文件已存在 → 读取现有 content，追加新 content（加换行分隔）
3. 如果目标文件不存在 → 新建
4. 写入 YAML frontmatter + 正文：
   ```markdown
   ---
   name: food-preferences
   description: Prefers 葱爆大虾、红烧肉、梅菜扣肉
   type: user
   createdAt: 2026-07-25T10:00:00Z
   updatedAt: 2026-07-25T14:30:00Z
   ---
   
   The user likes 吃葱爆大虾...
   还喜欢吃梅菜扣肉.
   ```
5. 调用 `updateIndex()` 更新 MEMORY.md

**新增方法**：

| 方法 | 签名 | 说明 |
|------|------|------|
| `load(slug)` | `(slug: string) => Promise<Memory \| null>` | 读取单个记忆 |
| `delete(slug)` | `(slug: string) => Promise<void>` | 删除文件 + 更新索引 |
| `listAll()` | `() => Promise<Memory[]>` | 列出全部（替代现有 `list()`） |
| `loadIndex()` | `() => Promise<string>` | 读取 MEMORY.md 全文 |
| `updateIndex()` | `private () => Promise<void>` | 根据所有文件重建 MEMORY.md |

**list()** 保留但标记 deprecated，内部调用 `listAll()` 并转换类型。

**MEMORY.md 格式**：
```markdown
# User Memory

- [身份信息](user/identity.md) — The user's name is huajun, full-stack developer.
- [食物偏好](user/food-preferences.md) — Prefers 葱爆大虾、红烧肉、梅菜扣肉.
```

**slug 自动生成**：从 name 转为 kebab-case。`toSlug(name: string): string` 工具函数。

#### 1.3 更新 MemoryLoader — `packages/core/src/memory/loader.ts`

**关键变更**：注入 `MEMORY.md` 索引内容，而非全量记忆正文。

```typescript
class MemoryLoader {
  constructor(private store: MemoryStore) {}

  async loadInto(systemPrompt: SystemPrompt): Promise<void> {
    const indexContent = await this.store.loadIndex();
    if (!indexContent || indexContent.trim().length === 0) return;

    systemPrompt.addLayer({
      name: "memory",
      priority: 5,   // 从 8 改为 5，提高优先级
      always: false,
      content: `# User Memory\n\nThe following memories are from previous conversations:\n\n${indexContent}`,
    });
  }
}
```

#### 1.4 更新 MemoryExtractor — `packages/core/src/memory/extractor.ts`

保持正则匹配逻辑不变，改动输出类型和 slug 映射：

| 正则匹配结果 | 旧输出 | 新输出 |
|-------------|--------|--------|
| `my name is X` / `我叫X` | `MemoryEntry { id, title: "User Name", tags: ["identity"] }` | `Memory { slug: "user/identity", type: "user", name: "身份信息" }` |
| `call me X` / `请叫我X` | `MemoryEntry { title: "Preferred Name", tags: ["identity"] }` | `Memory { slug: "user/identity", type: "user" }` 追加 |
| `I am a X` / `我是X` | `MemoryEntry { title: "User Identity", tags: ["identity"] }` | `Memory { slug: "user/identity", type: "user" }` 追加 |
| `remember that I prefer/like X` | `MemoryEntry { title: "Preference", tags: ["preference"] }` | `Memory { slug: 自动生成, type: "user" }` |
| `remember that X` / `记住X` (兜底) | `MemoryEntry { title: "Memory", tags: ["general"] }` | `Memory { slug: 自动生成, type: "user" }` |

- 所有正则提取结果 `type` 统一为 `"user"`
- `identity` 类别的固定 slug 为 `"user/identity"`
- 其他类别用 `hash(content)` 生成唯一 slug
- `extract()` 返回类型改为 `Memory[]`

#### 1.5 更新 memoryMiddleware — `packages/core/src/memory/middleware.ts`

不改变逻辑，只更新类型引用：`MemoryEntry[]` → `Memory[]`。位置保持在 Agent Loop 之前。

#### 1.6 更新 /memory 命令 — `packages/core/src/extensions/commands/builtin/memory.ts`

新增 `delete` 子命令：
- **`/memory list`** — 适配新结构，输出按类型分组
- **`/memory add <内容>`** — `type: "user"`, slug 自动生成，name 从内容截取
- **`/memory delete <slug>`** — 删除指定记忆 + 更新索引（新增）

#### 1.7 更新 /context 命令 — `packages/core/src/extensions/commands/builtin/context.ts`

适配 MemoryStore 新 API。

#### 1.8 更新 CLI 集成 — `packages/cli/src/cli.ts` 和 `packages/cli/src/hooks.ts`

- MemoryStore 实例化不变（仍是 `new MemoryStore(".licode/memory")`）
- MemoryLoader 使用不变（仍是 `new MemoryLoader(store); loader.loadInto(systemPrompt)`）
- memoryMiddleware 注入不变

#### 1.9 清理旧文件

删除 `.licode/memory/memory-*.md`（3 个文件）。

#### 1.10 更新测试

- **`packages/core/src/memory/memory.test.ts`** — 重写，测试新 API：save/load/delete/listAll/loadIndex，追加合并
- **`packages/core/src/memory/extractor.test.ts`** — 更新期望输出为新 Memory 类型
- **`packages/core/src/memory/middleware.test.ts`** — 更新期望输出为新 Memory 类型

#### 1.11 更新公开导出 — `packages/core/src/index.ts`

```typescript
export { MemoryStore } from "./memory/store.js";
export { MemoryLoader } from "./memory/loader.js";
export { MemoryExtractor } from "./memory/extractor.js";
export { memoryMiddleware } from "./memory/middleware.js";
export type { Memory, MemoryType } from "./memory/types.js";
```

### 验收标准

1. 启动 LICode 后在 `.licode/memory/` 下看到 `MEMORY.md` + `user/` `feedback/` `project/` `reference/` 子目录
2. 对 LICode 说 "记住我喜欢用 TypeScript" → `user/` 下生成对应 `.md` 文件，MEMORY.md 新增索引行
3. 再说 "记住我还喜欢用 Rust" → 同 slug 文件内容追加，不产生新文件
4. `/memory list` 正确显示分类记忆
5. `/memory delete <slug>` 正确删除文件并从索引移除
6. System Prompt 中注入的是 MEMORY.md 索引（精简），非全量正文
7. 所有现有单元测试通过（`pnpm test`）
8. 旧的 3 个 `memory-*.md` 文件已删除

---

## Step 2：LLM 提取 + 管道位置调整（后续，概要）

### 目标

用 LLM 分析完整对话替代正则匹配，在 Agent Loop 完成后的 hook 位置触发。

### 关键变更

1. **MemoryExtractor 重写**：
   - `shouldExtract(messages)` — 启发式（轻量，不调 LLM）
   - `extract(messages, store)` — LLM 分析对话 → 输出 JSON → 匹配已有文件 slug → 更新
   - 构造接受 `LLMProvider`

2. **管道位置调整**：
   - 从 Agent Loop **之前**移到 **之后**
   - 利用现有 `hook:after:agentLoop` 位置
   - fire-and-forget 后台执行

3. **Hook 系统扩展**：
   - 当前 HookManager 只支持 shell 命令钩子
   - Step 2 需要支持 in-process 函数钩子
   - 或直接在 `hook:after:agentLoop` 位置加一个独立中间件

### 验收标准

- 自然语言 "哦对了，我平时比较喜欢用 Rust 写后端" → 自动提取为记忆
- 同类记忆自动合并到同一文件
- 提取不阻塞用户看到回复
- 非记忆相关的对话不触发提取（`shouldExtract` 返回 false）

---

## Step 3：全局记忆 + 高级功能（后续，概要）

### 目标

支持跨项目的全局记忆（`~/.licode/memory/`），以及搜索、类型管理等高级功能。

### 关键变更

1. 启动时加载两级记忆：`~/.licode/memory/` + `.licode/memory/`
2. `/memory search <query>` — 文本搜索
3. `/memory types` — 按类型列出
4. MemoryExtractor 支持生成 `feedback`、`project`、`reference` 类型记忆

---

## 验证清单（Step 1）

- [ ] `pnpm build` 无错误
- [ ] Phase 1-3 已有测试通过（回归）
- [ ] memory 模块新测试通过
- [ ] 启动后 `.licode/memory/` 目录结构正确
- [ ] 正则触发 "记住我..." → 新结构文件生成 + MEMORY.md 更新
- [ ] 同 slug 追加不产生新文件
- [ ] `/memory list` 输出正确
- [ ] `/memory delete` 正确
- [ ] `/context` 显示记忆统计
- [ ] System Prompt 注入 MEMORY.md 索引

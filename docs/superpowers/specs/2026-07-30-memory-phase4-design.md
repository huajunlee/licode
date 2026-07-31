# 记忆系统 Phase 4 详细设计：反馈闭环（使用计数 + 热度遗忘归档）

> **日期**：2026-07-30
> **状态**：待批准
> **前置文档**：[记忆系统重构设计](./2026-07-27-memory-system-redesign-design.md) §6.3（本文档细化其 Phase 4 蓝图）
> **前置实施**：[Phase 1 生产层](./2026-07-27-memory-phase1-implementation-plan.md)、[Phase 2 召回层](./2026-07-28-memory-phase2-design.md)、[Phase 3 整理层 Dream](./2026-07-29-memory-phase3-design.md)，均已落地
> **核心参考**：知乎文章《Claude Code 的 Memory》§反馈（Codex 的 usage_count / last_usage 引用计数 + 30 天热度遗忘）--本地副本 `~/Desktop/Claude Code的Memory.md`

---

## 1. 背景与现状

### 1.1 Phase 1/2/3 已交付能力

| 能力 | 实现 | 位置 |
|---|---|---|
| 生产层（action 语义 / 门槛 / 矛盾处理 / 互斥） | `save(create/update/append)` + `shouldExtract` + 提取 prompt 携带旧正文 + `running` 锁 | `store.ts`、`extractor.ts`、`hook.ts` |
| 主 Agent 写入检测 | `hasChangesSince(tsMs)` 按 mtime 扫 4 个 type 目录（排除 MEMORY.md） | `store.ts:185` |
| 召回 side query | `MemoryRecall.select` 选 ≤5 条，`createMemoryRecallHandler` 合成 tool_call 对注入当轮 | `recall.ts` |
| 召回挂点 | `AgentConfig.onTurnStart`（`addUserMessage` 后、首次 LLM 调用前，每轮一次） | `loop.ts`、`hooks.ts` |
| Dream 整理 | 四阶段 Orient→Gather→Consolidate→Prune，`after:agentLoop` fire-and-forget | `dream.ts` |
| Dream 期间提取让位 | 提取 hook 开头 `if (dreamState.running) return`（**不查 mtime**） | `hook.ts:77` |
| delete 备份 | Consolidate 的 delete 前复制到 `.dream-backup/` | `dream.ts:400` |

### 1.2 反馈层现状与差距

**现状**：记忆一旦写入即"永生"--`createdAt`/`updatedAt` 是死数据，没有任何使用追踪，没有任何遗忘机制。recall 每轮注入相关记忆，但"注入"这个信号被丢弃。结果是：索引只增不减，长期未用、已失效、已被新记忆覆盖的旧记忆永远占据召回候选位与 system prompt 索引层。

**差距（对齐 spec §6.3 蓝图）**：

| 蓝本能力 | 现状 |
|---|---|
| 注入即计数（usageCount / lastUsedAt） | 无--recall 注入点未埋点 |
| 热度遗忘（长期未用退出活跃集） | 无--记忆永生 |
| 归档可恢复 | 无 archive 目录、无恢复路径 |
| Dream 复核归档决定 | 无--Consolidate 不读 lastUsedAt |

### 1.3 架构约束（调研已核实）

1. **recall 注入点是唯一可信计数源**：`createMemoryRecallHandler` 在 `recall.select` 返回 `Memory[]` 后构造合成对注入（`recall.ts:262`）。LICode 自己控制注入点，**不需要 Codex 那样解析 LLM 输出里的 citation 块**--select 返回谁就计谁。
2. **`hasChangesSince` 是 mtime 检测**：扫 4 个 type 目录下所有 `.md` 的 `mtimeMs`（`store.ts:185-199`），MEMORY.md 自身排除。**任何改写记忆 `.md` 文件的操作都会 bump mtime**。
3. **⚠️ 计数与提取的 mtime 冲突（核心坑，Phase 2 §6 / Phase 3 §6 双重预注）**：`recordUsage` 若改写 frontmatter 落盘，文件 mtime = `Date.now()`。而 `loopStartedAt` 在 `handleSubmit` 开头置位（`hooks.ts:379`），早于 `onTurnStart`。故计数写入的 mtime ≥ `loopStartedAt` → 提取 hook 的 `hasChangesSince(loopStartedAt)` 误判"主 Agent 本轮已写记忆"→ `rebuildIndex()` 后 **return，跳过提取**（`hook.ts:82-85`）。每轮 recall 都触发 → **提取被永久跳过**。
4. **Dream 写文件不受 mtime 坑影响**：Dream 期间提取 hook 在 `dreamState.running` 处直接 return（`hook.ts:77`），**根本不走到 `hasChangesSince`**。故归档（在 Dream 内执行）无 mtime 冲突--只有计数埋点（在 recall handler，`onTurnStart`）需要单独处理。
5. **`archive/` 非 type 目录即天然隐身**：`listAll`/`rebuildIndex`/`listAllRaw`/`hasChangesSince` 都只遍历 `user/feedback/project/reference` 四目录（`store.ts:7`）。`archive/` 与 `.dream-backup/` 同理，放 memory 根目录即不被扫到、不污染索引。
6. **`save()` 每次都 `rebuildIndex()`**（`store.ts:88`）：计数若走 `save()` 会每轮重建索引（重写 MEMORY.md）。索引行不含 usage 字段，重建无内容变化但仍是多余 IO，且不应在每轮 recall 热路径上发生。→ 计数需独立方法，**不 `rebuildIndex`**。
7. **`parse()` 只读 6 字段**（`store.ts:231-261`）：name/description/type/createdAt/updatedAt/content。新增 usage 字段需扩展 `parse`，且向后兼容旧文件（缺字段默认 0 / ""）。
8. **主 Agent 直接 Write 绕过 `save()`**（Phase 1 既定）：memory-guide 未提 usage 字段，主 Agent 手写记忆不会带 usageCount/lastUsedAt。与 Phase 1 "直接 Write 绕过 append 合并"同属一类已知折衷。
9. **`Memory` 接口的构造点很多**（extractor / dream / memory 命令）：新增 usage 字段须设为**可选**，否则破坏全部构造点。
10. **`onTurnStart` 每轮一次**（`addUserMessage` 后、ReAct while 循环前，`loop.ts`）：计数每轮至多一次，不会在单轮 LLM 多次迭代里重复触发。
11. **dist 构建是 CLI 生效前提**（沿用 Phase 1/2/3 约束）。

---

## 2. 详细设计

### 2.1 总体机制：两条反馈回路

反馈闭环 = **计数回路**（写入侧，每轮 recall 触发）+ **遗忘回路**（整理侧，Dream 触发）。两者通过 frontmatter 的 `usageCount` / `lastUsedAt` 解耦连接：

```
┌──────────── 计数回路（recall 热路径，每轮） ────────────┐
│ recall.select 返回 ≤5 条注入记忆                          │
│   └─ store.recordUsage(slug) × N                         │
│        frontmatter: usageCount+1, lastUsedAt=now         │
│        ⚠️ utimes 恢复原 mtime（对 hasChangesSince 隐身）  │
│        不 rebuildIndex（usage 不进索引）                  │
└────────────────────────┬─────────────────────────────────┘
                         │ lastUsedAt 累积
                         ▼
┌──────────── 遗忘回路（Dream Consolidate，定期） ────────┐
│ 程序识别归档候选：lastUsedAt 非空 且 >30d 未用            │
│ Consolidate prompt 带候选清单 + usage 统计               │
│   └─ LLM 复核：archive（确认退役）/ 不输出（保留）        │
│ 程序落盘：store.archive(slug) 移入 archive/<type>/        │
│   └─ 规则护栏：只对候选 slug 生效（防幻觉归档新记忆）      │
│ Prune.rebuildIndex → 归档文件自动从 MEMORY.md 消失        │
│ 恢复：/memory-restore <slug> 移回 + rebuildIndex          │
└──────────────────────────────────────────────────────────┘
```

**为什么分两条回路**：计数是高频热路径（每轮 recall），必须廉价且对提取无副作用；遗忘是低频冷路径（Dream，≥24h+≥5 session），可以调 LLM 复核。用 frontmatter 字段解耦：计数只写字段，遗忘只读字段。两者不直接耦合，各自独立可验证可回退。

### 2.2 组件变更

| 组件 | 变更 | 文件 |
|---|---|---|
| **Memory 类型** | 新增可选 `usageCount?: number` / `lastUsedAt?: string` | `packages/core/src/memory/types.ts` |
| **MemoryStore** | `parse` 读 usage 字段（缺省 0/""）；`save` 在 update/append 保留现有 usage、create 默认 0/""，frontmatter 写出两字段；新增 `recordUsage(slug)`（mtime 隐身，不重建索引）、`archive(slug)`、`listArchived()`、`restore(slug)` | `packages/core/src/memory/store.ts` |
| **MemoryRecall handler** | `recall.select` 返回非空时，对每个 slug 调 `store.recordUsage`（best-effort）；**Dream 期间让位**（`dreamState.running` -> 跳过计数，注入照常）；deps 加 `dreamState?: DreamState` | `packages/core/src/memory/recall.ts` |
| **MemoryDream** | `DreamConfig` 加 `archiveThresholdMs`（默认 30d）；Consolidate 计算归档候选、prompt 带候选清单、`parseDreamResponse` 支持 `archive` action、op 循环调 `store.archive`（规则护栏） | `packages/core/src/memory/dream.ts` |
| **/memory 命令** | 路由加 `restore` 子命令；新增 `memoryRestoreCommand` / `memoryArchiveCommand`（列出归档） | `packages/core/src/extensions/commands/builtin/memory.ts` |
| **core 导出** | `recordUsage`/`archive`/`listArchived`/`restore` 不单独导出（经 `MemoryStore` 方法即可）；导出两个新命令 | `packages/core/src/index.ts` |
| **CLI 接线** | 把 `memoryDreamStateRef.current` 传给 `createMemoryRecallHandler`（让位检查）；需将 `memoryDreamStateRef` 声明挪到 `memoryRecallHandlerRef` 之前（ref 对象 identity 稳定，挪一下即可）。无新 hook/state | `packages/cli/src/hooks.ts` |
| **TUI** | **无新组件**--计数静默；归档在 Dream 内（已有"🌙 记忆整理中"卡片覆盖）；恢复经命令消息 | - |

### 2.3 使用计数：recordUsage + mtime 隐身

#### 2.3.1 数据模型

`types.ts`：

```ts
export interface Memory {
  slug: string;
  type: MemoryType;
  name: string;
  description: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  /** 被 recall 注入上下文的累计次数（Phase 4）。未用过为 0。 */
  usageCount?: number;
  /** 最近一次被 recall 注入的 ISO 时间（Phase 4）。未用过为 ""。 */
  lastUsedAt?: string;
}
```

两字段**可选**，向后兼容所有既有 `Memory` 构造点（extractor / dream / 命令都不必显式赋值）。

`store.ts parse()`：在现有 6 字段后补两行（缺省 0 / ""）：

```ts
usageCount: fm.has("usageCount") ? Number(fm.get("usageCount")) || 0 : 0,
lastUsedAt: fm.get("lastUsedAt") ?? "",
```

`store.ts save()` frontmatter 写出（在 updatedAt 行后）：

```ts
`usageCount: ${usageCount}`,
`lastUsedAt: ${lastUsedAt}`,
```

`save()` 对 usage 的保留语义（与 `createdAt` 同款处理）：
- `update` / `append` 且文件已存在：`load` 现有，**保留**其 `usageCount` / `lastUsedAt`（内容更新 ≠ 使用事件，不应重置使用计数）。传入 `memory` 对象的 usage 字段被忽略。
- `create`（新文件）：`usageCount = memory.usageCount ?? 0`、`lastUsedAt = memory.lastUsedAt ?? ""`。
- `create` 遇已存在防御降级 `append`：走 append 分支，保留现有 usage。

> Dream 的 `update` 保留 usage：Dream 精炼内容不重置遗忘时钟，正确。Dream 的 `create`：新记忆从 0 / 未用过开始，正确。

#### 2.3.2 `recordUsage(slug)` -- 计数埋点

独立方法（**不走 `save()`**，避免每轮 `rebuildIndex`）：

```ts
async recordUsage(slug: string): Promise<void> {
  // 1. 在 4 个 type 目录定位文件
  let filePath: string | null = null;
  for (const type of MEMORY_TYPES) {
    const p = path.join(this.dir, type, `${path.basename(slug)}.md`);
    if (fs.existsSync(p)) { filePath = p; break; }
  }
  if (!filePath) return; // 文件不存在（已被 delete/archive）-> 静默 no-op

  // 2. 捕获原 mtime（mtime 隐身的关键）
  const stat = await fs.promises.stat(filePath);
  const mtimeMs = stat.mtimeMs;
  const atimeMs = stat.atimeMs;

  // 3. 读 + 解析，得到当前 usage（缺省 0/""）
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const existing = this.parse(raw, slug, /*type*/ path.basename(path.dirname(filePath)));
  const usageCount = (existing.usageCount ?? 0) + 1;
  const lastUsedAt = new Date().toISOString();

  // 4. 重写 frontmatter：只动 usageCount/lastUsedAt，其余原样保留
  const frontmatter = [
    "---",
    `name: ${existing.name}`,
    `description: ${existing.description}`,
    `type: ${existing.type}`,
    `createdAt: ${existing.createdAt}`,
    `updatedAt: ${existing.updatedAt}`,
    `usageCount: ${usageCount}`,
    `lastUsedAt: ${lastUsedAt}`,
    "---",
    "",
    existing.content,
    "",
  ].join("\n");
  await fs.promises.writeFile(filePath, frontmatter, "utf-8");

  // 5. 恢复原 mtime -> 对 hasChangesSince 隐身
  await fs.promises.utimes(filePath, atimeMs / 1000, mtimeMs / 1000).catch(() => {});
  // 6. 不 rebuildIndex（usage 字段不进索引）
}
```

设计要点：

- **mtime 隐身是核心**：步骤 5 把 mtime 恢复到写入前的值（< `loopStartedAt`）。提取 hook 的 `hasChangesSince(loopStartedAt)` 因此看不到这次写入（§1.3 约束 3 的对策）。`utimes` 失败时 `.catch` 吞掉--最坏情况是下轮提取被误跳一次（Phase 1 风险清单已记的自愈场景）。
- **不改 `updatedAt`**：`updatedAt` 是"内容更新时间"，使用事件不是内容更新。`recordUsage` 只动 usage 两字段，`updatedAt` 原样写回。
- **不 `rebuildIndex`**：索引行是 `name/description`，不含 usage；重建无内容变化且是多余热路径 IO（§1.3 约束 6）。
- **best-effort**：整个方法由调用方 try/catch 包裹；单文件失败不影响其余。文件不存在（本轮 recall 选中后、计数前被 Dream delete/archive）→ no-op。

#### 2.3.3 埋点位置：recall handler

`recall.ts createMemoryRecallHandler`，在 `recall.select` 返回非空、构造合成对之前插入计数：

```ts
const memories = await recall.select(query, store);
if (memories.length === 0) return;

// Phase 4: 注入即计数（best-effort，不阻断 recall）。
// Dream 整理期间让位（同提取）：recordUsage 是记忆写者，与 Dream 的
// consolidate 并发写会互相覆盖；Dream 期间跳过计数，注入照常（recall 的
// 读路径服务用户当轮，不让位）。漏计几次 usage 相对 30 天归档窗口可忽略。
if (!dreamState?.running) {
  await Promise.all(
    memories.map((m) => store.recordUsage(m.slug).catch(() => {}))
  ).catch(() => {});
}

const [toolUse, toolResult] = buildRecallPair(query, memories);
conversation.replaceMessages([...conversation.getMessages(), toolUse, toolResult]);
```

设计要点：

- **Dream 期间让位（写）**：`recordUsage` 是记忆写者，Dream 的 `consolidate` 也是记忆写者，二者并发会互相覆盖（Dream 的 `save(update)` 用旧快照覆盖 recordUsage 的 `usageCount+1`）。沿用 Phase 3 让位原则：`dreamState.running` -> 跳过计数。**只让位写、不让位 recall 的读**--select/inject 服务用户当轮，整体让位会为后台任务降级当轮召回。提取是纯写者故整体让位；recall 是"带写副作用的读者"故只让位写，原则一致。漏计几次 usage 相对 30 天归档窗口可忽略。
- **await 在合成对注入之前**：计数写入在 agent loop 的 LLM 调用之前完成，避免与主 Agent 本轮可能的直接 Write 发生写写竞态（计数先落盘，主 Agent 后写覆盖也只是丢这一次计数，见 §2.6「主 Agent 直接 Write」行）。
- **best-effort**：`recordUsage` 失败（文件锁/权限/IO）被 `.catch` 吞掉，recall 照常注入。recall handler 本身已整体 try/catch（`recall.ts:267`），双保险。
- **成本可忽略**：≤5 个小文件（frontmatter ~几百字节）的 stat+read+write+utimes，相对 side-query LLM 调用（≤10s）是噪声。
- **`recall.select` 降级为 `[]` 时不计数**：LLM 错误/超时/解析失败 → `select` 返回 `[]`（`recall.ts:146`）→ 不注入 → 不计数。正确（没注入就不算用）。
- **可选节流（本期不做）**：同一记忆短时间内被反复召回时，每轮重写同一文件。可加"距上次 recordUsage < 1h 则只更新内存计数、批量落盘"优化；个人 CLI 对话频率下，每轮 ≤5 次小写可接受，列为后续优化。

### 2.4 遗忘归档：规则、存储、恢复

#### 2.4.1 归档候选规则

```ts
/** 归档候选：被召回过（lastUsedAt 非空）且超过阈值未再被召回。 */
function isArchiveCandidate(m: Memory, now: number, thresholdMs: number): boolean {
  if (!m.lastUsedAt) return false;            // 从未被召回 -> 不判为候选（见下方决策）
  const lu = Date.parse(m.lastUsedAt);
  if (!lu) return false;                       // 解析失败兜底
  return now - lu > thresholdMs;
}
```

**关键决策：候选只看 `lastUsedAt`，不看 `createdAt`**（§5 决策表详述）。即只对"曾被召回过、之后冷却"的记忆判候选；**从未被召回的记忆不判候选**。理由：
- 防止 recall 关闭时的灭顶之灾：若用 `createdAt`，`LICODE_MEMORY_RECALL=off` 时所有记忆 `lastUsedAt` 永远为空 → 全部按 createdAt 判为陈旧 → Dream 可能整批归档。用 `lastUsedAt` 非空作前置条件，recall 关闭 ⇒ 无候选 ⇒ 无归档，自然安全。
- 语义更准：从未被召回 ≠ 无用，可能只是没遇到相关查询（稀有但重要的记忆）。"曾有用、后冷却"才是可靠的遗忘信号（Codex 热度模型）。
- 从未被召回的垃圾记忆由 Phase 3 内容审查（delete 重复/失效）处理，不靠热度。

#### 2.4.2 归档存储：`archive/<type>/`

`store.archive(slug)`：把 `<type>/<slug>.md` 移到 `archive/<type>/<slug>.md`。

```ts
async archive(slug: string): Promise<void> {
  for (const type of MEMORY_TYPES) {
    const src = path.join(this.dir, type, `${path.basename(slug)}.md`);
    if (!fs.existsSync(src)) continue;
    const dstDir = path.join(this.dir, "archive", type);
    await fs.promises.mkdir(dstDir, { recursive: true });
    await fs.promises.rename(src, path.join(dstDir, `${path.basename(slug)}.md`));
    return; // 不 rebuildIndex：Dream 的 Prune 阶段统一重建
  }
}
```

- **`rename` 而非复制+删除**：原子移动，同文件系统下廉价。
- **`archive/` 隐身**：非 type 目录，`listAll`/`rebuildIndex`/`hasChangesSince` 都不扫（§1.3 约束 5）。归档后 Prune 的 `rebuildIndex()` 自动让它从 MEMORY.md 消失、从 recall 候选消失。
- **不备份到 `.dream-backup/`**：归档本身就是"软删除"（文件还在 `archive/`，可恢复）。`.dream-backup/` 留给 delete（不可逆）。

`store.listArchived()`：扫 `archive/<type>/`，返回 `Memory[]`（复用 `parse`，含 usage 字段），供 `/memory-archive` 列出。

`store.restore(slug)`：`archive/<type>/<slug>.md` 移回 `<type>/<slug>.md` + `rebuildIndex()`。

#### 2.4.3 归档不是 delete

| | delete（Phase 3） | archive（Phase 4） |
|---|---|---|
| 触发维度 | 内容驱动（重复/失效/矛盾） | 热度驱动（长期未用） |
| 落点 | `.dream-backup/`（备份，手动捞回） | `archive/`（归档区，命令恢复） |
| 可恢复性 | 手动复制 + rebuildIndex | `/memory-restore` 一键 |
| 索引 | 重建后消失 | 重建后消失 |
| LLM action | `delete` | `archive` |

二者维度不重叠（Phase 3 §6 已定边界），Consolidate 可同批输出。

### 2.5 Dream Consolidate 扩展：复核归档

spec §6.3 "Dream 整理时复核归档决定" 的落地：在 Consolidate 阶段扩展，**不新增 Dream 阶段**（四阶段骨架不变，archive 作为 Consolidate 的额外 action）。

#### 2.5.1 候选识别 + prompt

`consolidate()` 开头计算候选，传入 prompt：

```ts
protected async consolidate(store: MemoryStore, suspicions: Suspicion[], evidence: Map<string, string[]>): Promise<void> {
  const all = await store.listAll();
  const now = Date.now();
  const candidateSlugs = new Set(
    all.filter((m) => isArchiveCandidate(m, now, this.archiveThresholdMs)).map((m) => m.slug)
  );
  const index = await store.loadIndex();
  const prompt = this.buildConsolidatePrompt(index, all, suspicions, evidence, candidateSlugs, now);
  // ... LLM 调用（不变）
  const ops = this.parseDreamResponse(response.content, knownSlugs, candidateSlugs);
  for (const op of ops) {
    if (op.action === "delete") await this.backupAndDelete(store, op.slug);
    else if (op.action === "archive") await store.archive(op.slug);   // Phase 4
    else { /* create/update/append -> store.save，不变 */ }
  }
}
```

`buildConsolidatePrompt` 新增"归档候选"区块：

```text
## Archive candidates（>30 天未被召回，归档候选）
- user/old-tool | usageCount=2 | lastUsedAt=2026-06-10 | 已 50 天未用
- reference/old-board | usageCount=1 | lastUsedAt=2026-06-25 | 已 35 天未用
（无候选则写"(无)"）

## Instructions（在既有 Rules 后追加）
- archive：把"归档候选"中确已长期无用、可安全退出活跃集的记忆移入归档区（可恢复）。只可作用于上面的归档候选；非候选不要 archive。
- 对归档候选，若仍明显相关/可能再用，则不输出（保留默认）；只对确应退役的输出 {"action":"archive","slug":"...","reason":"..."}（不需 content）。
```

复核语义：**默认保留，LLM 显式 `archive` 才退役**。LLM 失败/返回 `[]` → 不归档任何人（安全，避免 LLM 抖动整批归档）。这比"默认归档、LLM 否决"安全--遗忘仍会发生（prompt 明确指示对陈旧候选输出 archive），但不会因 LLM 失误而失控。

#### 2.5.2 解析防线 + 规则护栏

`parseDreamResponse` 扩展 `archive`（对齐既有 delete 防线风格）：

```ts
} else if (item.action === "archive") {
  // 规则护栏：只接受程序识别的候选 slug（防幻觉归档新记忆/常用记忆）
  if (candidateSlugs.has(item.slug)) {
    out.push({ action: "archive", slug: item.slug, reason: typeof item.reason === "string" ? item.reason : "" });
  }
}
```

- **规则护栏**：`archive` 的 slug 必须 ∈ `candidateSlugs`（程序按 `lastUsedAt`>30d 算出的集合）。LLM 无法归档非候选（新鲜/常用记忆），即使它输出也丢弃。与 delete 的"slug 必须存在"护栏同构。
- **archive 项只要求 slug + reason**，不要求 content/type/name（不重写内容，只移动文件）。

#### 2.5.3 与 Prune 的衔接

归档在 Consolidate 的 op 循环执行（文件已移走）；随后的 `prune()` 调 `rebuildIndex()`，归档文件不在 type 目录 → 自动从 MEMORY.md 消失。**无需额外接线**。下一轮 recall（`MemoryRecall.select` 每轮读磁盘索引）与索引层刷新（`createMemoryRecallHandler` 每轮 `loadIndex`）自动看不到归档记忆。

### 2.6 错误处理

| 场景 | 行为 |
|---|---|
| `recordUsage` 文件不存在（被 Dream 删/归档） | no-op，静默返回 |
| `recordUsage` IO/权限失败 | `.catch` 吞掉，recall 照常注入；usage 计数丢失一次，可接受 |
| `recordUsage` 的 `utimes` 失败 | mtime 未恢复 → 下轮提取 `hasChangesSince` 误判一次 → rebuildIndex + 跳过一轮提取，自愈（Phase 1 已记） |
| 主 Agent 本轮直接 Write 同一被召回记忆 | 主 Agent 的 Write 覆盖 frontmatter（不带 usage 字段）→ 该记忆 usage 重置为 0/""。罕见（本轮改写刚召回的记忆），属 Phase 1 "直接 Write 绕过 save 语义"同类折衷，可接受 |
| recall 降级（select 返回 `[]`） | 不注入 → 不计数，正确 |
| recall 对被 trimToBudget 裁剪 | 仍计了 usage（注入时已计），轻微高估，Phase 2 已接受 budget 裁剪 recall 对的折衷 |
| 归档候选为空 | prompt 候选区块写"(无)"，LLM 无 archive 可输出 |
| LLM 对候选都不 archive | 全部保留，遗忘本轮不发生（下轮 Dream 再评估），安全 |
| LLM 幻觉 archive 非候选 | 规则护栏丢弃，不归档 |
| LLM 失败/Consolidate 抛错 | `dream()` catch，不更新 `lastConsolidatedAt`，archive 未执行（op 循环未跑），下次重试 |
| `archive` 的文件已被同批 delete | `store.archive` 找不到文件 → no-op |
| `store.archive` rename 跨文件系统失败 | 罕见（archive/ 与 type/ 同在 memory 根下）；失败抛出被 `dream()` catch，下次重试 |
| Dream 期间计数写入 | 不发生：`dreamState.running` 时 recordUsage 让位（跳过计数），消除与 Dream consolidate 的写写竞态；recall 的 select/inject（读）照常服务当轮 |
| `restore` 的 slug 不在 archive | 命令返回"未找到"错误消息 |

> 注：recordUsage 的写有**两道互补安全网**--对提取侧 utimes 隐身（§2.3.2），对 Dream 侧让位缺席（§2.3.3）。Dream 期间 recall 的 select/inject 仍可跑（读路径，服务用户当轮），只是不计数；Dream 结束后下轮起计数恢复。让位沿用 Phase 3 提取让位的原则（Dream 整理时其它记忆写者让位），区别仅在于：提取是纯写者 -> 整体让位，recall 是"带写副作用的读者" -> 只让位写。

### 2.7 测试

| 测试 | 断言 |
|---|---|
| `parse` usage 字段 | 有 usageCount/lastUsedAt → 读出；缺字段 → 0/"" |
| `save` update 保留 usage | 已有 usageCount=3 的记忆，`save(update)` 改内容 → usageCount 仍 3、lastUsedAt 不变 |
| `save` create 默认 | 新建记忆不传 usage → frontmatter 写 usageCount=0、lastUsedAt="" |
| `recordUsage` 基本流程 | usageCount +1、lastUsedAt=今天、content/name/createdAt/updatedAt 原样保留、不重建索引（MEMORY.md mtime 不变） |
| `recordUsage` mtime 隐身 | 记录前后 `stat.mtimeMs` 不变；`hasChangesSince(记录前 ts)` 返回 false（**坑的回归测试**） |
| `recordUsage` 缺文件 | 不存在的 slug → no-op 不抛 |
| `recordUsage` best-effort | 模拟 utimes reject → 不抛、不阻断 |
| `archive` 移动 | 文件从 `<type>/` 消失、出现在 `archive/<type>/`；`listAll` 不含它；`rebuildIndex` 后 MEMORY.md 不含它 |
| `listArchived` | 列出 archive/ 下记忆（含 usage 字段） |
| `restore` | 移回 `<type>/`、`rebuildIndex` 后回索引、`listAll` 含它 |
| recall handler 计数 | `select` 返回非空 → 每个 slug 调一次 `recordUsage`；返回空 → 不调 |
| recall handler best-effort | `recordUsage` throw → recall 仍注入合成对 |
| recall handler 让位 | `dreamState.running=true` → `recordUsage` 不被调；合成对仍注入（recall 读路径不受影响） |
| Dream consolidate 归档 | 候选（lastUsedAt=35d 前）出现在 prompt；mock LLM 输出 archive → `store.archive` 被调、文件移入 archive/ |
| Dream 规则护栏 | mock LLM 对**非候选**输出 archive → 丢弃，不归档 |
| Dream 默认保留 | 候选存在但 mock LLM 输出 `[]` → 不归档任何人 |
| Dream 复核矛盾 | 候选中一个仍相关（mock LLM 不 archive 它）+ 一个陈旧（archive）→ 只后者归档 |
| Dream 候选为空 | 无候选 → prompt 候选区块为"(无)"，无 archive 输出 |
| 从未召回不判候选 | lastUsedAt="" 且 createdAt 很旧 → 不在候选集 |
| `/memory-restore` 命令 | 归档记忆 → restore → 回活跃集；不存在的 slug → 错误消息 |
| `/memory-archive` 命令 | 列出归档记忆 |
| 回归 | 现有 memory/dream/recall/hook 测试全部通过 |

---

## 3. 配置

| 项 | 值 |
|---|---|
| 归档阈值 | `archiveThresholdMs` 默认 30 天（可注入，仅供测试）；经 `DreamConfig` 传入 |
| 计数模型 | 无 LLM--`recordUsage` 纯程序 |
| 归档 LLM | 复用 Dream 的 Consolidate 调用（不新增 LLM 调用） |
| recall 开关 | `LICODE_MEMORY_RECALL=off` → 不计数 → 无归档候选 → 不归档（自然联动，无需额外开关） |
| Dream 开关 | `LICODE_MEMORY_DREAM=off` → 不整理 → 不归档（计数仍随 recall 进行，lastUsedAt 照常更新，等 Dream 重新开启再评估） |
| 归档目录 | `.licode/memory/archive/<type>/`（`.`/非 type 前缀皆隐身） |
| 索引约束 | 不变（<200 行 / <25KB，Phase 3 Prune 守护） |

---

## 4. 验证方式（Phase 4 验收标准）

1. 问一个能命中已有记忆的问题（如"今晚吃什么好？"命中食物偏好）→ 该记忆文件 frontmatter `usageCount` +1、`lastUsedAt` = 今天
2. **坑回归**：上一步 recall 计数后，紧接着问一个无关问题（应触发提取）→ 后台提取**正常执行**（日志可见，未被"主 Agent 已写"误跳过）
3. 手动把某记忆 `lastUsedAt` 改为 35 天前，触发 Dream（调小 `minIntervalMs`/`minNewSessions`）→ 它出现在归档候选；Dream 后该记忆移入 `archive/<type>/`、从 MEMORY.md 与 `/memory-list` 消失
4. 一个 `lastUsedAt` 为空（从未召回）的旧记忆 → Dream 后**不被**热度归档（候选规则只认 lastUsedAt）
5. Dream 复核：候选中一个仍相关（mock/观察 LLM 保留）→ 保留在活跃集；一个陈旧 → 归档
6. `/memory-archive` → 列出归档记忆；`/memory-restore <slug>` → 记忆回到活跃集、回索引、可被 recall 选中
7. `LICODE_MEMORY_RECALL=off` 启动 → 不计数；触发 Dream → 无归档候选、不归档
8. `LICODE_MEMORY_DREAM=off` 启动 → 不整理、不归档；recall 计数仍工作
9. Dream 失败（断网/无效 apiKey）→ 不归档、不更新 `lastConsolidatedAt`（下次重试）、错误写 `.licode/logs/dream.log`
10. 全部新旧测试通过

---

## 5. 设计决策记录

| 决策 | 选择 | 原因 |
|---|---|---|
| usage 存储 | frontmatter `usageCount`/`lastUsedAt`（spec §6.3 + Codex 对齐） | spec 明示；与记忆同址、随文件移动、Dream 直接读；否决 sidecar `.usage.json`（虽零 mtime 污染但偏离 spec、Dream 须 join 两源、不随文件移动） |
| 计数与提取的 mtime 冲突 | `recordUsage` 写后 `utimes` 恢复原 mtime | Phase 2/3 双重预注的坑；utimes 是局部、对症的修复，使计数对 `hasChangesSince` 隐身；否决"内容 hash 检测"（改 `hasChangesSince` 契约、每轮哈希全部文件，过重）；否决"mtime 检测排除仅 frontmatter 变化"（须 parse+diff，脆弱） |
| 计数与 Dream 的写写竞态 | recordUsage 让位给 Dream（`dreamState.running` -> 跳过计数，注入照常） | recordUsage 是记忆写者，与 Dream consolidate 并发写会互相覆盖（Dream 的 `save(update)` 用旧快照覆盖 recordUsage 的 `usageCount+1`）；沿用 Phase 3 让位原则（Dream 整理时记忆写者让位）；只让位写、不让位 recall 的读（服务用户当轮）；否决"接受竞态/最坏丢一次计数"（与 Phase 3 让位不一致，且让位零成本）。与 utimes 互补：utimes 闭提取侧、让位闭 Dream 侧 |
| 计数方法 | 独立 `recordUsage`，不走 `save()` | `save()` 每次重建索引（热路径多余 IO）；`recordUsage` 只动 frontmatter、不重建索引、不 `rebuildIndex` |
| 计数时机 | recall handler 内 `select` 返回非空后、合成对注入前 `await` | 注入即计数（spec）；await 在 agent loop 前，避免与主 Agent 直接 Write 写写竞态；成本 ≤5 小文件可忽略 |
| 计数不 `rebuildIndex` | usage 字段不进索引行 | 索引是 name/description；usage 变化无索引内容变化，重建纯浪费 |
| 归档候选口径 | 只看 `lastUsedAt` 非空且 >30d，不看 `createdAt` | 防 recall 关闭时全量误归档；"曾有用后冷却"是更可靠的遗忘信号；从未召回的垃圾交 Phase 3 内容审查 delete |
| 归档复核模型 | 默认保留，LLM 显式 `archive` 才退役 | LLM 失败/`[]` → 不归档（安全）；遗忘仍发生（prompt 指示对陈旧候选 archive）；否决"默认归档+LLM 否决"（LLM 失误→整批归档失控） |
| 规则护栏 | `archive` slug 必须 ∈ 程序候选集 | 防 LLM 幻觉归档新/常用记忆；与 delete 的 slug 存在性护栏同构 |
| archive 落点 | `archive/<type>/`（rename 移动） | 非 type 目录天然隐身；rename 原子廉价；归档=软删除可恢复，不进 `.dream-backup/`（那是 delete 的不可逆备份） |
| archive vs delete | 两个独立 action | 维度不同（热度 vs 内容），Phase 3 §6 已定边界；archive 可恢复、delete 不可逆 |
| 恢复路径 | `/memory-restore` 命令 | Phase 3 "本期不做"的 restore 落到 Phase 4；使"可恢复"用户可见；复用既有 `/memory` 路由模式 |
| Dream 阶段结构 | 不新增阶段，archive 作 Consolidate 额外 action | 四阶段骨架已就绪（Phase 3 §6 预注）；复用一次 Consolidate LLM 调用，零额外调用 |
| TUI | 无新组件 | 计数静默；归档在 Dream 内（已有"🌙 整理中"卡片）；恢复经命令消息 |

---

## 6. 记忆系统四阶段闭环总结

Phase 4 闭合了记忆系统重构的最后一块，四阶段形成完整生命周期：

```
生产（P1）──写入──> 召回（P2）──注入──> 计数（P4）──累积热度──> 整理（P3）──复核──> 归档（P4）
   ↑                  ↑                                                              │
   └──── archive/ 恢复（P4 /memory-restore）←──────────────────────────────────────────┘
```

| 阶段 | 能力 | 关键机制 |
|---|---|---|
| P1 生产 | 双路径写入 + 矛盾解决 | action 语义 / 冷却门槛 / 提取 prompt 携带旧正文 / 主 Agent 直写检测 |
| P2 召回 | 正文进上下文 | side query 合成 tool_call 对 / 每轮换新 / 索引层刷新 |
| P3 整理 | 去重/漂移/矛盾收敛 | Dream 四阶段 / 程序当导演 LLM 当顾问 / delete 备份 |
| **P4 反馈** | **热度追踪 + 遗忘** | **注入即计数（mtime 隐身）/ lastUsedAt 驱动归档候选 / Dream 复核 / archive 可恢复** |

闭环特性：
- **有进有出**：P1/P2 生产+注入，P4 计数追踪使用，P3 整理+P4 归档控制规模--记忆不再永生，索引收敛。
- **可恢复**：归档（archive/）与删除（.dream-backup/）双退路，误退役可捞回。
- **不阻塞**：计数在 recall 热路径（已调 LLM，计数为噪声）；归档在 Dream 后台（fire-and-forget）。
- **不动 RAG**：全程文件系统 LLM Wiki + 小模型，对齐参考文章核心论断。
- **逃生通道**：`LICODE_MEMORY_RECALL=off`（关计数+归档候选）、`LICODE_MEMORY_DREAM=off`（关整理+归档执行）独立可控。

未实现（后续可选）：`/memory restore` 批量/交互式恢复；recordUsage 节流批写；side query 带对话上下文消歧；archive 自动过期清理（archive/ 内超 N 天未恢复则真删）。

---

## 7. 参考

- [记忆系统重构设计](./2026-07-27-memory-system-redesign-design.md) §6.3（Phase 4 蓝图）
- [Phase 2 详细设计](./2026-07-28-memory-phase2-design.md) §6（Phase 4 计数埋点 + mtime 坑预注）
- [Phase 3 详细设计](./2026-07-29-memory-phase3-design.md) §6（Dream Consolidate 扩展归档复核预注、Phase 边界）
- 知乎文章《Claude Code 的 Memory》：https://zhuanlan.zhihu.com/p/2062191639829935034（本地副本 `~/Desktop/Claude Code的Memory.md`）--Codex usage_count/last_usage 引用计数 + 30 天热度遗忘蓝本

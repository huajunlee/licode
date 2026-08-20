# 记忆系统 Phase 4 详细设计：反馈闭环（使用计数 + 热度归档 + pinned 保护 + 归档通知）

> **日期**：2026-07-30（2026-07-31 验收期修订：归档模型从"LLM keep 否决"改为"规则驱动 + pinned 硬保护 + 通知"）
> **状态**：已实现、已验收
> **前置文档**：[记忆系统重构设计](./2026-07-27-memory-system-redesign-design.md) §6.3（本文档细化其 Phase 4 蓝图）
> **前置实施**：[Phase 1 生产层](./2026-07-27-memory-phase1-implementation-plan.md)、[Phase 2 召回层](./2026-07-28-memory-phase2-design.md)、[Phase 3 整理层 Dream](./2026-07-29-memory-phase3-design.md)，均已落地
> **核心参考**：知乎文章《Claude Code 的 Memory》§反馈（Codex 的 usage_count / last_usage 引用计数 + 30 天热度遗忘）--本地副本 `~/Desktop/Claude Code的Memory.md`

---

## 0. 验收期演进说明（重要）

本设计在实现/验收期间经历三轮迭代，最终落地与初稿不同，**以本文档为准**：

1. **初稿（Option A）**：归档靠 LLM 显式输出 `archive`（默认保留）。实测 LLM 两极摆动--一次把陈旧记忆 `delete`（过激）、一次全保留不归档（过保守），archive 通道几乎不触发。**已废弃。**
2. **翻转（Option B）**：规则驱动默认归档 + LLM `keep` 否决。归档能稳定触发，但 `keep` 的判据（"归档有严重后果"）与归档可恢复自相矛盾，LLM 仍判不准"重要性"，关键记忆（凭据）被归档。
3. **最终（本文档）**：**规则驱动自动归档 + `pinned` 硬保护 + 归档通知**。归档是规则（>30d 未用即归档，可恢复）；"重要性"不再交给 LLM 判断，改用**明确的 pinned 标记**（用户/Agent 说"这条别动"）；归档后给用户通知，万一漏 pin 也能看见 + 一键恢复。**去掉 LLM keep。**

迭代 commit：`445b521`（prompt 收紧）→ `0bb8329`（Option B 翻转）→ `35792b6`（pinned + 规则，去 keep）→ `7d55481`（归档通知）。

---

## 1. 背景与现状

### 1.1 Phase 1/2/3 已交付能力

| 能力 | 实现 | 位置 |
|---|---|---|
| 生产层（action 语义 / 门槛 / 矛盾处理 / 互斥） | `save(create/update/append)` + `shouldExtract` + 提取 prompt 携带旧正文 + `running` 锁 | `store.ts`、`extractor.ts`、`hook.ts` |
| 主 Agent 写入检测 | `hasChangesSince(tsMs)` 按 mtime 扫 4 个 type 目录（排除 MEMORY.md） | `store.ts` |
| 召回 side query | `MemoryRecall.select` 选 ≤5 条，`createMemoryRecallHandler` 合成 tool_call 对注入当轮 | `recall.ts` |
| Dream 整理 | 四阶段 Orient->Gather->Consolidate->Prune，`after:agentLoop` fire-and-forget | `dream.ts` |
| Dream 期间提取让位 | 提取 hook 开头 `if (dreamState.running) return`（不查 mtime） | `hook.ts` |

### 1.2 反馈层现状与差距

**现状**：记忆一旦写入即"永生"--`createdAt`/`updatedAt` 是死数据，无使用追踪，无遗忘。recall 每轮注入相关记忆但"注入"信号被丢弃。索引只增不减。

**差距（对齐 spec §6.3）**：注入即计数、热度遗忘、归档可恢复、（最终）pinned 硬保护 + 归档通知。

### 1.3 架构约束（调研已核实）

1. **recall 注入点是唯一可信计数源**：`createMemoryRecallHandler` 在 `recall.select` 返回 `Memory[]` 后注入。LICode 控制注入点，不需解析 LLM citation。
2. **`hasChangesSince` 是 mtime 检测**：任何改写记忆 `.md` 的操作都 bump mtime。
3. **⚠️ 计数与提取的 mtime 冲突（Phase 2/3 预注的坑）**：`recordUsage` 改 frontmatter -> mtime ≥ `loopStartedAt` -> 提取 hook 误判"主 Agent 已写" -> 提取被永久跳过。`recordUsage` 写后 `utimes` 恢复 mtime 解决。
4. **Dream 写文件不受 mtime 坑影响**：Dream 期间提取在 `dreamState.running` 直接 return，不查 mtime。
5. **`archive/` 非 type 目录即天然隐身**：`listAll`/`rebuildIndex`/`hasChangesSince` 只遍历 4 个 type 目录。
6. **"重要性"无法从内容/用法自动推断**：凭据与看板地址同为 reference 类、同 30 天未用、同用过 1 次--LLM 判不准（验收证实）。**故硬保护用明确 pinned 标记，不靠 LLM。**
7. **`save()` 每次重建索引** -> 计数走独立 `recordUsage`，不 `rebuildIndex`。
8. **`onTurnStart` 每轮一次**：计数每轮至多一次。
9. dist 构建是 CLI 生效前提（但 `npm start`/`run.sh` 走 tsx 直跑 src）。

---

## 2. 详细设计

### 2.1 总体机制：两条回路 + pinned 保护 + 通知

```
┌──────── 计数回路（recall 热路径，每轮） ────────────────┐
│ recall.select 返回 ≤5 条注入记忆                          │
│   └─ store.recordUsage(slug) × N                         │
│        frontmatter: usageCount+1, lastUsedAt=now         │
│        ⚠️ utimes 恢复原 mtime（对 hasChangesSince 隐身）  │
│        Dream 期间让位（dreamState.running -> 跳过）        │
│        不 rebuildIndex                                    │
└────────────────────────┬─────────────────────────────────┘
                         │ lastUsedAt 累积
                         ▼
┌──────── 遗忘回路（Dream Consolidate，定期） ────────────┐
│ 程序识别归档候选：lastUsedAt 非空 且 >30d 且 未 pinned    │
│ LLM 做内容维度：create/update/append/delete（不变）       │
│ 程序规则驱动：候选中未被 delete 的 -> 自动 store.archive  │
│   └─ pinned 候选不存在（isArchiveCandidate 已排除）       │
│   └─ delete 优先：被 LLM delete 的候选不再归档            │
│ Prune.rebuildIndex -> 归档文件自动从 MEMORY.md 消失        │
│ dream() 返回归档清单 -> onArchived -> TUI 黄字通知         │
│ 恢复：/memory-restore <slug> 移回 + rebuildIndex          │
│ 硬保护：/memory pin <slug> 设 pinned:true -> 永不归档     │
└──────────────────────────────────────────────────────────┘
```

**为什么规则驱动 + pinned，而非 LLM 判断**：归档是规则（>30d 未用即归档，spec §6.3 原意），可恢复、低风险，应确定性执行；"哪条重要到不该归档"是无法自动推断的主观判断（验收证实 LLM 判不准），改用**用户/Agent 明确的 pinned 标记**（硬条件，100% 可靠）。归档通知作安全网：漏 pin 的也被看见 + 可恢复。

### 2.2 组件变更

| 组件 | 变更 | 文件 |
|---|---|---|
| **Memory 类型** | 新增可选 `usageCount?` / `lastUsedAt?` / `pinned?` | `types.ts` |
| **MemoryStore** | `parse` 读 usage+pinned；`save` 在 update/append 保留现有 usage+pinned；新增 `recordUsage(slug)`（mtime 隐身）、`archive(slug)`、`listArchived()`、`restore(slug)`、`setPinned(slug, pinned)` | `store.ts` |
| **MemoryRecall handler** | `recall.select` 返回非空时 `recordUsage`（best-effort）；Dream 期间让位；deps 加 `dreamState?` | `recall.ts` |
| **MemoryDream** | `DreamConfig` 加 `archiveThresholdMs`；`isArchiveCandidate` 排除 pinned；Consolidate 规则驱动自动归档（候选 - deleted）；`dream()` 返回归档 slugs；`createMemoryDreamHook` 加 `onArchived` 回调 | `dream.ts` |
| **/memory 命令** | 加 `pin`/`unpin`/`archive`/`restore` 子命令 + 独立命令 | `memory.ts` |
| **memory-guide** | frontmatter 加 `pinned`；指引"凭据/密钥/关键配置设 pinned:true" | `memory-guide.md` |
| **CLI 接线** | `dreamState` 传给 recall handler；`onArchived` -> `archivedNotice` state | `hooks.ts` |
| **app.tsx** | 归档后黄字 banner（`archivedNotice`） | `app.tsx` |
| **TUI** | 无新组件（复用 dream indicator 区） | - |

### 2.3 使用计数：recordUsage + mtime 隐身 + Dream 让位

（与初稿一致，未变。）`Memory` 加 `usageCount?`/`lastUsedAt?`（可选，向后兼容）。`parse` 读两字段（缺省 0/""）；`save` 在 update/append 保留现有 usage（内容更新 ≠ 使用事件，不重置遗忘时钟），create 默认 0/""。

`recordUsage(slug)`：定位文件 -> `stat` 捕获原 mtime -> 读+解析 -> 重写 frontmatter（只动 usageCount+1/lastUsedAt=now，其余原样）-> `utimes` 恢复原 mtime（对 `hasChangesSince` 隐身）-> **不 `rebuildIndex`**。best-effort，文件不存在/utimes 失败静默吞掉。

埋点位置：`createMemoryRecallHandler` 中 `recall.select` 返回非空后、合成对注入前：

```ts
const memories = await recall.select(query, store);
if (memories.length === 0) return;
// Dream 整理期间让位（同提取），避免与 Dream consolidate 写写竞态；
// recall 的读路径（select/inject）服务用户当轮，不让位。
if (!dreamState?.running) {
  await Promise.all(memories.map((m) => store.recordUsage(m.slug).catch(() => {}))).catch(() => {});
}
const [toolUse, toolResult] = buildRecallPair(query, memories);
conversation.replaceMessages([...conversation.getMessages(), toolUse, toolResult]);
```

`recordUsage` 的写有**两道互补安全网**：对提取侧 `utimes` 隐身（§1.3.3），对 Dream 侧让位缺席（`dreamState.running`）。

### 2.4 遗忘归档：规则 + pinned + 存储 + 恢复

#### 2.4.1 归档候选规则（pinned 硬排除）

```ts
export function isArchiveCandidate(m: { lastUsedAt?: string; pinned?: boolean }, now: number, thresholdMs: number): boolean {
  if (m.pinned) return false;            // Phase 4: pinned 永不归档（硬条件）
  if (!m.lastUsedAt) return false;        // 从未召回 -> 不判候选（防 recall 关闭时全量误归档）
  const lu = Date.parse(m.lastUsedAt);
  if (!lu) return false;
  return now - lu > thresholdMs;
}
```

**pinned 是硬条件**：`pinned: true` 的记忆 `isArchiveCandidate` 直接返回 false，永不进候选集。这是用户/Agent 的明确意图，不靠 LLM 判断。设标记：`/memory pin <slug>` 命令，或主 Agent 写记忆时按 memory-guide 指引加 `pinned: true`（凭据/密钥/关键配置）。

**只看 lastUsedAt 不看 createdAt**：从未召回的记忆不判候选（防 `LICODE_MEMORY_RECALL=off` 时全量误归档）；从未召回的垃圾交 Phase 3 内容审查 delete。

#### 2.4.2 归档存储 + 恢复

`archive(slug)`：`<type>/<slug>.md` -> `archive/<type>/<slug>.md`（rename）。`archive/` 非 type 目录，`listAll`/`rebuildIndex`/`hasChangesSince` 不扫。归档后 Prune 的 `rebuildIndex` 自动让它从 MEMORY.md / recall 候选消失。`listArchived()` 列归档；`restore(slug)` 移回 + `rebuildIndex`。

#### 2.4.3 archive vs delete（两条独立维度）

| | delete（Phase 3） | archive（Phase 4） |
|---|---|---|
| 维度 | 内容（失效/重复/矛盾） | 热度（长期未用） |
| 决策者 | LLM（Consolidate） | 程序规则（自动） |
| 落点 | `.dream-backup/`（手动捞回） | `archive/`（`/memory-restore` 一键） |
| 优先级 | delete 优先：候选若被 LLM delete，不再归档 | - |

### 2.5 Dream Consolidate 扩展：规则驱动归档 + 通知

不新增 Dream 阶段，归档作 Consolidate 的收尾步骤。**LLM 只做内容维度（create/update/append/delete），归档是程序规则。**

`consolidate()` 返回归档 slugs（供通知）：

```ts
protected async consolidate(store, suspicions, evidence): Promise<string[]> {
  const all = await store.listAll();
  const now = Date.now();
  const candidateSlugs = new Set(all.filter((m) => isArchiveCandidate(m, now, this.archiveThresholdMs)).map((m) => m.slug));
  const prompt = this.buildConsolidatePrompt(index, all, suspicions, evidence, candidateSlugs, now);
  const response = await this.withTimeout(this.llm.chat({...}));
  const ops = this.parseDreamResponse(response.content, knownSlugs);  // delete/create/update/append，无 keep
  for (const op of ops) {
    if (op.action === "delete") await this.backupAndDelete(store, op.slug);
    else await store.save({...}, op.action);
  }
  // 规则驱动：候选中未被 delete 的 -> 自动归档（pinned 已在候选集外）
  const archived: string[] = [];
  for (const slug of candidateSlugs) {
    if (!(await store.load(slug))) continue;  // 已被 delete
    await store.archive(slug);
    archived.push(slug);
  }
  return archived;
}
```

`buildConsolidatePrompt` 的归档候选区块改为**信息性**（候选将自动归档，无需 LLM 输出 archive；若候选内容也失效可用 delete 优先；pinned 不在候选中）。action 枚举回到 `create|update|append|delete`（**无 keep、无 archive**）。

`dream()` 返回 `Promise<string[]>`（归档 slugs，失败返回 []）。

### 2.6 命令

| 命令 | 作用 |
|---|---|
| `/memory pin <slug>` | 设 `pinned: true`（永不归档） |
| `/memory unpin <slug>` | 取消 pinned |
| `/memory archive` | 列出已归档记忆 |
| `/memory restore <slug>` | 从归档恢复到活跃集 |
| （既有）`/memory list\|add\|delete` | 不变 |

### 2.7 归档通知

`createMemoryDreamHook` 加 `onArchived?: (slugs: string[]) => void`。Dream 完成且归档非空时调用。CLI 的 `onArchived` 把 slugs 格式化成 `archivedNotice` state：

```
🌙 记忆整理完成：已归档 1 条 [reference/old-board]，可用 /memory-restore <slug> 恢复
```

`app.tsx` 在 dream indicator 区下方渲染黄字 banner；`handleSubmit` 开头清空（下次提问即消失）。**安全网**：即使漏 pin 被归档，用户也看得见 + 一键恢复。

### 2.8 错误处理

| 场景 | 行为 |
|---|---|
| `recordUsage` 文件不存在/IO 失败/utimes 失败 | 静默吞掉；utimes 失败最坏下轮提取误跳一次，自愈 |
| 主 Agent 本轮直接 Write 同一被召回记忆 | 覆盖 frontmatter（不带 usage）-> usage 重置；罕见，Phase 1 同类折衷 |
| 归档候选为空 | 无归档，通知不出 |
| LLM delete 了某候选 | 该候选不再归档（delete 优先） |
| LLM 失败/Consolidate 抛错 | `dream()` catch，不更新 `lastConsolidatedAt`，无归档，下次重试 |
| Dream 期间 recall 计数 | 让位（不计数），注入照常 |
| pinned 记忆 | 永不进候选，永不归档（硬条件） |
| `restore`/`pin` 的 slug 不存在 | 命令返回"未找到" |

### 2.9 测试

| 测试 | 断言 |
|---|---|
| `parse` usage+pinned | 有字段读出；缺 -> 0/""/false |
| `save` update 保留 usage+pinned | update 改内容 -> usageCount/pinned 不变 |
| `recordUsage` mtime 隐身 | 记录后 mtime 不变；`hasChangesSince(记录前 ts)` false（坑回归） |
| `archive`/`listArchived`/`restore` | 移动、列出、移回+回索引 |
| `setPinned` | 设/取消 pinned；pinned 持久化 |
| recall handler 计数/让位/best-effort | select 非空调 recordUsage；dreaming 不调、仍注入；throw 不阻断 |
| Dream 规则归档 | 候选（35d）LLM 返回 `[]` -> 自动归档；`dream()` 返回归档 slugs |
| Dream pinned 不归档 | pinned 候选 -> 不归档、返回 [] |
| Dream delete 优先 | 候选被 LLM delete -> 进 .dream-backup、不进 archive |
| Dream 候选为空/never-recalled | 无归档 |
| `isArchiveCandidate` | never-used 非候选；stale 是候选；pinned 非候选 |
| `/memory pin`/`unpin`/`restore`/`archive` 命令 | 各路径 |
| 回归 | 现有 memory/dream/recall/hook 测试全过 |

---

## 3. 配置

| 项 | 值 |
|---|---|
| 归档阈值 | `archiveThresholdMs` 默认 30d（可注入，测试用） |
| 计数 | 无 LLM（`recordUsage` 纯程序） |
| 归档决策 | 规则驱动（程序），非 LLM |
| pinned 保护 | 硬条件（`isArchiveCandidate` 排除） |
| recall 开关 | `LICODE_MEMORY_RECALL=off` -> 不计数 -> 无候选 -> 不归档 |
| Dream 开关 | `LICODE_MEMORY_DREAM=off` -> 不整理 -> 不归档（计数仍随 recall） |
| 归档目录 | `.licode/memory/archive/<type>/` |
| 通知 | Dream 归档后 TUI 黄字 banner（`archivedNotice`） |

---

## 4. 验证方式（Phase 4 验收标准，已通过）

1. 问命中记忆的问题 -> 该记忆 `usageCount`+1、`lastUsedAt`=今天
2. 紧接问无关问题 -> 提取正常执行（未被"主 Agent 已写"误跳；mtime 隐身）
3. `reset-dream` + 触发 Dream -> old-board（35d 未用、未 pinned）自动归档；出现"已归档"通知
4. never-recalled（lastUsedAt 空）-> 不被归档
5. important-but-unused（pinned）-> **确定性不归档**（硬条件）；只有 old-board 进 archive/
6. `/memory archive` 列归档；`/memory restore` 恢复
7. `/memory pin`/`unpin` 设/取消 pinned
8. `LICODE_MEMORY_RECALL=off` -> 不计数；无候选不归档
9. `LICODE_MEMORY_DREAM=off` -> 不归档；计数仍工作
10. Dream 期间召回 -> 注入照常、不计数（让位）
11. Dream 失败 -> 不归档、不更新 state（单测覆盖，手动难测）
12. 全部测试通过

---

## 5. 设计决策记录

| 决策 | 选择 | 原因 |
|---|---|---|
| usage 存储 | frontmatter `usageCount`/`lastUsedAt` | spec §6.3 + Codex 对齐；与记忆同址、随文件移动、Dream 直接读；否决 sidecar |
| 计数与提取的 mtime 冲突 | `recordUsage` 写后 `utimes` 恢复 mtime | Phase 2/3 预注的坑；局部对症，使计数对 `hasChangesSince` 隐身 |
| 计数与 Dream 的写写竞态 | recordUsage 让位给 Dream | 与 Phase 3 让位同原则；只让位写、不让位 recall 读 |
| 归档决策 | **规则驱动自动归档**（>30d 未用即归档） | spec §6.3 原意；可恢复、低风险，应确定性执行；否决"LLM 显式 archive"（实测 LLM 过激/过保守，archive 不触发） |
| "重要性"保护 | **pinned 硬标记**（非 LLM 判断） | 重要性无法从内容/用法自动推断（验收证实 LLM 判不准凭据）；明确意图是唯一可靠信号；否决"LLM keep 否决"（判据与归档可恢复矛盾，判不准） |
| 归档通知 | Dream 完成后 TUI 黄字 banner | 安全网：漏 pin 被归档也看得见 + 一键恢复；解决"忘了收哪了" |
| delete 优先于归档 | 候选被 LLM delete -> 不再归档 | 内容维度优先于热度；失效的该删不该归档 |
| archive vs delete | 两个独立维度/动作 | 内容 vs 热度；archive 可恢复、delete 不可逆 |
| 归档候选口径 | 只看 lastUsedAt 非空且 >30d，不看 createdAt | 防 recall 关闭时全量误归档 |
| Dream 阶段结构 | 不新增阶段，归档作 Consolidate 收尾 | 四阶段骨架已就绪；零额外 LLM 调用 |
| 恢复路径 | `/memory-restore` 命令 | 可恢复用户可见；复用既有路由 |

---

## 6. 记忆系统四阶段闭环总结

Phase 4 闭合最后一块，四阶段形成完整生命周期：

| 阶段 | 能力 | 关键机制 |
|---|---|---|
| P1 生产 | 双路径写入 + 矛盾解决 | action 语义 / 冷却门槛 / 提取 prompt 携带旧正文 |
| P2 召回 | 正文进上下文 | side query 合成 tool_call 对 / 每轮换新 |
| P3 整理 | 去重/漂移/矛盾收敛 | Dream 四阶段 / delete 备份 |
| **P4 反馈** | **热度追踪 + 遗忘 + 硬保护 + 通知** | **注入即计数（mtime 隐身 + Dream 让位）/ 规则驱动归档 / pinned 硬保护 / 归档通知 / 可恢复** |

闭环特性：有进有出（P1/P2 生产+注入，P4 计数，P3 整理+P4 归档控规模）；pinned 硬保护 + 通知双保险（重要的不进柜子，进了也看得见）；可恢复（archive/ 与 .dream-backup/ 双退路）；不阻塞（计数热路径噪声级，归档 Dream 后台）；不动 RAG（文件系统 LLM Wiki）；逃生通道（`LICODE_MEMORY_RECALL=off` / `LICODE_MEMORY_DREAM=off`）。

---

## 7. 参考

- [记忆系统重构设计](./2026-07-27-memory-system-redesign-design.md) §6.3（Phase 4 蓝图）
- [Phase 2 详细设计](./2026-07-28-memory-phase2-design.md) §6（计数埋点 + mtime 坑预注）
- [Phase 3 详细设计](./2026-07-29-memory-phase3-design.md) §6（Dream Consolidate 扩展预注、Phase 边界）
- 知乎文章《Claude Code 的 Memory》：https://zhuanlan.zhihu.com/p/2062191639829935034--Codex usage_count/last_usage + 30 天热度遗忘蓝本

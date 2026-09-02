# LICode 记忆测试集方法论文档 v2

> 日期：2026-09-02
> 范围：记忆测试集 v2 —— 共享数据 + 双路径评测框架（RAG 检索层 vs v1 工具召回跑同一份数据）
> 数据与脚本：本目录下 `seed-memories.json`（91 条）、`cases.json`（55 条）、`run.ts` + `lib/` + `adapters/`（新框架）、`results/*.json`（结果存档）
> 前身：`A-B-test-v1.md`（v1 召回链路 A/B 测试，同目录）

---

## 1. 目标与定位

### 1.1 检索层为主、端到端为辅

v1 测试（`A-B-test-v1.md`）测的是**真实召回链路的 A/B**——`memory_recall` 工具召回 vs 旧 side-query 注入，用例与指标耦合"LLM 行为"（是否调工具、选哪些）。RAG 方向已定（检索器可插拔、向量初筛 + LLM 终审），但代码中**尚无确定性检索器**——这是一个全新组件，需要先单独量化它的排序质量，才能支撑调参。

因此 v2 的评测分两层：

| 层 | 测什么 | 指标 | 路径 |
|---|---|---|---|
| **检索层（主）** | RAG 检索器从大库捞准的能力 | recall@k / precision@k / MRR（IR 标准指标） | `rag-keyword` / `rag-retriever` |
| **端到端（辅）** | v1 真实召回链路的对照 | recallA / triggerRateB / falsePositiveB / precision / fabricateD（v1 行为指标） | `v1-tool` |

先验证检索是否准确，再验证增强生成效果；两条路径**共享同一份测试数据**、**同一把尺子量**。

### 1.2 与 v1 的关系

| | v1（A-B-test-v1.md） | v2（本文档） |
|---|---|---|
| 对象 | 旧 side-query vs 新 memory_recall 工具 | RAG 检索器 vs v1 工具召回 |
| 数据 | 21 种子 / 29 用例 + 2 多轮会话 | **原样保留** 21 种子 / 29 用例 + 新增扩展集（共 91 种子 / 55 用例） |
| 指标 | 行为指标 + 跨轮缓存命中率 | 检索层 IR 指标（主）+ v1 行为指标（辅） |
| 框架 | 单脚本 `eval-recall.ts` / `eval-recall-baseline.ts` | 可插拔 `Recaller` 接口 + 统一 runner |

核心集 21 种子 / 29 用例**原样保留、不改动**，保证与 v1 历史结果直接可比；扩展集在现有字段上追加（不破坏 v1 兼容），专为检索层"从大库捞准"的区分度服务。

---

## 2. 数据构成

### 2.1 seed-memories.json：91 条（21 核心 + 70 扩展）

| 集合 | 数量 | 标记 | 内容 |
|---|---|---|---|
| **核心集** | 21 | 无 `set` 字段（框架默认按 `core` 处理） | 原 v1 的 20 条 + v1 §10.7 新增的 `user/gym-membership`（健身房年卡），全部原样保留 |
| **扩展集** | 70 | `set: "extended"` | 分域干扰项 / 长段落 / 相似对 / 冲突对，见 §2.2 |

> 核心集条目不额外打 `set: "core"` 标签——按 surgical 原则（plan 全局约束）不动 core 条目，缺省即核心；`lib/eval-runner.ts` 对用例用 `set ?? "core"` 兜底，`lib/recaller.ts` 的类型允许 `set?: "core" | "extended"`。核心集 21 条类型分布：user 10 / feedback 4 / project 3 / reference 4。

### 2.2 扩展集 5 个方向（70 条 = 48 + 7 + 8 + 7）

| 方向 | 数量 | 说明 |
|---|---|---|
| **分域干扰项** | 48 | 12 个日常生活域 × 每域 4 条，纯垫库不挂用例，撑大记忆库以测"从大库捞准" |
| **长段落记忆** | 7 | 多段落"累积型"记忆（如 `project/migration-journey`、`project/ci-pipeline-history`、`user/xinjiang-roadtrip-2025`），测段落分块 + 归并 |
| **相似记忆对** | 8 | 4 对内容高度相似但语义不同的记忆，测区分度 |
| **时间状态冲突对** | 7 | 4 条旧记忆带 `conflictsWith` 指向新态 + 3 条新态记忆，测"取当前状态" |
| 合计 | 70 | |

**12 个分域**（`domain` 标签）：工作项目 `work` / 健康饮食 `health-diet` / 家庭亲友 `family` / 社交关系 `social` / 出行旅行 `travel` / 财务理财 `finance` / 学习技术 `learning-tech` / 娱乐爱好 `hobby` / 家居生活 `home` / 购物消费 `shopping` / 宠物 `pet` / 个人信息 `personal-info`。

**相似记忆对（4 对）**——个人事实 vs 通用建议共享关键词，检索器必须靠语义区分：

| 个人记忆 | 通用/参考记忆 |
|---|---|
| `user/fitness-personal-tips`（我自己的训练计划） | `reference/fitness-general-tips`（新手健身建议） |
| `user/coffee-habit`（我自己喝咖啡的习惯） | `reference/coffee-research`（咖啡健康研究） |
| `user/photo-style`（我个人摄影偏好） | `reference/photo-composition-tips`（通用构图技巧） |
| `user/investment-portfolio`（我个人投资配置） | `reference/investment-basics`（投资理财基础） |

**时间状态冲突对（4 组 `conflictsWith` 关系）**：

| 旧记忆（带 `conflictsWith`） | 新记忆（当前态） |
|---|---|
| `user/tech-stack-langchain` | `project/migration-journey` |
| `user/flight-chengdu-old` | `user/flight-chengdu-new` |
| `user/tv-model-old` | `user/tv-model-new` |
| `user/office-location-old` | `user/office-location-new` |

> 冲突对 7 条 = 4 条旧 + 3 条新（`flight-chengdu-new` / `tv-model-new` / `office-location-new`）；第 4 条新态 `project/migration-journey` 同时是长段落记忆，归入长段落桶计数一次。

### 2.3 cases.json：55 条（29 核心 + 26 扩展）

**核心 29 条**（沿用 v1，原样保留）：

| 组 | 数量 | 语义 |
|---|---|---|
| A | 11 | 应召回（`expectRecall: true`） |
| B | 8 | 不应召回（`expectRecall: false`，语义陷阱 / 纯技术） |
| C | 6 | 探索性（`expectRecall: null`，只记录不判分） |
| D | 4 | 对抗·防幻觉弃权（`expectRecall: false`） |

**扩展 26 条**（全部 `set: "extended"`、`group: "A"`、`expectRecall: true`、`k: 5`），按 `dimensions` 分 5 个维度：

| 维度 | 数量 | 用例 id | 测什么 |
|---|---|---|---|
| `semantic-robustness` | 10 | r1–r10 | 核心查询的同义改写 / 口语化 / 中英混合，expectedSlugs 与核心对应用例相同 |
| `time-conflict` | 4 | tc1–tc4 | 冲突对上的"当前态"查询，expectedSlugs 只标新态 |
| `similar-pair` | 4 | sp1–sp4 | 相似对上的唯一命中查询，expectedSlugs 只标其一 |
| `long-memory` | 3 | lm1–lm3 | 长段落记忆的整条召回 |
| `single-hop` | 5 | dmn1–dmn5 | 分域记忆的单跳直接检索（域抽查） |

### 2.4 维度标签词汇表

`dimensions` 取值（沿用 v1 的 LoCoMo 映射 + RAG 特有维度，见 spec §3.3）：

| 维度 | 说明 | 用例示例 |
|---|---|---|
| `single-hop` | 单跳·直接检索 | a1 宵夜吃什么 |
| `knowledge-update` | 时序·知识更新（新旧并存取当前态） | a6/a7 |
| `multi-hop` | 一次查询需命中多条记忆 | a8 |
| `anaphora` | 隐指/代词消解 | a9 / 多轮 t11 |
| `personal-detail` | 个人细节（敏感信息） | a10 |
| `relation` | 人员/关系/分工 | a11 |
| `pure-tech` | 纯技术·无状态（不应召回） | b1–b4 |
| `semantic-trap` | 语义陷阱·关键词撞车 | b5–b8 |
| `adversarial` | 对抗·防幻觉弃权 | d1–d4 |
| `semantic-robustness` | 语义鲁棒性（同义/口语/中英混） | 扩展 r1–r10 |
| `similar-pair` | 相似记忆对·区分度 | 扩展 sp1–sp4 |
| `long-memory` | 长段落记忆·分块 | 扩展 lm1–lm3 |
| `time-conflict` | 时间状态冲突·新旧冲突取当前态 | 扩展 tc1–tc4 |
| `exploratory` | 探索性（C 组，不计分） | c1–c6 |

### 2.5 时间/状态冲突的评分语义

- 查询当前态时，`expectedSlugs` **只标当前记忆（新态）**。
- 旧记忆靠语义撞车自然进候选，但**不算 hit、precision 照扣**——天然惩罚"旧记忆排新记忆前面"。
- 旧记忆带 `conflictsWith: "<新slug>"` 标注，评测报告可据此区分"召回了过时但相关的记忆"（排位问题）vs"召回了无关记忆"（真误）。
- 一个纯关键词检索器（如 `rag-keyword`）仍会把旧记忆顶进候选（新旧共享关键词），这正是它度量"基线检索器的 recency 盲区"的方式。
- 数据自检（`lib/validate.ts`）强制：`time-conflict` 用例若期望了被 `conflictsWith` 标注的替代记忆 → **直接报错**；`similar-pair` 用例 `expectedSlugs.length` 必须等于 1。

---

## 3. 评测框架

### 3.1 Recaller 接口

```ts
// lib/recaller.ts
interface RecallCandidate { slug: string; score: number }   // 已按相关度降序

interface RecallResult {
  candidates: RecallCandidate[];
  triggered?: boolean;   // v1：主模型是否调了工具（RAG 恒 true）
}

interface Recaller {
  readonly kind: "v1-tool" | "rag-keyword" | "rag-retriever";
  retrieve(query: string, opts: { keywords?: string[]; topK: number }): Promise<RecallResult>;
}

const DEFAULT_K = 5;
```

接口对齐 RAG 文档"输入问题 + 关键词 → 输出记忆 id 列表"的约定。任何实现只要满足该接口就能插进 runner 同尺对比。

### 3.2 三个适配器

| 适配器 | 实现 | 定位 |
|---|---|---|
| `adapters/rag-keyword.ts` | 关键词重叠打分：query 分词（拉丁词 + CJK 单字 + 相邻双字）vs 记忆 name/keywords/description/content 各字段 token 计数，加权求和（keywords×3、name×3、description×2、content×1），降序取 top-k | **确定性基线**，无需 API key，向量落地前先用它跑通评测 |
| `adapters/rag-retriever.ts` | 向量 + 关键词混合的**骨架**：当前委托给 `rag-keyword`，向量 embedding 接入点留好（`TODO(vector)`） | 后续接向量 |
| `adapters/recall-tool.ts` | 包装真实链路：主模型触发 `memory_recall` → 子代理 `recall-agent` 选摘；**复用 `eval-recall.ts` 单轮简化逻辑**（只取第一次 `collectResponse` 的 tool-use，不跑完整 agentic 循环） | v1 对照基线，需 LLM 凭证 |

`run.ts --recaller=` 的取值与适配器文件名一致：`v1-tool` / `rag-keyword` / `rag-retriever`。

### 3.3 统一 runner

```
读 seed-memories.json → 写临时 MemoryStore（frontmatter 固定 createdAt/updatedAt）
  → 数据自检（assertValidDataset，不过直接报错退出）
  → 逐条跑 cases.json：recaller.retrieve(query, { topK: case.k })
  → 按路径算指标 → 汇总表 + results/*.json
```

- `lib/eval-runner.ts`：`runEvaluation()` 逐条检索，切 top-k、算 per-case `hit`，再分别调 RAG 指标（`metrics.ts`）与行为指标（`computeBehaviorMetrics`）。
- 单条用例检索异常 → 记为 `failed`、跳过不拖垮整轮；汇总单列失败数。
- `lib/validate.ts` 自检项：每个 `expectedSlugs` 必须存在于种子；`k ≥ expectedSlugs.length`；`set` 取值合法；`conflictsWith` 目标必须存在；`time-conflict` 不得期望被替代记忆；`similar-pair` 期望必须唯一。

---

## 4. 指标口径

### 4.1 RAG 检索层指标（`lib/metrics.ts`，逐条按自己的 k，再对所有 valid 用例取平均）

| 指标 | 计算 | 说明 |
|---|---|---|
| **recall@k** | `期望 ⊆ top-k 候选 ? 1 : 0` | 多期望时**全部**命中才算 1；期望为空或 k≤0 → 0 |
| **precision@k** | `|top-k ∩ 期望| ÷ k` | 候选池里真正相关的比例；候选为空 → 0 |
| **MRR** | `1 ÷ 第一个期望 slug 的排名` | 只认期望的排名，旧记忆排前面**不得分**；未命中或期望为空 → 0 |

B/D 组（`expectedSlugs` 为空）按定义恒为 0，与 A/C/扩展用例一并计入平均。

### 4.2 v1 行为指标（`lib/metrics.ts` `computeBehaviorMetrics`，分组口径，与 A-B-test-v1.md §3.4 一致）

| 指标 | 定义 | 说明 |
|---|---|---|
| **recallA** | A 组中 `expectedSlugs ⊆ candidates` 的比例 | 该召回时是否召回了（正确 + 可能多余） |
| **triggerRateB** | B 组中 `triggered === true` 的比例（含空触发） | 不该召回时是否触发了工具调用（成本信号） |
| **falsePositiveB** | B 组中 `candidates.length > 0` 的比例 | 不该召回时是否真的注入了无关记忆；空触发不算误召回 |
| **precision** | 全局跨用例 `totalCorrect ÷ totalSelected`；`totalCorrect` = 选中 slug 出现在**任一**用例 expectedSlugs 里的次数；`totalSelected=0` → 1 | 全局口径，偏乐观（已知限制） |
| **fabricateD** | D 组中 `candidates.length > 0` 的比例 | 记忆不存在时是否"联想"出无关记忆 |
| C 组 | 只记录不判分（`expectRecall: null`） | 探索性用例 |

> `precision` 的全局口径有个细节：B 组选中某条 A 组的期望 slug，对 precision 算"正确"（在全局 expected 并集里），对 falsePositiveB 仍算误召回。扩展用例统一标 `group: "A"`，故 v1 路径跑全量时 `recallA` 的分母为 11 核心 A + 26 扩展 = 37。

### 4.3 冲突对 / 相似对在指标体系里的表现

- **冲突对（`time-conflict`）**：期望只标新态 → 旧记忆进 top-k 但不在期望 → `precision@k` 自动扣分、`MRR` 不给分。配合 `conflictsWith` 标注，报告可区分"过时但相关"（排位问题，应在新态之后）vs"纯无关"（真误）。
- **相似对（`similar-pair`）**：`expectedSlugs` 强制唯一命中其一；`MRR` 奖励正确那条排得靠前。`rag-keyword` 对共享关键词的相似对（如"个人健身安排" vs "健身通用建议"都含"健身/训练"）区分度差——两者会并排进候选，这正是这套用例要量化的 RAG 区分度缺口。

---

## 5. 运行方式

### 5.1 命令

```bash
# RAG 关键词基线（确定性，无需 API key，秒级）
pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=rag-keyword

# RAG 混合检索器骨架（当前委托关键词基线）
pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=rag-retriever

# v1 工具召回对照（需凭证）
pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=v1-tool
```

- `--recaller=` 取 `v1-tool` / `rag-keyword` / `rag-retriever`，缺省 `rag-keyword`。
- `v1-tool` 需要 `ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY`（二者任一）；`rag-keyword` / `rag-retriever` 无需凭证。
- `EVAL_MODEL` 环境变量可覆盖模型（默认 `kimi-k3`，与 `eval-recall.ts` 一致）。
- 温度**强制 0**：`run.ts` 用 `ZeroTempProvider` 包装 provider，对 chat/stream 一律覆写 `temperature: 0`。

### 5.2 可复现性

| 项 | 值 |
|---|---|
| 温度 | 强制 0（`ZeroTempProvider`） |
| 种子写入 | `writeSeedMemory` 固定 `createdAt/updatedAt = 2026-08-01` |
| RAG 路径 | 确定性：同输入同输出（`rag-keyword` 纯分词打分），跑 1 次 |
| v1 路径 | 非确定性（LLM 决策），沿用 v1 口径默认跑 2 次取范围 |

### 5.3 结果文件

每次运行写入 `results/results-<kind>-<时间戳>.json`（时间戳格式 `YYYY-MM-DD-HH-MM-SS`）。文件结构：`{ model, kind, seeds, cases, summary }`，其中 `summary.perCase` 含逐条用例的 `id/group/set/dimensions/expectedSlugs/k/candidates/triggered/hit/failed`，`summary.rag` 与 `summary.behavior` 为两组汇总指标。首批对比结果由后续任务产出（本文档不落结果表）。

---

## 6. 历史链接

- **v1 方法论文档**：`A-B-test-v1.md`（同目录）—— v1 召回链路 A/B 测试（memory_recall 工具 vs side-query 注入），21 种子 / 29 用例与行为指标口径的出处。
- **设计 spec**：`docs/superpowers/specs/2026-08-25-memory-test-suite-design.md`——共享数据 + 双路径评测框架的设计决策（检索层为主、可插拔 Recaller、指标语义、数据自检）。
- **实施计划**：`docs/superpowers/plans/2026-08-25-memory-test-suite.md`——13 个任务的分步实施计划（本框架代码与数据的落地依据）。

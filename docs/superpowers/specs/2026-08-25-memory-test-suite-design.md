# 记忆测试集设计：共享数据 + 双路径评测框架

> **日期**：2026-08-25
> **状态**：已批准（brainstorming 产出）
> **前置文档**：[记忆召回 A/B 测试 v1](../../../packages/core/scripts/eval-recall/A-B-test-v1.md)（v1 数据与方法论）、[RAG 记忆召回设计](../../rag-memory-recall-design.md)（RAG 方向：检索器可插拔、向量初筛 + LLM 终审）
> **核心目标**：为后续 RAG 记忆召回打基础——一套完整、可复用、双路径（v1 LLM 召回 / RAG 检索）同尺对比的记忆测试集与评测框架

---

## 1. 背景与动机

### 现状

- 已有 **v1 测试集**（`packages/core/scripts/eval-recall/`）：21 条种子记忆、29 条单轮用例（A/B/C/D 四组）、2 个多轮会话，指标为 recallA / triggerRateB / falsePositiveB / precision / fabricateD + 跨轮缓存命中率。
- v1 是为特定 A/B 对比造的（`memory_recall` 工具召回 vs 旧 side-query 注入），用例和指标耦合"LLM 行为"（是否调工具、选哪些）。
- RAG 方向已定（`docs/rag-memory-recall-design.md`）：检索器可插拔（输入问题+关键词 → 输出记忆 id）、向量初筛 + LLM 终审、分块按段落、增量同步。**代码中尚无"确定性检索器"**——RAG 检索器是全新组件。

### 差距

1. v1 测的是 LLM 行为，而 RAG 检索器是**确定性组件**，需要 IR 标准指标（recall@k / precision@k / MRR）才能量化排序质量、支撑调参。
2. v1 记忆库仅 21 条浓缩型记忆，测不出检索层"从大库捞准"的区分度。
3. 缺 RAG 特有维度的用例（分块、语义鲁棒性、相似记忆对、时间状态冲突）。

### 目标

- 设计**完整的记忆测试集**（数据 + 标注 + 评测框架），作为 RAG 召回的地基。
- **先验证 RAG 召回是否准确（检索层），再验证增强生成效果（端到端）**。
- v1 LLM 召回 与 RAG 检索 **两条并行路径**，共享同一份测试数据，同一把尺子量。

---

## 2. 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 评测层 | **检索层为主，端到端为辅** |
| 指标 | **top-k + IR 指标**（recall@k / precision@k / MRR） |
| 架构 | **v1 LLM 召回 与 RAG 检索两条并行路径**，共享测试数据 |
| 数据 | **21 条核心保留不动**（保证与 v1 历史可比）+ **扩展集**（分域干扰项 / 长段落记忆 / 相似记忆对 / 语义鲁棒性 / 时间状态冲突） |
| 同步 | **第一版不含**索引同步动态评测，由单元测试兜底 |
| 框架 | **方案 A：统一评测框架 + 可插拔 Recaller 接口** |
| recall-tool | 复用 `eval-recall.ts` 的**单轮简化逻辑**（只取第一次触发返回） |

---

## 3. 数据层设计

### 3.1 位置与目录

保留在 `packages/core/scripts/eval-recall/`，新框架代码放 `lib/` 与 `adapters/` 子目录，**现有脚本不删不改**（surgical 原则）：

```
packages/core/scripts/eval-recall/
  seed-memories.json        # 记忆库：21 核心（不动）+ 扩展记忆
  cases.json                # 单轮用例：29 核心（不动）+ 扩展用例
  scenarios.json            # 多轮会话（v1 端到端沿用，本期不扩展）
  A-B-test-v1.md            # 历史方法论文档（保留）
  eval-recall-v2.md         # 新方法论文档（指标口径、扩展集设计说明）
  lib/                      # 评测框架（新）
    recaller.ts             # Recaller 接口
    eval-runner.ts          # 统一评测执行
    metrics.ts              # recall@k / precision@k / MRR / 行为指标
  adapters/                 # 两条路径的适配器（新）
    recall-tool.ts          # v1 适配器：包装现有 memory_recall 链路（单轮简化）
    rag-keyword.ts          # RAG 关键词基线检索器（确定性）
    rag-retriever.ts        # RAG 混合检索器（接口 + 骨架，向量后续接）
  results/                  # 结果存档
```

### 3.2 核心集

21 条种子记忆 / 29 条用例**原样保留**，全部标 `set: "core"`。保证与 v1 历史结果直接可比。

### 3.3 用例标注格式扩展

在现有字段上加，不破坏 v1 兼容：

```jsonc
{
  "id": "a1",
  "query": "宵夜吃什么好？",
  "group": "A",                      // A=应召回 B=不应 C=探索 D=对抗（沿用）
  "expectedSlugs": ["user/food-preferences"],
  "set": "core",                     // core | extended
  "dimensions": ["single-hop"],      // LoCoMo + RAG 维度标签
  "k": 5                             // 该用例评测的 top-k（默认 5）
}
```

**维度标签词汇表**（`dimensions` 取值，沿用 v1 的 LoCoMo 映射 + RAG 特有维度）：

| 维度 | 说明 | 用例示例 |
|---|---|---|
| `single-hop` | 单跳·直接检索 | a1 宵夜吃什么 |
| `knowledge-update` | 时序·知识更新（新旧并存取当前态） | a6/a7 |
| `multi-hop` | 一次查询需命中多条记忆 | a8 |
| `anaphora` | 隐指/代词消解 | a9 / 多轮 t11 |
| `personal-detail` | 个人细节（敏感信息） | a10 |
| `relation` | 人员/关系/分工 | a11 |
| `pure-tech` | 纯技术·无状态（不应召回） | b1-b4 |
| `semantic-trap` | 语义陷阱·关键词撞车 | b5-b8 |
| `adversarial` | 对抗·防幻觉弃权 | d1-d4 |
| `semantic-robustness` | 语义鲁棒性（同义/口语/中英混） | 扩展集 |
| `similar-pair` | 相似记忆对·区分度 | 扩展集 |
| `long-memory` | 长段落记忆·分块 | 扩展集 |
| `time-conflict` | 时间状态冲突·新旧冲突取当前态 | 扩展集 |
| `exploratory` | 探索性（C 组，不计分） | c1-c6 |

**扩展记忆格式**：与 core 种子同一 JSON schema（slug/name/description/type/keywords/content），另加 `set: "extended"` 与 `domain`（分域标签，取自 §3.4 域列表）。

### 3.4 扩展集设计（5 个方向）

**分域覆盖要求：记忆涉及日常生活的方方面面，不局限于技术/项目域。** 域列表（每域 2-4 条干扰项，纯垫库不挂用例）：

工作项目 / 健康饮食 / 家庭亲友 / 社交关系 / 出行旅行 / 财务理财 / 学习技术 / 娱乐爱好 / 家居生活 / 购物消费 / 宠物 / 个人信息

| 方向 | 数据形态 | 规模（约） | 标注要点 |
|---|---|---|---|
| 分域干扰项 | 每域 2-4 条相关记忆，覆盖日常生活全谱系 | 40-60 条 | 干扰项不挂用例，纯垫库 |
| 长段落记忆 | 几百字多段落"累积型"记忆（段落式，模拟真实累积） | 5-8 条 | 测段落分块 + 归并回记忆 |
| 相似记忆对 | 内容高度相似但语义不同的记忆对 | 3-4 对 | expected 唯一命中其一 |
| 语义鲁棒性 | 同义改写 / 口语化 / 中英混合的查询 | 8-10 条 | 与 core 用例配对，expected 相同 |
| 时间状态冲突 | old/new 记忆对（如 LangChain→自研 agent runtime） | 3-4 对 | expected 只标当前态；旧记忆带 `conflictsWith` |

全库规模约 **80-100 条**。

### 3.5 时间/状态冲突的评分语义

- 查询当前态时，`expectedSlugs` **只标当前记忆**（新态）。
- 旧记忆靠语义撞车自然进候选，但**不算 hit、precision 照扣**——天然惩罚"旧记忆排新记忆前面"。
- 旧记忆带 `conflictsWith: "<新slug>"` 标注，评测报告可区分"召回了过时但相关的记忆"（排位问题）vs"召回了无关记忆"（真误）。

---

## 4. 评测框架

### 4.1 Recaller 接口（对齐 RAG 文档"输入问题+关键词→输出记忆id列表"）

```ts
// lib/recaller.ts
interface RecallCandidate {
  slug: string;
  score: number;          // 相关度分数，已排序
}

interface RecallResult {
  candidates: RecallCandidate[];  // 已按相关度降序
  triggered?: boolean;            // v1：主模型是否调了工具（RAG 恒 true）
}

interface Recaller {
  readonly kind: "v1-tool" | "rag-keyword" | "rag-retriever";
  retrieve(query: string, opts: { keywords?: string[]; topK: number }): Promise<RecallResult>;
}
```

### 4.2 三个适配器

| 适配器 | 实现 | 性质 |
|---|---|---|
| `rag-keyword.ts` | 关键词重叠打分（query 分词 vs 记忆 name/desc/keywords/content），现有 rich-index 数据就能算 | **确定性基线**，向量落地前先用它跑通评测 |
| `rag-retriever.ts` | 向量 + 关键词混合（接口 + 骨架，embedding 接入点留好） | 后续接向量 |
| `recall-tool.ts` | 包装现有链路：主模型触发 `memory_recall` → 子代理选摘；**复用 `eval-recall.ts` 单轮简化逻辑**（只取第一次 tool-use 触发，不跑完整 agentic 循环） | v1 对照基线 |

> `run.ts --recaller` 的值与适配器文件名一致：`v1-tool` / `rag-keyword` / `rag-retriever`。

### 4.3 统一 runner

```
读 seed-memories.json → 写临时 MemoryStore → 数据自检 → 逐条跑 cases.json
  → recaller.retrieve(query, {topK: case.k})
  → 按路径算指标 → 汇总表 + results/*.json
```

```bash
pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=rag-keyword
pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=rag-retriever
pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=v1-tool
```

---

## 5. 指标与评分语义

### 5.1 RAG 路径（每条用例按自己的 k）

| 指标 | 计算 | 说明 |
|---|---|---|
| recall@k | 期望 ⊆ top-k 候选？1/0 | 多期望时**全部**命中才算 |
| precision@k | \|top-k ∩ 期望\| ÷ k | 候选池里真正相关的比例 |
| MRR | 1 ÷ 第一个期望 slug 的排名 | 只认期望的排名；旧记忆排前面**不得分** |

时间冲突对在指标里天然生效：期望只标当前态 → 旧记忆进 top-k 但不在期望 → precision 自动扣分、MRR 不给分。报告按 `conflictsWith` 区分"过时相关"vs"纯无关"。

### 5.2 v1 路径（沿用 v1 口径）

recallA / triggerRateB / falsePositiveB / fabricateD / precision，与 A-B-test-v1.md §3.4 定义一致。

---

## 6. 数据自检、错误处理、可复现性

### 6.1 数据自检（跑评测前，呼应 RAG 文档"先查数据对不对"）

- 每个 `expectedSlugs` 必须存在于 seed-memories.json（防标注写错）
- 冲突对的 expected 必须是当前态；相似记忆对 expected 必须唯一命中其一
- 每条用例 `k ≥ expectedSlugs.length`（否则不可能召回全）
- 校验不过 → **直接报错退出**，不进评测

### 6.2 错误处理

- 单条用例检索异常 → 记为 fail、跳过，不拖垮整轮；汇总单列失败数
- v1 非确定性 → 默认跑 2 次取范围（沿用 v1 口径）；RAG 确定性路径跑 1 次
- 空检索（candidates=[]）正常计入（recall=0 / precision=0）

### 6.3 可复现性

- temperature=0（沿用 v1）
- 种子写入固定 createdAt/updatedAt（eval-recall.ts 已有做法）
- RAG 路径确定性：同一检索器同输入同输出

---

## 7. 交付范围与推进节奏

### 本期交付

1. 扩展测试集数据（seed/cases 扩展 + 维度/冲突标注 + 数据自检）
2. 评测框架 `lib/`（recaller / metrics / run）+ 三个适配器
3. `rag-keyword` 确定性基线跑通全库 + `v1-tool` 对照，产出**首批对比结果**
4. 框架单测（metrics 纯函数 + fake Recaller 跑 runner）
5. `eval-recall-v2.md` 方法论文档

### 明确后续（不在本期）

- `rag-hybrid` 向量接入（embedding 选型、索引同步、分块）
- 端到端增强生成效果评测（LLM 终审 + 回答质量 judge）
- 索引同步动态评测（由单元测试兜底）

---

## 8. 测试框架自身的测试

- `metrics.ts` 纯函数单测（recall@k / precision@k / MRR / 冲突对场景）
- fake Recaller 驱动 runner 单测（不调真实 LLM）
- 数据自检函数的单测（坏标注能被识别）

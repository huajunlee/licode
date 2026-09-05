# LICode 记忆召回 RAG 最小闭环评测（keyword / BM25 / hybrid）

> 日期：2026-09-05
> 范围：同一份数据（91 条种子记忆、55 条用例）上，对比三条检索曲线——关键词基线（`rag-keyword`）、纯 BM25（`lance-fts`）、BM25+向量+RRF 混合（`rag-retriever`）
> 数据与脚本：本目录下 `seed-memories.json`（91 条）、`cases.json`（55 条）、`run.ts --recaller=…`（三条曲线均为纯检索 + 指标计算，**无 LLM 调用**）、`results/results-*.json`（结果归档）
> 嵌入模型：`doubao-embedding-vision`（火山方舟 OpenAI 兼容端点）；LanceDB FTS 用 ICU 分词

---

## 1. 背景与目标

LICode 记忆召回此前走「主模型自主调用 `memory_recall` 工具」（模型驱动，A-B-test-v1 已测）。本闭环在评测侧引入 **LanceDB 确定性检索**，目标：

1. 用**纯检索器**（无模型决策、无工具调用）给出召回层本身的基线能力——关键词 vs BM25 vs 混合（向量+RRF）；
2. 三条曲线共用**同一份数据、同一指标**，可复现、确定性强（同配置重跑结果一致）；
3. 为「RAG 入口 `rag-retriever.ts` 接入真实对话侧」提供离线验收基准。

## 2. 检索器与数据

| 检索器 | `--recaller` | 实现 | 特性 |
|---|---|---|---|
| 关键词基线 | `rag-keyword` | `adapters/rag-keyword.ts` | 现有关键词召回，作为对照基线 |
| 纯 BM25 | `lance-fts` | `adapters/lancedb-fts.ts` + `lib/lance-index.ts` | LanceDB FTS（ICU 分词），无向量参与 |
| 混合·RRF | `rag-retriever` | `adapters/rag-retriever.ts` + `lib/lance-index.ts` | FTS + 向量 nearestTo 两路融合（LanceDB RRFReranker） |

- **种子记忆**：`seed-memories.json` 91 条（含核心集 + 扩展集：语义鲁棒性、时间冲突、相似对、长段、干扰域）。
- **用例**：`cases.json` 55 条，四组 A/B/C/D（A=应召回、B=不应召回、C=探索、D=对抗）。
- **嵌入缓存**：`results/embedding-cache.json`（sha256(model+NUL+text) → 向量），仅建索引时写入；重跑命中缓存不再调 API。

## 3. 指标定义

口径与 A-B-test-v1.md §3.4 一致：

| 指标 | 定义 |
|---|---|
| **recall@k** | `expectedSlugs ⊆ top-k` 的用例占比（RAG 检索口径，k=5） |
| **precision@k** | `\|top-k ∩ 期望\| ÷ k` 均值 |
| **MRR** | 第一个期望 slug 排名倒数均值 |
| **recallA** | A 组「应召回的记忆全部进入候选」占比 |
| **triggerB** | B 组触发召回（注入候选）占比（RAG 检索器恒触发） |
| **falsePosB** | B 组「候选非空（实际注入无关记忆）」占比 |
| **precision** | 全局选中 slug 中属于任一用例 `expectedSlugs` 的比例（v1 口径） |
| **fabricateD** | D 组「记忆不存在仍选中 ≥1 条」占比（对抗防幻觉） |

## 4. 执行环境

| 项 | 值 |
|---|---|
| 嵌入模型 | `doubao-embedding-vision`（`EMBEDDING_MODEL`，火山方舟 OpenAI 兼容端点） |
| 种子 / 用例 | 91 / 55，全部解析成功（`失败=0`） |
| 检索 top-k | 默认 5（`DEFAULT_K`） |
| 确定性 | `runEvaluation` 为纯检索 + 指标计算，无 LLM 调用；三条曲线重跑结果一致 |

复跑命令：

```bash
pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=rag-keyword
pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=lance-fts
pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=rag-retriever
```

> 注：`lance-fts` / `rag-retriever` 需要 `EMBEDDING_BASE_URL / EMBEDDING_API_KEY / EMBEDDING_MODEL` 三个环境变量（配置于 `~/.zshrc`）。

## 5. 三条曲线指标对比（doubao-embedding-vision，检索确定性）

| 指标 | rag-keyword（关键词基线） | lance-fts（BM25） | rag-retriever（混合·RRF） |
|---|---|---|---|
| **recall@k** | **70.9%** | 69.1% | **74.5%** |
| **precision@k** | 15.3% | 14.9% | **16.0%** |
| **MRR** | 0.595 | 0.602 | **0.640** |
| **recallA（A 组召回率）** | 94.6% | 94.6% | **100%** |
| **triggerB（B 组触发率）** | 100% | 100% | 100% |
| **falsePosB（B 组误召回率·注入）** | 100% | **87.5%** | 100% |
| **precision（选中准确率）** | 37.9% | **45.4%** | 42.5% |
| **fabricateD（D 组幻觉联想率）** | 100% | 100% | 100% |

### 5.1 打印的指标行（verbatim）

```text
[rag-keyword] 种子=91 用例=55 失败=0
  RAG 指标: recall@k=70.9%  precision@k=15.3%  MRR=0.595
  v1 行为指标: recallA=94.6%  triggerB=100.0%  falsePosB=100.0%  precision=37.9%  fabricateD=100.0%

[lance-fts] 种子=91 用例=55 失败=0
  RAG 指标: recall@k=69.1%  precision@k=14.9%  MRR=0.602
  v1 行为指标: recallA=94.6%  triggerB=100.0%  falsePosB=87.5%  precision=45.4%  fabricateD=100.0%

[rag-retriever] 种子=91 用例=55 失败=0
  RAG 指标: recall@k=74.5%  precision@k=16.0%  MRR=0.640
  v1 行为指标: recallA=100.0%  triggerB=100.0%  falsePosB=100.0%  precision=42.5%  fabricateD=100.0%
```

## 6. 关键发现

1. **混合（RAG）显著优于纯关键词 / 纯 BM25**：recall@k 74.5% vs 70.9% / 69.1%（+3.6pp / +5.4pp），MRR 0.640 vs 0.595 / 0.602，A 组召回率 100%（关键词/BM25 均 94.6%）——向量路补上了纯关键词漏掉的语义召回（语义鲁棒性、隐指类用例）。
2. **纯 BM25 相对关键词基线不占优**：recall@k 略低（69.1% vs 70.9%），但 precision@k/MRR 略高、B 组误召回率更低（87.5% vs 100%）——关键词路本身的召回已不错，换引擎（LanceDB ICU FTS）增益有限，主要增益来自向量路。
3. **B 组误召回率高是检索器的天然口径**：三条曲线 triggerB/falsePosB 都在 87.5–100%——纯检索器对「不该召回」的查询也会返回 top-k 候选（与 v1 模型驱动路径的「空触发弃权」行为不同，见 A-B-test-v1 §6.1）。这不代表对话侧会注入——真实入口是否注入由上层工具调用判据决定。
4. **fabricateD=100%**：D 组对抗查询（记忆里不存在的事实）检索器仍返回 top-k 候选，属检索器固有行为；防幻觉需依赖上层「是否调用/是否采纳」判据（v1 工具路径的 D 组 0% 即由模型驱动达成）。
5. **确定性 + 缓存复用**：`rag-retriever` 重跑指标与首次完全一致；`results/embedding-cache.json` 体积不变（3,086,129 字节），建索引零 embed 调用（命中缓存）。

## 7. 结论与遗留

- **结论**：LanceDB 混合检索（BM25+向量+RRF）在评测套件上全面优于关键词基线，是召回层可上线的确定性替代；纯 BM25 单项不劣、但增量主要来自向量。
- **遗留 1**：`buildLanceIndex` 建索引时对缺失向量分片 embed（doubao 单请求上限 10 条，真实端点 2026-09-05 实测 400），已在 `lib/lance-index.ts` 落地（分片=10），属 Task 3 的集成级修正。
- **遗留 2**：B/D 组误召回/联想是检索器固有行为，对话侧接入 `rag-retriever.ts` 时需配套上层相关性过滤/调用判据（对应 A-B-test-v1 遗留的主模型判据优化）。
- **遗留 3**：`results/*.json`（含 `embedding-cache.json`）不入库（缓存已 gitignore），仅本对比表入库供 review。

# RAG Reranker：混合检索末端的 LLM cross-encoder 判别器

> 日期：2026-09-06
> 目标：在混合 RAG（`rag-retriever`，BM25+向量+RRF）之后追加一次无工具的 LLM 调用充当 reranker，逐条判断候选记忆与当前问题的相关性，使混合 RAG 在 B/D 组及注入质量指标（falsePosB / 行为 precision / fabricateD）上达到 v1-tool 水平。
> 基线：`worktree-rag-min-loop`（本文档基于该分支，依赖其 `lib/lance-index.ts` 与 `src/llm/embedding.ts`）。
> 前置事实：`rag-min-loop-results.md` 发现 3/4——纯检索器对任何查询恒返回 top-k，B/D 组误召回/幻觉联想（100%）是结构性口径，防幻觉须靠上层判据；v1-tool 的 D 组 0% 由模型判断达成。

## 1. 已确认的决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| 组件范围 | 只做后置 reranker，**不加**前置"该不该检索"闸门 | triggerB 接受 100%：检索是确定性纯计算、成本恒定；falsePosB/precision/fabricateD 才是注入质量指标 |
| 候选池 | `hybrid(query, 20)` → reranker 过滤 → 截回 top-5 | 捞回排 6-20 名的目标（如 c4 类多目标用例）；保持各曲线统一 top-5 口径 |
| 模型 | deepseek-chat | 与 v1 判断层同模型——若达标，证明"检索+过滤"架构本身成立而非依赖更强模型 |
| 调用形态 | 单次 listwise 批判（一次调用判全部 20 条） | 成本 55 次/轮与 v1 同量级；一次看全部再判决，与 v1 recall-agent 行为可比性最强 |
| 工具 | **零工具**（读写皆无） | cross-encoder 输入由管道注入 prompt；持读工具会把过滤器变成第二召回路径，毁掉评测归因，并重开幻觉之门 |

## 2. 架构与组件

```
run.ts --recaller=rag-rerank
  └─ adapters/rag-rerank.ts（新增）
       deps: { llm: LLMProvider, model: "deepseek-chat", index: LanceIndex }
       1. index.hybrid(query, 20)        ← 池深 20，纯本地计算
       2. llm.chat(无 tools)              ← reranker，1 次 LLM 调用
       3. 保留判相关项 → 按 hybrid 分数序 → 截回 top-5 → RecallResult
```

- `lib/recaller.ts` 的 `RecallerKind` 扩 `"rag-rerank"`；既有四条曲线（v1-tool / rag-keyword / lance-fts / rag-retriever）一行不动，新增第五条。
- 复用既有件：`LanceIndex.hybrid`、`LLMProvider`（`src/llm/provider.js`，v1-tool 同款）、`buildMemoryText`（lance-index.ts 建索引同款文本）。
- 输出语义：`triggered` 恒 true；`score` 沿用 hybrid 分数（区别于 v1 的 `1-i/10`，trace 可辨层来源）；判相关项按 hybrid 原始分数序排列（排序归因仍属检索层，确定性）。

## 3. Prompt 设计

System（角色声明 + 判据，刻意不含任何评测用例内容，防 prompt 与测试集耦合）：

> 你是 cross-encoder 判别器（reranker），部署在混合检索管道的末端。你的唯一职责：逐条判断给定记忆与当前问题的相关性，输出 JSON 判决。你不持有任何工具——不检索、不查证、不补充信息，只基于眼前的文本做判断。判断标准：
> 1. 该记忆是否为回答当前问题提供直接的事实依据（用户偏好/事实/项目状态/明确反馈）；
> 2. 语义相邻不等于相关。判别方法：设想你在直接回答用户的问题——只有当这条记忆的内容能作为答案的依据被引用时，才判相关；如果它只是与问题谈论相近的话题、共享相似的词汇或属于同一领域，但内容本身并不回答问题所问的事实，判 false。典型情形：问题询问某个具体事实，而记忆记载的是相近的另一件事（主体、对象或场合不同），此时不相关；
> 3. 拿不准时判 false——宁可清空也不凑数（top-k 里没有"必须保留一条"的义务）。

User：问题原文 + 20 条候选（编号 + `buildMemoryText` 全文）+ 输出格式说明：

```json
{"verdicts": [{"id": 1, "relevant": true}, {"id": 2, "relevant": false}]}
```

## 4. 错误处理

| 失败 | 处理 |
|---|---|
| JSON 解析失败 | 原样重发一次；再失败 → fail-open 降级：返回 hybrid top-5，计入 `failed` 字段（保 recallA；工程失败不伪装成"判空"） |
| LLM 漏判某 id | 该条视为不相关（没选它 = 不相关） |
| LLM 幻觉出不存在的 id | 忽略 |
| `verdicts` 为空数组 | 合法结果：全部不相关 → 候选为空（B/D 组的目标行为） |

## 5. 测试与验收

**单测**（stub LLM）：① 判 true 保留 / false 剔除 / 截断到 5；② `hybrid` 调用参数 topN=20；③ LLM 调用不携带任何工具（验证零工具约束）；④ 解析失败 → 重试 → 降级路径；⑤ 漏判/幻觉 id 处理。

**集成**：`run.ts --recaller=rag-rerank` 跑出第五条曲线，更新 `rag-min-loop-results.md` 对比表；含 LLM 调用故非确定性，跑两轮看波动（复刻 v1-tool 双轮做法）。

**验收标准**：

| 指标 | 目标 | 对照 v1 |
|---|---|---|
| falsePosB | ≤ 25% | 12.5% |
| fabricateD | 0% | 0% |
| recallA | ≥ 94.6% 不降（理想 100%） | 94.6% |
| 行为 precision | ≥ 70% | 79.4% |
| 成本 | 55 次 LLM 调用/轮 | 同量级 |

核心张力：判据 2/3 的保守倾向（宁空勿凑）vs A 组该召回的不误杀。若 recallA 下降，调 prompt 判据的松紧——这是实验要产出的知识。

## 6. 边界（本次不做）

- ❌ 前置"该不该检索"闸门（triggerB 保持 100%）
- ❌ pointwise 逐对打分 / 阈值打分（listwise 二分类已覆盖需求）
- ❌ 生产链路接入（`src/memory/` 不动；本设计仍是评测侧验证）
- ❌ prompt 中使用评测集内的例子（防耦合，见 §3）

## 7. 后续展望（不在本次交付）

- 若验收达标：reranker 即生产侧"上层判据"的原型，可与 v1 的 recall-agent 判据做行为对比，为 `lance-index` 上移 `src/memory/` 后的完整链路提供参照；
- 若 recallA 受损：探索判据松紧、池深（20→10/30）、或对"判 false 的期望项"做错误分析反哺 prompt。

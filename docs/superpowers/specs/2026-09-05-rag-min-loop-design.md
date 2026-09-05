# RAG 最小闭环：评测侧 Native RAG 设计

> 日期：2026-09-05
> 目标：在 LICode 中引入 RAG 的最小闭环，接入 master 上既有的 rag 评测集（`packages/core/scripts/eval-recall/`），用数据判断 RAG 相对关键词基线的真实增益。
> 范围：**评测侧**优先。生产召回链路（`src/memory/recall-agent.ts` 那条线）的接入另行评估，不在本次范围。
> 背景参考：`docs/rag-memory-recall-design.md`（思路科普文，方向一致）。

---

## 1. 现状与约束

| 项 | 现状 | 证据 |
|---|---|---|
| 评测管线 | 完整可跑：runner + `Recaller` 接口 + 91 条种子 / 55 用例（A37/B8/C6/D4） | `scripts/eval-recall/run.ts`、`lib/recaller.ts` |
| RAG 检索器 | 骨架态，`TODO(vector)` 未实现，当前委托关键词基线 | `adapters/rag-retriever.ts:16` |
| 关键词基线 | 确定性打分：`keywords`×3 / `name`×3 / `description`×2 / `content`×1，CJK 单字+双字 token | `adapters/rag-keyword.ts:17-22` |
| 基线成绩 | 首批 v1 对比：RAG 关键词 70.9%（recallA） | 记忆：memory-test-suite-v2-state |
| 记忆存储 | 纯文件系统 markdown，无数据库 | `src/memory/store.ts` |
| 向量/embedding | 无任何依赖与调用通道 | `packages/core/package.json` |
| 规模 | content 平均 52 字 / 最长 177 字 —— 单条记忆即单 chunk | `seed-memories.json` |

**LLM 侧只有 Anthropic 兼容 provider**（`anthropic.ts`，走 `ANTHROPIC_BASE_URL` 代理）；**embedding 需要新建通道**。

## 2. Spike 验证结果（2026-09-05）

| 验证项 | 结论 |
|---|---|
| embedding 端点（火山方舟） | ✅ 纯 OpenAI 字符串格式直接可用：`POST {BASE}/embeddings`、200、**维度 2048**（`doubao-embedding-vision`） |
| @lancedb/lancedb | ✅ **0.38.0**（Node v26.4.0），需显式安装平台包 `@lancedb/lancedb-darwin-arm64`（它属于 optionalDependencies，`--omit=optional` 会漏掉） |
| jieba 分词器（TS） | ⚠️ 选项存在（`BaseTokenizer` 含 `jieba/${string}`），但需手动放置词典到 `~/Library/Application Support/lance/language_models/jieba/default`；缺目录即报错 |
| ICU 分词器（TS） | ✅ **开箱即用**。中文检索验证通过：`孙燕姿演唱会`→sun、`奶茶`→sun（按词匹配） |

**结论：FTS 分词器用 ICU（零配置、已验证）；jieba 作为后续可选增强**（放好词典即可切换，不阻塞最小闭环）。

## 3. 选型决策

### 3.1 向量存储：LanceDB（全托管混合检索）

- 原生 TS SDK、嵌入式无服务、darwin-arm64 预编译二进制；BM25 全文检索、混合检索（`queryType:"hybrid"`）与 **RRF reranker**（`lancedb.rerankers.RRFReranker`）全部内置
- 91~数百条规模下向量检索走暴力扫描，行为与手写余弦等价，无索引开销
- 持久化形态（Lance 数据文件）与生产路径一致，评测结论可平移到生产
- **代价**：依赖体积（原生包解压约 231MB；pnpm 用 `ignoredOptionalDependencies` 排除 openai/transformers 两个非必需可选依赖）。用户已明确体积不是问题
- 替代方案（已否决）：内存暴力余弦（零依赖，但丢持久化且生产要重写）；sqlite-vec / hnswlib / Qdrant（本规模过度设计）

### 3.2 embedding 接入：自写 `EmbeddingProvider`，原生 fetch

- OpenAI 兼容协议（spike 已验证），环境变量 `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL`（已在 `~/.zshrc:13-15`）
- **不引入 SDK/框架**；失败重试 1 次
- 向量缓存：`sha256(model + 文本)` 为 key 的 JSON 缓存文件——重跑评测零成本、结果可复现（不受服务端模型升级漂移影响）

### 3.3 切片：不切片

- 整条记忆所有字段拼接为一段文本（`name + keywords + description + content`），单条=单 chunk
- 拼文本逻辑收敛为显式函数 `buildMemoryText(memory)`，将来接大语料（>~500 字）要切片时只改这一处

### 3.4 融合：两路召回 + RRF

- 关键词路（LanceDB BM25/ICU）与向量路（embedding 余弦）各取 top20，内置 `RRFReranker` 融合（标准 RRF 常数），返回 topK
- **对照设计（关键）**：新增纯 BM25 适配器 `lance-fts`，形成阶梯：
  - `rag-keyword`（旧加权基线）→ `lance-fts`（BM25 路，对照“关键词换引擎”的影响）→ `rag-retriever`（BM25+向量+RRF 完整 RAG）
  - 后两者之差 = **向量路的净贡献**，避免“向量效果好/坏”归因不清

### 3.5 依赖

- `packages/core` 增加 `@lancedb/lancedb`（含显式平台包）
- pnpm 配置 `ignoredOptionalDependencies`：排除 `openai`、`@huggingface/transformers`
- 运行评测时读取 `EMBEDDING_*`（脚本内 source `~/.zshrc`，或后续迁 `.env`）

## 4. 组件与数据流

### 4.1 组件

```
src/llm/embedding.ts                     # 新建：EmbeddingProvider（OpenAI 兼容 fetch）
scripts/eval-recall/adapters/
  lancedb-fts.ts                         # 新建：纯 BM25 对照适配器（Recaller）
  rag-retriever.ts                       # 改造：补 TODO(vector)，LanceDB 混合检索
  lib/lance-index.ts                     # 新建：建表/建索引/向量缓存/查询封装（供两个适配器复用）
../results/embedding-cache.json          # 生成：向量缓存（与现有评测结果同目录，gitignore）
run.ts                                   # 改造：--recaller=rag-retriever/lance-fts 时注入 embedder
```

### 4.2 数据流（评测一次运行）

1. `buildEvalStore(seeds)` 建好记忆（现有逻辑不动）
2. `lance-index.ts` 初始化 LanceDB：连库 → 每条记忆 `buildMemoryText` → **批量 embed**（走 embedding.ts + 缓存）→ 写入表（`slug` / `text` / `vector` 2048 维）→ `Index.fts({ baseTokenizer:"icu" })` 建 FTS 索引
3. 查询时对 query 实时 embed（1 次），`queryType:"hybrid"` + `RRFReranker` 取 topK
4. 结果映射回 `{slug, score}` 交回评测 runner

### 4.3 错误处理

- embedding API 调用失败：重试 1 次后向上抛错、本次评测**失败即停**（评测场景要的是明确失败而非静默降级）
- 缺少 `EMBEDDING_*` 环境变量：启动时报错并提示配置方法（与现有 `v1-tool` 缺 key 报错对称）

## 5. 测试与验收

**单元测试**（vitest，mock fetch / 假向量）：
- `embedding.ts`：协议格式、批量输入、重试、错误路径
- `lance-index.ts`：缓存命中/失效（改文本、改模型都触发重嵌）、`buildMemoryText` 拼接顺序
- `lance-fts.ts`：BM25 返回 topK、空结果
- `rag-retriever.ts`：注入假数据后 RRF 融合顺序、topK 截断

**集成验收**（真环境变量跑评测）：
```
pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=rag-keyword   # 复现基线 ~70.9%
pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=lance-fts     # BM25 对照
pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=rag-retriever # 完整 RAG
```
对比 recall@k / precision@k / MRR，输出三份结果 JSON 并归档到 `scripts/eval-recall/results/`。

**成功标准**：三条曲线跑通并归档；能明确回答“向量路相对关键词路的净贡献是正是负、幅度多少”。

## 6. 边界（本次不做）

- ❌ 生产召回链路接入（`recall-agent.ts` 等）
- ❌ jieba 词典配置（后续可选增强）
- ❌ rerank 模型、chunking、向量数据库之外的任何框架/SDK
- ❌ 修改 `rag-keyword.ts` 基线、评测数据、`Recaller` 接口

## 7. 后续展望（不在本次交付）

- 生产侧接入：`EmbeddingProvider` 与 LanceDB 封装已是生产可用形态，届时把 `lance-index` 从 eval 目录上移到 `src/memory/`
- jieba 增强：下载词典放 `LANCE_LANGUAGE_MODEL_HOME`，对比 ICU/BM25 效果
- 长文本语料（日记全文）：触发切片策略，改 `buildMemoryText` 一处

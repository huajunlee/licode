// packages/core/scripts/eval-recall/adapters/rag-retriever.ts
import type { MemoryStore } from "../../../src/memory/store.js";
import type { RecallResult, Recaller } from "../lib/recaller.js";
import type { LanceIndex } from "../lib/lance-index.js";

/**
 * RAG 混合检索器（BM25 + 向量 + RRF）。
 * 两路各取 topK 后由 LanceDB 内置 RRFReranker 融合排名返回。
 * 关键词路经 `lance-fts`（纯 BM25 对照）隔离其单独贡献。
 */
export function createRagRetriever(deps: { store: MemoryStore; index: LanceIndex }): Recaller {
  return {
    kind: "rag-retriever",
    async retrieve(query, opts): Promise<RecallResult> {
      const candidates = await deps.index.hybrid(query, opts.topK);
      return { candidates, triggered: true };
    },
  };
}

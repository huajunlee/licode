// packages/core/scripts/eval-recall/adapters/rag-retriever.ts
import type { MemoryStore } from "../../../src/memory/store.js";
import type { RecallResult, Recaller } from "../lib/recaller.js";
import { createRagKeywordRecaller } from "./rag-keyword.js";

/**
 * RAG 混合检索器（向量 + 关键词）。
 * 骨架态：向量模型未接入，当前委托关键词基线（确定性），保证评测管线先行跑通。
 * 接入点：在此处新增向量评分项，与关键词分数混合加权排序后返回 topK。
 */
export function createRagRetriever(deps: { store: MemoryStore }): Recaller {
  const keyword = createRagKeywordRecaller(deps);
  return {
    kind: "rag-retriever",
    async retrieve(query, opts): Promise<RecallResult> {
      // TODO(vector): 叠加 embedding 相似度评分后再排序。当前仅关键词基线。
      return keyword.retrieve(query, opts);
    },
  };
}

// scripts/eval-recall/adapters/lancedb-fts.ts
import type { MemoryStore } from "../../../src/memory/store.js";
import type { RecallResult, Recaller } from "../lib/recaller.js";
import type { LanceIndex } from "../lib/lance-index.js";

/** 纯 BM25 对照适配器：仅 FTS 路，用于隔离"关键词换引擎"的影响。 */
export function createLanceFtsRecaller(deps: { store: MemoryStore; index: LanceIndex }): Recaller {
  return {
    kind: "lance-fts",
    async retrieve(query, opts): Promise<RecallResult> {
      const candidates = await deps.index.fts(query, opts.topK);
      return { candidates, triggered: true };
    },
  };
}

// packages/core/scripts/eval-recall/adapters/rag-keyword.ts
import type { MemoryStore } from "../../../src/memory/store.js";
import type { RecallResult, Recaller } from "../lib/recaller.js";

/** 分词：拉丁词 + CJK 单字 + 相邻双字。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const w of text.toLowerCase().match(/[a-z0-9_]+/g) ?? []) tokens.push(w);
  const cjk = text.replace(/[^一-鿿]/g, "");
  for (let i = 0; i < cjk.length; i++) {
    tokens.push(cjk[i]);
    if (i + 1 < cjk.length) tokens.push(cjk[i] + cjk[i + 1]);
  }
  return tokens;
}

const FIELDS: Array<{ pick: (m: { name: string; description: string; keywords: string[]; content: string }) => string; weight: number }> = [
  { pick: (m) => m.keywords.join(""), weight: 3 },
  { pick: (m) => m.name, weight: 3 },
  { pick: (m) => m.description, weight: 2 },
  { pick: (m) => m.content, weight: 1 },
];

/** 关键词重叠打分：确定性基线。query 分词 vs 记忆各字段 token 计数，加权求和。 */
export function createRagKeywordRecaller(deps: { store: MemoryStore }): Recaller {
  return {
    kind: "rag-keyword",
    async retrieve(query, opts): Promise<RecallResult> {
      const all = await deps.store.listAll();
      const qTokens = tokenize(query);
      if (qTokens.length === 0) return { candidates: [], triggered: true };

      const scored = all.map((m) => {
        let score = 0;
        for (const { pick, weight } of FIELDS) {
          const fieldTokens = tokenize(pick(m));
          const counts = new Map<string, number>();
          for (const t of fieldTokens) counts.set(t, (counts.get(t) ?? 0) + 1);
          for (const t of qTokens) score += (counts.get(t) ?? 0) * weight;
        }
        return { slug: m.slug, score };
      });

      scored.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
      const candidates = scored
        .filter((c) => c.score > 0)
        .slice(0, opts.topK)
        .map((c) => ({ slug: c.slug, score: c.score }));
      return { candidates, triggered: true };
    },
  };
}

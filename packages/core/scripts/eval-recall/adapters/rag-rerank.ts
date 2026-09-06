// packages/core/scripts/eval-recall/adapters/rag-rerank.ts
import type { LLMProvider } from "../../../src/llm/provider.js";
import type { LanceIndex } from "../lib/lance-index.js";
import type { RecallResult, Recaller } from "../lib/recaller.js";

/** 送入 reranker 的候选池深度（hybrid 取 top-N，过滤后截回 top-k）。 */
export const RERANK_POOL = 20;

const SYSTEM_PROMPT = `你是 cross-encoder 判别器（reranker），部署在混合检索管道的末端。你的唯一职责：逐条判断给定记忆与当前问题的相关性，输出 JSON 判决。你不持有任何工具——不检索、不查证、不补充信息，只基于眼前的文本做判断。判断标准：
1. 该记忆是否为回答当前问题提供直接的事实依据（用户偏好/事实/项目状态/明确反馈）；
2. 语义相邻不等于相关。判别方法：设想你在直接回答用户的问题——只有当这条记忆的内容能作为答案的依据被引用时，才判相关；如果它只是与问题谈论相近的话题、共享相似的词汇或属于同一领域，但内容本身并不回答问题所问的事实，判 false。典型情形：问题询问某个具体事实，而记忆记载的是相近的另一件事（主体、对象或场合不同），此时不相关；
3. 拿不准时判 false——宁可清空也不凑数（top-k 里没有"必须保留一条"的义务）。`;

export function buildRerankUserMessage(query: string, pool: Array<{ text: string }>): string {
  return [
    `【问题】${query}`,
    "",
    "【候选记忆】",
    ...pool.map((c, i) => `[${i + 1}] ${c.text}`),
    "",
    "【输出格式】只输出 JSON，不要输出其它内容：",
    '{"verdicts":[{"id":1,"relevant":true},{"id":2,"relevant":false}]}',
    "（逐条必判，id 与上方编号对应；全部不相关时全部判 false。）",
  ].join("\n");
}

/** 解析 reranker 输出：容忍 markdown 代码块包裹；非法项（id 非整数 / relevant 非布尔）忽略；漏判 id 由调用方按不相关处理。 */
export function parseVerdicts(raw: string): Map<number, boolean> {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("rerank 输出中未找到 JSON");
  const parsed = JSON.parse(m[0]) as { verdicts?: Array<{ id?: unknown; relevant?: unknown }> };
  const out = new Map<number, boolean>();
  for (const v of parsed.verdicts ?? []) {
    if (typeof v.id === "number" && Number.isInteger(v.id) && typeof v.relevant === "boolean") out.set(v.id, v.relevant);
  }
  return out;
}

export interface RagRerankDeps {
  llm: LLMProvider;
  model: string;
  index: LanceIndex;
  /** 诊断 trace（可选）：记录降级等事件。 */
  trace?: string[];
}

export function createRagRerankRecaller(deps: RagRerankDeps): Recaller {
  return {
    kind: "rag-rerank",
    async retrieve(query, opts): Promise<RecallResult> {
      const pool = await deps.index.hybrid(query, RERANK_POOL);
      if (pool.length === 0) return { candidates: [], triggered: true };

      const ask = async (): Promise<Map<number, boolean>> => {
        const res = await deps.llm.chat({
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildRerankUserMessage(query, pool), timestamp: new Date().toISOString() },
          ],
          model: deps.model,
          maxTokens: 1024,
          // 不传 tools：reranker 零工具（spec §1 决策）
        });
        return parseVerdicts(res.content);
      };

      let verdicts: Map<number, boolean>;
      try {
        verdicts = await ask();
      } catch {
        try {
          verdicts = await ask(); // 解析失败原样重试一次（spec §4）
        } catch (e) {
          deps.trace?.push(`rerank-fallback: ${String(e)}`);
          return { candidates: pool.slice(0, opts.topK).map(({ slug, score }) => ({ slug, score })), triggered: true };
        }
      }

      const kept = pool
        .filter((_, i) => verdicts.get(i + 1) === true) // 漏判=不相关；幻觉 id 永不被查询
        .slice(0, opts.topK)
        .map(({ slug, score }) => ({ slug, score }));
      return { candidates: kept, triggered: true };
    },
  };
}

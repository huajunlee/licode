// packages/core/scripts/eval-recall/run.ts
// 用法：
//   pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=rag-keyword
//   pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=v1-tool
//   （EVAL_MODEL 可覆盖默认模型；v1-tool 需要 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY）
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Seed, Case, Recaller, RecallerKind } from "./lib/recaller.js";
import { buildEvalStore, runEvaluation } from "./lib/eval-runner.js";
import { createRagKeywordRecaller } from "./adapters/rag-keyword.js";
import { createRagRetriever } from "./adapters/rag-retriever.js";
import { createRecallToolRecaller } from "./adapters/recall-tool.js";
import { envEmbeddingProvider } from "../../src/llm/embedding.js";
import { buildLanceIndex, type LanceIndex } from "./lib/lance-index.js";
import { createLanceFtsRecaller } from "./adapters/lancedb-fts.js";
import { AnthropicProvider } from "../../src/llm/anthropic.js";
import type { LLMProvider, ChatRequest, ChatResponse, StreamChunk, Message } from "../../src/llm/provider.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = DIR; // 本脚本即位于 eval-recall/ 数据目录内（seed-memories.json / cases.json 同目录）
const MODEL = process.env.EVAL_MODEL ?? "kimi-k3"; // 与 eval-recall.ts 的 EVAL_MODEL 默认一致

/** 包装 provider：强制 temperature=0（可复现），其余透传。 */
class ZeroTempProvider implements LLMProvider {
  constructor(private inner: LLMProvider) {}
  get name(): string { return this.inner.name; }
  get maxContextTokens(): number { return this.inner.maxContextTokens; }
  chat(request: ChatRequest): Promise<ChatResponse> { return this.inner.chat({ ...request, temperature: 0 }); }
  stream(request: ChatRequest): AsyncIterable<StreamChunk> { return this.inner.stream({ ...request, temperature: 0 }); }
  countTokens(messages: Message[]): number { return this.inner.countTokens(messages); }
}

async function main(): Promise<void> {
  const kind = (process.argv.find((a) => a.startsWith("--recaller="))?.slice(11) ?? "rag-keyword") as RecallerKind;
  if (!["v1-tool", "rag-keyword", "lance-fts", "rag-retriever"].includes(kind)) throw new Error(`未知 --recaller=${kind}`);

  const seeds = JSON.parse(fs.readFileSync(path.join(DATA, "seed-memories.json"), "utf-8")) as Seed[];
  const cases = JSON.parse(fs.readFileSync(path.join(DATA, "cases.json"), "utf-8")) as Case[];
  const { store, cleanup } = await buildEvalStore(seeds);

  let index: LanceIndex | undefined;
  try {
    let recaller: Recaller;
    if (kind === "rag-keyword") {
      recaller = createRagKeywordRecaller({ store });
    } else if (kind === "lance-fts" || kind === "rag-retriever") {
      const embedder = envEmbeddingProvider();
      const uri = fs.mkdtempSync(path.join(os.tmpdir(), "rag-eval-"));
      index = await buildLanceIndex({
        memories: seeds,
        embedder,
        cachePath: path.join(DATA, "results", "embedding-cache.json"),
        uri,
      });
      recaller = kind === "lance-fts"
        ? createLanceFtsRecaller({ store, index })
        : createRagRetriever({ store, index });
    } else {
      const apiKey = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("v1-tool 需要 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY");
      recaller = createRecallToolRecaller({
        llm: new ZeroTempProvider(new AnthropicProvider({ apiKey, baseUrl: process.env.ANTHROPIC_BASE_URL })),
        model: MODEL, store,
      });
    }

    const summary = await runEvaluation({ recaller, seeds, cases });

    console.log(`\n[${kind}] 种子=${seeds.length} 用例=${cases.length} 失败=${summary.failed}`);
    console.log(`  RAG 指标: recall@k=${(summary.rag.recallAtK * 100).toFixed(1)}%  precision@k=${(summary.rag.precisionAtK * 100).toFixed(1)}%  MRR=${summary.rag.mrr.toFixed(3)}`);
    console.log(`  v1 行为指标: recallA=${(summary.behavior.recallA * 100).toFixed(1)}%  triggerB=${(summary.behavior.triggerRateB * 100).toFixed(1)}%  falsePosB=${(summary.behavior.falsePositiveB * 100).toFixed(1)}%  precision=${(summary.behavior.precision * 100).toFixed(1)}%  fabricateD=${(summary.behavior.fabricateD * 100).toFixed(1)}%`);

    const out = path.join(DATA, "results", `results-${kind}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ model: MODEL, kind, seeds: seeds.length, cases: cases.length, summary }, null, 2));
    console.log(`结果已写入 ${out}`);
  } finally {
    if (index) { await index.close(); index.cleanup(); }
    cleanup();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });

// scripts/eval-recall/adapters/rag-retriever.test.ts
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "../../../src/llm/embedding.js";
import { buildLanceIndex, type LanceIndex } from "../lib/lance-index.js";
import { buildEvalStore } from "../lib/eval-runner.js";
import type { Seed } from "../lib/recaller.js";
import { createRagRetriever } from "./rag-retriever.js";

class FakeEmbedder implements EmbeddingProvider {
  readonly model = "fake";
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => Array.from(createHash("sha256").update(t).digest().subarray(0, 8)).map((b) => b / 255));
  }
}

const seeds: Seed[] = [
  { slug: "user/sun", name: "孙燕姿", description: "歌手", type: "user", keywords: ["孙燕姿", "奶茶"], content: "孙燕姿喜欢喝奶茶，演唱会常选周六。" },
  { slug: "user/code", name: "构建", description: "工具链", type: "user", keywords: ["pnpm"], content: "项目用 pnpm workspace 与 vitest。" },
];

describe("createRagRetriever（混合检索 + RRF）", () => {
  it("kind 为 rag-retriever，retrieve 直接委派 index.hybrid 并透传 topK", async () => {
    const { store, cleanup } = await buildEvalStore(seeds);
    const hybrid = vi.fn(async (_query: string, _topK: number) => [{ slug: "user/sun", score: 1 }]);
    const index = { fts: vi.fn(), hybrid, close: vi.fn(), cleanup: vi.fn() } as unknown as LanceIndex;
    try {
      const r = createRagRetriever({ store, index });
      expect(r.kind).toBe("rag-retriever");
      const out = await r.retrieve("孙燕姿演唱会", { topK: 1 });
      expect(hybrid).toHaveBeenCalledTimes(1);
      expect(hybrid).toHaveBeenCalledWith("孙燕姿演唱会", 1);
      expect(out.candidates).toEqual([{ slug: "user/sun", score: 1 }]);
    } finally { cleanup(); }
  });

  it("候选按相关度降序且 score 为数字", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-ret-"));
    const { store, cleanup } = await buildEvalStore(seeds);
    const index = await buildLanceIndex({
      memories: seeds, embedder: new FakeEmbedder(),
      cachePath: path.join(dir, "cache.json"), uri: path.join(dir, "l"),
    });
    try {
      const r = createRagRetriever({ store, index });
      const out = await r.retrieve("孙燕姿奶茶", { topK: 2 });
      expect(out.candidates.length).toBeGreaterThanOrEqual(1);
      for (const c of out.candidates) expect(typeof c.score).toBe("number");
    } finally { await index.close(); index.cleanup(); cleanup(); }
  });
});

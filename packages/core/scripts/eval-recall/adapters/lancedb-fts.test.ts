// scripts/eval-recall/adapters/lancedb-fts.test.ts
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "../../../src/llm/embedding.js";
import { buildLanceIndex } from "../lib/lance-index.js";
import { buildEvalStore } from "../lib/eval-runner.js";
import type { Seed } from "../lib/recaller.js";
import { createLanceFtsRecaller } from "./lancedb-fts.js";

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

describe("createLanceFtsRecaller（纯 BM25 对照）", () => {
  it("kind 为 lance-fts，关键词查询命中对应记忆", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lance-fts-"));
    const { store, cleanup } = await buildEvalStore(seeds);
    const index = await buildLanceIndex({
      memories: seeds, embedder: new FakeEmbedder(),
      cachePath: path.join(dir, "cache.json"), uri: path.join(dir, "l"),
    });
    try {
      const r = createLanceFtsRecaller({ store, index });
      expect(r.kind).toBe("lance-fts");
      const out = await r.retrieve("孙燕姿演唱会", { topK: 2 });
      expect(out.triggered).toBe(true);
      expect(out.candidates[0].slug).toBe("user/sun");
    } finally { await index.close(); index.cleanup(); cleanup(); }
  });

  it("无关查询返回空候选", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lance-fts-"));
    const { store, cleanup } = await buildEvalStore(seeds);
    const index = await buildLanceIndex({
      memories: seeds, embedder: new FakeEmbedder(),
      cachePath: path.join(dir, "cache.json"), uri: path.join(dir, "l"),
    });
    try {
      const r = createLanceFtsRecaller({ store, index });
      const out = await r.retrieve("量子物理计算", { topK: 2 });
      expect(out.candidates).toHaveLength(0);
    } finally { await index.close(); index.cleanup(); cleanup(); }
  });
});

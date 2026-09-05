// scripts/eval-recall/lib/lance-index.test.ts
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "../../../src/llm/embedding.js";
import { buildLanceIndex, buildMemoryText, EmbeddingCache } from "./lance-index.js";

/** 确定性假 embedder：sha256 前 8 字节归一化 → 8 维向量。 */
class FakeEmbedder implements EmbeddingProvider {
  readonly model = "fake";
  calls = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    return texts.map((t) => {
      const h = createHash("sha256").update(t).digest();
      return Array.from(h.subarray(0, 8)).map((b) => b / 255);
    });
  }
}

const MEM = (slug: string) => ({ slug, name: slug, description: `${slug} 描述`, keywords: [`kw-${slug}`], content: `${slug} 内容` });

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lance-idx-"));
}

describe("buildMemoryText", () => {
  it("按 name/keywords/description/content 顺序拼接，跳过空段", () => {
    const t = buildMemoryText({ name: "N", description: "", keywords: ["A", "B"], content: "C" });
    expect(t).toBe("N\nA B\nC");
  });
});

describe("EmbeddingCache", () => {
  it("key 含 model 与文本，换 model 即失效", () => {
    const c = new EmbeddingCache("m1");
    expect(c.key("你好")).toBe(c.key("你好"));
    expect(c.key("你好")).not.toBe(new EmbeddingCache("m2").key("你好"));
  });
  it("save 后 load 恢复数据", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "cache.json");
    const c = new EmbeddingCache("m");
    c.set("文本", [1, 2, 3]);
    await c.save(file);
    const c2 = await EmbeddingCache.load(file, "m");
    expect(c2.get("文本")).toEqual([1, 2, 3]);
    expect(c2.get("其它")).toBeUndefined();
  });
});

describe("buildLanceIndex", () => {
  it("缓存命中：同 cachePath 第二次构建不再调用 embedder", async () => {
    const dir = tmpDir();
    const cacheFile = path.join(dir, "cache.json");
    const memories = [MEM("user/孙燕姿"), MEM("user/奶茶")];
    const e1 = new FakeEmbedder();
    await buildLanceIndex({ memories, embedder: e1, cachePath: cacheFile, uri: path.join(dir, "l1") });
    const e2 = new FakeEmbedder();
    const idx2 = await buildLanceIndex({ memories, embedder: e2, cachePath: cacheFile, uri: path.join(dir, "l2") });
    expect(e2.calls).toBe(0); // 全部命中缓存，零 embed 调用
    await idx2.close(); idx2.cleanup();
  });

  it("文本变化触发重新 embed", async () => {
    const dir = tmpDir();
    const cacheFile = path.join(dir, "cache.json");
    await buildLanceIndex({ memories: [MEM("user/a")], embedder: new FakeEmbedder(), cachePath: cacheFile, uri: path.join(dir, "l1") });
    const e = new FakeEmbedder();
    await buildLanceIndex({
      memories: [{ slug: "user/a", name: "a", description: "d", keywords: [], content: "完全不同的新内容" }],
      embedder: e, cachePath: cacheFile, uri: path.join(dir, "l2"),
    });
    expect(e.calls).toBe(1);
  });

  it("fts 中文查询按语义分词命中对应记忆", async () => {
    const dir = tmpDir();
    const idx = await buildLanceIndex({
      memories: [
        { slug: "user/sun", name: "孙燕姿", description: "歌手", keywords: [], content: "孙燕姿喜欢喝奶茶，演唱会常选周六" },
        { slug: "user/code", name: "构建", description: "工具链", keywords: [], content: "项目用 pnpm workspace 与 vitest" },
      ],
      embedder: new FakeEmbedder(), cachePath: path.join(dir, "cache.json"), uri: path.join(dir, "l"),
    });
    try {
      const r = await idx.fts("孙燕姿演唱会", 3);
      expect(r[0].slug).toBe("user/sun");
      expect(r[0].score).toBeGreaterThan(0);
    } finally { await idx.close(); idx.cleanup(); }
  });

  it("hybrid 返回 topK 条候选（含 RRF 融合）", async () => {
    const dir = tmpDir();
    const idx = await buildLanceIndex({
      memories: [MEM("user/a"), MEM("user/b"), MEM("user/c")],
      embedder: new FakeEmbedder(), cachePath: path.join(dir, "cache.json"), uri: path.join(dir, "l"),
    });
    try {
      const r = await idx.hybrid("kw-user/a", 2);
      expect(r.length).toBe(2);
      expect(r.some((c) => c.slug === "user/a")).toBe(true);
      expect(r.every((c) => typeof c.score === "number")).toBe(true);
      expect(r[0].score).toBeGreaterThan(0);
      expect(r[0].score).toBeLessThanOrEqual(1); // RRF 融合分 ∈ (0,1]
    } finally { await idx.close(); idx.cleanup(); }
  });
});

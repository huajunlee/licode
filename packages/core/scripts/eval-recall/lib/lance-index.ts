// scripts/eval-recall/lib/lance-index.ts
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { connect, Index, rerankers } from "@lancedb/lancedb";
import type { EmbeddingProvider } from "../../../src/llm/embedding.js";

/** 整条记忆拼一段文本（name + keywords + description + content），单条=单 chunk。 */
export function buildMemoryText(m: { name: string; description: string; keywords?: string[]; content: string }): string {
  return [m.name, (m.keywords ?? []).join(" "), m.description, m.content].filter((p) => p && p.trim()).join("\n");
}

/** embedding 结果缓存：key = sha256(model + NUL + text)。换模型/改文本即失效。 */
export class EmbeddingCache {
  constructor(
    private readonly model: string,
    private readonly data: Map<string, number[]> = new Map(),
  ) {}

  static async load(file: string, model: string): Promise<EmbeddingCache> {
    let data = new Map<string, number[]>();
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, number[]>;
      data = new Map(Object.entries(raw));
    } catch {
      data = new Map();
    }
    return new EmbeddingCache(model, data);
  }

  key(text: string): string {
    return createHash("sha256").update(this.model).update("\u0000").update(text).digest("hex");
  }

  get(text: string): number[] | undefined {
    return this.data.get(this.key(text));
  }

  set(text: string, vec: number[]): void {
    this.data.set(this.key(text), vec);
  }

  async save(file: string): Promise<void> {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(this.data)));
  }
}

export interface LanceIndex {
  fts(query: string, topK: number): Promise<Array<{ slug: string; text: string; score: number }>>;
  hybrid(query: string, topK: number): Promise<Array<{ slug: string; text: string; score: number }>>;
  close(): Promise<void>;
  cleanup(): void;
}

type Row = Record<string, unknown>;

type ScoreMode = "fts" | "hybrid";

/**
 * 行 → 候选；score 按查询模式取对应字段，无则排名兜底。
 * hybrid 行同时带 _score（FTS 子分，与最终排序无关）与 _relevance_score（RRF 融合分），必须优先 _relevance_score。
 */
function toCandidates(rows: Row[], topK: number, mode: ScoreMode): Array<{ slug: string; text: string; score: number }> {
  const pref = mode === "hybrid" ? ["_relevance_score", "_score"] : ["_score"];
  return rows.map((r, i) => {
    for (const f of pref) {
      if (typeof r[f] === "number") return { slug: String(r.slug), text: String(r.text), score: r[f] as number };
    }
    return { slug: String(r.slug), text: String(r.text), score: topK - i };
  });
}

/**
 * 建 LanceDB 表（slug/text/vector）+ ICU FTS 索引 + 查询封装。
 * 向量先查缓存、缺失批量 embed 后回写缓存；表建在调用方给的临时 uri 上。
 */
export async function buildLanceIndex(opts: {
  memories: Array<{ slug: string; name: string; description: string; keywords?: string[]; content: string }>;
  embedder: EmbeddingProvider;
  cachePath: string;
  uri: string;
  tokenizer?: string;
}): Promise<LanceIndex> {
  const tokenizer = opts.tokenizer ?? "icu";
  const cache = await EmbeddingCache.load(opts.cachePath, opts.embedder.model);
  const texts = opts.memories.map((m) => buildMemoryText(m));
  const missing: number[] = [];
  const vectors: Array<number[] | undefined> = texts.map((t, i) => cache.get(t) ?? (missing.push(i), undefined));
  if (missing.length > 0) {
    // 分片调用 embed：doubao-embedding-vision 单请求上限 10 条（真实端点 2026-09-05 实测 400 InvalidParameter）。
    const missingTexts = missing.map((i) => texts[i]);
    const CHUNK = 10;
    const got: number[][] = [];
    for (let i = 0; i < missingTexts.length; i += CHUNK) {
      got.push(...(await opts.embedder.embed(missingTexts.slice(i, i + CHUNK))));
    }
    missing.forEach((i, j) => {
      vectors[i] = got[j];
      cache.set(texts[i], got[j]);
    });
  }
  await cache.save(opts.cachePath);

  const db = await connect(opts.uri);
  const tables = await db.tableNames();
  if (tables.includes("memories")) await db.dropTable("memories");
  const tbl = await db.createTable(
    "memories",
    opts.memories.map((m, i) => ({ slug: m.slug, text: texts[i], vector: Float32Array.from(vectors[i]!) })),
  );
  await tbl.createIndex("text", { config: Index.fts({ baseTokenizer: tokenizer }) });
  const rrf = await rerankers.RRFReranker.create();

  return {
    async fts(query, topK) {
      const rows = await tbl.query().nearestToText(query).limit(topK).toArray();
      return toCandidates(rows, topK, "fts");
    },
    async hybrid(query, topK) {
      const [qvec] = await opts.embedder.embed([query]);
      const rows = await tbl.query().nearestTo(qvec).fullTextSearch(query).rerank(rrf).limit(topK).toArray();
      return toCandidates(rows, topK, "hybrid");
    },
    async close() {
      await db.close();
    },
    cleanup() {
      fs.rmSync(opts.uri, { recursive: true, force: true });
    },
  };
}

# RAG 最小闭环（评测侧 Native RAG）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在评测侧引入 RAG 最小闭环（LanceDB 全托管混合检索 + 自写 embedding），跑通 `rag-keyword` / `lance-fts` / `rag-retriever` 三条评测曲线，量化向量路对关键词基线的净贡献。

**Architecture:** 自写 OpenAI 兼容 `EmbeddingProvider`（src/llm/embedding.ts）→ LanceDB 表（slug/text/vector 三列，ICU 分词 FTS 索引）→ 两个评测适配器：`lance-fts`（纯 BM25 对照）、`rag-retriever`（`queryType:"hybrid"` + 内置 RRF）。embedding 结果以 `sha256(model+text)` 为 key 落 JSON 缓存，重跑零成本。

**Tech Stack:** @lancedb/lancedb ^0.38.0（原生预编译二进制）、vitest（全局 globals）、tsx（跑评测脚本）、Node ≥ 22（node:fetch）。

**Spec:** `docs/superpowers/specs/2026-09-05-rag-min-loop-design.md`

## Global Constraints

- 依赖：`@lancedb/lancedb`（`^0.38.0`）加入 `packages/core`；根 `package.json` 增 `pnpm.ignoredOptionalDependencies: ["openai", "@huggingface/transformers"]`（平台包 `@lancedb/lancedb-darwin-arm64` 由 optionalDependencies 自动装）
- 环境变量：`EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL`（已在 `~/.zshrc:13-15`）；OpenAI 兼容 `/embeddings`，维度 2048（doubao-embedding-vision）
- FTS 分词器固定 `baseTokenizer: "icu"`（jieba 需手动放词典，本次不用）
- 所有测试在 worktree 内运行（vitest root = worktree 根，不受 `.claude/**` exclude 影响）；命令 `pnpm vitest run <file>`
- embedding 缓存文件：`packages/core/scripts/eval-recall/results/embedding-cache.json`，加入 `.gitignore`
- LanceDB 表每次评测重建于临时目录（mkdtemp），不持久化；缓存层保证不重复调 API
- 不做：生产召回链路接入、jieba 词典、rerank 模型、chunking、修改 `rag-keyword.ts` / 评测数据 / `Recaller` 接口语义

---

### Task 1: 依赖与配置

**Files:**
- Modify: `packages/core/package.json`（dependencies 增 @lancedb/lancedb）
- Modify: `package.json`（根，增 `pnpm.ignoredOptionalDependencies`）
- Modify: `.gitignore`（增 embedding 缓存条目）
- 生成：`pnpm-lock.yaml` 变更

**Interfaces:**
- Consumes: 无
- Produces: `@lancedb/lancedb` 可在 TS 中 `import { connect, Index, rerankers }` 正常加载

- [ ] **Step 1: 编辑根 `package.json` 加 pnpm 忽略配置**

在根 `package.json`（`/Users/lixiaohua/Project/agent/LICode/.claude/worktrees/rag-min-loop/package.json`）末尾、`devDependencies` 之后追加：

```json
  "pnpm": {
    "ignoredOptionalDependencies": ["openai", "@huggingface/transformers"]
  }
```

- [ ] **Step 2: 安装依赖**

在 worktree 根执行：

```bash
pnpm --filter @licode/core add @lancedb/lancedb
```

- [ ] **Step 3: 验证加载 + 排除可选依赖**

```bash
pnpm exec tsx -e "
import { connect } from '@lancedb/lancedb';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'lance-smoke-'));
const db = await connect(dir); await db.close();
console.log('lancedb 加载 ok');
"
# 确认 openai/transformers 未被装入：
ls node_modules/.pnpm | grep -Ei '^openai|transformers' && echo 'FAIL: 可选依赖未排除' || echo 'OK: 可选依赖已排除'
```

Expected: 打印 `lancedb 加载 ok` 与 `OK: 可选依赖已排除`。

- [ ] **Step 4: 编辑 `.gitignore` 忽略 embedding 缓存**

在根 `.gitignore` 追加：

```
# eval-recall embedding 缓存（内容哈希 → 向量，可再生成）
packages/core/scripts/eval-recall/results/embedding-cache.json
```

- [ ] **Step 5: Commit（含本实现计划文档）**

```bash
git add package.json packages/core/package.json pnpm-lock.yaml .gitignore docs/superpowers/plans/2026-09-05-rag-min-loop.md
git commit -m "docs(eval): RAG 最小闭环实现计划；build: 接入 lancedb + 排除可选依赖 + 忽略缓存"
```

---

### Task 2: `src/llm/embedding.ts` — OpenAI 兼容 EmbeddingProvider

**Files:**
- Create: `src/llm/embedding.ts`
- Create: `src/llm/embedding.test.ts`

**Interfaces:**
- Consumes: 无（纯 fetch，Node ≥ 22 全局 `fetch`）
- Produces:
  - `interface EmbeddingProvider { readonly model: string; embed(texts: string[]): Promise<number[][]>; }`
  - `class OpenAICompatEmbeddingProvider implements EmbeddingProvider` — `constructor({ baseUrl, apiKey, model, fetchImpl? })`，`embed` 批量单请求、失败重试 1 次
  - `function envEmbeddingProvider(env?: NodeJS.ProcessEnv): EmbeddingProvider` — 读三个 `EMBEDDING_*`，缺失抛错

- [ ] **Step 1: 写失败测试 `src/llm/embedding.test.ts`**

```ts
// src/llm/embedding.test.ts
import { describe, expect, it, vi } from "vitest";
import { envEmbeddingProvider, OpenAICompatEmbeddingProvider } from "./embedding.js";

function jsonFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  ) as unknown as typeof fetch;
}

describe("OpenAICompatEmbeddingProvider", () => {
  it("POST {base}/embeddings，Bearer 认证，body 含 model 与 input，按 index 还原顺序", async () => {
    const fetchMock = jsonFetch(200, {
      data: [
        { index: 1, embedding: [0.2, 0.3] },
        { index: 0, embedding: [0.1, 0.9] },
      ],
    });
    const p = new OpenAICompatEmbeddingProvider({ baseUrl: "https://x.example/v3/", apiKey: "k", model: "m", fetchImpl: fetchMock });
    const out = await p.embed(["一", "二"]);
    expect(p.model).toBe("m");
    expect(out).toEqual([[0.1, 0.9], [0.2, 0.3]]);
    const call = vi.mocked(fetchMock).mock.calls[0];
    expect(call[0]).toBe("https://x.example/v3/embeddings");
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(JSON.parse(init.body as string)).toEqual({ model: "m", input: ["一", "二"] });
  });

  it("空输入返回空数组且不发请求", async () => {
    const fetchMock = jsonFetch(200, { data: [] });
    const p = new OpenAICompatEmbeddingProvider({ baseUrl: "https://x", apiKey: "k", model: "m", fetchImpl: fetchMock });
    await expect(p.embed([])).resolves.toEqual([]);
    expect(vi.mocked(fetchMock)).not.toHaveBeenCalled();
  });

  it("5xx 失败后重试一次成功", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ index: 0, embedding: [7] }] }), { status: 200 }));
    const p = new OpenAICompatEmbeddingProvider({ baseUrl: "https://x", apiKey: "k", model: "m", fetchImpl: f as unknown as typeof fetch });
    await expect(p.embed(["a"])).resolves.toEqual([[7]]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("4xx 重试一次后抛错，错误信息含状态码", async () => {
    const f = vi.fn().mockResolvedValue(new Response("bad model", { status: 400 }));
    const p = new OpenAICompatEmbeddingProvider({ baseUrl: "https://x", apiKey: "k", model: "m", fetchImpl: f as unknown as typeof fetch });
    await expect(p.embed(["a"])).rejects.toThrow(/400/);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("响应缺少某 index 时报错", async () => {
    const fetchMock = jsonFetch(200, { data: [{ index: 0, embedding: [1] }] });
    const p = new OpenAICompatEmbeddingProvider({ baseUrl: "https://x", apiKey: "k", model: "m", fetchImpl: fetchMock });
    await expect(p.embed(["a", "b"])).rejects.toThrow(/缺少部分 index/);
  });
});

describe("envEmbeddingProvider", () => {
  it("三个变量齐全时返回 provider", () => {
    const p = envEmbeddingProvider({ EMBEDDING_BASE_URL: "https://x", EMBEDDING_API_KEY: "k", EMBEDDING_MODEL: "m" } as NodeJS.ProcessEnv);
    expect(p.model).toBe("m");
  });
  it("缺变量时抛错", () => {
    expect(() => envEmbeddingProvider({ EMBEDDING_MODEL: "m" } as NodeJS.ProcessEnv)).toThrow(/EMBEDDING_BASE_URL/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run packages/core/src/llm/embedding.test.ts
```

Expected: FAIL，`Cannot find module './embedding.js'`。

- [ ] **Step 3: 实现 `src/llm/embedding.ts`**

```ts
// src/llm/embedding.ts
export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * OpenAI 兼容 /embeddings 客户端。纯 fetch，批量单请求，失败重试 1 次。
 * 协议已验证：doubao-embedding-vision（火山方舟）接受 {"model","input":[string]} 标准格式。
 */
export class OpenAICompatEmbeddingProvider implements EmbeddingProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly modelName: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { baseUrl: string; apiKey: string; model: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.modelName = opts.model;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get model(): string {
    return this.modelName;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.modelName, input: texts }),
        });
        if (!res.ok) {
          throw new Error(`embedding HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        const json = (await res.json()) as { data: Array<{ index?: number; embedding: number[] }> };
        const byIndex = new Map(json.data.map((d) => [d.index ?? 0, d.embedding]));
        const out = texts.map((_, i) => byIndex.get(i));
        if (out.some((v) => !v)) throw new Error("embedding 响应缺少部分 index");
        return out as number[][];
      } catch (e) {
        lastErr = e;
        if (attempt === 1) throw lastErr;
      }
    }
    throw lastErr;
  }
}

/** 从环境变量构造 provider；缺任一变量即抛错（评测场景失败即停）。 */
export function envEmbeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const { EMBEDDING_BASE_URL, EMBEDDING_API_KEY, EMBEDDING_MODEL } = env;
  if (!EMBEDDING_BASE_URL || !EMBEDDING_API_KEY || !EMBEDDING_MODEL) {
    throw new Error("缺少 EMBEDDING_BASE_URL / EMBEDDING_API_KEY / EMBEDDING_MODEL（见设计文档 §3.2，已配置于 ~/.zshrc）");
  }
  return new OpenAICompatEmbeddingProvider({ baseUrl: EMBEDDING_BASE_URL, apiKey: EMBEDDING_API_KEY, model: EMBEDDING_MODEL });
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm vitest run packages/core/src/llm/embedding.test.ts
```

Expected: PASS（6 个用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/llm/embedding.ts packages/core/src/llm/embedding.test.ts
git commit -m "feat(llm): OpenAI 兼容 EmbeddingProvider（批量 + 重试 + env 构造）"
```

---

### Task 3: `lib/lance-index.ts` — 记忆文本、embedding 缓存、LanceDB 表/索引/查询

**Files:**
- Create: `scripts/eval-recall/lib/lance-index.ts`
- Create: `scripts/eval-recall/lib/lance-index.test.ts`

**Interfaces:**
- Consumes: `EmbeddingProvider`（Task 2）、`@lancedb/lancedb`（Task 1）
- Produces:
  - `function buildMemoryText(m: { name: string; description: string; keywords?: string[]; content: string }): string` — 按 `name + keywords + description + content` 拼接，空段跳过
  - `class EmbeddingCache` — `constructor(model, data?: Map)`；`static async load(file, model)`；`key(text)`（`sha256(model + " " + text)`）；`get(text)`；`set(text, vec)`；`async save(file)`
  - `interface LanceIndex { fts(query: string, topK: number): Promise<Array<{ slug: string; score: number }>>; hybrid(query: string, topK: number): Promise<Array<{ slug: string; score: number }>>; close(): Promise<void>; cleanup(): void; }`
  - `async function buildLanceIndex(opts: { memories: Array<{ slug: string; name: string; description: string; keywords?: string[]; content: string }>; embedder: EmbeddingProvider; cachePath: string; uri: string; tokenizer?: string }): Promise<LanceIndex>` — 建表（slug/text/vector）、ICU FTS 索引、写缓存

- [ ] **Step 1: 写失败测试 `scripts/eval-recall/lib/lance-index.test.ts`**

```ts
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
    } finally { await idx.close(); idx.cleanup(); }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run packages/core/scripts/eval-recall/lib/lance-index.test.ts
```

Expected: FAIL，`Cannot find module './lance-index.js'`。

- [ ] **Step 3: 实现 `scripts/eval-recall/lib/lance-index.ts`**

```ts
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
    return createHash("sha256").update(this.model).update(" ").update(text).digest("hex");
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
  fts(query: string, topK: number): Promise<Array<{ slug: string; score: number }>>;
  hybrid(query: string, topK: number): Promise<Array<{ slug: string; score: number }>>;
  close(): Promise<void>;
  cleanup(): void;
}

type Row = Record<string, unknown>;

/** 行 → 候选；score 优先读 FTS 的 _relevance_score，否则用排名兜底。 */
function toCandidates(rows: Row[], topK: number): Array<{ slug: string; score: number }> {
  return rows.map((r, i) => ({
    slug: String(r.slug),
    score: typeof r._relevance_score === "number" ? (r._relevance_score as number) : topK - i,
  }));
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
    const got = await opts.embedder.embed(missing.map((i) => texts[i]));
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
      return toCandidates(rows, topK);
    },
    async hybrid(query, topK) {
      const rows = await tbl.search(query, "hybrid").rerank(rrf).limit(topK).toArray();
      return toCandidates(rows, topK);
    },
    async close() {
      await db.close();
    },
    cleanup() {
      fs.rmSync(opts.uri, { recursive: true, force: true });
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm vitest run packages/core/scripts/eval-recall/lib/lance-index.test.ts
```

Expected: PASS（6 个用例全绿，真实 LanceDB 建表/检索走通）。

- [ ] **Step 5: Commit**

```bash
git add packages/core/scripts/eval-recall/lib/lance-index.ts packages/core/scripts/eval-recall/lib/lance-index.test.ts
git commit -m "feat(eval): LanceDB 索引封装（buildMemoryText + embedding 缓存 + fts/hybrid 查询）"
```

---

### Task 4: `adapters/lancedb-fts.ts` — 纯 BM25 对照适配器

**Files:**
- Create: `scripts/eval-recall/adapters/lancedb-fts.ts`
- Create: `scripts/eval-recall/adapters/lancedb-fts.test.ts`
- Modify: `scripts/eval-recall/lib/recaller.ts:22`（`RecallerKind` 增 `"lance-fts"`）

**Interfaces:**
- Consumes: `LanceIndex`（Task 3）、`MemoryStore`、`Recaller`（既有）
- Produces: `function createLanceFtsRecaller(deps: { store: MemoryStore; index: LanceIndex }): Recaller` — `kind: "lance-fts"`，`retrieve` 走 `index.fts`

- [ ] **Step 1: 写失败测试 `scripts/eval-recall/adapters/lancedb-fts.test.ts`**

```ts
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
```

- [ ] **Step 2: 修改 `lib/recaller.ts` 的 RecallerKind 并跑测试确认失败**

`scripts/eval-recall/lib/recaller.ts:22`：

```ts
export type RecallerKind = "v1-tool" | "rag-keyword" | "lance-fts" | "rag-retriever";
```

```bash
pnpm vitest run packages/core/scripts/eval-recall/adapters/lancedb-fts.test.ts
```

Expected: FAIL，`Cannot find module './lancedb-fts.js'`。

- [ ] **Step 3: 实现 `scripts/eval-recall/adapters/lancedb-fts.ts`**

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm vitest run packages/core/scripts/eval-recall/adapters/lancedb-fts.test.ts
```

Expected: PASS（2 个用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add packages/core/scripts/eval-recall/adapters/lancedb-fts.ts packages/core/scripts/eval-recall/adapters/lancedb-fts.test.ts packages/core/scripts/eval-recall/lib/recaller.ts
git commit -m "feat(eval): lance-fts 纯 BM25 对照适配器 + RecallerKind 扩展"
```

---

### Task 5: `adapters/rag-retriever.ts` — 补 TODO(vector)：混合检索 + RRF

**Files:**
- Modify: `scripts/eval-recall/adapters/rag-retriever.ts`（整体重写）
- Modify: `scripts/eval-recall/adapters/rag-retriever.test.ts`（旧"骨架=关键词"测试已过时，整体替换）

**Interfaces:**
- Consumes: `LanceIndex`（Task 3）、`MemoryStore`、`Recaller`
- Produces: `function createRagRetriever(deps: { store: MemoryStore; index: LanceIndex }): Recaller` — `kind: "rag-retriever"`，`retrieve` 走 `index.hybrid`（两路召回 + 内置 RRF）

- [ ] **Step 1: 替换测试 `scripts/eval-recall/adapters/rag-retriever.test.ts`**

```ts
// scripts/eval-recall/adapters/rag-retriever.test.ts
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "../../../src/llm/embedding.js";
import { buildLanceIndex } from "../lib/lance-index.js";
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
  it("kind 为 rag-retriever，混合查询命中关键词记忆并限 topK", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-ret-"));
    const { store, cleanup } = await buildEvalStore(seeds);
    const index = await buildLanceIndex({
      memories: seeds, embedder: new FakeEmbedder(),
      cachePath: path.join(dir, "cache.json"), uri: path.join(dir, "l"),
    });
    try {
      const r = createRagRetriever({ store, index });
      expect(r.kind).toBe("rag-retriever");
      const out = await r.retrieve("孙燕姿演唱会", { topK: 1 });
      expect(out.candidates).toHaveLength(1);
      expect(out.candidates[0].slug).toBe("user/sun");
    } finally { await index.close(); index.cleanup(); cleanup(); }
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run packages/core/scripts/eval-recall/adapters/rag-retriever.test.ts
```

Expected: FAIL（旧测试断言"与关键词一致"不再成立 / 新签名缺 `index`）。

- [ ] **Step 3: 重写 `scripts/eval-recall/adapters/rag-retriever.ts`**

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm vitest run packages/core/scripts/eval-recall/adapters/rag-retriever.test.ts
```

Expected: PASS（2 个用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add packages/core/scripts/eval-recall/adapters/rag-retriever.ts packages/core/scripts/eval-recall/adapters/rag-retriever.test.ts
git commit -m "feat(eval): rag-retriever 接入 LanceDB 混合检索（BM25+向量+RRF），补 TODO(vector)"
```

---

### Task 6: `run.ts` 接线 + 全量评测三条曲线

**Files:**
- Modify: `scripts/eval-recall/run.ts`

**Interfaces:**
- Consumes: `envEmbeddingProvider`（Task 2）、`buildLanceIndex`（Task 3）、`createLanceFtsRecaller`（Task 4）、`createRagRetriever`（Task 5）
- Produces: 三条评测结果 JSON 归档于 `scripts/eval-recall/results/`

- [ ] **Step 1: 修改 `scripts/eval-recall/run.ts` 接线**

把 `run.ts` 中 kind 白名单与 recaller 构造替换为：

```ts
const kind = (process.argv.find((a) => a.startsWith("--recaller="))?.slice(11) ?? "rag-keyword") as RecallerKind;
if (!["v1-tool", "rag-keyword", "lance-fts", "rag-retriever"].includes(kind)) throw new Error(`未知 --recaller=${kind}`);
```

```ts
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
```

对应的 import 变更（`run.ts` 顶部）：

```ts
import * as os from "node:os";
import { envEmbeddingProvider } from "../../src/llm/embedding.js";
import { buildLanceIndex, type LanceIndex } from "./lib/lance-index.js";
import { createLanceFtsRecaller } from "./adapters/lancedb-fts.js";
```

- [ ] **Step 2: 单元自检（eval 脚本在 src 之外，靠 vitest/tsx 校验）**

```bash
pnpm vitest run packages/core/scripts/eval-recall
```

Expected: Task 2-5 全部用例通过——run.ts 的依赖（`envEmbeddingProvider`/`buildLanceIndex`/两个适配器）被真实加载，import 无解析错误。

- [ ] **Step 3: 全量评测——复现关键词基线**

```bash
pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=rag-keyword
```

Expected: 打印 `[rag-keyword]` 指标（对照 ~70.9% recallA），结果写入 `results/results-rag-keyword-*.json`。

- [ ] **Step 4: 全量评测——BM25 对照**

```bash
pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=lance-fts
```

Expected: 打印 `[lance-fts]` 指标；首次运行生成 `results/embedding-cache.json`。

- [ ] **Step 5: 全量评测——完整 RAG**

```bash
pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=rag-retriever
```

Expected: 打印 `[rag-retriever]` 指标（hybrid + RRF）。

- [ ] **Step 6: 验证缓存复用（重跑第 5 步不再调 API）**

```bash
pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=rag-retriever
```

Expected: 与上次一致的结果；`results/embedding-cache.json` 存在且体积不变（命中缓存，未重新 embed）。

- [ ] **Step 7: 汇总三条曲线并提交**

把三条指标行整理为对比表（rag-keyword / lance-fts / rag-retriever × recall@k / precision@k / MRR / recallA），写入新文件 `scripts/eval-recall/rag-min-loop-results.md`（与既有 `A-B-test-v1.md` 同目录、同风格），然后提交：

```bash
git add packages/core/scripts/eval-recall/run.ts packages/core/scripts/eval-recall/rag-min-loop-results.md
git commit -m "test(eval): RAG 最小闭环三条评测曲线（keyword/fts/hybrid）"
```

> 注：`results/*.json`（含 `embedding-cache.json`）不入库；对比表以 `.md` 入库供 review。

- [ ] **Step 8: 收尾——跑全量测试回归**

```bash
pnpm test
```

Expected: 全部既有测试 + 新增测试通过（无回归）。

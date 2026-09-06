# RAG Reranker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在混合 RAG（`rag-retriever`）之后追加一次无工具的 LLM reranker（cross-encoder 判别器），使 B/D 组注入质量指标达到 v1-tool 水平。

**Architecture:** 新增第五条评测曲线 `rag-rerank`：`index.hybrid(query, 20)` 取候选池（含索引文本）→ 单次 listwise LLM 调用逐条判相关性 → 过滤 → 截回 top-5。`LanceIndex` 返回值扩展携带 `text`，reranker 与文本构造/切片策略解耦。

**Tech Stack:** TypeScript、vitest、LanceDB（既有）、AnthropicProvider（既有，OpenAI 兼容端点）。

**Spec:** `docs/superpowers/specs/2026-09-06-rag-reranker-design.md`（本计划从 spec 立论，执行者需同时读两者）

## Global Constraints

- SYSTEM_PROMPT 必须与 spec §3 **逐字一致**（角色声明 "你是 cross-encoder 判别器（reranker）" + 三条判据，一字不改）。
- reranker LLM 调用**零工具**：`ChatRequest` 不传 `tools` 字段。
- 池深 20（`RERANK_POOL = 20`），过滤后截回调用方传入的 `opts.topK`（默认 5）。
- 模型 deepseek-chat：评测运行时用 `EVAL_MODEL=deepseek-chat` 环境变量（与 v1-tool 轮次同机制，结果 JSON 的 model 字段自动记录）。
- 既有四条曲线（v1-tool / rag-keyword / lance-fts / rag-retriever）行为一行不动（`rag-retriever`/`lancedb-fts` 适配器无需改动——多出的 `text` 字段对 `RecallCandidate[]` 结构类型兼容）。
- `results/*.json` 已被 gitignore，评测产物不入库，只有 `rag-min-loop-results.md` 对比表入库。
- 测试命令一律在仓库根执行：`pnpm vitest run <文件>`；不新增任何依赖。

---

### Task 1: `LanceIndex.hybrid`/`fts` 候选携带索引文本 `text`

**Files:**
- Modify: `packages/core/scripts/eval-recall/lib/lance-index.ts:49-54`（`LanceIndex` 接口）、`lance-index.ts:64-72`（`toCandidates`）
- Test: `packages/core/scripts/eval-recall/lib/lance-index.test.ts`（新增一个用例）

**Interfaces:**
- Consumes: 行数据已含 `text` 列（`buildLanceIndex` 建表时写入 `text: texts[i]`，`lance-index.ts:110`）。
- Produces: `LanceIndex.fts/hybrid` 返回 `Promise<Array<{ slug: string; text: string; score: number }>>`——Task 2 的 reranker 从中取候选文本。

- [ ] **Step 1: 写失败测试**

在 `lance-index.test.ts` 的 `describe("buildLanceIndex", ...)` 内（"hybrid 返回 topK 条候选"用例之后）新增：

```ts
it("hybrid/fts 候选携带索引文本 text（= buildMemoryText 输出，reranker 消费）", async () => {
  const dir = tmpDir();
  const memories = [MEM("user/a"), MEM("user/b")];
  const idx = await buildLanceIndex({
    memories, embedder: new FakeEmbedder(), cachePath: path.join(dir, "cache.json"), uri: path.join(dir, "l"),
  });
  try {
    for (const r of [await idx.hybrid("kw-user/a", 2), await idx.fts("kw-user/a", 2)]) {
      expect(r.length).toBeGreaterThanOrEqual(1);
      const a = r.find((c) => c.slug === "user/a")!;
      expect(a.text).toBe(buildMemoryText(MEM("user/a")));
    }
  } finally { await idx.close(); idx.cleanup(); }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/core/scripts/eval-recall/lib/lance-index.test.ts`
Expected: FAIL——`a.text` 为 `undefined`（当前候选不含 text 字段）。

- [ ] **Step 3: 最小实现**

`lance-index.ts` 接口（49-54 行）改为：

```ts
export interface LanceIndex {
  fts(query: string, topK: number): Promise<Array<{ slug: string; text: string; score: number }>>;
  hybrid(query: string, topK: number): Promise<Array<{ slug: string; text: string; score: number }>>;
  close(): Promise<void>;
  cleanup(): void;
}
```

`toCandidates`（64-72 行）在 map 里加 `text`：

```ts
function toCandidates(rows: Row[], topK: number, mode: ScoreMode): Array<{ slug: string; text: string; score: number }> {
  const pref = mode === "hybrid" ? ["_relevance_score", "_score"] : ["_score"];
  return rows.map((r, i) => {
    for (const f of pref) {
      if (typeof r[f] === "number") return { slug: String(r.slug), text: String(r.text), score: r[f] as number };
    }
    return { slug: String(r.slug), text: String(r.text), score: topK - i };
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run packages/core/scripts/eval-recall/lib/lance-index.test.ts`
Expected: PASS（含新增用例）。

- [ ] **Step 5: 回归——适配器测试不受影响**

Run: `pnpm vitest run packages/core/scripts/eval-recall`
Expected: 全部 PASS（`rag-retriever`/`lancedb-fts` 对多出的 `text` 字段结构类型兼容，零改动）。

- [ ] **Step 6: Commit**

```bash
git add packages/core/scripts/eval-recall/lib/lance-index.ts packages/core/scripts/eval-recall/lib/lance-index.test.ts
git commit -m "feat(eval): LanceIndex 候选携带索引文本 text，为 reranker 解耦切片策略"
```

---

### Task 2: `rag-rerank` 适配器（prompt + 解析 + 过滤截断 + 降级）

**Files:**
- Create: `packages/core/scripts/eval-recall/adapters/rag-rerank.ts`
- Create: `packages/core/scripts/eval-recall/adapters/rag-rerank.test.ts`
- Modify: `packages/core/scripts/eval-recall/lib/recaller.ts:38`（`RecallerKind` 扩 `"rag-rerank"`）

**Interfaces:**
- Consumes: Task 1 的 `LanceIndex.hybrid(query, N): Promise<Array<{slug, text, score}>>`；`LLMProvider.chat(ChatRequest): Promise<ChatResponse>`（`src/llm/provider.ts`，注意 `SystemMessage` 无 timestamp、`UserMessage` 有 timestamp）。
- Produces: `createRagRerankRecaller(deps: { llm: LLMProvider; model: string; index: LanceIndex; trace?: string[] }): Recaller`（kind 为 `"rag-rerank"`）；导出 `RERANK_POOL = 20`、`buildRerankUserMessage(query, pool)`、`parseVerdicts(raw): Map<number, boolean>`。Task 3 的 run.ts 依赖此签名。

- [ ] **Step 1: 写失败测试**

`rag-rerank.test.ts` 全文：

```ts
// packages/core/scripts/eval-recall/adapters/rag-rerank.test.ts
import { describe, expect, it, vi } from "vitest";
import type { LLMProvider, ChatRequest, ChatResponse } from "../../../src/llm/provider.js";
import type { LanceIndex } from "../lib/lance-index.js";
import { createRagRerankRecaller, parseVerdicts, buildRerankUserMessage, RERANK_POOL } from "./rag-rerank.js";

const POOL = Array.from({ length: 8 }, (_, i) => ({
  slug: `user/m${i + 1}`, text: `记忆${i + 1}的内容`, score: 1 - i * 0.1,
}));

function fakeIndex(hybrid = vi.fn(async () => POOL)): LanceIndex {
  return { fts: vi.fn(), hybrid, close: vi.fn(), cleanup: vi.fn() } as unknown as LanceIndex;
}

function fakeLlm(reply: (req: ChatRequest) => string): LLMProvider {
  return {
    name: "fake", maxContextTokens: 100000,
    chat: vi.fn(async (req: ChatRequest): Promise<ChatResponse> =>
      ({ content: reply(req), usage: { input: 0, output: 0 }, stopReason: "stop" })),
    stream: vi.fn(), countTokens: vi.fn(() => 0),
  } as unknown as LLMProvider;
}

describe("parseVerdicts", () => {
  it("容忍 markdown 代码块包裹，忽略非法项", () => {
    const m = parseVerdicts('```json\n{"verdicts":[{"id":1,"relevant":true},{"id":"x"},{"id":2,"relevant":"yes"}]}\n```');
    expect(m.get(1)).toBe(true);
    expect(m.get(2)).toBeUndefined();
    expect(m.size).toBe(1);
  });
  it("无 JSON 时抛错（触发重试/降级）", () => {
    expect(() => parseVerdicts("我觉得都不相关")).toThrow();
  });
});

describe("buildRerankUserMessage", () => {
  it("含问题、编号候选文本、输出格式说明", () => {
    const s = buildRerankUserMessage("问题Q", [{ text: "文本A" }, { text: "文本B" }]);
    expect(s).toContain("问题Q");
    expect(s).toContain("[1] 文本A");
    expect(s).toContain("[2] 文本B");
    expect(s).toContain("verdicts");
  });
});

describe("createRagRerankRecaller", () => {
  it("kind 为 rag-rerank，hybrid 以池深 RERANK_POOL 调用", async () => {
    const hybrid = vi.fn(async () => POOL);
    const r = createRagRerankRecaller({ llm: fakeLlm(() => '{"verdicts":[]}'), model: "m", index: fakeIndex(hybrid) });
    expect(r.kind).toBe("rag-rerank");
    await r.retrieve("q", { topK: 5 });
    expect(hybrid).toHaveBeenCalledWith("q", RERANK_POOL);
    expect(RERANK_POOL).toBe(20);
  });

  it("LLM 请求不含 tools 且 system 含 cross-encoder 角色声明", async () => {
    const chat = vi.fn(async (): Promise<ChatResponse> =>
      ({ content: '{"verdicts":[]}', usage: { input: 0, output: 0 }, stopReason: "stop" }));
    const llm = { name: "f", maxContextTokens: 1, chat, stream: vi.fn(), countTokens: vi.fn(() => 0) } as unknown as LLMProvider;
    await createRagRerankRecaller({ llm, model: "m", index: fakeIndex() }).retrieve("q", { topK: 5 });
    const req = chat.mock.calls[0][0] as ChatRequest;
    expect(req.tools).toBeUndefined();
    expect(req.messages[0].role).toBe("system");
    expect((req.messages[0] as { content: string }).content).toContain("cross-encoder");
    expect((req.messages[1] as { content: string }).content).toContain("q");
  });

  it("保留判 true 项（hybrid 序与分数），漏判视为不相关", async () => {
    const llm = fakeLlm(() => '{"verdicts":[{"id":3,"relevant":true},{"id":1,"relevant":true},{"id":99,"relevant":true}]}');
    const out = await createRagRerankRecaller({ llm, model: "m", index: fakeIndex() }).retrieve("q", { topK: 5 });
    expect(out.candidates).toEqual([
      { slug: "user/m1", score: 1 },
      { slug: "user/m3", score: 1 - 2 * 0.1 },
    ]);
    expect(out.triggered).toBe(true);
  });

  it("截断到 opts.topK", async () => {
    const all = Array.from({ length: 8 }, (_, i) => i + 1).map((id) => ({ id, relevant: true }));
    const llm = fakeLlm(() => JSON.stringify({ verdicts: all }));
    const out = await createRagRerankRecaller({ llm, model: "m", index: fakeIndex() }).retrieve("q", { topK: 5 });
    expect(out.candidates).toHaveLength(5);
  });

  it("全判 false → 候选为空且 triggered=true（B/D 组目标行为）", async () => {
    const llm = fakeLlm(() => '{"verdicts":[]}');
    const out = await createRagRerankRecaller({ llm, model: "m", index: fakeIndex() }).retrieve("q", { topK: 5 });
    expect(out.candidates).toEqual([]);
    expect(out.triggered).toBe(true);
  });

  it("两次解析失败 → fail-open 返回 hybrid top-K，chat 共调 2 次，trace 记录", async () => {
    const chat = vi.fn(async (): Promise<ChatResponse> =>
      ({ content: "不是 JSON", usage: { input: 0, output: 0 }, stopReason: "stop" }));
    const llm = { name: "f", maxContextTokens: 1, chat, stream: vi.fn(), countTokens: vi.fn(() => 0) } as unknown as LLMProvider;
    const trace: string[] = [];
    const out = await createRagRerankRecaller({ llm, model: "m", index: fakeIndex(), trace }).retrieve("q", { topK: 3 });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(out.candidates).toEqual(POOL.slice(0, 3).map(({ slug, score }) => ({ slug, score })));
    expect(trace[0]).toContain("rerank-fallback");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/core/scripts/eval-recall/adapters/rag-rerank.test.ts`
Expected: FAIL——模块 `./rag-rerank.js` 不存在。

- [ ] **Step 3: 最小实现**

`recaller.ts:38` 的类型联合改为：

```ts
export type RecallerKind = "v1-tool" | "rag-keyword" | "lance-fts" | "rag-retriever" | "rag-rerank";
```

`rag-rerank.ts` 全文（SYSTEM_PROMPT 与 spec §3 逐字一致）：

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run packages/core/scripts/eval-recall/adapters/rag-rerank.test.ts`
Expected: PASS（全部 8 个用例）。

- [ ] **Step 5: Commit**

```bash
git add packages/core/scripts/eval-recall/adapters/rag-rerank.ts packages/core/scripts/eval-recall/adapters/rag-rerank.test.ts packages/core/scripts/eval-recall/lib/recaller.ts
git commit -m "feat(eval): rag-rerank 适配器——混合检索末端 LLM cross-encoder 判别器"
```

---

### Task 3: `run.ts` 接入 `--recaller=rag-rerank`

**Files:**
- Modify: `packages/core/scripts/eval-recall/run.ts:2-5`（用法注释）、`run.ts:36-37`（kind 校验）、`run.ts:48-59`（分支接线）、`run.ts:13` 附近（import）

**Interfaces:**
- Consumes: Task 2 的 `createRagRerankRecaller({ llm, model, index })`；Task 1 的 `LanceIndex`。
- Produces: CLI 曲线 `pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=rag-rerank`（Task 4 用它跑评测）。

- [ ] **Step 1: 接线实现**

1. import 区（第 13 行后）加：

```ts
import { createRagRerankRecaller } from "./adapters/rag-rerank.js";
```

2. 用法注释（第 2-5 行）加一行：

```ts
//   pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=rag-rerank
//   （rag-rerank 需要 EMBEDDING_* 与 ANTHROPIC_* 环境变量；EVAL_MODEL 建议设 deepseek-chat）
```

3. kind 校验（第 37 行）：

```ts
if (!["v1-tool", "rag-keyword", "lance-fts", "rag-retriever", "rag-rerank"].includes(kind)) throw new Error(`未知 --recaller=${kind}`);
```

4. 分支接线：把第 48-59 行的 `else if (kind === "lance-fts" || kind === "rag-retriever")` 块改为（index 构建共享，LLM 仅 rag-rerank 需要）：

```ts
} else if (kind === "lance-fts" || kind === "rag-retriever" || kind === "rag-rerank") {
  const embedder = envEmbeddingProvider();
  const uri = fs.mkdtempSync(path.join(os.tmpdir(), "rag-eval-"));
  index = await buildLanceIndex({
    memories: seeds,
    embedder,
    cachePath: path.join(DATA, "results", "embedding-cache.json"),
    uri,
  });
  if (kind === "lance-fts") {
    recaller = createLanceFtsRecaller({ store, index });
  } else if (kind === "rag-retriever") {
    recaller = createRagRetriever({ store, index });
  } else {
    const apiKey = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("rag-rerank 需要 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY");
    recaller = createRagRerankRecaller({
      llm: new ZeroTempProvider(new AnthropicProvider({ apiKey, baseUrl: process.env.ANTHROPIC_BASE_URL })),
      model: MODEL, index,
    });
  }
}
```

- [ ] **Step 2: 回归验证**

Run: `pnpm vitest run packages/core/scripts/eval-recall`
Expected: 全部 PASS（run.ts 无单测，靠既有套件兜底类型/导入错误）。

- [ ] **Step 3: Commit**

```bash
git add packages/core/scripts/eval-recall/run.ts
git commit -m "feat(eval): run.ts 接入 rag-rerank 曲线（--recaller=rag-rerank）"
```

---

### Task 4: 评测执行与结果文档

**Files:**
- Modify: `packages/core/scripts/eval-recall/rag-min-loop-results.md`（对比表加 rag-rerank 列 + 验收对照节）

**Interfaces:**
- Consumes: Task 3 的 CLI 曲线；真实环境变量（`EMBEDDING_BASE_URL/EMBEDDING_API_KEY/EMBEDDING_MODEL` 已在 `~/.zshrc`；`ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY`（v1-tool 同款，可能需 `ANTHROPIC_BASE_URL` 指向 deepseek 兼容端点））。

- [ ] **Step 1: 第一轮评测**

```bash
EVAL_MODEL=deepseek-chat pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=rag-rerank
```

Expected: 打印 `[rag-rerank] 种子=91 用例=55 失败=0` 与两行指标；结果写入 `results/results-rag-rerank-<时间戳>.json`。失败=0 是硬前提（非 0 先查 trace/降级计数再继续）。

- [ ] **Step 2: 对照验收标准（spec §5）**

从打印输出读数，对照：falsePosB ≤ 25%、fabricateD = 0%、recallA ≥ 94.6%、行为 precision ≥ 70%。逐项记录实际值（含未达标项——未达标是有效实验结果，不是失败，如实记录）。

- [ ] **Step 3: 第二轮评测（波动观察）**

重复 Step 1 命令再跑一次，记录两轮指标差（复刻 v1-tool 双轮做法）。

- [ ] **Step 4: 更新 `rag-min-loop-results.md`**

1. 标题行范围改为四条曲线（keyword / BM25 / hybrid / hybrid+rerank），并加一句 reranker 说明（池深 20 截回 5、deepseek-chat、零工具、prompt 见 spec 链接）；
2. §2 检索器表加一行：

```markdown
| 混合+Rerank | `rag-rerank` | `adapters/rag-rerank.ts` + `lib/lance-index.ts` | hybrid top-20 → LLM cross-encoder 判相关 → 截回 top-5 |
```

3. §5 对比表加 rag-rerank 列，数值从两轮运行输出填入（R1/R2 并记）；
4. 新增「§5.2 rag-rerank 验收对照」小节，逐项列 spec §5 验收表的目标值 vs 实际值（falsePosB / fabricateD / recallA / 行为 precision / 成本 55 次调用每轮）；
5. §6 关键发现补一条：reranker 对 B/D 组与 recallA 的实际影响（达标与否均如实写，含 A 组误杀/漏杀的具体用例 id 分析——从 `results/results-rag-rerank-*.json` 的 perCase 挑 miss 的 A 组用例）；
6. 设计文档链接：`docs/superpowers/specs/2026-09-06-rag-reranker-design.md`。

- [ ] **Step 5: Commit**

```bash
git add packages/core/scripts/eval-recall/rag-min-loop-results.md
git commit -m "test(eval): rag-rerank 首批评测结果（hybrid+LLM reranker 曲线）"
```

---

## 自审记录

- **Spec 覆盖**：§1 五决策（零工具/池深/模型/listwise/不加前置闸门）→ Task 2/3/4；§2 text 解耦 → Task 1；§3 prompt 逐字 → Task 2 SYSTEM_PROMPT + 全局约束；§4 错误处理四行 → Task 2 测试（漏判/幻觉 id 在"保留判 true 项"用例、空 verdicts 在"全判 false"用例、重试+降级在 fail-open 用例）；§5 测试与验收 → Task 2 单测 + Task 4 双轮评测；§6 边界（不做前置闸门/pointwise/生产接入）未引入任何对应任务 ✓。
- **占位符**：Task 4 的表格数值为运行期测量值，来源与填法已指定，非 TBD。
- **类型一致性**：Task 1 产出 `{slug,text,score}` 与 Task 2 消费一致；`createRagRerankRecaller` 签名在 Task 2 定义、Task 3 按同签名调用；`RERANK_POOL` 常量导出并在测试中引用。

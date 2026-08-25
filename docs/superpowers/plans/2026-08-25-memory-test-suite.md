# 记忆测试集（v2）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立完整记忆测试集（扩展数据 + 双路径评测框架），为后续 RAG 召回打地基——用同一份数据测 v1 LLM 召回 与 RAG 检索两条路径。

**Architecture:** 共享测试数据（seed-memories.json / cases.json 扩展）+ 统一评测框架（`Recaller` 接口 → runner → 指标模块）+ 三个适配器（`v1-tool` / `rag-keyword` / `rag-retriever`）。RAG 路径用 top-k + IR 指标（recall@k / precision@k / MRR），v1 路径沿用行为指标。

**Tech Stack:** TypeScript (ESM)、vitest、tsx、`@licode/core`（`packages/core/src` 的 MemoryStore / recall-agent / memory-recall 工具）。

**Spec:** `docs/superpowers/specs/2026-08-25-memory-test-suite-design.md`

## Global Constraints

- **surgical**：现有 `packages/core/scripts/eval-recall/eval-recall*.ts` 脚本**不修改不删除**；`seed-memories.json` / `cases.json` 里的 core 条目**原样保留**（只新增扩展条目、给既有条目补 `set: "core"` 等标签时以追加不覆盖为原则——若补标签会改变原字段语义，则只新增扩展条目，不动 core 条目）。
- 所有新代码在 `packages/core/scripts/eval-recall/` 下：`lib/`、`adapters/`、`run.ts`。
- 测试用 vitest，globals 开启，测试文件与被测文件同目录（`*.test.ts`），运行 `pnpm test`。
- LLM 路径（`v1-tool`）强制 temperature=0；种子写入固定 createdAt/updatedAt（复用 `eval-recall.ts` 的 `writeSeedMemory` 格式）。
- 中文注释/字符串，与项目现有代码一致。
- 代码引用以 `packages/core/src/` 为准，不引入新依赖。

## File Structure

```
packages/core/scripts/eval-recall/
  lib/
    recaller.ts            # Seed/Case/RecallCandidate/RecallResult/Recaller 类型 + 接口
    metrics.ts             # recall@k / precision@k / MRR + 行为指标（纯函数）
    validate.ts            # 数据集自检（expectedSlug 存在性 / k 足够 / 冲突对合法性）
    eval-runner.ts         # 统一评测执行（含 buildEvalStore / writeSeedMemory）
  adapters/
    rag-keyword.ts         # 关键词重叠打分检索器（确定性基线）
    rag-retriever.ts       # 混合检索器骨架（当前委托 rag-keyword）
    recall-tool.ts         # v1 适配器（包装 memory_recall 单轮链路）
  run.ts                   # CLI 入口（--recaller=v1-tool|rag-keyword|rag-retriever）
  seed-memories.json       # 扩展（分域干扰项/长段落/相似对/冲突对）
  cases.json               # 扩展（语义鲁棒性/新维度用例 + 标签）
  eval-recall-v2.md        # 新方法论文档
  lib/*.test.ts, adapters/*.test.ts   # 框架单测
  results/                 # 结果存档
```

**模块依赖顺序**：recaller.ts（类型）← metrics.ts / validate.ts ← eval-runner.ts ← adapters/* ← run.ts。

---

### Task 1: Recaller 类型与接口

**Files:**
- Create: `packages/core/scripts/eval-recall/lib/recaller.ts`
- Test: `packages/core/scripts/eval-recall/lib/recaller.test.ts`

**Interfaces:**
- Produces: `Seed`, `Case`, `CaseGroup`, `RecallCandidate`, `RecallResult`, `RecallerKind`, `Recaller`, `DEFAULT_K = 5`。签名见下方代码，后续所有任务引用这些类型。

- [ ] **Step 1: 写接口文件**

```ts
// packages/core/scripts/eval-recall/lib/recaller.ts
export type MemoryType = "user" | "feedback" | "project" | "reference";
export type CaseGroup = "A" | "B" | "C" | "D";

export interface Seed {
  slug: string;
  name: string;
  description: string;
  type: MemoryType;
  keywords: string[];
  content: string;
  set?: "core" | "extended";   // 核心集 / 扩展集
  domain?: string;             // 分域标签（扩展集）
  conflictsWith?: string;      // 时间冲突对：旧记忆被哪条新记忆替代（spec §3.5）
}

export interface Case {
  id: string;
  group: CaseGroup;            // A=应召回 B=不应 C=探索 D=对抗
  query: string;
  expectRecall: boolean | null;
  expectedSlugs: string[];
  set?: "core" | "extended";
  dimensions?: string[];       // 维度标签，取值见 spec §3.3 词汇表
  k?: number;                  // 评测 top-k，默认 DEFAULT_K
}

export interface RecallCandidate {
  slug: string;
  score: number;
}

export interface RecallResult {
  candidates: RecallCandidate[];  // 已按相关度降序
  triggered?: boolean;            // v1：主模型是否调了工具（RAG 恒 true）
}

export type RecallerKind = "v1-tool" | "rag-keyword" | "rag-retriever";

export interface Recaller {
  readonly kind: RecallerKind;
  retrieve(query: string, opts: { keywords?: string[]; topK: number }): Promise<RecallResult>;
}

export const DEFAULT_K = 5;
```

- [ ] **Step 2: 写测试（锁接口形状）**

```ts
// packages/core/scripts/eval-recall/lib/recaller.test.ts
import { describe, expect, it } from "vitest";
import { DEFAULT_K, type RecallResult, type Recaller } from "./recaller.js";

describe("Recaller 接口形状", () => {
  it("DEFAULT_K 为 5", () => {
    expect(DEFAULT_K).toBe(5);
  });

  it("合法的 fake recaller 满足接口（kind 在枚举内，retrieve 返回 RecallResult）", async () => {
    const fake: Recaller = {
      kind: "rag-keyword",
      async retrieve(q, opts) {
        expect(q).toBe("宵夜吃什么好？");
        expect(opts.topK).toBe(5);
        const res: RecallResult = { candidates: [{ slug: "user/food-preferences", score: 1 }], triggered: true };
        return res;
      },
    };
    const out = await fake.retrieve("宵夜吃什么好？", { topK: DEFAULT_K });
    expect(out.candidates[0].slug).toBe("user/food-preferences");
  });
});
```

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm vitest run packages/core/scripts/eval-recall/lib/recaller.test.ts`
Expected: 2 passed

- [ ] **Step 4: Commit**

```bash
git add packages/core/scripts/eval-recall/lib/recaller.ts packages/core/scripts/eval-recall/lib/recaller.test.ts
git commit -m "feat(eval): Recaller 接口与类型定义"
```

---

### Task 2: 指标纯函数（RAG + 行为指标）

**Files:**
- Create: `packages/core/scripts/eval-recall/lib/metrics.ts`
- Test: `packages/core/scripts/eval-recall/lib/metrics.test.ts`

**Interfaces:**
- Consumes: `CaseGroup`（from recaller.ts）
- Produces: `recallAtK(ranked, expected, k): number`、`precisionAtK(ranked, expected, k): number`、`mrr(ranked, expected): number`、`PerCaseBehavior`、`BehaviorMetrics`、`computeBehaviorMetrics(results): BehaviorMetrics`

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/scripts/eval-recall/lib/metrics.test.ts
import { describe, expect, it } from "vitest";
import { recallAtK, precisionAtK, mrr, computeBehaviorMetrics } from "./metrics.js";

describe("recallAtK", () => {
  it("期望全部在前 k 命中算 1", () => {
    expect(recallAtK(["a", "b", "c"], ["a"], 3)).toBe(1);
  });
  it("期望排在 k 之外算 0", () => {
    expect(recallAtK(["a", "b", "c", "d"], ["d"], 3)).toBe(0);
  });
  it("多期望需全部命中", () => {
    expect(recallAtK(["a", "b", "c"], ["a", "d"], 5)).toBe(0);
    expect(recallAtK(["a", "b", "c"], ["a", "b"], 5)).toBe(1);
  });
  it("k 为 0 永远 0", () => {
    expect(recallAtK(["a"], ["a"], 0)).toBe(0);
  });
});

describe("precisionAtK", () => {
  it("top-k 中相关比例", () => {
    expect(precisionAtK(["a", "b", "c"], ["a"], 3)).toBeCloseTo(1 / 3);
  });
  it("空候选为 0", () => {
    expect(precisionAtK([], ["a"], 3)).toBe(0);
  });
});

describe("mrr", () => {
  it("第一个期望排名倒数", () => {
    expect(mrr(["x", "a", "b"], ["a"])).toBeCloseTo(0.5);   // 排名第 2 → 1/2
  });
  it("期望在前为 1", () => {
    expect(mrr(["a", "b"], ["a"])).toBe(1);
  });
  it("未命中为 0", () => {
    expect(mrr(["x", "y"], ["a"])).toBe(0);
  });
  it("时间冲突：旧记忆排新记忆前面不得分（只认期望的排名）", () => {
    // 查询当前态，期望=[new]；old 相关但不在期望
    expect(mrr(["user/fitness-schedule", "user/fitness-schedule-new"], ["user/fitness-schedule-new"])).toBeCloseTo(0.5);
  });
});

describe("computeBehaviorMetrics（v1 口径）", () => {
  it("按 A/B/D 组计算 recallA / triggerRateB / falsePositiveB / fabricateD", () => {
    const results = [
      { id: "a1", group: "A" as const, triggered: true, candidates: ["user/food-preferences"], expectedSlugs: ["user/food-preferences"] },
      { id: "a2", group: "A" as const, triggered: false, candidates: [], expectedSlugs: ["project/q3-launch"] },
      { id: "b1", group: "B" as const, triggered: true, candidates: [], expectedSlugs: [] },          // 空触发：调用了工具但没选中
      { id: "b2", group: "B" as const, triggered: true, candidates: ["user/neovim-workflow"], expectedSlugs: [] }, // 触发并注入无关
      { id: "d1", group: "D" as const, triggered: true, candidates: [], expectedSlugs: [] },          // 弃权合格
    ];
    const m = computeBehaviorMetrics(results);
    expect(m.recallA).toBeCloseTo(0.5);          // a1 命中，a2 漏
    expect(m.triggerRateB).toBe(1);              // b1、b2 都调用了工具
    expect(m.falsePositiveB).toBeCloseTo(0.5);   // b2 注入，b1 空触发不算
    expect(m.precision).toBeCloseTo(0.5);        // a1 正确 1 条 + b2 错选 1 条 → 1/2（v1 口径）
    expect(m.fabricateD).toBe(0);                // d1 弃权
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/scripts/eval-recall/lib/metrics.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
// packages/core/scripts/eval-recall/lib/metrics.ts
import type { CaseGroup } from "./recaller.js";

/** 期望 ⊆ top-k？多期望全部命中才算 1。 */
export function recallAtK(ranked: string[], expected: string[], k: number): number {
  if (k <= 0 || expected.length === 0) return 0;
  const top = ranked.slice(0, k);
  return expected.every((s) => top.includes(s)) ? 1 : 0;
}

/** |top-k ∩ 期望| ÷ k；空候选返回 0。 */
export function precisionAtK(ranked: string[], expected: string[], k: number): number {
  const top = ranked.slice(0, k);
  if (top.length === 0) return 0;
  const hit = top.filter((s) => expected.includes(s)).length;
  return hit / k;
}

/** 第一个期望 slug 排名的倒数；未命中 0。旧记忆排前面不得分（只认期望）。 */
export function mrr(ranked: string[], expected: string[]): number {
  if (expected.length === 0) return 0;
  for (let i = 0; i < ranked.length; i++) {
    if (expected.includes(ranked[i])) return 1 / (i + 1);
  }
  return 0;
}

export interface PerCaseBehavior {
  id: string;
  group: CaseGroup;
  triggered: boolean;
  candidates: string[];
  expectedSlugs: string[];
}

export interface BehaviorMetrics {
  recallA: number;
  triggerRateB: number;
  falsePositiveB: number;
  precision: number;
  fabricateD: number;
}

/** v1 行为指标，口径与 A-B-test-v1.md §3.4 一致。 */
export function computeBehaviorMetrics(results: PerCaseBehavior[]): BehaviorMetrics {
  const A = results.filter((r) => r.group === "A");
  const B = results.filter((r) => r.group === "B");
  const D = results.filter((r) => r.group === "D");
  const recallA = A.length ? A.filter((r) => r.expectedSlugs.every((s) => r.candidates.includes(s))).length / A.length : 0;
  const triggerRateB = B.length ? B.filter((r) => r.triggered).length / B.length : 0;
  const falsePositiveB = B.length ? B.filter((r) => r.candidates.length > 0).length / B.length : 0;
  // 与 v1（eval-recall.ts）口径一致：正确 = 选中的 slug 出现在任一用例的 expectedSlugs 里。
  // 例如 B 组选中某 A 组的期望 slug：对 precision 是"正确"（对 falsePositiveB 仍是误召回）。
  const totalExpected = results.flatMap((r) => r.expectedSlugs);
  const totalSelected = results.reduce((n, r) => n + r.candidates.length, 0);
  const totalCorrect = results.reduce(
    (n, r) => n + r.candidates.filter((s) => totalExpected.includes(s)).length,
    0
  );
  const precision = totalSelected === 0 ? 1 : totalCorrect / totalSelected;
  const fabricateD = D.length ? D.filter((r) => r.candidates.length > 0).length / D.length : 0;
  return { recallA, triggerRateB, falsePositiveB, precision, fabricateD };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/core/scripts/eval-recall/lib/metrics.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
git add packages/core/scripts/eval-recall/lib/metrics.ts packages/core/scripts/eval-recall/lib/metrics.test.ts
git commit -m "feat(eval): RAG + 行为指标纯函数"
```

---

### Task 3: 数据集自检

**Files:**
- Create: `packages/core/scripts/eval-recall/lib/validate.ts`
- Test: `packages/core/scripts/eval-recall/lib/validate.test.ts`

**Interfaces:**
- Consumes: `Seed`, `Case`, `DEFAULT_K`（from recaller.ts）
- Produces: `ValidationIssue`、`validateDataset(seeds, cases): ValidationIssue[]`、`assertValidDataset(seeds, cases): void`（有 error 级 issue 则 throw）

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/scripts/eval-recall/lib/validate.test.ts
import { describe, expect, it } from "vitest";
import { validateDataset, assertValidDataset } from "./validate.js";
import type { Seed, Case } from "./recaller.js";

const seed: Seed = { slug: "user/food-preferences", name: "食物偏好", description: "爱吃甜", type: "user", keywords: ["甜食"], content: "爱吃甜食。" };
const seeds: Seed[] = [
  seed,
  { ...seed, slug: "user/fitness-schedule", name: "旧健身", type: "user", keywords: ["健身"], content: "周三晚健身。", conflictsWith: "user/fitness-schedule-new" },
  { ...seed, slug: "user/fitness-schedule-new", name: "新健身", type: "user", keywords: ["晨练"], content: "周一四早晨练。" },
];
const base: Case = { id: "c1", group: "A", query: "宵夜吃什么？", expectRecall: true, expectedSlugs: ["user/food-preferences"] };

describe("validateDataset", () => {
  it("合法数据无 error", () => {
    const issues = validateDataset(seeds, [base]);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("expectedSlug 不存在 → error", () => {
    const issues = validateDataset(seeds, [{ ...base, expectedSlugs: ["user/nonexistent"] }]);
    expect(issues.some((i) => i.severity === "error" && i.message.includes("user/nonexistent"))).toBe(true);
  });

  it("k 小于期望数 → error", () => {
    const issues = validateDataset(seeds, [{ ...base, expectedSlugs: ["user/food-preferences", "user/fitness-schedule"], k: 1 }]);
    expect(issues.some((i) => i.severity === "error" && i.message.includes("k=1"))).toBe(true);
  });

  it("time-conflict 用例期望了被替代记忆 → error", () => {
    const issues = validateDataset(seeds, [{ ...base, dimensions: ["time-conflict"], expectedSlugs: ["user/fitness-schedule"] }]);
    expect(issues.some((i) => i.severity === "error" && i.message.includes("被替代"))).toBe(true);
  });

  it("similar-pair 用例期望数 ≠ 1 → error", () => {
    const issues = validateDataset(seeds, [{ ...base, dimensions: ["similar-pair"], expectedSlugs: ["user/food-preferences", "user/fitness-schedule"] }]);
    expect(issues.some((i) => i.severity === "error" && i.message.includes("唯一命中"))).toBe(true);
  });

  it("conflictsWith 目标不存在 → error", () => {
    const issues = validateDataset([{ ...seed, slug: "s1", conflictsWith: "s2-missing" }], [base]);
    expect(issues.some((i) => i.severity === "error" && i.message.includes("s2-missing"))).toBe(true);
  });
});

describe("assertValidDataset", () => {
  it("有 error 时 throw", () => {
    expect(() => assertValidDataset(seeds, [{ ...base, expectedSlugs: ["user/nonexistent"] }])).toThrow("数据集校验失败");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/scripts/eval-recall/lib/validate.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
// packages/core/scripts/eval-recall/lib/validate.ts
import type { Seed, Case } from "./recaller.js";
import { DEFAULT_K } from "./recaller.js";

export interface ValidationIssue {
  severity: "error" | "warning";
  message: string;
}

export function validateDataset(seeds: Seed[], cases: Case[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const slugs = new Set(seeds.map((s) => s.slug));
  const superseded = new Set<string>();

  for (const c of cases) {
    for (const s of c.expectedSlugs) {
      if (!slugs.has(s)) issues.push({ severity: "error", message: `${c.id}: expectedSlug ${s} 不存在于种子` });
    }
    const k = c.k ?? DEFAULT_K;
    if (k < c.expectedSlugs.length) {
      issues.push({ severity: "error", message: `${c.id}: k=${k} < expectedSlugs.length=${c.expectedSlugs.length}` });
    }
    if (c.set && c.set !== "core" && c.set !== "extended") {
      issues.push({ severity: "error", message: `${c.id}: 非法 set ${c.set}` });
    }
  }

  for (const s of seeds) {
    if (s.conflictsWith) {
      if (!slugs.has(s.conflictsWith)) {
        issues.push({ severity: "error", message: `${s.slug}: conflictsWith ${s.conflictsWith} 不存在` });
      }
      superseded.add(s.slug);
    }
  }

  for (const c of cases) {
    if (c.dimensions?.includes("time-conflict")) {
      for (const s of c.expectedSlugs) {
        if (superseded.has(s)) issues.push({ severity: "error", message: `${c.id}: time-conflict 用例期望了被替代记忆 ${s}` });
      }
    }
    if (c.dimensions?.includes("similar-pair") && c.expectedSlugs.length !== 1) {
      issues.push({ severity: "error", message: `${c.id}: similar-pair 用例期望必须唯一命中其一` });
    }
  }

  return issues;
}

export function assertValidDataset(seeds: Seed[], cases: Case[]): void {
  const errors = validateDataset(seeds, cases).filter((i) => i.severity === "error");
  if (errors.length) {
    throw new Error("数据集校验失败：\n" + errors.map((e) => `  - ${e.message}`).join("\n"));
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/core/scripts/eval-recall/lib/validate.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
git add packages/core/scripts/eval-recall/lib/validate.ts packages/core/scripts/eval-recall/lib/validate.test.ts
git commit -m "feat(eval): 数据集自检"
```

---

### Task 4: 统一评测 runner

**Files:**
- Create: `packages/core/scripts/eval-recall/lib/eval-runner.ts`
- Test: `packages/core/scripts/eval-recall/lib/eval-runner.test.ts`

**Interfaces:**
- Consumes: `Seed`/`Case`/`Recaller`/`DEFAULT_K`（recaller.ts）、`recallAtK`/`precisionAtK`/`mrr`/`computeBehaviorMetrics`（metrics.ts）、`assertValidDataset`（validate.ts）、`MemoryStore`（`packages/core/src/memory/store.js`）
- Produces: `writeSeedMemory(dir, seed)`、`buildEvalStore(seeds): Promise<{store, cleanup}>`、`EvalConfig`、`PerCaseResult`、`EvalSummary`、`runEvaluation(config): Promise<EvalSummary>`

- [ ] **Step 1: 写失败测试（fake Recaller 驱动 runner）**

```ts
// packages/core/scripts/eval-recall/lib/eval-runner.test.ts
import { describe, expect, it } from "vitest";
import { runEvaluation } from "./eval-runner.js";
import type { Seed, Case, Recaller } from "./recaller.js";

const seeds: Seed[] = [
  { slug: "user/food-preferences", name: "食物偏好", description: "爱吃甜", type: "user", keywords: ["甜食"], content: "爱吃甜食。" },
];
const cases: Case[] = [
  { id: "a1", group: "A", query: "宵夜吃什么？", expectRecall: true, expectedSlugs: ["user/food-preferences"] },
  { id: "a2", group: "A", query: "上线时间", expectRecall: true, expectedSlugs: ["project/q3-launch"] },  // 期望不存在 → 数据自检应拦截
];

const fakeRecall = (cands: string[]): Recaller => ({
  kind: "rag-keyword",
  async retrieve() {
    return { candidates: cands.map((slug, i) => ({ slug, score: 1 - i })), triggered: true };
  },
});

describe("runEvaluation", () => {
  it("数据自检失败时直接 throw（a2 期望不存在）", async () => {
    await expect(runEvaluation({ recaller: fakeRecall([]), seeds, cases })).rejects.toThrow("数据集校验失败");
  });

  it("合法数据：计算 RAG 指标与行为指标、标记 hit", async () => {
    const good = cases.filter((c) => c.id !== "a2");
    const summary = await runEvaluation({ recaller: fakeRecall(["user/food-preferences", "project/q3-launch"]), seeds, cases: good });
    expect(summary.perCase[0].hit).toBe(true);
    expect(summary.rag.recallAtK).toBe(1);
    expect(summary.rag.mrr).toBe(1);
    expect(summary.rag.precisionAtK).toBeCloseTo(1 / 5); // top-5 中 1 条相关
  });

  it("单条检索异常记为 failed 不拖垮整轮", async () => {
    const bad: Recaller = {
      kind: "rag-keyword",
      async retrieve(q) {
        if (q === "宵夜吃什么？") throw new Error("boom");
        return { candidates: [], triggered: true };
      },
    };
    const good = cases.filter((c) => c.id !== "a2");
    const summary = await runEvaluation({ recaller: bad, seeds, cases: good });
    expect(summary.failed).toBe(1);
    expect(summary.perCase.find((r) => r.id === "a1")?.failed).toBe("Error: boom");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/scripts/eval-recall/lib/eval-runner.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
// packages/core/scripts/eval-recall/lib/eval-runner.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStore } from "../../../src/memory/store.js";
import type { Seed, Case, CaseGroup, Recaller } from "./recaller.js";
import { DEFAULT_K } from "./recaller.js";
import { recallAtK, precisionAtK, mrr, computeBehaviorMetrics, type BehaviorMetrics } from "./metrics.js";
import { assertValidDataset } from "./validate.js";

/** 写一条种子记忆到目录（frontmatter 格式必须与 store.parse() 兼容，参照 eval-recall.ts）。 */
export function writeSeedMemory(dir: string, seed: Seed): void {
  const file = path.join(dir, `${seed.slug}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fm = [
    "---",
    `name: ${seed.name}`,
    `description: ${seed.description}`,
    `type: ${seed.type}`,
    "createdAt: 2026-08-01T00:00:00.000Z",
    "updatedAt: 2026-08-01T00:00:00.000Z",
    "pinned: false",
    `keywords: ${JSON.stringify(seed.keywords)}`,
    "---",
    "",
    seed.content,
  ].join("\n");
  fs.writeFileSync(file, fm);
}

/** 临时目录建 MemoryStore；校验种子全部解析成功。 */
export async function buildEvalStore(seeds: Seed[]): Promise<{ store: MemoryStore; cleanup: () => void }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eval-recall-"));
  for (const s of seeds) writeSeedMemory(tmp, s);
  const store = new MemoryStore(tmp);
  await store.rebuildIndex();
  const loaded = await store.listAll();
  if (loaded.length !== seeds.length) throw new Error(`种子解析失败：${loaded.length}/${seeds.length}`);
  return { store, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

export interface EvalConfig {
  recaller: Recaller;
  seeds: Seed[];
  cases: Case[];
  // 注意：runner 只用数据 + recaller，不持有 store——store 由调用方建适配器时单独持有。
}

export interface PerCaseResult {
  id: string;
  group: CaseGroup;
  set: string;
  dimensions: string[];
  expectedSlugs: string[];
  k: number;
  candidates: string[];
  triggered: boolean;
  hit: boolean;
  failed?: string;
}

export interface EvalSummary {
  kind: string;
  perCase: PerCaseResult[];
  failed: number;
  rag: { recallAtK: number; precisionAtK: number; mrr: number };
  behavior: BehaviorMetrics;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export async function runEvaluation(cfg: EvalConfig): Promise<EvalSummary> {
  assertValidDataset(cfg.seeds, cfg.cases);
  const perCase: PerCaseResult[] = [];
  for (const c of cfg.cases) {
    const k = c.k ?? DEFAULT_K;
    let candidates: string[] = [];
    let triggered = false;
    let failed: string | undefined;
    try {
      const res = await cfg.recaller.retrieve(c.query, { topK: k });
      triggered = res.triggered ?? true;
      candidates = res.candidates.map((x) => x.slug).slice(0, k);
    } catch (e) {
      failed = String(e);
    }
    const hit = c.expectedSlugs.length > 0 && c.expectedSlugs.every((s) => candidates.includes(s));
    perCase.push({
      id: c.id, group: c.group, set: c.set ?? "core", dimensions: c.dimensions ?? [],
      expectedSlugs: c.expectedSlugs, k, candidates, triggered, hit, failed,
    });
  }
  const valid = perCase.filter((r) => !r.failed);
  const rag = {
    recallAtK: avg(valid.map((r) => recallAtK(r.candidates, r.expectedSlugs, r.k))),
    precisionAtK: avg(valid.map((r) => precisionAtK(r.candidates, r.expectedSlugs, r.k))),
    mrr: avg(valid.map((r) => mrr(r.candidates, r.expectedSlugs))),
  };
  const behavior = computeBehaviorMetrics(valid);
  return { kind: cfg.recaller.kind, perCase, failed: perCase.length - valid.length, rag, behavior };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/core/scripts/eval-recall/lib/eval-runner.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
git add packages/core/scripts/eval-recall/lib/eval-runner.ts packages/core/scripts/eval-recall/lib/eval-runner.test.ts
git commit -m "feat(eval): 统一评测 runner（含 buildEvalStore）"
```

---

### Task 5: RAG 关键词基线检索器

**Files:**
- Create: `packages/core/scripts/eval-recall/adapters/rag-keyword.ts`
- Test: `packages/core/scripts/eval-recall/adapters/rag-keyword.test.ts`

**Interfaces:**
- Consumes: `MemoryStore`（`packages/core/src/memory/store.js`）、`Recaller`/`RecallResult`（recaller.ts）、`buildEvalStore`（eval-runner.ts）
- Produces: `createRagKeywordRecaller({ store }): Recaller`（`kind: "rag-keyword"`，确定性）

**实现说明**：query 分词 = 拉丁词（`[a-z0-9_]+`）+ CJK 单字 + 相邻双字。每条记忆按字段加权打分：keywords/name 权重 3、description 权重 2、content 权重 1。分数 = Σ（查询 token 在该字段中出现的次数 × 权重）。按分数降序取 topK。纯本地计算，无 LLM。

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/scripts/eval-recall/adapters/rag-keyword.test.ts
import { describe, expect, it } from "vitest";
import { createRagKeywordRecaller } from "./rag-keyword.js";
import { buildEvalStore } from "../lib/eval-runner.js";
import type { Seed } from "../lib/recaller.js";

const seeds: Seed[] = [
  { slug: "user/food-preferences", name: "食物偏好", description: "喜欢蛋挞和甜食，不吃辣", type: "user", keywords: ["蛋挞", "甜食"], content: "用户喜欢吃蛋挞，宵夜尤其爱吃。" },
  { slug: "reference/docker-cheatsheet", name: "Docker 备忘", description: "Docker 常用命令", type: "reference", keywords: ["docker"], content: "Docker 镜像、容器、卷的常用命令。" },
  { slug: "user/fitness-schedule", name: "健身时间", description: "周三周五晚健身", type: "user", keywords: ["健身"], content: "每周三和周五晚上 7 点去健身房。" },
  { slug: "user/fitness-schedule-new", name: "晨练新安排", description: "周一四早 6:30 晨练", type: "user", keywords: ["晨练"], content: "改为每周一、周四早上 6:30 晨练。" },
];

describe("createRagKeywordRecaller", () => {
  let store: Awaited<ReturnType<typeof buildEvalStore>>["store"];

  it("单跳命中：'宵夜吃什么好' → food-preferences 进 top", async () => {
    const { store, cleanup } = await buildEvalStore(seeds);
    try {
      const r = createRagKeywordRecaller({ store });
      const res = await r.retrieve("宵夜吃什么好？", { topK: 3 });
      expect(res.candidates[0].slug).toBe("user/food-preferences");
    } finally { cleanup(); }
  });

  it("关键词撞车：'docker compose 入门' → docker-cheatsheet 靠前，健身记忆靠后", async () => {
    const { store, cleanup } = await buildEvalStore(seeds);
    try {
      const r = createRagKeywordRecaller({ store });
      const res = await r.retrieve("docker compose 怎么入门", { topK: 3 });
      expect(res.candidates[0].slug).toBe("reference/docker-cheatsheet");
    } finally { cleanup(); }
  });

  it("时间冲突：'现在健身时间' 新旧记忆都在候选，但期望的新记忆在 top 且旧记忆可能也在（排序由分数定）", async () => {
    const { store, cleanup } = await buildEvalStore(seeds);
    try {
      const r = createRagKeywordRecaller({ store });
      const res = await r.retrieve("现在健身是晚上还是早上？", { topK: 3 });
      const slugs = res.candidates.map((c) => c.slug);
      expect(slugs).toContain("user/fitness-schedule-new");
    } finally { cleanup(); }
  });

  it("确定性：同一输入两次结果一致", async () => {
    const { store, cleanup } = await buildEvalStore(seeds);
    try {
      const r = createRagKeywordRecaller({ store });
      const a = await r.retrieve("宵夜吃什么好？", { topK: 3 });
      const b = await r.retrieve("宵夜吃什么好？", { topK: 3 });
      expect(a.candidates.map((c) => c.slug)).toEqual(b.candidates.map((c) => c.slug));
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/scripts/eval-recall/adapters/rag-keyword.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/core/scripts/eval-recall/adapters/rag-keyword.test.ts`
Expected: PASS（全部用例）。若"docker compose 怎么入门"未把 docker-cheatsheet 排第一，检查分词是否覆盖了 "compose"（拉丁词命中 content 里的 "docker"？）——必要时在 docker-cheatsheet 的 keywords 或 content 里加 "compose" 相关词。

- [ ] **Step 5: Commit**

```bash
git add packages/core/scripts/eval-recall/adapters/rag-keyword.ts packages/core/scripts/eval-recall/adapters/rag-keyword.test.ts
git commit -m "feat(eval): RAG 关键词基线检索器"
```

---

### Task 6: v1 适配器（LLM 召回对照基线）

**Files:**
- Create: `packages/core/scripts/eval-recall/adapters/recall-tool.ts`
- Test: `packages/core/scripts/eval-recall/adapters/recall-tool.test.ts`

**Interfaces:**
- Consumes: `MemoryStore`、`LLMProvider`（`packages/core/src/llm/provider.js`）、`ConversationManager`/`SystemPrompt`/`loadDefaultLayers`/`currentDateLayer`（conversation）、`ToolRegistry`/`ToolExecutor`、`collectResponse`（`agent/react.js`）、`createMemoryRecallTool`（`tools/builtin/memory-recall.js`）、`createRecallAgent`（`memory/recall-agent.js`）、`memoryPresenceLayer`（`memory/presence-layer.js`）、`LoadedMemoryRegistry`（`memory/loaded-memory-registry.js`）
- Produces: `parseSelectedSlugs(content): string[]`（解析 `## name (slug)` 行）、`createRecallToolRecaller(deps): Recaller`（`kind: "v1-tool"`）

**设计要点**：**单轮简化**（spec §4.2 决策 A）——只调一次 `collectResponse`，若主模型首次回复是 `tool-use` 且含 `memory_recall`，执行该工具、从返回解析选中 slug；否则 triggered=false、候选为空。不跑完整 agentic 循环。`runRecall` 可注入（测试用 stub），默认走真实 recall-agent。

- [ ] **Step 1: 写失败测试（scripted provider，参照 recall-agent.test.ts 的模式）**

```ts
// packages/core/scripts/eval-recall/adapters/recall-tool.test.ts
import { describe, expect, it, vi } from "vitest";
import { createRecallToolRecaller, parseSelectedSlugs } from "./recall-tool.js";
import { buildEvalStore } from "../lib/eval-runner.js";
import type { Seed } from "../lib/recaller.js";
import { LoadedMemoryRegistry } from "../../../src/memory/loaded-memory-registry.js";
import type { LLMProvider, StreamChunk, ChatRequest, Message, ChatResponse } from "../../../src/llm/provider.js";

const seeds: Seed[] = [
  { slug: "user/food-preferences", name: "食物偏好", description: "爱吃甜", type: "user", keywords: ["甜食"], content: "爱吃甜食。" },
];

/** scripted LLM：stream 按调用依次产出队列里的 chunk 序列。 */
class ScriptedProvider implements LLMProvider {
  constructor(private scripts: StreamChunk[][]) {}
  get name(): string { return "scripted"; }
  get maxContextTokens(): number { return 128_000; }
  chat(_req: ChatRequest): Promise<ChatResponse> { throw new Error("not used"); }
  countTokens(_m: Message[]): number { return 0; }
  async *stream(): AsyncIterable<StreamChunk> {
    const s = this.scripts.shift() ?? [];
    for (const c of s) yield c;
  }
}

describe("parseSelectedSlugs", () => {
  it("解析 ## name (slug) 行", () => {
    const content = "## 食物偏好 (user/food-preferences)\n相关记忆。\n## 健身 (user/fitness-schedule)";
    expect(parseSelectedSlugs(content)).toEqual(["user/food-preferences", "user/fitness-schedule"]);
  });
  it("无匹配返回空", () => {
    expect(parseSelectedSlugs("未找到相关记忆。")).toEqual([]);
  });
});

describe("createRecallToolRecaller", () => {
  it("主模型触发 → candidates 来自注入的 runRecall", async () => {
    const { store, cleanup } = await buildEvalStore(seeds);
    try {
      const toolUse: StreamChunk = {
        type: "tool-use",
        toolUse: { id: "t1", name: "memory_recall", input: { query: "宵夜吃什么好？", keywords: ["宵夜"] } },
      };
      const llm = new ScriptedProvider([[toolUse]]);
      const runRecall = vi.fn(async () => ["user/food-preferences"]);
      const r = createRecallToolRecaller({
        llm, model: "deepseek-chat", store, registry: new LoadedMemoryRegistry(), runRecall,
      });
      const res = await r.retrieve("宵夜吃什么好？", { topK: 5 });
      expect(res.triggered).toBe(true);
      expect(res.candidates.map((c) => c.slug)).toEqual(["user/food-preferences"]);
    } finally { cleanup(); }
  });

  it("主模型未触发（文本回复）→ candidates 为空", async () => {
    const { store, cleanup } = await buildEvalStore(seeds);
    try {
      const text: StreamChunk = { type: "token", text: "我不知道你宵夜想吃什么。" };
      const llm = new ScriptedProvider([[text]]);
      const runRecall = vi.fn(async () => ["user/food-preferences"]);
      const r = createRecallToolRecaller({
        llm, model: "deepseek-chat", store, registry: new LoadedMemoryRegistry(), runRecall,
      });
      const res = await r.retrieve("宵夜吃什么好？", { topK: 5 });
      expect(res.triggered).toBe(false);
      expect(res.candidates).toEqual([]);
      expect(runRecall).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/scripts/eval-recall/adapters/recall-tool.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
// packages/core/scripts/eval-recall/adapters/recall-tool.ts
import type { LLMProvider } from "../../../src/llm/provider.js";
import type { MemoryStore } from "../../../src/memory/store.js";
import type { LoadedMemoryRegistry } from "../../../src/memory/loaded-memory-registry.js";
import { ConversationManager } from "../../../src/conversation/manager.js";
import { SystemPrompt, loadDefaultLayers, currentDateLayer } from "../../../src/conversation/system-prompt.js";
import { ToolRegistry } from "../../../src/tools/registry.js";
import { ToolExecutor } from "../../../src/tools/executor.js";
import { collectResponse } from "../../../src/agent/react.js";
import { createMemoryRecallTool } from "../../../src/tools/builtin/memory-recall.js";
import { createRecallAgent } from "../../../src/memory/recall-agent.js";
import { memoryPresenceLayer } from "../../../src/memory/presence-layer.js";
import type { RecallResult, Recaller } from "../lib/recaller.js";

export interface RecallToolRecallerDeps {
  llm: LLMProvider;
  model?: string;
  store: MemoryStore;
  registry: LoadedMemoryRegistry;
  /** 可注入（测试用）；默认走真实 recall-agent。 */
  runRecall?: (query: string, keywords: string[]) => Promise<string[]>;
  trace?: string[];
}

/** 从 memory_recall 工具返回内容解析选中 slug：`## name (slug)` 行。 */
export function parseSelectedSlugs(content: string): string[] {
  return [...content.matchAll(/^## .* \(([^)]+)\)$/gm)].map((m) => m[1]);
}

/**
 * v1 对照基线：主模型自主决定是否调 memory_recall（单轮简化，spec §4.2 决策 A）。
 * 只取第一次 collectResponse 的结果，不跑完整 agentic 循环。
 */
export function createRecallToolRecaller(deps: RecallToolRecallerDeps): Recaller {
  return {
    kind: "v1-tool",
    async retrieve(query, _opts): Promise<RecallResult> {
      const conv = new ConversationManager({ model: deps.model ?? "deepseek-chat" });
      const sp = new SystemPrompt();
      for (const layer of loadDefaultLayers()) sp.addLayer(layer);
      sp.addLayer(currentDateLayer());
      sp.addLayer(memoryPresenceLayer((await deps.store.listAll()).length));
      conv.systemPrompt = sp;
      conv.addUserMessage(query);

      const agent = createRecallAgent({ llm: deps.llm, model: deps.model ?? "deepseek-chat", store: deps.store, trace: deps.trace });
      const runRecall = deps.runRecall ?? ((q, kw) => agent.run(q, kw));
      const tools = new ToolRegistry();
      tools.register(createMemoryRecallTool({ runRecall, store: deps.store, registry: deps.registry }));

      const res = await collectResponse(deps.llm, conv.buildMessages(), tools.toLLMTools(), conv);
      if (res.type === "tool-use") {
        const call = res.toolUses.find((t) => t.name === "memory_recall");
        if (call) {
          const executor = new ToolExecutor(tools);
          const [toolRes] = await executor.executeParallel([call]);
          const content = toolRes.status === "success" ? toolRes.content : "";
          const slugs = parseSelectedSlugs(content);
          return { triggered: true, candidates: slugs.map((slug, i) => ({ slug, score: 1 - i / 10 })) };
        }
      }
      return { triggered: false, candidates: [] };
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/core/scripts/eval-recall/adapters/recall-tool.test.ts`
Expected: PASS（全部用例）。若 scripted provider 与 `collectResponse` 的流处理不兼容（如需要额外的 usage/stream-complete chunk），参照 `recall-agent.test.ts` 现有 scripted LLM 的 chunk 序列补齐。

- [ ] **Step 5: Commit**

```bash
git add packages/core/scripts/eval-recall/adapters/recall-tool.ts packages/core/scripts/eval-recall/adapters/recall-tool.test.ts
git commit -m "feat(eval): v1 适配器（单轮简化）"
```

---

### Task 7: RAG 混合检索器骨架

**Files:**
- Create: `packages/core/scripts/eval-recall/adapters/rag-retriever.ts`
- Test: `packages/core/scripts/eval-recall/adapters/rag-retriever.test.ts`

**Interfaces:**
- Consumes: `MemoryStore`、`createRagKeywordRecaller`（rag-keyword.ts）、`Recaller`（recaller.ts）
- Produces: `createRagRetriever({ store }): Recaller`（`kind: "rag-retriever"`）

**设计要点**：向量未接入，当前委托关键词基线。embedding 接入点见 `retrieve` 内的注释。骨架测试 = 行为与关键词基线一致。

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/scripts/eval-recall/adapters/rag-retriever.test.ts
import { describe, expect, it } from "vitest";
import { createRagRetriever } from "./rag-retriever.js";
import { createRagKeywordRecaller } from "./rag-keyword.js";
import { buildEvalStore } from "../lib/eval-runner.js";
import type { Seed } from "../lib/recaller.js";

const seeds: Seed[] = [
  { slug: "user/food-preferences", name: "食物偏好", description: "爱吃甜", type: "user", keywords: ["甜食"], content: "爱吃甜食。" },
];

describe("createRagRetriever（骨架）", () => {
  it("kind 为 rag-retriever，行为与关键词基线一致", async () => {
    const { store, cleanup } = await buildEvalStore(seeds);
    try {
      const hybrid = createRagRetriever({ store });
      const kw = createRagKeywordRecaller({ store });
      expect(hybrid.kind).toBe("rag-retriever");
      const a = await hybrid.retrieve("宵夜吃什么？", { topK: 3 });
      const b = await kw.retrieve("宵夜吃什么？", { topK: 3 });
      expect(a.candidates.map((c) => c.slug)).toEqual(b.candidates.map((c) => c.slug));
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/scripts/eval-recall/adapters/rag-retriever.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
// packages/core/scripts/eval-recall/adapters/rag-retriever.ts
import type { MemoryStore } from "../../../src/memory/store.js";
import type { RecallResult, Recaller } from "../lib/recaller.js";
import { createRagKeywordRecaller } from "./rag-keyword.js";

/**
 * RAG 混合检索器（向量 + 关键词）。
 * 骨架态：向量模型未接入，当前委托关键词基线（确定性），保证评测管线先行跑通。
 * 接入点：在此处新增向量评分项，与关键词分数混合加权排序后返回 topK。
 */
export function createRagRetriever(deps: { store: MemoryStore }): Recaller {
  const keyword = createRagKeywordRecaller(deps);
  return {
    kind: "rag-retriever",
    async retrieve(query, opts): Promise<RecallResult> {
      // TODO(vector): 叠加 embedding 相似度评分后再排序。当前仅关键词基线。
      return keyword.retrieve(query, opts);
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/core/scripts/eval-recall/adapters/rag-retriever.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/scripts/eval-recall/adapters/rag-retriever.ts packages/core/scripts/eval-recall/adapters/rag-retriever.test.ts
git commit -m "feat(eval): RAG 混合检索器骨架"
```

---

### Task 8: CLI 入口 run.ts

**Files:**
- Create: `packages/core/scripts/eval-recall/run.ts`

**Interfaces:**
- Consumes: `buildEvalStore`/`runEvaluation`（eval-runner.ts）、三个适配器工厂、`AnthropicProvider`（`llm/anthropic.js`）、`LoadedMemoryRegistry`
- Produces: 可执行 CLI（`pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=<kind>`）

**设计要点**：`--recaller=` 取值 `v1-tool` / `rag-keyword` / `rag-retriever`；默认 `rag-keyword`。加载 seed/cases JSON → 建临时 store → 按 kind 建适配器 → runEvaluation → 结果写 `results/results-<kind>-<ts>.json` + 控制台汇总。v1-tool 需要 `ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY`。temperature 强制 0（复用 `ZeroTempProvider` 包装）。

- [ ] **Step 1: 写实现**

```ts
// packages/core/scripts/eval-recall/run.ts
// 用法：
//   pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=rag-keyword
//   pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=v1-tool
//   （EVAL_MODEL 可覆盖默认模型；v1-tool 需要 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY）
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Seed, Case, Recaller, RecallerKind } from "./lib/recaller.js";
import { buildEvalStore, runEvaluation } from "./lib/eval-runner.js";
import { createRagKeywordRecaller } from "./adapters/rag-keyword.js";
import { createRagRetriever } from "./adapters/rag-retriever.js";
import { createRecallToolRecaller } from "./adapters/recall-tool.js";
import { AnthropicProvider } from "../../src/llm/anthropic.js";
import type { LLMProvider, ChatRequest, ChatResponse, StreamChunk, Message } from "../../src/llm/provider.js";
import { LoadedMemoryRegistry } from "../../src/memory/loaded-memory-registry.js";

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
  if (!["v1-tool", "rag-keyword", "rag-retriever"].includes(kind)) throw new Error(`未知 --recaller=${kind}`);

  const seeds = JSON.parse(fs.readFileSync(path.join(DATA, "seed-memories.json"), "utf-8")) as Seed[];
  const cases = JSON.parse(fs.readFileSync(path.join(DATA, "cases.json"), "utf-8")) as Case[];
  const { store, cleanup } = await buildEvalStore(seeds);

  let recaller: Recaller;
  if (kind === "rag-keyword") {
    recaller = createRagKeywordRecaller({ store });
  } else if (kind === "rag-retriever") {
    recaller = createRagRetriever({ store });
  } else {
    const apiKey = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("v1-tool 需要 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY");
    recaller = createRecallToolRecaller({
      llm: new ZeroTempProvider(new AnthropicProvider({ apiKey, baseUrl: process.env.ANTHROPIC_BASE_URL })),
      model: MODEL, store, registry: new LoadedMemoryRegistry(),
    });
  }

  const summary = await runEvaluation({ recaller, seeds, cases });
  cleanup();

  console.log(`\n[${kind}] 种子=${seeds.length} 用例=${cases.length} 失败=${summary.failed}`);
  console.log(`  RAG 指标: recall@k=${(summary.rag.recallAtK * 100).toFixed(1)}%  precision@k=${(summary.rag.precisionAtK * 100).toFixed(1)}%  MRR=${summary.rag.mrr.toFixed(3)}`);
  console.log(`  v1 行为指标: recallA=${(summary.behavior.recallA * 100).toFixed(1)}%  triggerB=${(summary.behavior.triggerRateB * 100).toFixed(1)}%  falsePosB=${(summary.behavior.falsePositiveB * 100).toFixed(1)}%  precision=${(summary.behavior.precision * 100).toFixed(1)}%  fabricateD=${(summary.behavior.fabricateD * 100).toFixed(1)}%`);

  const out = path.join(DATA, "results", `results-${kind}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ model: MODEL, kind, seeds: seeds.length, cases: cases.length, summary }, null, 2));
  console.log(`结果已写入 ${out}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: 冒烟测试（当前 21/29 数据，rag-keyword 不需要 API key）**

Run: `pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=rag-keyword`
Expected: exit 0，打印 `[rag-keyword]` 汇总行，`results/results-rag-keyword-*.json` 生成。若报路径错误，检查 `run.ts` 的 `DATA`（脚本位于 `eval-recall/` 目录内，`DATA = DIR` 即数据目录）。

- [ ] **Step 3: 提交**

```bash
git add packages/core/scripts/eval-recall/run.ts packages/core/scripts/eval-recall/results
git commit -m "feat(eval): CLI 入口 run.ts"
```

---

### Task 9: 扩展 seed-memories.json —— Part 1 分域干扰项

**Files:**
- Modify: `packages/core/scripts/eval-recall/seed-memories.json`

**设计要点**（spec §3.4）：**核心 21 条原样保留**。新增扩展记忆覆盖日常生活全谱系。所有扩展记忆带 `"set": "extended"`、`"domain"` 标签。干扰项**不挂任何用例**（纯垫库，增大检索难度）。内容风格参考现有 core 记忆：中文、简洁、个人助理视角的真实事实。

**分域与数量**（每域 3-4 条，共 ~40-50 条；12 个域）：

| domain | 建议内容方向（示例） |
|---|---|
| work | 项目节奏偏好 / 某同事工作习惯 / 最近一次需求评审结论 |
| health-diet | 每周体检安排 / 过敏原 / 外卖忌口 |
| family | 家人的生日 / 父母常住的联系方式 / 家里养的植物 |
| social | 周末聚会的朋友 / 某朋友的职业 / 上次一起露营的人 |
| travel | 已订的机票 / 想去的国家清单 / 护照有效期 |
| finance | 房贷还款日 / 公积金余额 / 每月信用卡账单日 |
| learning-tech | 在学的课程 / 收藏的文档 / 常用的开发工具链 |
| hobby | 在追的剧 / 钓鱼装备 / 相机型号 |
| home | 路由器管理密码 / 门锁指纹几号 / 家电保修期 |
| shopping | 常用超市 / 会员卡 / 上次换的床垫品牌 |
| pet | 宠物名字 / 疫苗日期 / 狗粮品牌 |
| personal-info | 常用快递地址 / 备用邮箱 / 证件编号 |

每条示例（干扰项，含 label）：

```jsonc
{ "slug": "user/home-router-password", "name": "路由器密码", "description": "家里路由器管理后台密码", "type": "user", "keywords": ["路由器", "密码"], "content": "家里路由器管理后台密码是 admin@2026，WiFi 密码记在手机备忘录。", "set": "extended", "domain": "home" }
```

**规则**：
- slug 命名 `user/<英文-kebab>`（与 core 一致）；reference 类用 `reference/<...>`。
- `type` 从 user/feedback/project/reference 取；干扰项以 user/project/reference 为主。
- 内容不与其他记忆重复；关键词贴合内容。
- 各域之间、以及与 core 的记忆在关键词上允许重叠（模拟真实），但正文语义不同。

- [ ] **Step 1: 编辑 seed-memories.json，追加 12 域干扰项（40-50 条）**

保持数组结构，在末尾追加对象；core 21 条不动。

- [ ] **Step 2: 验证数据格式合法 + 自检通过**

Run: `pnpm tsx -e "import('./packages/core/scripts/eval-recall/lib/validate.js').then(async ({validateDataset}) => { const f=await import('node:fs'); const seeds=JSON.parse(f.readFileSync('packages/core/scripts/eval-recall/seed-memories.json','utf-8')); const cases=JSON.parse(f.readFileSync('packages/core/scripts/eval-recall/cases.json','utf-8')); const errs=validateDataset(seeds,cases).filter(i=>i.severity==='error'); console.log('seeds:',seeds.length,'errors:',errs.length); if(errs.length) console.log(errs.map(e=>e.message).join('\\n')); })"`
Expected: `seeds: ~61-71`（21 + 40-50），`errors: 0`

- [ ] **Step 3: 冒烟跑 rag-keyword 确认可跑通**

Run: `pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=rag-keyword`
Expected: exit 0，无报错

- [ ] **Step 4: Commit**

```bash
git add packages/core/scripts/eval-recall/seed-memories.json
git commit -m "test(eval): 扩展记忆——分域干扰项（日常生活全谱系）"
```

---

### Task 10: 扩展 seed-memories.json —— Part 2 长段落 / 相似对 / 冲突对

**Files:**
- Modify: `packages/core/scripts/eval-recall/seed-memories.json`

**设计要点**：三组结构化扩展，全部 `set: "extended"`。

**A. 长段落记忆（5-8 条）**：几百字、多段落（空行分隔），模拟真实累积的记忆。用于测段落分块 + 归并回记忆。示例：

```jsonc
{
  "slug": "project/migration-journey",
  "name": "迁移记录",
  "description": "从 LangChain 迁到自研 agent runtime 的过程记录",
  "type": "project",
  "keywords": ["LangChain", "agent", "runtime", "迁移"],
  "content": "2026-05 决定不再用 LangChain 搭 ReAct，太重。\n\n自研 agent runtime 的第一版：react 循环 + 工具注册表 + event bus。\n\n2026-06 跑通第一个多步工具调用，去掉了 LangChain 的 AgentExecutor。\n\n现在重点是错误恢复和重试。",
  "set": "extended",
  "domain": "work"
}
```

**B. 相似记忆对（3-4 对）**：内容高度相似但语义不同，期望只命中其一。示例对（同一域、关键词重叠、语义不同）：

```jsonc
// 对 1：都在谈"健身"，一条是个人安排、一条是通用建议
{ "slug": "user/fitness-personal-tips", "name": "个人健身安排", "description": "我自己的训练计划", "type": "user", "keywords": ["健身", "训练", "计划"], "content": "我自己每周一四早 6:30 晨练，周末补一次力量训练。", "set": "extended", "domain": "health-diet" },
{ "slug": "reference/fitness-general-tips", "name": "健身通用建议", "description": "给新手看的健身建议整理", "type": "reference", "keywords": ["健身", "训练", "建议"], "content": "新手健身建议：循序渐进、重视休息、先学动作标准再上重量。", "set": "extended", "domain": "health-diet" }
```

**C. 时间状态冲突对（3-4 对）**：old/new 同主题，旧记忆带 `conflictsWith` 指向新记忆。示例（沿用你的例子）：

```jsonc
{ "slug": "user/tech-stack-langchain", "name": "旧技术栈", "description": "曾用 LangChain 构建 ReAct agent", "type": "project", "keywords": ["LangChain", "技术栈", "agent"], "content": "2026-05 前用 LangChain 构建 ReAct agent，AgentExecutor 驱动。", "set": "extended", "domain": "work", "conflictsWith": "project/migration-journey" }
```

> 注意：冲突对的"当前态"记忆可以是上面 A 里的长段落记忆（如 `project/migration-journey`），构成"旧 LangChain → 新自研 runtime"的完整叙事。

**规则**：相似对的记忆要能一眼看出不同（personal vs general / 事实 vs 观点）；冲突对的 `conflictsWith` 必须指向存在的记忆。

- [ ] **Step 1: 编辑 seed-memories.json 追加三组（共 ~20-28 条）**

- [ ] **Step 2: 验证自检通过（含 conflictsWith 目标存在）**

Run: 同 Task 9 Step 2 的校验命令
Expected: `errors: 0`（含 conflictsWith 目标存在），`seeds: ~81-95`

- [ ] **Step 3: Commit**

```bash
git add packages/core/scripts/eval-recall/seed-memories.json
git commit -m "test(eval): 扩展记忆——长段落/相似对/时间冲突对"
```

---

### Task 11: 扩展 cases.json —— 新用例 + 维度标签

**Files:**
- Modify: `packages/core/scripts/eval-recall/cases.json`

**设计要点**（spec §3.3/§3.4）：core 29 条**原样保留**。新增扩展用例，全部带 `set: "extended"` 与 `dimensions` 标签。

**A. 语义鲁棒性（8-10 条）**：改写 core 用例的查询表达，`expectedSlugs` 与对应 core 用例相同。示例：

```jsonc
{ "id": "r1", "group": "A", "query": "晚上想来点甜的解解馋，有啥推荐？", "expectRecall": true, "expectedSlugs": ["user/food-preferences"], "set": "extended", "dimensions": ["semantic-robustness"], "k": 5 },
{ "id": "r2", "group": "A", "query": "What model does LICode use by default?", "expectRecall": true, "expectedSlugs": ["project/deepseek-default"], "set": "extended", "dimensions": ["semantic-robustness"], "k": 5 }
```

**B. 时间状态冲突（3-4 条）**：每个冲突对一条查询当前态，`expectedSlugs` 只标当前态记忆。示例：

```jsonc
{ "id": "tc1", "group": "A", "query": "现在跑 agent 还是用 LangChain 吗？", "expectRecall": true, "expectedSlugs": ["project/migration-journey"], "set": "extended", "dimensions": ["time-conflict"], "k": 5 }
```

**C. 相似记忆对（3-4 条）**：每个相似对一条查询，`expectedSlugs` 只含其中一条。示例：

```jsonc
{ "id": "sp1", "group": "A", "query": "帮我看看我自己这周的健身安排", "expectRecall": true, "expectedSlugs": ["user/fitness-personal-tips"], "set": "extended", "dimensions": ["similar-pair"], "k": 5 }
```

**D. 长段落记忆（2-3 条）**：查询指向长段落记忆。示例：

```jsonc
{ "id": "lm1", "group": "A", "query": "我们现在这套 agent runtime 是怎么演进过来的？", "expectRecall": true, "expectedSlugs": ["project/migration-journey"], "set": "extended", "dimensions": ["long-memory"], "k": 5 }
```

**E. 补充干扰域抽查（3-5 条）**：从扩展库中挑几个域各出 1 条应召回用例，确保新记忆不是纯摆设。示例：

```jsonc
{ "id": "dmn1", "group": "A", "query": "家里路由器后台密码是多少来着？", "expectRecall": true, "expectedSlugs": ["user/home-router-password"], "set": "extended", "dimensions": ["single-hop"], "k": 5 }
```

**规则**：
- 所有扩展用例 `set: "extended"`；`dimensions` 必填（非空）。
- B 的 `expectedSlugs` 不得含被替代记忆（validate 会拦）。
- 新增后用 validate 校验。

- [ ] **Step 1: 编辑 cases.json 追加 A-E 组（共 ~20-26 条）**

- [ ] **Step 2: 验证自检通过**

Run: 同 Task 9 Step 2 的校验命令
Expected: `errors: 0`，`cases: ~49-55`

- [ ] **Step 3: 冒烟跑 rag-keyword + 抽查人工核对**

Run: `pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=rag-keyword`
Expected: exit 0；人工抽查 summary 中 `semantic-robustness` / `time-conflict` 用例的命中情况，确认标注合理。

- [ ] **Step 4: Commit**

```bash
git add packages/core/scripts/eval-recall/cases.json
git commit -m "test(eval): 扩展用例——语义鲁棒性/时间冲突/相似对/长段/干扰域"
```

---

### Task 12: 新方法论文档 eval-recall-v2.md

**Files:**
- Create: `packages/core/scripts/eval-recall/eval-recall-v2.md`

**内容**：参照 `A-B-test-v1.md` 的写法，记录 v2 评测的：
1. 目标与定位（检索层为主、端到端为辅；与 v1 的关系）
2. 数据构成（21 核心 + 扩展集规模与 5 个方向；维度标签词汇表；时间冲突评分语义）
3. 评测框架（Recaller 接口、三个适配器、统一 runner 命令）
4. 指标口径（recall@k / precision@k / MRR；v1 行为指标；冲突对在指标里的表现）
5. 运行方式（三条 `run.ts --recaller=` 命令；temperature=0；可复现性）
6. 历史链接（A-B-test-v1.md、spec、plan）

- [ ] **Step 1: 写文档**

- [ ] **Step 2: 提交**

```bash
git add packages/core/scripts/eval-recall/eval-recall-v2.md
git commit -m "docs(eval): 记忆测试集 v2 方法论文档"
```

---

### Task 13: 全库跑通 + 首批对比结果

**Files:**
- Create: `packages/core/scripts/eval-recall/results/results-rag-keyword-*.json`、`results/results-v1-tool-*.json`

**设计要点**：在扩展后的全库上产出首批结果，两条路径同尺对比（spec §7 本期交付 3）。

- [ ] **Step 1: 跑 rag-keyword（确定性，一次）**

Run: `pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=rag-keyword`
Expected: 输出 `[rag-keyword]` 汇总（recall@k / precision@k / MRR），结果文件生成

- [ ] **Step 2: 跑 rag-retriever（骨架，应与 rag-keyword 一致）**

Run: `pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=rag-retriever`
Expected: 汇总与 rag-keyword 相同（骨架委托关键词基线）

- [ ] **Step 3: 跑 v1-tool（真实 LLM，跑 2 次取范围）**

Run: `ANTHROPIC_AUTH_TOKEN=... pnpm tsx packages/core/scripts/eval-recall/run.ts --recaller=v1-tool`（EVAL_MODEL 默认 deepseek-chat；跑两遍）
Expected: 输出 `[v1-tool]` 汇总（recallA / triggerRateB / falsePositiveB / fabricateD）

- [ ] **Step 4: 记录首批对比发现**

在 `eval-recall-v2.md` 末尾追加"首批结果"小节：三路径汇总表 + 关键观察（如 rag-keyword 在语义鲁棒性 / 时间冲突上的表现、v1-tool 的误触发率）。标注日期与命令。

- [ ] **Step 5: 全量测试回归**

Run: `pnpm test`
Expected: 全绿（新增 lib/adapters 单测通过；既有测试不受影响）

- [ ] **Step 6: Commit**

```bash
git add packages/core/scripts/eval-recall/results packages/core/scripts/eval-recall/eval-recall-v2.md
git commit -m "test(eval): 首批全库对比结果（rag-keyword/rag-retriever/v1-tool）"
```

---

## Self-Review（已完成）

- **Spec 覆盖**：数据层（T9/T10/T11）、框架（T1-T4）、适配器（T5/T6/T7）、runner CLI（T8）、文档（T12）、首批结果（T13）——spec §3-§7 全部有对应任务。
- **占位符**：数据任务以"方向+示例+规则+机器校验"代替逐条内容占位，保证 executor 有具体抓手（validate 是硬性门禁）。
- **类型一致性**：`Recaller.kind` 统一为 `"v1-tool" | "rag-keyword" | "rag-retriever"`（recaller.ts / 三个适配器 / run.ts 一致）；`buildEvalStore`、`runEvaluation`、`recallAtK` 等签名在依赖任务中保持一致。

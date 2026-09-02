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

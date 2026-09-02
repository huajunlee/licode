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

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

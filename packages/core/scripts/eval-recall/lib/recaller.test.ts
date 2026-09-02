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

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

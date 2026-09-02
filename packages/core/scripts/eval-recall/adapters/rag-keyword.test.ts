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

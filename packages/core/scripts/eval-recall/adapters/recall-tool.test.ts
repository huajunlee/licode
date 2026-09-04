// packages/core/scripts/eval-recall/adapters/recall-tool.test.ts
import { describe, expect, it, vi } from "vitest";
import { createRecallToolRecaller, parseSelectedSlugs } from "./recall-tool.js";
import { buildEvalStore } from "../lib/eval-runner.js";
import type { Seed } from "../lib/recaller.js";
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
      const r = createRecallToolRecaller({ llm, model: "deepseek-chat", store, runRecall });
      const res = await r.retrieve("宵夜吃什么好？", { topK: 5 });
      expect(res.triggered).toBe(true);
      expect(res.candidates.map((c) => c.slug)).toEqual(["user/food-preferences"]);
    } finally { cleanup(); }
  });

  it("主模型未触发（文本回复）→ candidates 为空", async () => {
    const { store, cleanup } = await buildEvalStore(seeds);
    try {
      const text: StreamChunk = { type: "token", text: "我不知道你宵夜想吃什么。", index: 0 };
      const llm = new ScriptedProvider([[text]]);
      const runRecall = vi.fn(async () => ["user/food-preferences"]);
      const r = createRecallToolRecaller({ llm, model: "deepseek-chat", store, runRecall });
      const res = await r.retrieve("宵夜吃什么好？", { topK: 5 });
      expect(res.triggered).toBe(false);
      expect(res.candidates).toEqual([]);
      expect(runRecall).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it("同一实例两次 retrieve 各自独立（registry 每用例新建，不跨调用污染）", async () => {
    const { store, cleanup } = await buildEvalStore(seeds);
    try {
      const toolUse: StreamChunk = {
        type: "tool-use",
        toolUse: { id: "t1", name: "memory_recall", input: { query: "宵夜吃什么好？", keywords: ["宵夜"] } },
      };
      // 两个 tool-use chunk：两次 retrieve 各消费一个。
      const llm = new ScriptedProvider([[toolUse], [toolUse]]);
      const runRecall = vi.fn(async () => ["user/food-preferences"]);
      const r = createRecallToolRecaller({ llm, model: "deepseek-chat", store, runRecall });

      const first = await r.retrieve("宵夜吃什么好？", { topK: 5 });
      const second = await r.retrieve("宵夜吃什么好？", { topK: 5 });

      // 若 registry 在调用间共享，第二次会被滤成「已在上下文，跳过」→ 候选为空，测试失败。
      expect(first.triggered).toBe(true);
      expect(first.candidates.map((c) => c.slug)).toEqual(["user/food-preferences"]);
      expect(second.triggered).toBe(true);
      expect(second.candidates.map((c) => c.slug)).toEqual(["user/food-preferences"]);
    } finally { cleanup(); }
  });
});

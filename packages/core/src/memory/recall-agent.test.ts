import { describe, it, expect } from "vitest";
import { createRecallAgent } from "./recall-agent.js";
import type { LLMProvider, ChatRequest, ChatResponse, StreamChunk } from "../llm/provider.js";
import type { MemoryStore } from "./store.js";
import type { Memory } from "./types.js";

const FOOD: Memory = {
  name: "食物偏好", slug: "user/food-preferences", description: "喜欢蛋挞",
  content: "用户喜欢吃蛋挞。", keywords: ["蛋挞"],
} as Memory;

function fakeStore(all: Memory[]): MemoryStore {
  return {
    listAll: async () => all,
    load: async (slug: string) => all.find((m) => m.slug === slug) ?? null,
  } as unknown as MemoryStore;
}

/**  scripted LLM：chat 不用；stream 按队列依次产出（text 或一次 tool_use） */
function scriptedLlm(script: Array<{ text?: string; toolSlug?: string }>): LLMProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    name: "fake", maxContextTokens: 200_000, requests,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      requests.push(req);
      return { content: "", usage: { input: 0, output: 0 }, stopReason: "end_turn" };
    },
    async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
      requests.push(req);
      const step = script.shift() ?? { text: "SELECTED: none" };
      if (step.toolSlug) {
        yield { type: "tool-use", toolUse: { id: "t1", name: "read_memory", input: { slug: step.toolSlug } } };
      } else {
        for (const ch of step.text ?? "") yield { type: "token", text: ch, index: 0 };
      }
      yield { type: "stop", stopReason: "end_turn", usage: { input: 1, output: 1 } };
    },
    countTokens: () => 0,
  };
}

describe("createRecallAgent", () => {
  it("returns [] without any LLM call when store is empty", async () => {
    const llm = scriptedLlm([]);
    const agent = createRecallAgent({ llm, store: fakeStore([]) });
    expect(await agent.run("宵夜吃什么", ["宵夜"])).toEqual([]);
    expect(llm.requests).toHaveLength(0);
  });

  it("parses SELECTED slugs from final text, filtered to known slugs", async () => {
    const llm = scriptedLlm([{ text: "SELECTED: user/food-preferences, fake/slug" }]);
    const agent = createRecallAgent({ llm, store: fakeStore([FOOD]) });
    expect(await agent.run("宵夜吃什么", ["宵夜"])).toEqual(["user/food-preferences"]);
  });

  it("tolerates .md suffix copied from the rich index display", async () => {
    const llm = scriptedLlm([{ text: "SELECTED: user/food-preferences.md" }]);
    const agent = createRecallAgent({ llm, store: fakeStore([FOOD]) });
    expect(await agent.run("宵夜吃什么", ["宵夜"])).toEqual(["user/food-preferences"]);
  });

  it("drives read_memory tool loop before final selection", async () => {
    const llm = scriptedLlm([
      { toolSlug: "user/food-preferences" },
      { text: "SELECTED: user/food-preferences" },
    ]);
    const agent = createRecallAgent({ llm, store: fakeStore([FOOD]) });
    expect(await agent.run("宵夜吃什么", ["宵夜"])).toEqual(["user/food-preferences"]);
    expect(llm.requests.length).toBeGreaterThanOrEqual(2);
  });

  it("stops at maxSteps and returns [] when model never selects", async () => {
    const llm = scriptedLlm([{ toolSlug: "user/food-preferences" }]);
    const agent = createRecallAgent({ llm, store: fakeStore([FOOD]), maxSteps: 2 });
    // 队列耗尽后 scriptedLlm 兜底产出 "SELECTED: none" → 第 2 步必然收尾
    expect(await agent.run("q", [])).toEqual([]);
  });

  it("returns [] on LLM error (never throws)", async () => {
    const llm = scriptedLlm([]);
    llm.stream = async function* (): AsyncIterable<StreamChunk> { throw new Error("boom"); };
    const agent = createRecallAgent({ llm, store: fakeStore([FOOD]) });
    expect(await agent.run("q", [])).toEqual([]);
  });

  it("records each agent step into config.trace when provided", async () => {
    const llm = scriptedLlm([
      { toolSlug: "user/food-preferences" },
      { text: "SELECTED: user/food-preferences" },
    ]);
    const trace: string[] = [];
    const agent = createRecallAgent({ llm, store: fakeStore([FOOD]), trace });
    expect(await agent.run("宵夜吃什么", ["宵夜"])).toEqual(["user/food-preferences"]);
    expect(trace.length).toBe(2);
    expect(trace[0]).toMatch(/read_memory/);
    expect(trace[1]).toContain("SELECTED");
  });

  it("caps selections at default maxResults=3", async () => {
    const four = ["user/1", "user/2", "user/3", "user/4"].map((slug) => ({
      ...FOOD, slug, name: slug,
    }));
    const llm = scriptedLlm([{ text: "SELECTED: user/1, user/2, user/3, user/4" }]);
    const agent = createRecallAgent({ llm, store: fakeStore(four) });
    expect(await agent.run("q", [])).toEqual(["user/1", "user/2", "user/3"]);
  });

  it("passes recent conversation context into the agent user message", async () => {
    const llm = scriptedLlm([{ text: "SELECTED: user/food-preferences" }]);
    const agent = createRecallAgent({ llm, store: fakeStore([FOOD]) });
    await agent.run(
      "它的卡到什么时候到期？",
      ["到期"],
      "用户：我在金仕堡健身房办了张年卡。\n助手：好的，记下了。"
    );
    const userMsg = llm.requests[0].messages.find((m) => m.role === "user");
    const text = typeof userMsg?.content === "string" ? userMsg.content : JSON.stringify(userMsg?.content);
    expect(text).toContain("金仕堡");
    expect(text).toContain("最近对话");
  });
});

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

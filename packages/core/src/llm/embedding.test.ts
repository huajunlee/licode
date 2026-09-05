// src/llm/embedding.test.ts
import { describe, expect, it, vi } from "vitest";
import { envEmbeddingProvider, OpenAICompatEmbeddingProvider } from "./embedding.js";

function jsonFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  ) as unknown as typeof fetch;
}

describe("OpenAICompatEmbeddingProvider", () => {
  it("POST {base}/embeddings，Bearer 认证，body 含 model 与 input，按 index 还原顺序", async () => {
    const fetchMock = jsonFetch(200, {
      data: [
        { index: 1, embedding: [0.2, 0.3] },
        { index: 0, embedding: [0.1, 0.9] },
      ],
    });
    const p = new OpenAICompatEmbeddingProvider({ baseUrl: "https://x.example/v3/", apiKey: "k", model: "m", fetchImpl: fetchMock });
    const out = await p.embed(["一", "二"]);
    expect(p.model).toBe("m");
    expect(out).toEqual([[0.1, 0.9], [0.2, 0.3]]);
    const call = vi.mocked(fetchMock).mock.calls[0];
    expect(call[0]).toBe("https://x.example/v3/embeddings");
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(JSON.parse(init.body as string)).toEqual({ model: "m", input: ["一", "二"] });
  });

  it("空输入返回空数组且不发请求", async () => {
    const fetchMock = jsonFetch(200, { data: [] });
    const p = new OpenAICompatEmbeddingProvider({ baseUrl: "https://x", apiKey: "k", model: "m", fetchImpl: fetchMock });
    await expect(p.embed([])).resolves.toEqual([]);
    expect(vi.mocked(fetchMock)).not.toHaveBeenCalled();
  });

  it("5xx 失败后重试一次成功", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ index: 0, embedding: [7] }] }), { status: 200 }));
    const p = new OpenAICompatEmbeddingProvider({ baseUrl: "https://x", apiKey: "k", model: "m", fetchImpl: f as unknown as typeof fetch });
    await expect(p.embed(["a"])).resolves.toEqual([[7]]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("4xx 重试一次后抛错，错误信息含状态码", async () => {
    const f = vi.fn(() => Promise.resolve(new Response("bad model", { status: 400 })));
    const p = new OpenAICompatEmbeddingProvider({ baseUrl: "https://x", apiKey: "k", model: "m", fetchImpl: f as unknown as typeof fetch });
    await expect(p.embed(["a"])).rejects.toThrow(/400/);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("响应缺少某 index 时报错", async () => {
    const fetchMock = jsonFetch(200, { data: [{ index: 0, embedding: [1] }] });
    const p = new OpenAICompatEmbeddingProvider({ baseUrl: "https://x", apiKey: "k", model: "m", fetchImpl: fetchMock });
    await expect(p.embed(["a", "b"])).rejects.toThrow(/缺少部分 index/);
  });
});

describe("envEmbeddingProvider", () => {
  it("三个变量齐全时返回 provider", () => {
    const p = envEmbeddingProvider({ EMBEDDING_BASE_URL: "https://x", EMBEDDING_API_KEY: "k", EMBEDDING_MODEL: "m" } as NodeJS.ProcessEnv);
    expect(p.model).toBe("m");
  });
  it("缺变量时抛错", () => {
    expect(() => envEmbeddingProvider({ EMBEDDING_MODEL: "m" } as NodeJS.ProcessEnv)).toThrow(/EMBEDDING_BASE_URL/);
  });
});

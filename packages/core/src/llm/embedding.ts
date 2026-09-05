// src/llm/embedding.ts
export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * OpenAI 兼容 /embeddings 客户端。纯 fetch，批量单请求，失败重试 1 次。
 * 协议已验证：doubao-embedding-vision（火山方舟）接受 {"model","input":[string]} 标准格式。
 */
export class OpenAICompatEmbeddingProvider implements EmbeddingProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly modelName: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { baseUrl: string; apiKey: string; model: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.modelName = opts.model;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get model(): string {
    return this.modelName;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.modelName, input: texts }),
        });
        if (!res.ok) {
          throw new Error(`embedding HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        const json = (await res.json()) as { data: Array<{ index?: number; embedding: number[] }> };
        const byIndex = new Map(json.data.map((d) => [d.index ?? 0, d.embedding]));
        const out = texts.map((_, i) => byIndex.get(i));
        if (out.some((v) => !v)) throw new Error("embedding 响应缺少部分 index");
        return out as number[][];
      } catch (e) {
        lastErr = e;
        if (attempt === 1) throw lastErr;
      }
    }
    throw lastErr;
  }
}

/** 从环境变量构造 provider；缺任一变量即抛错（评测场景失败即停）。 */
export function envEmbeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const { EMBEDDING_BASE_URL, EMBEDDING_API_KEY, EMBEDDING_MODEL } = env;
  if (!EMBEDDING_BASE_URL || !EMBEDDING_API_KEY || !EMBEDDING_MODEL) {
    throw new Error("缺少 EMBEDDING_BASE_URL / EMBEDDING_API_KEY / EMBEDDING_MODEL（见设计文档 §3.2，已配置于 ~/.zshrc）");
  }
  return new OpenAICompatEmbeddingProvider({ baseUrl: EMBEDDING_BASE_URL, apiKey: EMBEDDING_API_KEY, model: EMBEDDING_MODEL });
}

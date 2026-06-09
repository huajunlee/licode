import type { StreamChunk, TokenUsage } from "./provider.js";

export async function collectStream(
  stream: AsyncIterable<StreamChunk>
): Promise<{ text: string; usage: TokenUsage }> {
  const chunks: string[] = [];
  let usage: TokenUsage = { input: 0, output: 0 };

  for await (const chunk of stream) {
    if (chunk.type === "token") {
      chunks.push(chunk.text);
    } else if (chunk.type === "stop") {
      usage = chunk.usage;
    }
  }

  return { text: chunks.join(""), usage };
}

export function mergeChunks(chunks: StreamChunk[]): string {
  return chunks
    .filter((c): c is { type: "token"; text: string; index: number } => c.type === "token")
    .sort((a, b) => a.index - b.index)
    .map((c) => c.text)
    .join("");
}

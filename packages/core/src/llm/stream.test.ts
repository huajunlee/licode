import { describe, it, expect } from "vitest";
import { mergeChunks, collectStream } from "./stream.js";
import type { StreamChunk } from "./provider.js";

describe("mergeChunks", () => {
  it("merges token chunks sorted by index", () => {
    const chunks: StreamChunk[] = [
      { type: "token", text: " world", index: 1 },
      { type: "token", text: "Hello", index: 0 },
    ];
    expect(mergeChunks(chunks)).toBe("Hello world");
  });

  it("ignores non-token chunks", () => {
    const chunks: StreamChunk[] = [
      { type: "token", text: "Hi", index: 0 },
      {
        type: "stop",
        stopReason: "end_turn",
        usage: { input: 10, output: 2 },
      },
    ];
    expect(mergeChunks(chunks)).toBe("Hi");
  });

  it("returns empty string for no token chunks", () => {
    expect(mergeChunks([])).toBe("");
  });
});

describe("collectStream", () => {
  it("collects text and final usage from stream", async () => {
    async function* testStream(): AsyncIterable<StreamChunk> {
      yield { type: "token", text: "H", index: 0 };
      yield { type: "token", text: "i", index: 1 };
      yield {
        type: "stop",
        stopReason: "end_turn",
        usage: { input: 5, output: 2 },
      };
    }

    const result = await collectStream(testStream());
    expect(result.text).toBe("Hi");
    expect(result.usage).toEqual({ input: 5, output: 2 });
  });
});

import { describe, expect, it } from "vitest";
import { Summarizer } from "./summarizer.js";

describe("Summarizer", () => {
  it("summarizes message content through the injected model callback", async () => {
    const summarizer = new Summarizer({
      generate: async (prompt) => `summary:${prompt.includes("hello world")}`,
    });

    const summary = await summarizer.summarize([
      { role: "user", content: "hello world", timestamp: "" },
    ]);

    expect(summary).toBe("summary:true");
  });
});

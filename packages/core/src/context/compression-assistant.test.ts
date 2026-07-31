import { describe, expect, it } from "vitest";
import { CompressionAssistant } from "./summarizer.js";

describe("CompressionAssistant", () => {
  it("parses a JSON response into structured result", async () => {
    const canned = JSON.stringify({
      updatedSummary: "user worked on auth",
      classifications: [{ index: 1, keep: "important" }],
      fileChanges: [{ index: 2, symbols: ["JwtFilter.doFilter"], summary: { kind: "add filter" } }],
    });
    const a = new CompressionAssistant({ generate: async () => canned });
    const res = await a.assist({
      existingSummary: null,
      turns: [
        { index: 1, kind: "candidate", text: "user: lets use jwt" },
        { index: 2, kind: "must-keep-write", text: "write src/JwtFilter.java", writeOperation: "write", writePath: "src/JwtFilter.java", writeStats: { added: 35, removed: 0 } },
      ],
    });
    expect(res.updatedSummary).toBe("user worked on auth");
    expect(res.classifications).toEqual([{ index: 1, keep: "important" }]);
    expect(res.fileChanges[0].symbols).toEqual(["JwtFilter.doFilter"]);
  });

  it("passes existing summary into the prompt (rolling)", async () => {
    let seen = "";
    const a = new CompressionAssistant({ generate: async (p) => { seen = p; return '{"updatedSummary":"s","classifications":[],"fileChanges":[]}'; } });
    await a.assist({ existingSummary: "PRIOR", turns: [] });
    expect(seen).toContain("PRIOR");
  });

  it("throws on non-JSON response (compressor will degrade to trim)", async () => {
    const a = new CompressionAssistant({ generate: async () => "nope not json" });
    await expect(a.assist({ existingSummary: null, turns: [] })).rejects.toThrow();
  });

  it("strips markdown fences around the JSON", async () => {
    const fenced = "```json\n" + JSON.stringify({ updatedSummary: "s", classifications: [], fileChanges: [] }) + "\n```";
    const a = new CompressionAssistant({ generate: async () => fenced });
    const res = await a.assist({ existingSummary: null, turns: [] });
    expect(res.updatedSummary).toBe("s");
  });
});

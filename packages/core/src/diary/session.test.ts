import { describe, it, expect } from "vitest";
import { DiarySession } from "./session.js";
import type { DiaryExtractorLike, ExtractInput } from "./extractor.js";
import type { DiaryEntry } from "./types.js";

function fakeExtractor(): DiaryExtractorLike {
  return {
    async extract(input: ExtractInput): Promise<DiaryEntry> {
      return {
        meta: { id: input.id, date: input.date, createdAt: input.createdAt, endedAt: input.endedAt },
        raw: { content: input.content, segments: input.segments },
        summary: "fake summary",
        facts: [], decisions: [], emotions: [], people: [], futureMemory: [],
      };
    },
  };
}

describe("DiarySession", () => {
  it("addSegment accumulates segments; end produces an entry with all segments", async () => {
    const session = new DiarySession("2026-07-31", new Date("2026-07-31T10:00:00.000Z"));
    session.addSegment("第一段", new Date("2026-07-31T10:01:00.000Z"));
    session.addSegment("第二段", new Date("2026-07-31T10:02:00.000Z"));
    const entry = await session.end(fakeExtractor(), new Date("2026-07-31T10:05:00.000Z"));
    expect(entry.meta.date).toBe("2026-07-31");
    expect(entry.meta.endedAt).toBe("2026-07-31T10:05:00.000Z");
    expect(entry.raw.segments.map((s) => s.content)).toEqual(["第一段", "第二段"]);
    expect(entry.raw.content).toBe("第一段\n第二段");
    expect(entry.summary).toBe("fake summary");
  });

  it("end with no segments still yields an entry (empty raw)", async () => {
    const session = new DiarySession("2026-07-31", new Date("2026-07-31T10:00:00.000Z"));
    const entry = await session.end(fakeExtractor(), new Date("2026-07-31T10:00:00.000Z"));
    expect(entry.raw.segments).toEqual([]);
    expect(entry.raw.content).toBe("");
  });
});

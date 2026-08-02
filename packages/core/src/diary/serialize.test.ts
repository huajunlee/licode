import { describe, it, expect } from "vitest";
import { emptyEntry, dateString, type DiaryEntry } from "./types.js";
import { serializeEntry, parseEntry } from "./serialize.js";

describe("diary types + serialize", () => {
  it("emptyEntry produces the canonical empty shape", () => {
    const e = emptyEntry("id1", "2026-07-31", "2026-07-31T10:00:00.000Z");
    expect(e.meta).toEqual({ id: "id1", date: "2026-07-31", createdAt: "2026-07-31T10:00:00.000Z", endedAt: "2026-07-31T10:00:00.000Z" });
    expect(e.raw).toEqual({ content: "", segments: [] });
    expect(e.facts).toEqual([]);
    expect(e.futureMemory).toEqual([]);
    expect(e.title).toBe("");
  });

  it("dateString formats YYYY-MM-DD in local time", () => {
    expect(dateString(new Date(2026, 6, 31))).toBe("2026-07-31"); // month 0-based
    expect(dateString(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("serializeEntry then parseEntry round-trips a full entry", () => {
    const entry: DiaryEntry = {
      meta: { id: "id1", date: "2026-07-31", createdAt: "2026-07-31T10:00:00.000Z", endedAt: "2026-07-31T10:05:00.000Z" },
      raw: {
        content: "今天和老板聊了项目",
        segments: [{ timestamp: "2026-07-31T10:00:00.000Z", speaker: "user", content: "今天和老板聊了项目" }],
      },
      title: "和老板聊项目",
      summary: "和老板讨论了项目技术方案",
      facts: [{ what: "和老板聊了项目", when: null, tags: ["work"] }],
      decisions: [{ decision: "换技术方案", reasoning: "老板建议", context: null }],
      emotions: [{ state: "焦虑", intensity: 3, trigger: "项目方向不确定", inferred: true }],
      people: [{ name: "老板", relation: "上级", relationInferred: true, interaction: "聊了项目方案", note: "建议换技术方案", specific: false }],
      futureMemory: [{ content: "老板倾向换技术方案", type: "decision", importance: "high", promotability: "medium", reason: "影响后续技术选型" }],
    };
    const raw = serializeEntry(entry);
    expect(raw).toContain("## 原文");
    expect(raw).toContain("## 结构化");
    expect(raw).toContain("id: id1");
    expect(raw).toContain("title: 和老板聊项目");
    expect(raw).toContain("people: 老板");

    const parsed = parseEntry(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.meta).toEqual(entry.meta);
    expect(parsed!.summary).toBe(entry.summary);
    expect(parsed!.title).toBe(entry.title);
    expect(parsed!.raw.segments).toEqual(entry.raw.segments);
    expect(parsed!.people).toEqual(entry.people);
    expect(parsed!.futureMemory).toEqual(entry.futureMemory);
  });

  it("parseEntry returns null on non-frontmatter input", () => {
    expect(parseEntry("just some text")).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { DiaryExtractor } from "./extractor.js";
import type { Segment } from "./types.js";

const segments: Segment[] = [
  { timestamp: "2026-07-31T10:00:00.000Z", speaker: "user", content: "今天和老板聊了项目，他建议我换技术方案，我有点焦虑" },
];

const baseInput = {
  id: "id1", date: "2026-07-31",
  createdAt: "2026-07-31T10:00:00.000Z", endedAt: "2026-07-31T10:05:00.000Z",
  segments, content: segments[0].content,
};

describe("DiaryExtractor", () => {
  it("extracts a full entry from valid JSON", async () => {
    const generate = async () => JSON.stringify({
      summary: "和老板讨论项目，建议换技术方案",
      facts: [{ what: "和老板聊了项目", when: null, tags: ["work"] }],
      decisions: [{ decision: "换技术方案", reasoning: "老板建议", context: null }],
      emotions: [{ state: "焦虑", intensity: 3, trigger: "项目方向", inferred: true }],
      people: [{ name: "老板", relation: "上级", relationInferred: true, interaction: "聊了方案", note: "建议换技术方案", specific: false }],
      futureMemory: [{ content: "老板倾向换方案", type: "decision", importance: "high", promotability: "medium", reason: "影响选型" }],
    });
    const ex = new DiaryExtractor({ generate });
    const entry = await ex.extract(baseInput);
    expect(entry.meta.id).toBe("id1");
    expect(entry.raw.segments).toEqual(segments);
    expect(entry.summary).toBe("和老板讨论项目，建议换技术方案");
    expect(entry.people[0].name).toBe("老板");
    expect(entry.futureMemory[0].importance).toBe("high");
  });

  it("parses JSON wrapped in a code fence", async () => {
    const generate = async () => "```json\n" + JSON.stringify({ summary: "fenced", facts: [], decisions: [], emotions: [], people: [], futureMemory: [] }) + "\n```";
    const ex = new DiaryExtractor({ generate });
    const entry = await ex.extract(baseInput);
    expect(entry.summary).toBe("fenced");
  });

  it("degrades to raw + fallback summary when generate throws", async () => {
    const generate = async () => { throw new Error("network"); };
    const ex = new DiaryExtractor({ generate });
    const entry = await ex.extract(baseInput);
    expect(entry.raw.segments).toEqual(segments);
    expect(entry.summary).toMatch(/抽取失败/);
    expect(entry.facts).toEqual([]);
    expect(entry.futureMemory).toEqual([]);
  });

  it("degrades when generate returns non-JSON", async () => {
    const generate = async () => "totally not json";
    const ex = new DiaryExtractor({ generate });
    const entry = await ex.extract(baseInput);
    expect(entry.summary).toMatch(/抽取失败/);
    expect(entry.raw.content).toBe(segments[0].content);
  });

  it("populates PersonRef.specific and routes a person's liking to person_trait", async () => {
    const generate = async () => JSON.stringify({
      summary: "和王总开会",
      facts: [],
      decisions: [],
      emotions: [],
      people: [
        { name: "王总", relation: "上级", relationInferred: true, interaction: "开会", note: "爱喝茶", specific: true },
        { name: "朋友", relation: null, relationInferred: false, interaction: "吃饭", note: null, specific: false },
      ],
      futureMemory: [{ content: "王总爱喝茶", type: "person_trait", importance: "high", promotability: "high", reason: "稳定偏好" }],
    });
    const ex = new DiaryExtractor({ generate });
    const entry = await ex.extract(baseInput);
    expect(entry.people[0].specific).toBe(true);
    expect(entry.people[1].specific).toBe(false);
    expect(entry.futureMemory[0].type).toBe("person_trait");
  });
});

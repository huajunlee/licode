import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { journalRecallTool, JournalRecallParams } from "./journal-recall.js";
import { JournalStore } from "../../diary/store.js";
import { emptyEntry, type Segment } from "../../diary/types.js";

function makeEntry(id: string, date: string, text: string, person?: string) {
  const e = emptyEntry(id, date, `${date}T10:00:00.000Z`);
  const seg: Segment = { timestamp: `${date}T10:00:00.000Z`, speaker: "user", content: text };
  e.raw = { content: text, segments: [seg] };
  e.summary = text;
  if (person) e.people = [{ name: person, relation: null, relationInferred: false, interaction: text, note: null, specific: true }];
  return e;
}

describe("journalRecallTool", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "jrec-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  async function save(entries: ReturnType<typeof makeEntry>[]) {
    const store = new JournalStore(path.join(dir, ".licode", "journal"));
    for (const e of entries) await store.save(e);
  }
  const ctx = () => ({ workingDirectory: dir, sessionId: "test" });

  it("returns recent entries when no params", async () => {
    await save([makeEntry("a1", "2026-07-31", "和老板聊了项目", "老板"), makeEntry("b1", "2026-07-30", "跑步")]);
    const res = await journalRecallTool.execute({}, ctx());
    expect(res.status).toBe("success");
    if (res.status === "success") {
      expect(res.content).toContain("和老板聊了项目");
      expect(res.content).toContain("跑步");
    }
  });

  it("filters by a single day when both date fields are equal", async () => {
    await save([makeEntry("a1", "2026-07-31", "和老板聊了项目", "老板"), makeEntry("b1", "2026-07-30", "跑步")]);
    const res = await journalRecallTool.execute({ start_date: "2026-07-31", end_date: "2026-07-31" }, ctx());
    expect(res.status).toBe("success");
    if (res.status === "success") {
      expect(res.content).toContain("和老板聊了项目");
      expect(res.content).not.toContain("跑步");
    }
  });

  it("returns entries within a date range in ascending order", async () => {
    await save([makeEntry("a1", "2026-07-31", "和老板聊了项目", "老板"), makeEntry("b1", "2026-08-01", "晨跑")]);
    const res = await journalRecallTool.execute({ start_date: "2026-07-31", end_date: "2026-08-01" }, ctx());
    expect(res.status).toBe("success");
    if (res.status === "success") {
      expect(res.content.indexOf("和老板聊了项目")).toBeLessThan(res.content.indexOf("晨跑"));
    }
  });

  it("start_date alone means that single day", async () => {
    await save([makeEntry("a1", "2026-07-31", "和老板聊了项目", "老板"), makeEntry("b1", "2026-07-30", "跑步")]);
    const res = await journalRecallTool.execute({ start_date: "2026-07-31" }, ctx());
    expect(res.status).toBe("success");
    if (res.status === "success") {
      expect(res.content).toContain("和老板聊了项目");
      expect(res.content).not.toContain("跑步");
    }
  });

  it("end_date alone means that single day", async () => {
    await save([makeEntry("a1", "2026-07-31", "和老板聊了项目", "老板"), makeEntry("b1", "2026-07-30", "跑步")]);
    const res = await journalRecallTool.execute({ end_date: "2026-07-31" }, ctx());
    expect(res.status).toBe("success");
    if (res.status === "success") {
      expect(res.content).toContain("和老板聊了项目");
      expect(res.content).not.toContain("跑步");
    }
  });

  it("query combined with a date range searches within the range", async () => {
    await save([
      makeEntry("a1", "2026-07-31", "和老板聊了项目", "老板"),
      makeEntry("a2", "2026-08-02", "和老板吃饭", "老板"),
      makeEntry("c1", "2026-08-03", "独自跑步"),
    ]);
    const res = await journalRecallTool.execute(
      { query: "老板", start_date: "2026-08-01", end_date: "2026-08-31" },
      ctx()
    );
    expect(res.status).toBe("success");
    if (res.status === "success") {
      expect(res.content).toContain("和老板吃饭");
      expect(res.content).not.toContain("和老板聊了项目");
    }
  });

  it("start > end returns a validation error", async () => {
    await save([makeEntry("a1", "2026-07-31", "和老板聊了项目", "老板")]);
    const res = await journalRecallTool.execute(
      { start_date: "2026-08-31", end_date: "2026-08-01" },
      ctx()
    );
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.errorType).toBe("validation");
  });

  it("rejects malformed date formats at the schema level", () => {
    expect(JournalRecallParams.safeParse({ start_date: "2026-8-1" }).success).toBe(false);
    expect(JournalRecallParams.safeParse({ end_date: "20260801" }).success).toBe(false);
    expect(
      JournalRecallParams.safeParse({
        start_date: "2026-08-01",
        end_date: "2026-08-02",
      }).success
    ).toBe(true);
  });

  it("searches by query (person name)", async () => {
    await save([makeEntry("a1", "2026-07-31", "和老板聊了项目", "老板"), makeEntry("a2", "2026-07-31", "晚上独自跑步")]);
    const res = await journalRecallTool.execute({ query: "老板" }, ctx());
    expect(res.status).toBe("success");
    if (res.status === "success") {
      expect(res.content).toContain("和老板聊了项目");
      expect(res.content).not.toContain("跑步");
    }
  });

  it("returns no-entries message when journal empty", async () => {
    const res = await journalRecallTool.execute({}, ctx());
    expect(res.status).toBe("success");
    if (res.status === "success") expect(res.content).toContain("没有找到");
  });
});

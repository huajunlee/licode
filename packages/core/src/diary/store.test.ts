import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JournalStore } from "./store.js";
import { emptyEntry, type DiaryEntry, type Segment } from "./types.js";
import { hhmmFromISO } from "../memory/types.js";

function entry(id: string, date: string, text: string, person?: string): DiaryEntry {
  const e = emptyEntry(id, date, `${date}T10:00:00.000Z`);
  const seg: Segment = { timestamp: `${date}T10:00:00.000Z`, speaker: "user", content: text };
  e.raw = { content: text, segments: [seg] };
  e.summary = text;
  e.title = text;
  e.people = person ? [{ name: person, relation: null, relationInferred: false, interaction: text, note: null, specific: true }] : [];
  return e;
}

describe("JournalStore", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "diary-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("save writes <date>/<date>-<HHmm>-<title>.md and load reads it back", async () => {
    const store = new JournalStore(dir);
    const e = entry("a1", "2026-07-31", "和老板聊了项目", "老板");
    await store.save(e);
    const hhmm = hhmmFromISO(e.meta.createdAt);
    const file = path.join(dir, "2026-07-31", `2026-07-31-${hhmm}-和老板聊了项目.md`);
    expect(fs.existsSync(file)).toBe(true);

    const loaded = await store.load("a1");
    expect(loaded).not.toBeNull();
    expect(loaded!.meta.id).toBe("a1");
    expect(loaded!.people[0].name).toBe("老板");
  });

  it("save 同分同名冲突加序号 -2，不再 throw", async () => {
    const store = new JournalStore(dir);
    const e1 = entry("a1", "2026-07-31", "开会");
    const e2 = entry("a2", "2026-07-31", "开会"); // 同 date 同 createdAt 同 title
    await store.save(e1);
    await expect(store.save(e2)).resolves.toBeUndefined();
    const hhmm = hhmmFromISO(e1.meta.createdAt);
    const dateDir = path.join(dir, "2026-07-31");
    expect(fs.existsSync(path.join(dateDir, `2026-07-31-${hhmm}-开会.md`))).toBe(true);
    expect(fs.existsSync(path.join(dateDir, `2026-07-31-${hhmm}-开会-2.md`))).toBe(true);
  });

  it("load(id) 扫描 frontmatter 定位（文件名不含 id）", async () => {
    const store = new JournalStore(dir);
    await store.save(entry("a1", "2026-07-31", "晨会"));
    await store.save(entry("b1", "2026-07-30", "前一天"));
    const loaded = await store.load("b1");
    expect(loaded).not.toBeNull();
    expect(loaded!.meta.id).toBe("b1");
    expect(await store.load("nope")).toBeNull();
  });

  it("listByDate returns all entries for a date", async () => {
    const store = new JournalStore(dir);
    await store.save(entry("a1", "2026-07-31", "晨会"));
    await store.save(entry("a2", "2026-07-31", "晚上跑步"));
    await store.save(entry("b1", "2026-07-30", "前一天"));
    const list = await store.listByDate("2026-07-31");
    expect(list.map((e) => e.meta.id).sort()).toEqual(["a1", "a2"]);
  });

  it("listRecent returns newest-first across dates up to limit", async () => {
    const store = new JournalStore(dir);
    await store.save(entry("b1", "2026-07-30", "旧"));
    await store.save(entry("a1", "2026-07-31", "新"));
    const recent = await store.listRecent(1);
    expect(recent.map((e) => e.meta.date)).toEqual(["2026-07-31"]);
  });

  it("search matches raw content and people names", async () => {
    const store = new JournalStore(dir);
    await store.save(entry("a1", "2026-07-31", "和老板聊了项目", "老板"));
    await store.save(entry("a2", "2026-07-31", "晚上独自跑步"));
    const hits = await store.search("老板");
    expect(hits.map((e) => e.meta.id)).toEqual(["a1"]);
  });

  it("listAll returns every entry across all dates", async () => {
    const store = new JournalStore(dir);
    await store.save(entry("a1", "2026-07-31", "x"));
    await store.save(entry("b1", "2026-07-30", "y"));
    const all = await store.listAll();
    expect(all.map((e) => e.meta.id).sort()).toEqual(["a1", "b1"]);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { autoFileEntry, mergeProfiles } from "./profile-file.js";
import { PersonProfileStore } from "./store.js";
import { emptyProfile } from "./types.js";
import { toSlug } from "../memory/types.js";
import { CuratedIndex } from "../diary/curated.js";
import { emptyEntry, type PersonRef } from "../diary/types.js";

const NOW = () => new Date("2026-08-01T10:00:00.000Z");
function person(name: string, specific: boolean, interaction: string, note: string | null, relation: string | null): PersonRef {
  return { name, relation, relationInferred: false, interaction, note, specific };
}

describe("autoFileEntry", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("creates a new profile for a specific person and marks key", async () => {
    const entry = emptyEntry("e1", "2026-08-01", "2026-08-01T10:00:00.000Z");
    entry.people = [person("王总", true, "开会聊新项目", "爱喝茶", "上级")];
    const store = new PersonProfileStore(path.join(dir, "people"));
    const idx = new CuratedIndex(path.join(dir, ".curated.json"));
    const res = await autoFileEntry(entry, { profileStore: store, curatedIndex: idx, now: NOW });

    expect(res.filed).toEqual(["王总"]);
    const p = await store.findByName("王总");
    expect(p).not.toBeNull();
    expect(p!.meta.canonicalName).toBe("王总");
    expect(p!.interactions[0]).toEqual({ date: "2026-08-01", entryId: "e1", event: "开会聊新项目" });
    expect(p!.traits).toContain("爱喝茶");
    expect(p!.relationshipState[0]).toEqual({ date: "2026-08-01", state: "上级" });
    expect((await idx.load()).has("e1#p0")).toBe(true);
  });

  it("appends to an existing profile without duplicating the same relation", async () => {
    const store = new PersonProfileStore(path.join(dir, "people"));
    const idx = new CuratedIndex(path.join(dir, ".curated.json"));
    const e1 = emptyEntry("e1", "2026-08-01", "2026-08-01T10:00:00.000Z");
    e1.people = [person("王总", true, "开会", null, "上级")];
    await autoFileEntry(e1, { profileStore: store, curatedIndex: idx, now: NOW });
    const e2 = emptyEntry("e2", "2026-08-02", "2026-08-02T10:00:00.000Z");
    e2.people = [person("王总", true, "又开会", "做事果断", "上级")];
    await autoFileEntry(e2, { profileStore: store, curatedIndex: idx, now: NOW });

    const p = await store.findByName("王总");
    expect(p!.interactions.length).toBe(2);
    expect(p!.relationshipState.length).toBe(1); // same relation not duplicated
    expect(p!.traits).toContain("做事果断");
    expect(p!.meta.mentionCount).toBe(2);
  });

  it("skips ambiguous (specific:false) people, leaves them unmarked", async () => {
    const entry = emptyEntry("e1", "2026-08-01", "2026-08-01T10:00:00.000Z");
    entry.people = [person("朋友", false, "吃饭", null, null)];
    const store = new PersonProfileStore(path.join(dir, "people"));
    const idx = new CuratedIndex(path.join(dir, ".curated.json"));
    const res = await autoFileEntry(entry, { profileStore: store, curatedIndex: idx, now: NOW });
    expect(res.filed).toEqual([]);
    expect((await store.listAll()).length).toBe(0);
    expect((await idx.load()).has("e1#p0")).toBe(false); // unmarked -> curation
  });

  it("mergeProfiles combines two profiles and deletes the from-profile", async () => {
    const store = new PersonProfileStore(path.join(dir, "people"));
    const wz = emptyProfile("王总", "2026-08-01"); wz.meta.slug = toSlug("王总"); wz.traits = ["果断"]; wz.meta.mentionCount = 1;
    await store.save(wz, "create");
    const lw = emptyProfile("老王", "2026-08-02"); lw.meta.slug = toSlug("老王"); lw.traits = ["爱喝茶"]; lw.meta.mentionCount = 1;
    await store.save(lw, "create");

    const res = await mergeProfiles("老王", "王总", { profileStore: store });
    expect(res.merged).toEqual({ from: "老王", into: "王总" });
    expect(res.error).toBeNull();
    expect(await store.load(toSlug("老王"))).toBeNull(); // 老王 档案文件已删除
    expect((await store.findByName("老王"))?.meta.canonicalName).toBe("王总"); // 老王 作别名命中王总
    const merged = await store.findByName("王总");
    expect(merged!.meta.aliases).toContain("老王");
    expect(merged!.traits).toEqual(expect.arrayContaining(["果断", "爱喝茶"]));
    expect(merged!.meta.mentionCount).toBe(2);
  });

  it("mergeProfiles reports error when a profile is not found", async () => {
    const store = new PersonProfileStore(path.join(dir, "people"));
    const res = await mergeProfiles("不存在", "也没", { profileStore: store });
    expect(res.merged).toBeNull();
    expect(res.error).toMatch(/找不到/);
  });
});

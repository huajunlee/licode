import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PersonProfileStore } from "./store.js";
import { emptyProfile } from "./types.js";
import { toSlug, cleanName } from "../memory/types.js";

describe("PersonProfileStore", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppl-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function profile(name: string, aliases: string[] = []) {
    const p = emptyProfile(name, "2026-08-01");
    p.meta.slug = toSlug(name);
    p.meta.aliases = aliases;
    p.meta.mentionCount = 1;
    return p;
  }

  it("save(create) writes <canonicalName>.md and load reads it back", async () => {
    const s = new PersonProfileStore(dir);
    const p = profile("王总", ["老板"]);
    await s.save(p, "create");
    const file = path.join(dir, `${cleanName("王总")}.md`);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(dir, `${p.meta.slug}.md`))).toBe(false); // 文件名不再是 slug

    const loaded = await s.load(p.meta.slug);
    expect(loaded).not.toBeNull();
    expect(loaded!.meta.canonicalName).toBe("王总");
  });

  it("save(create) refuses to overwrite existing canonicalName", async () => {
    const s = new PersonProfileStore(dir);
    await s.save(profile("王总"), "create");
    await expect(s.save(profile("王总"), "create")).rejects.toThrow(/already exists/);
  });

  it("save(update) overwrites", async () => {
    const s = new PersonProfileStore(dir);
    const p = profile("王总");
    await s.save(p, "create");
    p.summary = "更新过";
    await s.save(p, "update");
    expect((await s.load(p.meta.slug))!.summary).toBe("更新过");
  });

  it("findByName matches canonicalName or alias", async () => {
    const s = new PersonProfileStore(dir);
    await s.save(profile("王总", ["老板", "王志远"]), "create");
    expect((await s.findByName("王总"))?.meta.canonicalName).toBe("王总");
    expect((await s.findByName("老板"))?.meta.canonicalName).toBe("王总");
    expect((await s.findByName("王志远"))?.meta.canonicalName).toBe("王总");
    expect(await s.findByName("李四")).toBeNull();
  });

  it("listRecent returns newest-first by lastSeen", async () => {
    const s = new PersonProfileStore(dir);
    const a = profile("A"); a.meta.lastSeen = "2026-07-30";
    const b = profile("B"); b.meta.lastSeen = "2026-08-01";
    await s.save(a, "create"); await s.save(b, "create");
    const recent = await s.listRecent(2);
    expect(recent[0].meta.canonicalName).toBe("B");
  });

  it("delete(slug) 扫描定位并删除文件", async () => {
    const s = new PersonProfileStore(dir);
    const p = profile("王总");
    await s.save(p, "create");
    expect(fs.existsSync(path.join(dir, `${cleanName("王总")}.md`))).toBe(true);
    await s.delete(p.meta.slug);
    expect(fs.existsSync(path.join(dir, `${cleanName("王总")}.md`))).toBe(false);
    expect(await s.load(p.meta.slug)).toBeNull();
  });
});

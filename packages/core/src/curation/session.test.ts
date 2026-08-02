import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CurationSession } from "./session.js";
import { CuratedIndex } from "../diary/curated.js";
import { MemoryStore } from "../memory/store.js";
import { PersonProfileStore } from "../people/store.js";
import type { MemoryCreateProposal } from "./types.js";

function prop(slug: string, sources: string[]): MemoryCreateProposal {
  return { kind: "memory", slug, type: "project", name: slug, description: "d", content: "c", sourceKeys: sources };
}

describe("CurationSession", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ses-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("formatList numbers proposals grouped by kind", () => {
    const s = new CurationSession([prop("project/a", ["e1#c0"]), prop("user/b", ["e1#c1"])]);
    const txt = s.formatList();
    expect(txt).toContain("1.");
    expect(txt).toContain("project/a");
    expect(txt).toContain("2.");
  });

  it("apply all saves selected memories and marks sourceKeys", async () => {
    const s = new CurationSession([prop("project/a", ["e1#c0"]), prop("user/b", ["e1#c1"])]);
    const store = new MemoryStore(path.join(dir, "memory"));
    const idx = new CuratedIndex(path.join(dir, ".curated.json"));
    const res = await s.apply("all", { memoryStore: store, curatedIndex: idx });
    expect(res.applied).toBe(2);
    expect((await store.listAll()).length).toBe(2);
    const marked = await idx.load();
    expect(marked.has("e1#c0")).toBe(true);
    expect(marked.has("e1#c1")).toBe(true);
  });

  it("apply selected indices only persists chosen, but marks ALL proposed keys (no nag)", async () => {
    const s = new CurationSession([prop("project/a", ["e1#c0"]), prop("user/b", ["e1#c1"])]);
    const store = new MemoryStore(path.join(dir, "memory"));
    const idx = new CuratedIndex(path.join(dir, ".curated.json"));
    const res = await s.apply([0], { memoryStore: store, curatedIndex: idx });
    expect(res.applied).toBe(1);
    expect((await store.listAll()).length).toBe(1);
    const marked = await idx.load();
    expect(marked.has("e1#c0")).toBe(true);
    expect(marked.has("e1#c1")).toBe(true); // not selected but still marked (decided)
  });

  it("apply profile-new creates a profile and marks sourceKeys", async () => {
    const store = new PersonProfileStore(path.join(dir, "people"));
    const idx = new CuratedIndex(path.join(dir, ".curated.json"));
    const s = new CurationSession([
      { kind: "profile-new", name: "李四", reason: "新", date: "2026-08-01", entryId: "e1", interaction: "吃饭", note: "幽默", relation: null, sourceKeys: ["e1#p0"] },
    ]);
    const res = await s.apply("all", { memoryStore: new MemoryStore(path.join(dir, "memory")), curatedIndex: idx, profileStore: store });
    expect(res.applied).toBe(1);
    const p = await store.findByName("李四");
    expect(p).not.toBeNull();
    expect(p!.traits).toContain("幽默");
    expect((await idx.load()).has("e1#p0")).toBe(true);
  });
});

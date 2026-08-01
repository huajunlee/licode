import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleCurationInput } from "./dispatch.js";
import { JournalStore } from "../diary/store.js";
import { CuratedIndex } from "../diary/curated.js";
import { MemoryStore } from "../memory/store.js";
import { MemoryCuration } from "./memory-curation.js";
import { PersonProfileStore } from "../people/store.js";
import { ProfileCuration } from "../people/curation/profile-curation.js";
import { emptyEntry } from "../diary/types.js";

const NOW = () => new Date("2026-08-01T10:00:00.000Z");

async function seed(dir: string) {
  const journal = new JournalStore(path.join(dir, "journal"));
  const e = emptyEntry("e1", "2026-08-01", "2026-08-01T10:00:00.000Z");
  e.futureMemory = [
    { content: "决定换架构", type: "decision", importance: "high", promotability: "low", reason: "r" },
    { content: "吃面", type: "decision", importance: "low", promotability: "low", reason: "r" },
  ];
  await journal.save(e);
  return journal;
}

describe("handleCurationInput", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdisp-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function ctx(session: null, journal: JournalStore, memGenerate?: (p: string) => Promise<string>, profGenerate?: (p: string) => Promise<string>) {
    return {
      session,
      journalStore: journal,
      memoryStore: new MemoryStore(path.join(dir, "memory")),
      curatedIndex: new CuratedIndex(path.join(dir, "journal", ".curated.json")),
      memoryCuration: new MemoryCuration({ generate: memGenerate ?? (async () => JSON.stringify([
        { slug: "project/arch", type: "project", name: "新架构", description: "d", content: "决定换架构", sources: [0] },
      ])) }),
      profileStore: new PersonProfileStore(path.join(dir, "people")),
      profileCuration: new ProfileCuration({ generate: profGenerate ?? (async () => JSON.stringify([
        { action: "new", index: 0, name: "李四", reason: "新人物" },
      ])) }),
      now: NOW,
    };
  }

  it("returns null for non-curation input", async () => {
    const j = await seed(dir);
    expect(await handleCurationInput("/diary", ctx(null, j))).toBeNull();
  });

  it("/diary-curate gathers high+low non-person candidates (skips low), proposes, stashes session", async () => {
    const j = await seed(dir);
    const out = await handleCurationInput("/diary-curate", ctx(null, j));
    expect(out).not.toBeNull();
    expect(out!.result.message).toContain("1.");
    expect(out!.result.message).toContain("project/arch");
    expect(out!.nextSession).not.toBeNull();
  });

  it("/diary-curate apply all persists memory and marks keys", async () => {
    const j = await seed(dir);
    const c = ctx(null, j);
    const proposed = await handleCurationInput("/diary-curate", c);
    const out = await handleCurationInput("/diary-curate apply all", { ...c, session: proposed!.nextSession });
    expect(out!.result.message).toMatch(/已应用/);
    expect((await c.memoryStore.listAll()).length).toBe(1);
    const marked = await c.curatedIndex.load();
    expect(marked.has("e1#c0")).toBe(true);
    expect(out!.nextSession).toBeNull();
  });

  it("/diary-curate reject clears session without persisting", async () => {
    const j = await seed(dir);
    const c = ctx(null, j);
    const proposed = await handleCurationInput("/diary-curate", c);
    const out = await handleCurationInput("/diary-curate reject", { ...c, session: proposed!.nextSession });
    expect(out!.nextSession).toBeNull();
    expect((await c.memoryStore.listAll()).length).toBe(0);
  });

  it("re-running /diary-curate after apply finds nothing new", async () => {
    const j = await seed(dir);
    const c = ctx(null, j);
    const proposed = await handleCurationInput("/diary-curate", c);
    await handleCurationInput("/diary-curate apply all", { ...c, session: proposed!.nextSession });
    const again = await handleCurationInput("/diary-curate", c);
    expect(again!.result.message).toMatch(/没有待整理/);
  });

  it("/diary-curate also resolves ambiguous people into profile proposals", async () => {
    const j = await seed(dir);
    const e2 = emptyEntry("e2", "2026-08-01", "2026-08-01T11:00:00.000Z");
    e2.people = [{ name: "朋友", relation: null, relationInferred: false, interaction: "吃饭", note: null, specific: false }];
    await j.save(e2);
    const c = ctx(null, j);
    const out = await handleCurationInput("/diary-curate", c);
    expect(out!.result.message).toContain("新档案");
    expect(out!.nextSession).not.toBeNull();
  });
});

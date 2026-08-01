import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deriveMemory, autoPromoteEntry } from "./promote.js";
import { CuratedIndex } from "./curated.js";
import { MemoryStore } from "../memory/store.js";
import { emptyEntry, type Candidate } from "./types.js";

const NOW = () => new Date("2026-08-01T10:00:00.000Z");

function cand(content: string, type: Candidate["type"], importance: Candidate["importance"], promotability: Candidate["promotability"]): Candidate {
  return { content, type, importance, promotability, reason: "r" };
}

describe("deriveMemory", () => {
  it("maps preference->user, decision->project, goal->project", () => {
    expect(deriveMemory(cand("我喜欢早起", "preference", "high", "high"), NOW).type).toBe("user");
    expect(deriveMemory(cand("决定换架构", "decision", "high", "high"), NOW).type).toBe("project");
    expect(deriveMemory(cand("想学吉他", "goal", "high", "high"), NOW).type).toBe("project");
  });
  it("derives name from content (truncated) and content/reason", () => {
    const m = deriveMemory(cand("决定下周启用新架构", "decision", "high", "high"), NOW);
    expect(m.content).toBe("决定下周启用新架构");
    expect(m.name.length).toBeLessThanOrEqual(20);
    expect(m.slug.startsWith("project/")).toBe(true);
  });
});

describe("autoPromoteEntry", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "pro-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("promotes only high+high preference/decision/goal, marks their keys, skips other/low", async () => {
    const entry = emptyEntry("e1", "2026-08-01", "2026-08-01T10:00:00.000Z");
    entry.futureMemory = [
      cand("我喜欢早起", "preference", "high", "high"),       // promote
      cand("决定换架构", "decision", "high", "high"),          // promote
      cand("今天和王总吵架", "relationship", "high", "low"),   // skip (not auto)
      cand("其它杂事", "other", "high", "high"),               // skip (other -> curation)
      cand("吃面", "decision", "low", "low"),                  // skip (low importance)
    ];
    const store = new MemoryStore(path.join(dir, "memory"));
    const idx = new CuratedIndex(path.join(dir, ".curated.json"));
    const res = await autoPromoteEntry(entry, { memoryStore: store, curatedIndex: idx, now: NOW });

    expect(res.promoted.length).toBe(2);
    const all = await store.listAll();
    expect(all.length).toBe(2);
    const marked = await idx.load();
    expect(marked.has("e1#c0")).toBe(true);
    expect(marked.has("e1#c1")).toBe(true);
    expect(marked.has("e1#c2")).toBe(false); // relationship high+low not marked -> curation
    expect(marked.has("e1#c3")).toBe(false); // other high+high not marked -> curation
    expect(marked.has("e1#c4")).toBe(false); // low not marked (curation predicate excludes by importance)
  });
});

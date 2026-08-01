import type { DiaryEntry, Candidate } from "./types.js";
import type { CuratedIndex } from "./curated.js";
import type { MemoryStore } from "../memory/store.js";
import { toSlug } from "../memory/types.js";
import type { Memory, MemoryType } from "../memory/types.js";

const TYPE_MAP: Record<string, MemoryType> = {
  preference: "user",
  decision: "project",
  goal: "project",
};

const NAME_MAX = 20;

export function deriveMemory(candidate: Candidate, now: () => Date): Memory {
  const type = TYPE_MAP[candidate.type];
  const iso = now().toISOString();
  const name = candidate.content.length > NAME_MAX ? candidate.content.slice(0, NAME_MAX) : candidate.content;
  return {
    slug: `${type}/${toSlug(candidate.content)}`,
    type,
    name,
    description: candidate.reason,
    content: candidate.content,
    createdAt: iso,
    updatedAt: iso,
  };
}

export interface AutoPromoteDeps {
  memoryStore: MemoryStore;
  curatedIndex: CuratedIndex;
  now: () => Date;
}
export interface AutoPromoteResult {
  promoted: string[];
  markedKeys: string[];
  errors: string[];
}

export async function autoPromoteEntry(entry: DiaryEntry, deps: AutoPromoteDeps): Promise<AutoPromoteResult> {
  const promoted: string[] = [];
  const markedKeys: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < entry.futureMemory.length; i++) {
    const c = entry.futureMemory[i];
    const auto = TYPE_MAP[c.type] && c.importance === "high" && c.promotability === "high";
    if (!auto) continue;
    const key = `${entry.meta.id}#c${i}`;
    try {
      await deps.memoryStore.save(deriveMemory(c, deps.now), "create");
      promoted.push(c.content);
      markedKeys.push(key);
    } catch (err) {
      errors.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (markedKeys.length) await deps.curatedIndex.mark(markedKeys);
  return { promoted, markedKeys, errors };
}

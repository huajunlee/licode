import type { DiaryEntry } from "../diary/types.js";
import type { CuratedIndex } from "../diary/curated.js";
import { PersonProfileStore } from "./store.js";
import { emptyProfile } from "./types.js";
import { toSlug } from "../memory/types.js";

export interface AutoFileDeps {
  profileStore: PersonProfileStore;
  curatedIndex: CuratedIndex;
  now: () => Date;
}
export interface AutoFileResult {
  filed: string[];
  markedKeys: string[];
  errors: string[];
}

export async function autoFileEntry(entry: DiaryEntry, deps: AutoFileDeps): Promise<AutoFileResult> {
  const filed: string[] = [];
  const markedKeys: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < entry.people.length; i++) {
    const ref = entry.people[i];
    if (!ref.specific) continue;            // 模糊留给 curation
    const key = `${entry.meta.id}#p${i}`;
    try {
      const existing = await deps.profileStore.findByName(ref.name);
      const p = existing ?? emptyProfile(ref.name, entry.meta.date);
      if (!existing) { p.meta.slug = toSlug(ref.name); p.meta.mentionCount = 0; }
      // interaction -> timeline
      p.interactions.push({ date: entry.meta.date, entryId: entry.meta.id, event: ref.interaction });
      // note -> traits (raw; curation 清理延后)
      if (ref.note && !p.traits.includes(ref.note)) p.traits.push(ref.note);
      // relation -> relationshipState（记变化，非每条重复）
      if (ref.relation) {
        const last = p.relationshipState[p.relationshipState.length - 1];
        if (!last || last.state !== ref.relation) {
          p.relationshipState.push({ date: entry.meta.date, state: ref.relation });
        }
      }
      p.meta.lastSeen = entry.meta.date;
      p.meta.mentionCount += 1;
      await deps.profileStore.save(p, existing ? "update" : "create");
      filed.push(ref.name);
      markedKeys.push(key);
    } catch (err) {
      errors.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (markedKeys.length) await deps.curatedIndex.mark(markedKeys);
  return { filed, markedKeys, errors };
}

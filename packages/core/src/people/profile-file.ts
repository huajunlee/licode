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

export interface MergeDeps {
  profileStore: PersonProfileStore;
}
export interface MergeResult {
  merged: { from: string; into: string } | null;
  error: string | null;
}

/**
 * 手动合并（补漏并）：把 fromName 档案并入 intoName 档案。
 * - intoName 的 aliases 补入 fromName 的 canonicalName + 其 aliases
 * - 合并 interactions / traits / preferences（去重）
 * - relationshipState 合并并按日期排序
 * - 删除 fromName 档案
 * 用于 profile-curation side-call 漏判（没提议 merge）时的人审兜底。
 */
export async function mergeProfiles(fromName: string, intoName: string, deps: MergeDeps): Promise<MergeResult> {
  const from = await deps.profileStore.findByName(fromName);
  const into = await deps.profileStore.findByName(intoName);
  if (!from) return { merged: null, error: `找不到档案「${fromName}」` };
  if (!into) return { merged: null, error: `找不到档案「${intoName}」` };
  if (from.meta.slug === into.meta.slug) {
    return { merged: null, error: `「${fromName}」和「${intoName}」已是同一档案` };
  }
  // aliases: 补入 from 的 canonicalName + 其别名
  const addAlias = (a: string) => { if (a && !into.meta.aliases.includes(a)) into.meta.aliases.push(a); };
  addAlias(from.meta.canonicalName);
  for (const a of from.meta.aliases) addAlias(a);
  // 合并内容（去重）
  into.interactions.push(...from.interactions);
  into.traits = [...new Set([...into.traits, ...from.traits])];
  into.preferences = [...new Set([...into.preferences, ...from.preferences])];
  into.relationshipState = [...into.relationshipState, ...from.relationshipState]
    .sort((a, b) => a.date.localeCompare(b.date));
  // meta
  into.meta.firstSeen = into.meta.firstSeen < from.meta.firstSeen ? into.meta.firstSeen : from.meta.firstSeen;
  into.meta.lastSeen = into.meta.lastSeen > from.meta.lastSeen ? into.meta.lastSeen : from.meta.lastSeen;
  into.meta.mentionCount += from.meta.mentionCount;
  await deps.profileStore.save(into, "update");
  await deps.profileStore.delete(from.meta.slug);
  return { merged: { from: from.meta.canonicalName, into: into.meta.canonicalName }, error: null };
}

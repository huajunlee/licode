import type { JournalStore } from "../diary/store.js";
import type { CuratedIndex } from "../diary/curated.js";
import type { MemoryStore } from "../memory/store.js";
import type { MemoryCuration } from "./memory-curation.js";
import type { PersonProfileStore } from "../people/store.js";
import type { ProfileCuration } from "../people/curation/profile-curation.js";
import { mergeProfiles } from "../people/profile-file.js";
import { CurationSession, type Selection } from "./session.js";
import type { PendingCandidate, PendingPerson } from "./types.js";

export interface CurationDispatchDeps {
  journalStore: JournalStore;
  memoryStore: MemoryStore;
  curatedIndex: CuratedIndex;
  memoryCuration: MemoryCuration;
  profileStore: PersonProfileStore;
  profileCuration: ProfileCuration;
  now: () => Date;
}
export interface CurationDispatchContext extends CurationDispatchDeps {
  session: CurationSession | null;
}
export interface CurationDispatchResult {
  type: "action" | "error";
  message: string;
}
export interface CurationDispatchOutcome {
  result: CurationDispatchResult;
  nextSession: CurationSession | null;
}

const NON_PERSON = new Set(["preference", "decision", "goal", "other"]);

async function gatherPending(ctx: CurationDispatchDeps): Promise<PendingCandidate[]> {
  const index = await ctx.curatedIndex.load();
  const all = await ctx.journalStore.listAll();
  const out: PendingCandidate[] = [];
  for (const e of all) {
    for (let i = 0; i < e.futureMemory.length; i++) {
      const c = e.futureMemory[i];
      const key = `${e.meta.id}#c${i}`;
      if (index.has(key)) continue;
      if (c.importance !== "high") continue;          // low/medium 留日记
      if (!NON_PERSON.has(c.type)) continue;          // person_trait/relationship 留给 Phase B
      out.push({ key, candidate: c });
    }
  }
  return out;
}

async function gatherPendingPeople(ctx: CurationDispatchDeps): Promise<PendingPerson[]> {
  const index = await ctx.curatedIndex.load();
  const all = await ctx.journalStore.listAll();
  const out: PendingPerson[] = [];
  for (const e of all) {
    for (let i = 0; i < e.people.length; i++) {
      const key = `${e.meta.id}#p${i}`;
      if (index.has(key)) continue;          // 已自动入档或已整理
      out.push({ key, personRef: e.people[i], date: e.meta.date, entryId: e.meta.id });
    }
  }
  return out;
}

function parseApply(rest: string): Selection | "reject" | null {
  const args = rest.split(/\s+/).filter(Boolean);
  if (args[0] === "reject") return "reject";
  if (args[0] === "apply") {
    if (args[1] === "all" || args.length === 1) return "all";
    const nums = args.slice(1).flatMap((s) => s.split(",")).map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n));
    return nums.map((n) => n - 1); // 1-indexed display -> 0-indexed
  }
  return null;
}

export async function handleCurationInput(
  input: string,
  ctx: CurationDispatchContext
): Promise<CurationDispatchOutcome | null> {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/diary-curate")) return null;
  const rest = trimmed.slice("/diary-curate".length).trim();

  // apply / reject operate on an existing session
  if (rest.startsWith("apply") || rest.startsWith("reject")) {
    if (!ctx.session) {
      return { result: { type: "error", message: "没有待确认的整理提议。先 /diary-curate 生成。" }, nextSession: null };
    }
    const sel = parseApply(rest);
    if (sel === "reject") {
      return { result: { type: "action", message: "已放弃本轮整理（未落库，下次可重跑 /diary-curate）。" }, nextSession: null };
    }
    if (sel === null) {
      return { result: { type: "error", message: "用法: /diary-curate apply 1,3,5 | apply all | reject" }, nextSession: ctx.session };
    }
    const res = await ctx.session.apply(sel, { memoryStore: ctx.memoryStore, curatedIndex: ctx.curatedIndex, profileStore: ctx.profileStore });
    return { result: { type: "action", message: `✅ 已应用 ${res.applied} 项整理。` }, nextSession: null };
  }

  // /diary-curate merge <from> <into> -- 手动合并（补漏并）
  if (rest.startsWith("merge")) {
    const parts = rest.slice("merge".length).split(/[\s,，]+/).filter(Boolean);
    if (parts.length < 2) {
      return { result: { type: "error", message: "用法: /diary-curate merge <fromName> <intoName>（把 from 档案并入 into）" }, nextSession: ctx.session };
    }
    const [fromName, intoName] = parts;
    const mr = await mergeProfiles(fromName, intoName, { profileStore: ctx.profileStore });
    if (mr.error) return { result: { type: "error", message: mr.error }, nextSession: ctx.session };
    return { result: { type: "action", message: `✅ 已合并「${mr.merged!.from}」->「${mr.merged!.into}」（前者档案已删除，后者 aliases 已补充）。` }, nextSession: ctx.session };
  }

  // /diary-curate (no sub) -> gather + curate + stash
  const pendingC = await gatherPending(ctx);
  const pendingP = await gatherPendingPeople(ctx);
  if (pendingC.length === 0 && pendingP.length === 0) {
    return { result: { type: "action", message: "没有待整理的候选（高优候选已自动提升或已整理）。" }, nextSession: null };
  }
  const memProps = pendingC.length ? await ctx.memoryCuration.curate(pendingC) : [];
  const profiles = await ctx.profileStore.listAll();
  const profProps = pendingP.length ? await ctx.profileCuration.resolveAmbiguous(pendingP, profiles) : [];
  const proposals = [...memProps, ...profProps];
  if (proposals.length === 0) {
    return { result: { type: "action", message: `⚠️ 整理未产出提议（候选 ${pendingC.length}、模糊人 ${pendingP.length}），可能 side-call 失败，可重试 /diary-curate。` }, nextSession: null };
  }
  const session = new CurationSession(proposals);
  return {
    result: { type: "action", message: `整理提议（共 ${proposals.length} 项，/diary-curate apply 1,3 | apply all | reject）：\n${session.formatList()}` },
    nextSession: session,
  };
}

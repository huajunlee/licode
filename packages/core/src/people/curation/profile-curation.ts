import type { PersonProfile } from "../types.js";
import type { PendingPerson, ProfileMergeProposal, ProfileNewProposal } from "../../curation/types.js";

export interface ProfileCurationConfig {
  generate: (prompt: string) => Promise<string>;
}

type ResolveProposal = ProfileMergeProposal | ProfileNewProposal;

export class ProfileCuration {
  constructor(private config: ProfileCurationConfig) {}

  async resolveAmbiguous(pending: PendingPerson[], profiles: PersonProfile[]): Promise<ResolveProposal[]> {
    if (pending.length === 0) return [];
    let raw: string;
    try {
      raw = await this.config.generate(this.buildResolvePrompt(pending, profiles));
    } catch {
      return [];
    }
    return this.parseResolve(raw, pending);
  }

  private buildResolvePrompt(pending: PendingPerson[], profiles: PersonProfile[]): string {
    const ppl = pending.map((p, i) =>
      `[${i}] name=${p.personRef.name} | relation=${p.personRef.relation ?? "?"} | interaction=${p.personRef.interaction} | note=${p.personRef.note ?? "?"}`
    ).join("\n");
    const profs = profiles.length
      ? profiles.map((p) => `- slug=${p.meta.slug} canonical=${p.meta.canonicalName} aliases=[${p.meta.aliases.join(",")}]`).join("\n")
      : "(无现有档案)";
    return [
      "你是人物档案的别名归一器。下面是日记里【模糊】（泛称）提到的人，和现有档案。判断每个模糊人是否就是某个现有档案（同一个人），还是新人物。",
      "靠名字周围的上下文（relation/interaction/note）判断，不是字符串匹配。歧义无法确定时判 new。",
      "",
      "现有档案：", profs,
      "",
      "模糊人：", ppl,
      "",
      '只返回 JSON 数组（无则 []）：[{"action":"merge","index":0,"intoSlug":"wang","reason":"..."} | {"action":"new","index":0,"name":"李四","reason":"..."}]',
    ].join("\n");
  }

  private parseResolve(raw: string, pending: PendingPerson[]): ResolveProposal[] {
    let s = raw.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const start = s.indexOf("[");
    const end = s.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start) return [];
    let arr: unknown;
    try { arr = JSON.parse(s.slice(start, end + 1)); } catch { return []; }
    if (!Array.isArray(arr)) return [];
    const out: ResolveProposal[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const idx = Number(o.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= pending.length) continue;
      const p = pending[idx];
      const data = { date: p.date, entryId: p.entryId, interaction: p.personRef.interaction, note: p.personRef.note, relation: p.personRef.relation };
      if (o.action === "merge" && typeof o.intoSlug === "string") {
        out.push({ kind: "profile-merge", fromName: p.personRef.name, intoSlug: o.intoSlug, reason: String(o.reason ?? ""), ...data, sourceKeys: [p.key] });
      } else if (o.action === "new" && typeof o.name === "string") {
        out.push({ kind: "profile-new", name: o.name, reason: String(o.reason ?? ""), ...data, sourceKeys: [p.key] });
      }
    }
    return out;
  }
}

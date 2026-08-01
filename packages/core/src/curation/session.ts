import type { Proposal, MemoryCreateProposal, ProfileMergeProposal, ProfileNewProposal } from "./types.js";
import type { MemoryStore } from "../memory/store.js";
import type { CuratedIndex } from "../diary/curated.js";
import type { PersonProfileStore } from "../people/store.js";
import { emptyProfile } from "../people/types.js";
import { toSlug } from "../memory/types.js";

export type Selection = "all" | number[];

export interface ApplyDeps {
  memoryStore: MemoryStore;
  curatedIndex: CuratedIndex;
  profileStore?: PersonProfileStore;
}

export interface ApplyResult {
  applied: number;
  markedKeys: string[];
}

const NOW = () => new Date();

export class CurationSession {
  constructor(private proposals: Proposal[]) {}

  get length(): number { return this.proposals.length; }

  formatList(): string {
    const lines: string[] = [];
    this.proposals.forEach((p, i) => {
      if (p.kind === "memory") {
        lines.push(`${i + 1}. [新建记忆] ${p.slug} "${p.name}"`);
      } else if (p.kind === "profile-merge") {
        lines.push(`${i + 1}. [并别名] "${p.fromName}" -> ${p.intoSlug} (${p.reason})`);
      } else if (p.kind === "profile-new") {
        lines.push(`${i + 1}. [新档案] ${p.name} (${p.reason})`);
      }
    });
    return lines.join("\n");
  }

  async apply(selection: Selection, deps: ApplyDeps): Promise<ApplyResult> {
    const chosen = new Set<number>(selection === "all" ? this.proposals.map((_, i) => i) : selection);
    let applied = 0;
    const markedKeys: string[] = [];
    for (let i = 0; i < this.proposals.length; i++) {
      const p = this.proposals[i];
      // collect ALL proposed sourceKeys (selected or not) -> no nag
      if (p.kind === "memory") markedKeys.push(...p.sourceKeys);
      else if (p.kind === "profile-merge" || p.kind === "profile-new") markedKeys.push(...p.sourceKeys);
      if (!chosen.has(i)) continue;
      if (p.kind === "memory") {
        const m = p as MemoryCreateProposal;
        const iso = NOW().toISOString();
        await deps.memoryStore.save(
          { slug: m.slug, type: m.type, name: m.name, description: m.description, content: m.content, createdAt: iso, updatedAt: iso },
          "create"
        );
        applied++;
      } else if (p.kind === "profile-merge" && deps.profileStore) {
        const target = await deps.profileStore.load((p as ProfileMergeProposal).intoSlug);
        if (target) {
          if (!target.meta.aliases.includes(p.fromName)) target.meta.aliases.push(p.fromName);
          target.interactions.push({ date: p.date, entryId: p.entryId, event: p.interaction });
          if (p.note && !target.traits.includes(p.note)) target.traits.push(p.note);
          if (p.relation) { const last = target.relationshipState[target.relationshipState.length - 1]; if (!last || last.state !== p.relation) target.relationshipState.push({ date: p.date, state: p.relation }); }
          target.meta.lastSeen = p.date; target.meta.mentionCount += 1;
          await deps.profileStore.save(target, "update");
          applied++;
        }
      } else if (p.kind === "profile-new" && deps.profileStore) {
        const pn = p as ProfileNewProposal;
        const np = emptyProfile(pn.name, pn.date);
        np.meta.slug = toSlug(pn.name);
        np.interactions.push({ date: pn.date, entryId: pn.entryId, event: pn.interaction });
        if (pn.note) np.traits.push(pn.note);
        if (pn.relation) np.relationshipState.push({ date: pn.date, state: pn.relation });
        np.meta.mentionCount = 1;
        await deps.profileStore.save(np, "create");
        applied++;
      }
    }
    if (markedKeys.length) await deps.curatedIndex.mark(markedKeys);
    return { applied, markedKeys };
  }
}

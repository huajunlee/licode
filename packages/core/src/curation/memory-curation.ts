import type { MemoryType } from "../memory/types.js";
import type { PendingCandidate, MemoryCreateProposal } from "./types.js";

export interface MemoryCurationConfig {
  generate: (prompt: string) => Promise<string>;
}

const VALID_TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];

export class MemoryCuration {
  constructor(private config: MemoryCurationConfig) {}

  async curate(pending: PendingCandidate[]): Promise<MemoryCreateProposal[]> {
    if (pending.length === 0) return [];
    let raw: string;
    try {
      raw = await this.config.generate(this.buildPrompt(pending));
    } catch {
      return [];
    }
    return this.parse(raw, pending);
  }

  private buildPrompt(pending: PendingCandidate[]): string {
    const list = pending.map((p, i) =>
      `[${i}] type=${p.candidate.type} importance=${p.candidate.importance} | ${p.candidate.content}`
    ).join("\n");
    return [
      "你是日记候选记忆的整理器。把下面的 futureMemory 候选合并成少数连贯的长期记忆（窄档：只在这批候选之间合并，不碰库里已有记忆）。",
      "规则：相关候选合并成一条；type 从 user|feedback|project|reference 选（preference 倾向 user、decision/goal 倾向 project）；sources 用候选序号；不臆造。",
      "",
      "候选：",
      list,
      "",
      "只返回 JSON 数组（无则 []）：",
      '[{"slug":"project/xxx","type":"project","name":"简短","description":"一句","content":"正文","sources":[0,1]}]',
    ].join("\n");
  }

  private parse(raw: string, pending: PendingCandidate[]): MemoryCreateProposal[] {
    let s = raw.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const start = s.indexOf("[");
    const end = s.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start) return [];
    let arr: unknown;
    try { arr = JSON.parse(s.slice(start, end + 1)); } catch { return []; }
    if (!Array.isArray(arr)) return [];
    const out: MemoryCreateProposal[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const type = o.type as MemoryType;
      if (!VALID_TYPES.includes(type)) continue;
      const sources = Array.isArray(o.sources) ? (o.sources as number[]).filter((n) => Number.isInteger(n) && n >= 0 && n < pending.length) : [];
      if (sources.length === 0) continue;
      out.push({
        kind: "memory",
        slug: typeof o.slug === "string" ? o.slug : `${type}/untitled`,
        type,
        name: typeof o.name === "string" ? o.name : "untitled",
        description: typeof o.description === "string" ? o.description : "",
        content: typeof o.content === "string" ? o.content : "",
        sourceKeys: sources.map((i) => pending[i].key),
      });
    }
    return out;
  }
}

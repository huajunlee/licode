import type { PersonProfile } from "./types.js";

const SUMMARY_MAX = 100;

function parseFrontmatter(fm: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of fm.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return map;
}

function extractJsonBlock(body: string): string | null {
  const fence = body.match(/```json\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start !== -1 && end > start) return body.slice(start, end + 1);
  return null;
}

export function serializeProfile(p: PersonProfile): string {
  const fm = [
    "---",
    `canonicalName: ${p.meta.canonicalName}`,
    `aliases: ${p.meta.aliases.join(", ")}`,
    `slug: ${p.meta.slug}`,
    `firstSeen: ${p.meta.firstSeen}`,
    `lastSeen: ${p.meta.lastSeen}`,
    `mentionCount: ${p.meta.mentionCount}`,
    `summary: ${p.summary.slice(0, SUMMARY_MAX)}`,
    "---",
    "",
  ].join("\n");
  const json = JSON.stringify(
    { traits: p.traits, preferences: p.preferences, interactions: p.interactions, relationshipState: p.relationshipState },
    null, 2
  );
  const fence = "```";
  return `${fm}## 概述\n${p.summary}\n\n## 结构化\n${fence}json\n${json}\n${fence}\n`;
}

export function parseProfile(raw: string): PersonProfile | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const fm = parseFrontmatter(m[1]);
  const jsonStr = extractJsonBlock(m[2]);
  if (!jsonStr) return null;
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(jsonStr); } catch { return null; }
  const summaryMatch = m[2].match(/## 概述\n([\s\S]*?)\n\n## 结构化/);
  const summary = summaryMatch ? summaryMatch[1].trim() : "";
  return {
    meta: {
      canonicalName: fm.canonicalName ?? "",
      aliases: (fm.aliases ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      slug: fm.slug ?? "",
      firstSeen: fm.firstSeen ?? "",
      lastSeen: fm.lastSeen ?? "",
      mentionCount: Number(fm.mentionCount ?? 0) || 0,
    },
    summary,
    traits: Array.isArray(obj.traits) ? obj.traits as string[] : [],
    preferences: Array.isArray(obj.preferences) ? obj.preferences as string[] : [],
    interactions: Array.isArray(obj.interactions) ? obj.interactions as PersonProfile["interactions"] : [],
    relationshipState: Array.isArray(obj.relationshipState) ? obj.relationshipState as PersonProfile["relationshipState"] : [],
  };
}

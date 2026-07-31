import type { DiaryEntry } from "./types.js";

const INDEX_SUMMARY_MAX = 100;

function unique(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))];
}

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

export function serializeEntry(entry: DiaryEntry): string {
  const people = unique(entry.people.map((p) => p.name));
  const emotions = unique(entry.emotions.map((e) => e.state));
  const fm = [
    "---",
    `id: ${entry.meta.id}`,
    `date: ${entry.meta.date}`,
    `createdAt: ${entry.meta.createdAt}`,
    `endedAt: ${entry.meta.endedAt}`,
    `people: ${people.join(", ")}`,
    `emotions: ${emotions.join(", ")}`,
    `summary: ${entry.summary.slice(0, INDEX_SUMMARY_MAX)}`,
    "---",
    "",
  ].join("\n");

  const rawBlock = entry.raw.segments
    .map((s) => `[${s.timestamp}] ${s.speaker}: ${s.content}`)
    .join("\n");

  const json = JSON.stringify(
    {
      raw: entry.raw,
      summary: entry.summary,
      facts: entry.facts,
      decisions: entry.decisions,
      emotions: entry.emotions,
      people: entry.people,
      futureMemory: entry.futureMemory,
    },
    null,
    2
  );

  const fence = "```";
  return `${fm}## 原文\n${rawBlock}\n\n## 结构化\n${fence}json\n${json}\n${fence}\n`;
}

export function parseEntry(raw: string): DiaryEntry | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const fm = parseFrontmatter(m[1]);
  const jsonStr = extractJsonBlock(m[2]);
  if (!jsonStr) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  const rawField = (obj.raw as DiaryEntry["raw"]) ?? { content: "", segments: [] };
  return {
    meta: {
      id: fm.id ?? "",
      date: fm.date ?? "",
      createdAt: fm.createdAt ?? "",
      endedAt: fm.endedAt ?? "",
    },
    raw: rawField,
    summary: typeof obj.summary === "string" ? obj.summary : "",
    facts: Array.isArray(obj.facts) ? (obj.facts as DiaryEntry["facts"]) : [],
    decisions: Array.isArray(obj.decisions) ? (obj.decisions as DiaryEntry["decisions"]) : [],
    emotions: Array.isArray(obj.emotions) ? (obj.emotions as DiaryEntry["emotions"]) : [],
    people: Array.isArray(obj.people) ? (obj.people as DiaryEntry["people"]) : [],
    futureMemory: Array.isArray(obj.futureMemory) ? (obj.futureMemory as DiaryEntry["futureMemory"]) : [],
  };
}

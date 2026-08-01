import type { DiaryEntry, PersonRef } from "../../diary/types.js";
import { formatLocalDate } from "../../util/date.js";

export interface BuildEntryInput {
  topic: string;
  decision: string;
  reasoning: string;
  people?: string[];
  now: () => Date;
}

export function buildDecisionEntry(input: BuildEntryInput): DiaryEntry {
  const { topic, decision, reasoning, people, now } = input;
  const d = now();
  const iso = d.toISOString();
  const peopleRefs: PersonRef[] = (people ?? []).map((name) => ({
    name,
    relation: null,
    relationInferred: false,
    interaction: "决策涉及",
    note: null,
    specific: true,
  }));
  return {
    meta: { id: d.getTime().toString(36), date: formatLocalDate(d), createdAt: iso, endedAt: iso },
    raw: {
      content: `# 决策：${topic}\n\n## 结论\n${decision}\n\n## 理由与分析\n${reasoning}`,
      segments: [],
    },
    title: `【决策】${topic}`,
    summary: decision,
    facts: [],
    decisions: [{ decision, reasoning, context: topic }],
    emotions: [],
    people: peopleRefs,
    futureMemory: [],
  };
}

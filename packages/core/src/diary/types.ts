export type FutureMemoryType = "person_trait" | "preference" | "relationship" | "decision" | "goal" | "other";
export type Importance = "low" | "medium" | "high";
export type Promotability = "low" | "medium" | "high";

export interface Segment {
  timestamp: string;
  speaker: "user";
  content: string;
}
export interface Fact { what: string; when: string | null; tags: string[]; }
export interface Decision { decision: string; reasoning: string | null; context: string | null; }
export interface Emotion { state: string; intensity: 1 | 2 | 3 | 4 | 5; trigger: string | null; inferred: boolean; }
export interface PersonRef { name: string; relation: string | null; relationInferred: boolean; interaction: string; note: string | null; specific: boolean; }
export interface Candidate { content: string; type: FutureMemoryType; importance: Importance; promotability: Promotability; reason: string; }

export interface DiaryEntryMeta { id: string; date: string; createdAt: string; endedAt: string; }

export interface DiaryEntry {
  meta: DiaryEntryMeta;
  raw: { content: string; segments: Segment[] };
  title: string;
  summary: string;
  facts: Fact[];
  decisions: Decision[];
  emotions: Emotion[];
  people: PersonRef[];
  futureMemory: Candidate[];
}

export function emptyEntry(id: string, date: string, createdAt: string): DiaryEntry {
  return {
    meta: { id, date, createdAt, endedAt: createdAt },
    raw: { content: "", segments: [] },
    title: "",
    summary: "",
    facts: [], decisions: [], emotions: [], people: [], futureMemory: [],
  };
}

import { formatLocalDate } from "../util/date.js";

export function dateString(d: Date): string {
  return formatLocalDate(d);
}

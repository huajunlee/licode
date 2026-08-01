import type { Candidate, PersonRef } from "../diary/types.js";
import type { MemoryType } from "../memory/types.js";

export interface PendingCandidate {
  key: string;            // ${entryId}#c${idx}
  candidate: Candidate;
}

export interface MemoryCreateProposal {
  kind: "memory";
  slug: string;
  type: MemoryType;
  name: string;
  description: string;
  content: string;
  sourceKeys: string[];   // candidate keys merged into this memory
}

// Phase B: profile proposals
export interface PendingPerson {
  key: string;             // ${entryId}#p${idx}
  personRef: PersonRef;
  date: string;
  entryId: string;
}

export interface ProfileMergeProposal {
  kind: "profile-merge";
  fromName: string;
  intoSlug: string;
  reason: string;
  date: string; entryId: string; interaction: string; note: string | null; relation: string | null;
  sourceKeys: string[];
}
export interface ProfileNewProposal {
  kind: "profile-new";
  name: string;
  reason: string;
  date: string; entryId: string; interaction: string; note: string | null; relation: string | null;
  sourceKeys: string[];
}

export type Proposal = MemoryCreateProposal | ProfileMergeProposal | ProfileNewProposal;

import type { Candidate } from "../diary/types.js";
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

// Phase B will add: ProfileMergeProposal / ProfileNewProposal / ProfileUpdateProposal
export type Proposal = MemoryCreateProposal;

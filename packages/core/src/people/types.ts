export interface Interaction { date: string; entryId: string; event: string; }
export interface RelationshipState { date: string; state: string; }

export interface PersonProfileMeta {
  canonicalName: string;
  aliases: string[];
  slug: string;
  firstSeen: string;
  lastSeen: string;
  mentionCount: number;
}

export interface PersonProfile {
  meta: PersonProfileMeta;
  summary: string;
  traits: string[];
  preferences: string[];
  interactions: Interaction[];
  relationshipState: RelationshipState[];
}

export function emptyProfile(canonicalName: string, date: string): PersonProfile {
  return {
    meta: { canonicalName, aliases: [], slug: "", firstSeen: date, lastSeen: date, mentionCount: 0 },
    summary: "",
    traits: [], preferences: [], interactions: [], relationshipState: [],
  };
}

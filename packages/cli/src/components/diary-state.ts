import type { Segment } from "@licode/core";

export interface DiaryState {
  mode: boolean;
  segments: Segment[];
  date: string;
}

export const EMPTY_DIARY_STATE: DiaryState = { mode: false, segments: [], date: "" };

/**
 * Derive the next diary UI state from a handleDiaryInput outcome.
 * - nextSession non-null -> mode on, mirror its segments + date
 * - nextSession null (wasEnd) -> mode off, clear
 */
export function nextDiaryState(
  nextSession: { getSegments(): Segment[]; getDate(): string } | null
): DiaryState {
  if (nextSession) {
    return {
      mode: true,
      segments: [...nextSession.getSegments()],
      date: nextSession.getDate(),
    };
  }
  return { ...EMPTY_DIARY_STATE };
}

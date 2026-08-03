import { describe, it, expect } from "vitest";
import { nextDiaryState, EMPTY_DIARY_STATE } from "./diary-state.js";

const fakeSession = (segs: string[], date: string) => ({
  getSegments: () => segs.map((content) => ({ timestamp: "", speaker: "user" as const, content })),
  getDate: () => date,
});

describe("nextDiaryState", () => {
  it("enter: mode on, empty segments, session date", () => {
    const s = nextDiaryState(fakeSession([], "2026-8-2"));
    expect(s).toEqual({ mode: true, segments: [], date: "2026-8-2" });
  });
  it("capture: mode on, segments mirrored", () => {
    const s = nextDiaryState(fakeSession(["第一段", "第二段"], "2026-8-2"));
    expect(s.mode).toBe(true);
    expect(s.segments.map((g) => g.content)).toEqual(["第一段", "第二段"]);
  });
  it("end: mode off, cleared", () => {
    const s = nextDiaryState(null);
    expect(s).toEqual(EMPTY_DIARY_STATE);
  });
});

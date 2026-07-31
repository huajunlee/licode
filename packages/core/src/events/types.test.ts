import { describe, expect, it } from "vitest";
// Type-level test: the new fields must be assignable.
import type { PipelineEvent } from "./types.js";

describe("context-compressed event", () => {
  it("accepts rolling method and new stat fields", () => {
    const e: PipelineEvent = {
      type: "context-compressed",
      method: "rolling",
      removedMessages: 4,
      retainedTurns: 2,
      compactedTurns: 1,
      summaryUpdated: true,
    };
    expect(e.type).toBe("context-compressed");
    expect(e.method).toBe("rolling");
  });
});

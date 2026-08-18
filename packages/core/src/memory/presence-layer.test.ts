import { describe, it, expect } from "vitest";
import { memoryPresenceLayer } from "./presence-layer.js";

describe("memoryPresenceLayer", () => {
  it("quantizes count down to tens for n >= 10", () => {
    expect(memoryPresenceLayer(23).content).toContain("20+ 条");
    expect(memoryPresenceLayer(10).content).toContain("10+ 条");
  });

  it("uses 几 for 1-9", () => {
    expect(memoryPresenceLayer(7).content).toContain("几 条".replace(" ", ""));
  });

  it("omits count phrase for 0", () => {
    expect(memoryPresenceLayer(0).content).toContain("目前还没有长期记忆");
  });

  it("mentions the four categories and memory_recall for n > 0", () => {
    const c = memoryPresenceLayer(23).content;
    for (const kw of ["user", "feedback", "project", "reference", "memory_recall"]) {
      expect(c).toContain(kw);
    }
  });

  it("is an optional layer named memory-presence at priority 5", () => {
    const layer = memoryPresenceLayer(5);
    expect(layer).toMatchObject({ name: "memory-presence", priority: 5, always: false });
  });
});

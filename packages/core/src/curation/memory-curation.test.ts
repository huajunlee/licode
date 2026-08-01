import { describe, it, expect } from "vitest";
import { MemoryCuration } from "./memory-curation.js";
import type { PendingCandidate } from "./types.js";

function pc(key: string, content: string, type: string): PendingCandidate {
  return { key, candidate: { content, type: type as never, importance: "high", promotability: "low", reason: "r" } };
}

describe("MemoryCuration", () => {
  it("clusters pending candidates into create proposals with sourceKeys", async () => {
    const generate = async () => JSON.stringify([
      { slug: "project/arch", type: "project", name: "新架构决定", description: "决定换架构", content: "决定下周启用新架构", sources: [0] },
    ]);
    const c = new MemoryCuration({ generate });
    const props = await c.curate([pc("e1#c0", "决定下周启用新架构", "decision")]);
    expect(props.length).toBe(1);
    expect(props[0].slug).toBe("project/arch");
    expect(props[0].type).toBe("project");
    expect(props[0].sourceKeys).toEqual(["e1#c0"]);
  });

  it("parses proposals wrapped in a json fence", async () => {
    const generate = async () => "```json\n" + JSON.stringify([
      { slug: "user/prefs", type: "user", name: "偏好", description: "d", content: "我喜欢早起", sources: [0] },
    ]) + "\n```";
    const c = new MemoryCuration({ generate });
    const props = await c.curate([pc("e1#c0", "我喜欢早起", "preference")]);
    expect(props[0].sourceKeys).toEqual(["e1#c0"]);
  });

  it("returns [] when side-call throws (skip pass)", async () => {
    const generate = async () => { throw new Error("net"); };
    const c = new MemoryCuration({ generate });
    const props = await c.curate([pc("e1#c0", "x", "other")]);
    expect(props).toEqual([]);
  });

  it("returns [] when response is not JSON", async () => {
    const generate = async () => "nope";
    const c = new MemoryCuration({ generate });
    expect(await c.curate([pc("e1#c0", "x", "other")])).toEqual([]);
  });
});

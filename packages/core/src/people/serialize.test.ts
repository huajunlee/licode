import { describe, it, expect } from "vitest";
import { emptyProfile } from "./types.js";
import { serializeProfile, parseProfile } from "./serialize.js";

describe("PersonProfile serialize", () => {
  it("emptyProfile produces canonical shape", () => {
    const p = emptyProfile("王总", "2026-08-01");
    expect(p.meta.canonicalName).toBe("王总");
    expect(p.meta.aliases).toEqual([]);
    expect(p.traits).toEqual([]);
    expect(p.interactions).toEqual([]);
  });

  it("round-trips a full profile", () => {
    const p = emptyProfile("王总", "2026-08-01");
    p.meta.aliases = ["老板", "王志远"];
    p.meta.mentionCount = 3;
    p.summary = "用户的上级，做事果断";
    p.traits = ["做事果断"];
    p.preferences = ["爱喝茶，偏好龙井"];
    p.interactions = [{ date: "2026-08-01", entryId: "e1", event: "开会聊新项目" }];
    p.relationshipState = [{ date: "2026-08-01", state: "直属领导" }];

    const raw = serializeProfile(p);
    expect(raw).toContain("canonicalName: 王总");
    expect(raw).toContain("## 概述");
    expect(raw).toContain("## 结构化");

    const parsed = parseProfile(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.meta.canonicalName).toBe("王总");
    expect(parsed!.meta.aliases).toEqual(["老板", "王志远"]);
    expect(parsed!.traits).toEqual(["做事果断"]);
    expect(parsed!.interactions[0].event).toBe("开会聊新项目");
    expect(parsed!.relationshipState[0].state).toBe("直属领导");
  });

  it("parseProfile returns null on non-frontmatter input", () => {
    expect(parseProfile("just text")).toBeNull();
  });
});

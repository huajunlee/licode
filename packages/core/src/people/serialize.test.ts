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

  it("多段概述不会把 frontmatter 撑破（summary 行必须单行）", () => {
    const p = emptyProfile("爸妈", "2026-08-01");
    // 前 100 字里带换行——不处理的话 frontmatter 会在换行处断掉，
    // 后面的段落变成伪 key，外部工具读这段 YAML 就崩
    p.summary = "第一段概述。\n\n第二段概述。\n\n第三段。";
    const raw = serializeProfile(p);

    // frontmatter 是首个 --- 到第二个 --- 之间，里面不能有裸换行开头的续行
    const fm = raw.split("---\n")[1];
    const summaryLine = fm.split("\n").find((l) => l.startsWith("summary: "));
    expect(summaryLine).toBeDefined();
    expect(summaryLine).toBe("summary: 第一段概述。 第二段概述。 第三段。");

    // 正文里的概述仍保留分段
    expect(raw).toContain("## 概述\n第一段概述。\n\n第二段概述。\n\n第三段。");

    // 往返仍能取回完整概述
    expect(parseProfile(raw)!.summary).toBe("第一段概述。\n\n第二段概述。\n\n第三段。");
  });

  it("parseProfile returns null on non-frontmatter input", () => {
    expect(parseProfile("just text")).toBeNull();
  });
});

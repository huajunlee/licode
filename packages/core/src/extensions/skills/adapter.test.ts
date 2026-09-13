import { describe, it, expect } from "vitest";
import { skillsToPromptLayer } from "./adapter.js";
import type { Skill } from "./loader.js";

describe("skillsToPromptLayer", () => {
  const skills: Skill[] = [
    { name: "decision", description: "帮用户做决定时使用", dir: "/p/decision" },
    { name: "people", description: "查询人物档案时使用", dir: "/p/people" },
  ];

  it("把多个技能合成一个常驻书目层", () => {
    const layer = skillsToPromptLayer(skills, "/proj/.licode/skills");

    expect(layer).not.toBeNull();
    expect(layer!.name).toBe("skills");
    expect(layer!.priority).toBe(15);
    expect(layer!.always).toBe(true);
    expect(layer!.content).toContain("- decision：帮用户做决定时使用");
    expect(layer!.content).toContain("- people：查询人物档案时使用");
    expect(layer!.content).toContain("/proj/.licode/skills");
  });

  it("书目层不含正文（正文只在磁盘上）", () => {
    const layer = skillsToPromptLayer(skills, "/proj/.licode/skills");
    expect(layer!.content).not.toContain("SKILL.md 的正文");
    expect(layer!.content.length).toBeLessThan(500);
  });

  it("没有技能时返回 null，不添加空层", () => {
    expect(skillsToPromptLayer([], "/proj/.licode/skills")).toBeNull();
  });
});

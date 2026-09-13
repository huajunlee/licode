import { describe, it, expect } from "vitest";
import { parseYamlFrontmatter } from "./parser.js";

describe("parseYamlFrontmatter", () => {
  it("提取 frontmatter 与正文", () => {
    const raw = `---
name: web-access
description: 搜索网页时使用
---
# Web Access Skill

This skill enables web search.`;

    const result = parseYamlFrontmatter(raw);

    expect(result.frontmatter.name).toBe("web-access");
    expect(result.frontmatter.description).toBe("搜索网页时使用");
    expect(result.body).toContain("# Web Access Skill");
    expect(result.body).toContain("This skill enables web search.");
  });

  it("容忍多余字段（不报错，也不进契约）", () => {
    const raw = `---
name: legacy
description: 旧写法
version: 1.0.0
---
Body`;

    const result = parseYamlFrontmatter(raw);

    expect(result.frontmatter.name).toBe("legacy");
    expect(result.frontmatter.description).toBe("旧写法");
  });

  it("没有 frontmatter 时优雅降级", () => {
    const raw = "# Just a markdown file\n\nNo frontmatter here.";

    const result = parseYamlFrontmatter(raw);

    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(raw);
  });

  it("空内容", () => {
    const result = parseYamlFrontmatter("");
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("");
  });
});

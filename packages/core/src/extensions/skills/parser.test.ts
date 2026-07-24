import { describe, it, expect } from "vitest";
import { parseYamlFrontmatter, skillParamsToZod } from "./parser.js";

describe("parseYamlFrontmatter", () => {
  it("extracts frontmatter and body from skill.md content", () => {
    const raw = `---
name: web-access
version: 1.0.0
tools:
  - name: web_search
    description: Search the web
    parameters:
      query:
        type: string
        description: "Search query"
---
# Web Access Skill

This skill enables web search.`;

    const result = parseYamlFrontmatter(raw);

    expect(result.frontmatter.name).toBe("web-access");
    expect(result.frontmatter.version).toBe("1.0.0");
    expect(result.frontmatter.tools).toHaveLength(1);
    expect(result.frontmatter.tools?.[0]?.name).toBe("web_search");
    expect(result.body).toContain("# Web Access Skill");
    expect(result.body).toContain("This skill enables web search.");
  });

  it("handles missing frontmatter gracefully", () => {
    const raw = "# Just a markdown file\n\nNo frontmatter here.";

    const result = parseYamlFrontmatter(raw);

    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(raw);
  });

  it("handles empty content", () => {
    const result = parseYamlFrontmatter("");
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("");
  });

  it("parses multiple tools in frontmatter", () => {
    const raw = `---
name: multi-tool
tools:
  - name: tool_a
    description: First tool
    parameters:
      input:
        type: string
  - name: tool_b
    description: Second tool
    parameters:
      count:
        type: number
---
Body text`;

    const result = parseYamlFrontmatter(raw);
    expect(result.frontmatter.tools).toHaveLength(2);
    expect(result.frontmatter.tools?.[1]?.name).toBe("tool_b");
  });
});

describe("skillParamsToZod", () => {
  it("converts string parameter to zod schema", () => {
    const params = {
      query: { type: "string", description: "Search query" },
    };

    const schema = skillParamsToZod(params);
    expect(schema.safeParse({ query: "hello" }).success).toBe(true);
    expect(schema.safeParse({ query: 123 }).success).toBe(false);
  });

  it("converts number parameter", () => {
    const params = {
      count: { type: "number" },
    };

    const schema = skillParamsToZod(params);
    expect(schema.safeParse({ count: 42 }).success).toBe(true);
  });

  it("handles default values", () => {
    const params = {
      max_results: { type: "number", default: 10 },
    };

    const schema = skillParamsToZod(params);
    const result = schema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_results).toBe(10);
    }
  });

  it("non-defaulted parameters are required", () => {
    const params = {
      name: { type: "string" },
    };

    const schema = skillParamsToZod(params);
    expect(schema.safeParse({}).success).toBe(false);
  });
});

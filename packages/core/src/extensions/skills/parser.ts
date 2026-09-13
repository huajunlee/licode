import * as yaml from "js-yaml";

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  [key: string]: unknown;
}

export function parseYamlFrontmatter(raw: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }

  try {
    const frontmatter = yaml.load(match[1]) as SkillFrontmatter;
    const body = raw.slice(match[0].length).trim();
    return { frontmatter, body };
  } catch {
    return { frontmatter: {}, body: raw };
  }
}

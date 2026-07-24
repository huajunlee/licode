import * as yaml from "js-yaml";
import { z, ZodTypeAny } from "zod";

export interface SkillToolDef {
  name: string;
  description: string;
  parameters: Record<string, {
    type: string;
    description?: string;
    default?: unknown;
  }>;
  script: string;
}

export interface SkillFrontmatter {
  name?: string;
  version?: string;
  tools?: SkillToolDef[];
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

export function skillParamsToZod(
  params: Record<string, { type: string; description?: string; default?: unknown }>
): ZodTypeAny {
  const shape: Record<string, ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(params)) {
    let zodType: ZodTypeAny;

    switch (prop.type) {
      case "string":
        zodType = z.string();
        break;
      case "number":
        zodType = z.number();
        break;
      case "boolean":
        zodType = z.boolean();
        break;
      default:
        zodType = z.any();
    }

    if (prop.description) {
      zodType = zodType.describe(prop.description);
    }

    if (prop.default !== undefined) {
      zodType = zodType.default(prop.default);
    }

    shape[key] = zodType;
  }

  return z.object(shape);
}

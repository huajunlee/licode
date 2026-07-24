import * as fs from "node:fs";
import * as path from "node:path";
import { parseYamlFrontmatter } from "./parser.js";
import type { SkillToolDef } from "./parser.js";

export type { SkillToolDef };

export interface Skill {
  name: string;
  version: string;
  description: string;
  tools: SkillToolDef[];
  dir: string;
}

export class SkillLoader {
  async loadAll(userDir?: string, projectDir?: string): Promise<Skill[]> {
    const userSkills = userDir ? await this.loadFromDir(userDir) : [];
    const projectSkills = projectDir ? await this.loadFromDir(projectDir) : [];

    // Project-level skills override user-level skills with the same name
    const byName = new Map<string, Skill>();
    for (const skill of userSkills) {
      byName.set(skill.name, skill);
    }
    for (const skill of projectSkills) {
      byName.set(skill.name, skill);
    }

    return [...byName.values()];
  }

  async loadFromDir(dir: string): Promise<Skill[]> {
    if (!fs.existsSync(dir)) return [];

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const skills: Skill[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = path.join(dir, entry.name);
      const skill = await this.loadSkill(skillDir);
      if (skill) skills.push(skill);
    }

    return skills;
  }

  private async loadSkill(skillDir: string): Promise<Skill | null> {
    const defPath = path.join(skillDir, "skill.md");
    if (!fs.existsSync(defPath)) return null;

    const raw = await fs.promises.readFile(defPath, "utf-8");
    const { frontmatter, body } = parseYamlFrontmatter(raw);

    return {
      name: frontmatter.name ?? path.basename(skillDir),
      version: frontmatter.version ?? "0.0.0",
      description: body,
      tools: frontmatter.tools ?? [],
      dir: skillDir,
    };
  }
}

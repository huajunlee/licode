import * as fs from "node:fs";
import * as path from "node:path";
import { parseYamlFrontmatter } from "./parser.js";

export interface Skill {
  name: string;
  description: string;
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

      const skill = await this.loadSkill(path.join(dir, entry.name));
      if (skill) skills.push(skill);
    }

    return skills;
  }

  private async loadSkill(skillDir: string): Promise<Skill | null> {
    // 列目录精确比对文件名，而不是 existsSync("SKILL.md")：
    // macOS 默认大小写不敏感，existsSync 会把小写的旧格式 skill.md 也当成命中
    const entries = await fs.promises.readdir(skillDir);
    if (!entries.includes("SKILL.md")) return null;

    const defPath = path.join(skillDir, "SKILL.md");

    const raw = await fs.promises.readFile(defPath, "utf-8");
    const { frontmatter } = parseYamlFrontmatter(raw);

    // 契约同 Claude 的 SKILL.md：name 与 description 必填，缺任一则跳过该技能
    const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
    const description =
      typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
    if (!name || !description) return null;

    // 正文刻意不读进内存：模型需要时自行 Read SKILL.md（渐进披露）
    return { name, description, dir: skillDir };
  }
}

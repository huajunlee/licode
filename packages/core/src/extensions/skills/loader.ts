import * as fs from "node:fs";
import * as path from "node:path";
import { parseYamlFrontmatter } from "./parser.js";

export interface Skill {
  name: string;
  description: string;
  dir: string;
  /**
   * 交付前必须对最终回答施加的后处理技能名。
   *
   * 技能正文只能"请"模型照做，模型可以跳过；这个声明是给 harness 看的：
   * 本次会话只要读过声明了 polishWith 的技能，AgentLoop 就会在交付前
   * 自动用被指定的技能改写最终回答（见 agent/polish.ts）。
   * 例如 decide 声明 polishWith: shuorenhua，保证结论不会以 AI 腔调交付。
   */
  polishWith?: string;
  /** polishWith 指向的技能正文（由 loadAll 在解析完全部技能后回填）。 */
  polishBody?: string;
}

export class SkillLoader {
  /**
   * 按顺序加载多个目录，**后加载的同名技能覆盖先加载的**。
   * 调用方据此表达优先级：内置 < 用户 < 项目。
   */
  async loadAll(...dirs: (string | undefined)[]): Promise<Skill[]> {
    const byName = new Map<string, Skill>();
    for (const dir of dirs) {
      if (!dir) continue;
      for (const skill of await this.loadFromDir(dir)) {
        byName.set(skill.name, skill);
      }
    }
    const skills = [...byName.values()];

    // 回填 polishWith 指向的技能正文。放在这里而不是 loadSkill 里，
    // 因为 polishWith 可能指向另一个目录里的技能（如内置 decide → 内置 shuorenhua），
    // 单目录解析时还看不到对方。
    for (const s of skills) {
      if (!s.polishWith) continue;
      const target = byName.get(s.polishWith);
      if (target) s.polishBody = await this.readBody(target.dir);
    }

    return skills;
  }

  /** 读 SKILL.md 的正文（去掉 frontmatter）。 */
  async readBody(skillDir: string): Promise<string> {
    const raw = await fs.promises.readFile(path.join(skillDir, "SKILL.md"), "utf-8");
    const m = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    return (m ? m[1] : raw).trim();
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

    const polishWith =
      typeof frontmatter.polishWith === "string" ? frontmatter.polishWith.trim() : undefined;

    // 正文刻意不读进内存：模型需要时自行 Read SKILL.md（渐进披露）
    return { name, description, dir: skillDir, ...(polishWith ? { polishWith } : {}) };
  }
}

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SkillLoader } from "./loader.js";

describe("SkillLoader", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "licode-skill-test-"));

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createSkillDir(baseDir: string, name: string, content: string): string {
    const dir = path.join(baseDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), content);
    return dir;
  }

  it("从 SKILL.md 读取 name 与 description，正文不进 Skill 对象", async () => {
    const dir = createSkillDir(
      tmpDir,
      "web-access",
      [
        "---",
        "name: web-access",
        "description: 搜索网页时使用",
        "---",
        "# Web Access",
        "",
        "这段正文不应出现在 Skill 对象里。",
      ].join("\n")
    );

    const skills = await new SkillLoader().loadFromDir(tmpDir);

    expect(skills).toHaveLength(1);
    expect(skills[0]).toEqual({
      name: "web-access",
      description: "搜索网页时使用",
      dir,
    });
  });

  it("缺 description 的技能被跳过", async () => {
    createSkillDir(tmpDir, "no-desc", "---\nname: no-desc\n---\nbody");
    expect(await new SkillLoader().loadFromDir(tmpDir)).toEqual([]);
  });

  it("缺 name 的技能被跳过", async () => {
    createSkillDir(tmpDir, "no-name", "---\ndescription: 只有描述\n---\nbody");
    expect(await new SkillLoader().loadFromDir(tmpDir)).toEqual([]);
  });

  it("不认小写的 skill.md（旧格式）", async () => {
    const dir = path.join(tmpDir, "legacy");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "skill.md"),
      "---\nname: legacy\ndescription: 旧格式\n---\nbody"
    );
    expect(await new SkillLoader().loadFromDir(tmpDir)).toEqual([]);
  });

  it("目录里没有 SKILL.md 时跳过", async () => {
    const dir = path.join(tmpDir, "empty");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "readme.txt"), "not a skill");
    expect(await new SkillLoader().loadFromDir(tmpDir)).toEqual([]);
  });

  it("loadAll 同扫用户与项目目录，同名以项目为准", async () => {
    const userDir = path.join(tmpDir, "user-skills");
    const projectDir = path.join(tmpDir, "project-skills");
    createSkillDir(userDir, "my-skill", "---\nname: my-skill\ndescription: 用户版\n---\nb");
    createSkillDir(projectDir, "my-skill", "---\nname: my-skill\ndescription: 项目版\n---\nb");
    createSkillDir(projectDir, "only-project", "---\nname: only-project\ndescription: 仅项目\n---\nb");

    const skills = await new SkillLoader().loadAll(userDir, projectDir);
    const byName = new Map(skills.map((s) => [s.name, s]));

    expect(skills).toHaveLength(2);
    expect(byName.get("my-skill")?.description).toBe("项目版");
    expect(byName.get("only-project")?.description).toBe("仅项目");
  });
});

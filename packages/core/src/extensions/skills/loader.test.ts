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

  function createSkillDir(baseDir: string, name: string, skillMdContent: string): string {
    const dir = path.join(baseDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "skill.md"), skillMdContent);
    return dir;
  }

  it("loads a skill from a directory with skill.md", async () => {
    createSkillDir(tmpDir, "web-access", `---
name: web-access
version: 1.0.0
tools:
  - name: web_search
    description: Search the web
    parameters:
      query:
        type: string
---
# Web Access

Use this skill for web searches.`);

    const loader = new SkillLoader();
    const skills = await loader.loadFromDir(tmpDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("web-access");
    expect(skills[0].version).toBe("1.0.0");
    expect(skills[0].description).toContain("# Web Access");
    expect(skills[0].tools).toHaveLength(1);
    expect(skills[0].tools[0].name).toBe("web_search");
  });

  it("returns empty array when directory has no skill subdirectories", async () => {
    // Empty tmpDir with no subdirectories
    const loader = new SkillLoader();
    const skills = await loader.loadFromDir(tmpDir);
    expect(skills).toEqual([]);
  });

  it("skips directories without skill.md", async () => {
    const dir = path.join(tmpDir, "no-skill-md");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "readme.txt"), "not a skill");

    const loader = new SkillLoader();
    const skills = await loader.loadFromDir(tmpDir);
    expect(skills).toHaveLength(0);
  });

  it("loadAll scans both user-level and project-level dirs", async () => {
    const userDir = path.join(tmpDir, "user-skills");
    const projectDir = path.join(tmpDir, "project-skills");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    createSkillDir(userDir, "user-skill", `---
name: user-skill
version: 1.0.0
tools: []
---
User skill body.`);

    createSkillDir(projectDir, "project-skill", `---
name: project-skill
version: 1.0.0
tools: []
---
Project skill body.`);

    const loader = new SkillLoader();
    const skills = await loader.loadAll(userDir, projectDir);

    expect(skills).toHaveLength(2);
    const names = skills.map((s) => s.name);
    expect(names).toContain("user-skill");
    expect(names).toContain("project-skill");
  });

  it("project-level skill overrides user-level skill with same name", async () => {
    const userDir = path.join(tmpDir, "user-skills");
    const projectDir = path.join(tmpDir, "project-skills");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    createSkillDir(userDir, "my-skill", `---
name: my-skill
version: 1.0.0
tools: []
---
User version.`);

    createSkillDir(projectDir, "my-skill", `---
name: my-skill
version: 2.0.0
tools: []
---
Project version.`);

    const loader = new SkillLoader();
    const skills = await loader.loadAll(userDir, projectDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].version).toBe("2.0.0");
    expect(skills[0].description).toContain("Project version");
  });
});

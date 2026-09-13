import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { skillToolToAdapter, skillToPromptLayer, skillsToPromptLayer } from "./adapter.js";
import type { Skill } from "./loader.js";
import type { SkillToolDef } from "./parser.js";

describe("skillToolToAdapter", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "licode-adapter-test-"));

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("wraps a skill tool with namespaced name", () => {
    const toolDef: SkillToolDef = {
      name: "web_search",
      description: "Search the web",
      parameters: {
        query: { type: "string", description: "Search query" },
      },
      script: "scripts/search.sh",
    };

    // Create the script file
    const scriptsDir = path.join(tmpDir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "scripts/search.sh"), "#!/bin/sh\necho '{}'");
    fs.chmodSync(path.join(tmpDir, "scripts/search.sh"), 0o755);

    const tool = skillToolToAdapter(toolDef, tmpDir);

    expect(tool.name).toBe("skill__web_search");
    expect(tool.description).toBe("Search the web");
  });

  it("executes the script and returns success on exit code 0", async () => {
    const scriptsDir = path.join(tmpDir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "scripts/echo.sh"),
      '#!/bin/sh\nread input\necho "got: $input"'
    );
    fs.chmodSync(path.join(tmpDir, "scripts/echo.sh"), 0o755);

    const toolDef: SkillToolDef = {
      name: "echo",
      description: "Echo input",
      parameters: {
        text: { type: "string" },
      },
      script: "scripts/echo.sh",
    };

    const tool = skillToolToAdapter(toolDef, tmpDir);
    const result = await tool.execute(
      { text: "hello" },
      { workingDirectory: "/tmp", sessionId: "s1" }
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.content).toContain("got:");
    }
  });

  it("returns error on non-zero exit code", async () => {
    const scriptsDir = path.join(tmpDir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "scripts/fail.sh"),
      '#!/bin/sh\necho "something failed" >&2\nexit 1'
    );
    fs.chmodSync(path.join(tmpDir, "scripts/fail.sh"), 0o755);

    const toolDef: SkillToolDef = {
      name: "failer",
      description: "Always fails",
      parameters: {},
      script: "scripts/fail.sh",
    };

    const tool = skillToolToAdapter(toolDef, tmpDir);
    const result = await tool.execute(
      {},
      { workingDirectory: "/tmp", sessionId: "s1" }
    );

    expect(result.status).toBe("error");
  });
});

describe("skillToPromptLayer", () => {
  it("creates a SystemPromptLayer from a Skill", () => {
    const skill: Skill = {
      name: "web-access",
      description: "# Web Access\n\nUse this skill to search the web.",
      dir: "/tmp/web-access",
    };

    const layer = skillToPromptLayer(skill);

    expect(layer.name).toBe("skill:web-access");
    expect(layer.priority).toBe(15);
    expect(layer.content).toBe(skill.description);
    expect(layer.always).toBe(false);
  });
});

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

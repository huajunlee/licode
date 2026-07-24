import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { skillToolToAdapter, skillToPromptLayer } from "./adapter.js";
import type { Skill, SkillToolDef } from "./loader.js";

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
      version: "1.0.0",
      description: "# Web Access\n\nUse this skill to search the web.",
      tools: [],
      dir: "/tmp/web-access",
    };

    const layer = skillToPromptLayer(skill);

    expect(layer.name).toBe("skill:web-access");
    expect(layer.priority).toBe(15);
    expect(layer.content).toBe(skill.description);
    expect(layer.always).toBe(false);
  });
});

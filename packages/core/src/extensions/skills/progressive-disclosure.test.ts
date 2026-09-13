import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeExtensions } from "../startup.js";
import { SystemPrompt } from "../../conversation/system-prompt.js";
import { ToolRegistry } from "../../tools/registry.js";
import { CommandRouter } from "../commands/router.js";

const BODY = "这是正文：B 式给倾向建议，C 式只摆事实。";

describe("Skill 渐进式披露（端到端）", () => {
  let workspace: string | null = null;

  afterEach(() => {
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true });
      workspace = null;
    }
  });

  it("只把书目放进 system prompt，正文留在磁盘、脚本不登记为工具", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "licode-skill-pd-"));
    const skillDir = path.join(workspace, ".licode", "skills", "decision");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: decision",
        "description: 帮用户做决定时使用",
        "---",
        BODY,
      ].join("\n")
    );

    const systemPrompt = new SystemPrompt();
    const tools = new ToolRegistry();
    const extensions = await initializeExtensions({
      workingDirectory: workspace,
      toolRegistry: tools,
      systemPrompt,
      commandRouter: new CommandRouter(),
    });

    // 1) 书目层存在、常驻、含名字与描述
    const layer = systemPrompt.getLayers().find((l) => l.name === "skills");
    expect(layer).toBeDefined();
    expect(layer!.always).toBe(true);
    expect(layer!.content).toContain("- decision：帮用户做决定时使用");

    // 2) 书目告诉模型技能在哪个目录（模型据此 Read）
    expect(layer!.content).toContain(
      path.join(workspace, ".licode", "skills")
    );

    // 3) 正文没有进 system prompt
    expect(layer!.content).not.toContain(BODY);

    // 4) 正文确实在磁盘上、模型读得到
    expect(readFileSync(path.join(skillDir, "SKILL.md"), "utf-8")).toContain(BODY);

    // 5) 不再把技能脚本登记成 skill__ 工具
    expect(tools.list().filter((n) => n.startsWith("skill__"))).toEqual([]);

    await extensions.shutdown();
  });
});

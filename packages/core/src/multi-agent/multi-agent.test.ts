import { describe, expect, it, vi } from "vitest";
import { CommandRouter } from "../extensions/commands/router.js";
import { ToolRegistry } from "../tools/registry.js";
import { createAgentTool } from "./agent-tool.js";
import { subagentCommand, SubAgentSettings } from "./commands.js";
import { SubAgentManager } from "./subagent.js";
import { WorktreeManager } from "./worktree.js";
import type { AgentRunner } from "./types.js";

describe("createAgentTool", () => {
  it("delegates task execution to SubAgentManager", async () => {
    const runner: AgentRunner = vi.fn(async (input) => ({
      status: "success",
      content: `done: ${input.task}`,
    } as const));
    const manager = new SubAgentManager({ runner });
    const tool = createAgentTool(manager);

    const result = await tool.execute(
      { task: "review auth", isolation: "none" },
      { workingDirectory: "/tmp/project", sessionId: "main" }
    );

    expect(result).toEqual({ status: "success", content: "done: review auth" });
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({ task: "review auth", isolation: "none" }),
      expect.objectContaining({ workingDirectory: "/tmp/project" })
    );
  });
});

describe("WorktreeManager", () => {
  it("creates and removes an isolated worktree through the injected git runner", async () => {
    const calls: string[][] = [];
    const manager = new WorktreeManager({
      repoPath: "/repo",
      worktreeRoot: "/repo/.licode/worktrees",
      runGit: async (args) => {
        calls.push(args);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    const context = await manager.create("agent-a");
    await manager.remove(context);

    expect(context.path).toContain("/repo/.licode/worktrees/agent-a");
    expect(calls[0]).toEqual([
      "worktree",
      "add",
      context.path,
      "-b",
      context.branch,
    ]);
    expect(calls[1]).toEqual(["worktree", "remove", context.path, "--force"]);
  });
});

describe("subagentCommand", () => {
  it("toggles subagent settings through slash command routing", async () => {
    const settings = new SubAgentSettings();
    const router = new CommandRouter();
    router.register(subagentCommand(settings));
    const context = {
      conversation: {
        id: "s",
        metadata: { model: "m", createdAt: "", updatedAt: "" },
        clear() {},
        getTokenCount() {
          return 0;
        },
        getMessageCount() {
          return 0;
        },
      },
      toolRegistry: new ToolRegistry(),
      workingDirectory: "/tmp",
    };

    const on = await router.route("/subagent on", context);
    const status = await router.route("/subagent status", context);
    const off = await router.route("/subagent off", context);

    expect(on).toMatchObject({ type: "action", message: expect.stringContaining("enabled") });
    expect(status).toMatchObject({ type: "action", message: expect.stringContaining("enabled") });
    expect(off).toMatchObject({ type: "action", message: expect.stringContaining("disabled") });
  });
});

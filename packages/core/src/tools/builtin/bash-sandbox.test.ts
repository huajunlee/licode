import { describe, expect, it } from "vitest";
import { bashTool } from "./bash.js";
import type { Sandbox } from "../../safety/sandbox.js";

describe("bashTool sandbox integration", () => {
  it("uses the sandbox wrapper when a sandbox is provided in tool context", async () => {
    const sandbox: Sandbox = {
      wrapCommand(command) {
        return {
          command: "printf",
          args: [`sandboxed:${command}`],
        };
      },
    };

    const result = await bashTool.execute(
      { command: "echo real-command", timeout: 1000 },
      { workingDirectory: process.cwd(), sessionId: "s", sandbox }
    );

    expect(result).toEqual({
      status: "success",
      content: "sandboxed:echo real-command",
    });
  });
});

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PermissionGuard } from "./permissions.js";
import { ToolExecutor } from "../tools/executor.js";
import { ToolRegistry } from "../tools/registry.js";
import type { PermissionUI } from "./types.js";
import type { Tool } from "../tools/types.js";

describe("PermissionGuard", () => {
  it("denies an approved tool execution before the tool runs", async () => {
    let executed = false;
    const ui: PermissionUI = {
      async ask() {
        return { action: "deny", reason: "not allowed" };
      },
    };
    const guard = new PermissionGuard(ui);
    const registry = new ToolRegistry();
    const dangerousTool: Tool = {
      name: "bash",
      description: "Run shell commands",
      requiresApproval: true,
      parameters: z.object({ command: z.string() }),
      async execute() {
        executed = true;
        return { status: "success", content: "ran" };
      },
    };
    registry.register(dangerousTool);

    const executor = new ToolExecutor(registry, { permissionGuard: guard });
    const result = await executor.executeOne({
      id: "tool-1",
      name: "bash",
      input: { command: "rm -rf node_modules" },
    });

    expect(result).toEqual({
      status: "error",
      error: "not allowed",
      errorType: "execution",
    });
    expect(executed).toBe(false);
  });
});

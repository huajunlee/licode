import type { Tool, ToolResult, ToolContext } from "./types.js";
import type { ToolUseBlock } from "../llm/provider.js";
import { ToolRegistry } from "./registry.js";
import type { ToolPermissionGuard } from "../safety/types.js";

export interface ExecutorOptions {
  signal?: AbortSignal;
  workingDirectory?: string;
  sessionId?: string;
}

export interface ToolExecutorConfig {
  permissionGuard?: ToolPermissionGuard;
}

export class ToolExecutor {
  constructor(
    private registry: ToolRegistry,
    private config: ToolExecutorConfig = {}
  ) {}

  async executeParallel(
    toolUses: ToolUseBlock[],
    options?: ExecutorOptions
  ): Promise<ToolResult[]> {
    return Promise.all(
      toolUses.map((tu) => this.executeOne(tu, options))
    );
  }

  async executeOne(
    toolUse: ToolUseBlock,
    options?: ExecutorOptions
  ): Promise<ToolResult> {
    const tool = this.registry.get(toolUse.name);
    if (!tool) {
      return {
        status: "error",
        error: `Unknown tool: ${toolUse.name}. Available: ${this.registry.list().join(", ")}`,
        errorType: "validation",
      };
    }

    const parsed = tool.parameters.safeParse(toolUse.input);
    if (!parsed.success) {
      return {
        status: "error",
        error: `Parameter validation failed: ${parsed.error.message}`,
        errorType: "validation",
      };
    }

    try {
      const context: ToolContext = {
        workingDirectory: options?.workingDirectory ?? process.cwd(),
        sessionId: options?.sessionId ?? "",
        signal: options?.signal,
      };
      const decision = await this.config.permissionGuard?.check(
        tool,
        parsed.data,
        context
      );
      if (decision?.action === "deny") {
        return {
          status: "error",
          error: decision.reason,
          errorType: "execution",
        };
      }
      return await tool.execute(parsed.data, context);
    } catch (err) {
      return {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        errorType: "execution",
      };
    }
  }
}

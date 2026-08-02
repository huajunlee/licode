import type { Tool, ToolResult, ToolContext } from "./types.js";
import type { ToolUseBlock } from "../llm/provider.js";
import { ToolRegistry } from "./registry.js";
import type { ToolPermissionGuard } from "../safety/types.js";
import { overflowToolResult } from "../context/overflow.js";

export interface ExecutorOptions {
  signal?: AbortSignal;
  workingDirectory?: string;
  sessionId?: string;
}

export interface ToolExecutorConfig {
  permissionGuard?: ToolPermissionGuard;
  /**
   * Max inline bytes for a tool's success output. Larger output spills to
   * .licode/overflow/ and a pointer+preview is returned instead of flooding
   * the context. Default 64KB. (Phase 4)
   */
  overflowMaxBytes?: number;
}

export class ToolExecutor {
  private registry: ToolRegistry;
  private config: ToolExecutorConfig;
  private overflowMaxBytes: number;

  constructor(registry: ToolRegistry, config: ToolExecutorConfig = {}) {
    this.registry = registry;
    this.config = config;
    this.overflowMaxBytes = config.overflowMaxBytes ?? 64 * 1024;
  }

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
      let result = await tool.execute(parsed.data, context);
      // Phase 4: spill oversized success output to disk so it never floods the
      // conversation; a pointer + head preview is returned instead.
      if (
        result.status === "success" &&
        Buffer.byteLength(result.content, "utf-8") > this.overflowMaxBytes
      ) {
        result = await overflowToolResult(result.content, {
          workingDirectory: context.workingDirectory,
          maxInlineBytes: this.overflowMaxBytes,
        });
      }
      return result;
    } catch (err) {
      return {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        errorType: "execution",
      };
    }
  }
}

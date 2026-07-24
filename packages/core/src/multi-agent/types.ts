import type { ToolContext, ToolResult } from "../tools/types.js";

export interface AgentToolInput {
  agent?: string;
  task: string;
  isolation?: "none" | "worktree";
  tools?: string[];
  maxSteps?: number;
}

export type AgentRunner = (
  input: AgentToolInput,
  context: ToolContext
) => Promise<ToolResult>;

export interface AgentSummary {
  name: string;
  createdAt: string;
  lastUsedAt: string;
  messageCount: number;
  status: "active" | "idle";
}

export interface WorktreeContext {
  name: string;
  path: string;
  branch: string;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

import type { Tool, ToolContext } from "../tools/types.js";

export type PermissionDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string };

export interface PermissionRequest {
  toolName: string;
  description: string;
  input: unknown;
  options: ("allow-once" | "allow-session" | "deny")[];
}

export interface PermissionUI {
  ask(request: PermissionRequest): Promise<PermissionDecision>;
}

export interface PermissionRule {
  toolName: string;
  action: PermissionDecision;
}

export interface PermissionCheckContext extends ToolContext {}

export interface ToolPermissionGuard {
  check(
    tool: Tool,
    input: unknown,
    context: PermissionCheckContext
  ): Promise<PermissionDecision>;
}

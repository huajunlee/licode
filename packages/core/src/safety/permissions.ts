import type {
  PermissionDecision,
  PermissionRule,
  PermissionUI,
  PermissionCheckContext,
} from "./types.js";
import type { Tool } from "../tools/types.js";

export class PermissionGuard {
  private sessionCache = new Map<string, PermissionDecision>();

  constructor(
    private ui: PermissionUI,
    private rules: PermissionRule[] = []
  ) {}

  async check(
    tool: Tool,
    input: unknown,
    _context: PermissionCheckContext
  ): Promise<PermissionDecision> {
    if (!tool.requiresApproval) return { action: "allow" };

    const rule = this.rules.find((candidate) => candidate.toolName === tool.name);
    if (rule) return rule.action;

    const key = this.cacheKey(tool.name, input);
    const cached = this.sessionCache.get(key);
    if (cached) return cached;

    const decision = await this.ui.ask({
      toolName: tool.name,
      description: tool.description,
      input,
      options: ["allow-once", "allow-session", "deny"],
    });
    return decision;
  }

  remember(toolName: string, input: unknown, decision: PermissionDecision): void {
    this.sessionCache.set(this.cacheKey(toolName, input), decision);
  }

  private cacheKey(toolName: string, input: unknown): string {
    return `${toolName}:${JSON.stringify(input)}`;
  }
}

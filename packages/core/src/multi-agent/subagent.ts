import type { ToolContext, ToolResult } from "../tools/types.js";
import type { AgentRunner, AgentSummary, AgentToolInput } from "./types.js";

export interface SubAgentManagerConfig {
  runner: AgentRunner;
}

interface AgentState {
  name: string;
  createdAt: string;
  lastUsedAt: string;
  messageCount: number;
}

export class SubAgentManager {
  private agents = new Map<string, AgentState>();

  constructor(private config: SubAgentManagerConfig) {}

  async execute(
    input: AgentToolInput,
    context: ToolContext
  ): Promise<ToolResult> {
    if (input.agent) {
      const now = new Date().toISOString();
      const state =
        this.agents.get(input.agent) ??
        {
          name: input.agent,
          createdAt: now,
          lastUsedAt: now,
          messageCount: 0,
        };
      state.lastUsedAt = now;
      state.messageCount += 1;
      this.agents.set(input.agent, state);
    }

    return this.config.runner(input, context);
  }

  listAgents(): AgentSummary[] {
    return [...this.agents.values()].map((agent) => ({
      ...agent,
      status: "idle",
    }));
  }

  async destroy(name: string): Promise<void> {
    this.agents.delete(name);
  }
}

import { MemoryStore } from "../../../memory/store.js";
import type { SlashCommand } from "../registry.js";

export const contextCommand: SlashCommand = {
  name: "context",
  description: "Show token usage, session info, and memory",
  async execute(_args, context) {
    const conv = context.conversation;
    const budget = conv.getBudgetInfo();
    const info = [
      `Model: ${conv.metadata.model}`,
      `Tokens: ${budget.used}`,
      `Messages: ${conv.getMessageCount()}`,
      `Session: ${conv.id}`,
    ];

    // Window/reserve are published by the AgentLoop each turn; before the
    // first turn they are 0 and we omit them.
    if (budget.contextWindow > 0) {
      info.push(
        `Window: ${budget.contextWindow} (reserve ${budget.outputReserve})`
      );
      info.push(`Remaining: ${budget.remaining}`);
    }

    // Show memory stats
    const store = new MemoryStore(`${context.workingDirectory}/.licode/memory`);
    const entries = await store.listAll();
    if (entries.length > 0) {
      info.push(`Memory: ${entries.length} entries`);
    }

    return { type: "action", message: info.join("\n") };
  },
};

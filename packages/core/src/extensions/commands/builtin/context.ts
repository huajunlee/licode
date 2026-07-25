import { MemoryStore } from "../../../memory/store.js";
import type { SlashCommand } from "../registry.js";

export const contextCommand: SlashCommand = {
  name: "context",
  description: "Show token usage, session info, and memory",
  async execute(_args, context) {
    const conv = context.conversation;
    const info = [
      `Model: ${conv.metadata.model}`,
      `Tokens: ${conv.getTokenCount()}`,
      `Messages: ${conv.getMessageCount()}`,
      `Session: ${conv.id}`,
    ];

    // Show memory stats
    const store = new MemoryStore(`${context.workingDirectory}/.licode/memory`);
    const entries = await store.listAll();
    if (entries.length > 0) {
      info.push(`Memory: ${entries.length} entries`);
    }

    return { type: "action", message: info.join("\n") };
  },
};

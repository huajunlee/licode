import * as fs from "node:fs";
import * as path from "node:path";
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
      const pct = Math.round((budget.used / budget.contextWindow) * 100);
      info.push(
        `Window: ${budget.contextWindow} (reserve ${budget.outputReserve})`
      );
      info.push(`Used: ${pct}% (${budget.used}/${budget.contextWindow})`);
      info.push(`Remaining: ${budget.remaining}`);
    }

    // Show memory stats
    const store = new MemoryStore(`${context.workingDirectory}/.licode/memory`);
    const entries = await store.listAll();
    if (entries.length > 0) {
      info.push(`Memory: ${entries.length} entries`);
    }

    // Phase 4: count spilled overflow files.
    const overflowDir = path.join(context.workingDirectory, ".licode", "overflow");
    let overflowCount = 0;
    try {
      overflowCount = fs.readdirSync(overflowDir).length;
    } catch {
      // dir missing -> 0
    }
    if (overflowCount > 0) {
      info.push(`Overflow: ${overflowCount} files`);
    }

    return { type: "action", message: info.join("\n") };
  },
};

import type { SlashCommand } from "../registry.js";

export const clearCommand: SlashCommand = {
  name: "clear",
  description: "Clear the conversation history",
  async execute(_args, context) {
    context.conversation.clear();
    return {
      type: "action",
      message: "Conversation cleared.",
    };
  },
};

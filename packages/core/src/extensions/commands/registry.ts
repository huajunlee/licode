export interface SlashCommand {
  name: string;
  description: string;
  args?: {
    name: string;
    description: string;
    required?: boolean;
  }[];
  execute(args: string[], context: CommandContext): Promise<CommandResult>;
}

export interface CommandContext {
  conversation: {
    id: string;
    metadata: { model: string; createdAt: string; updatedAt: string };
    clear(): void;
    getTokenCount(): number;
    getMessageCount(): number;
    getBudgetInfo(): {
      contextWindow: number;
      outputReserve: number;
      used: number;
      remaining: number;
    };
  };
  toolRegistry: {
    getTools(): unknown[];
  };
  workingDirectory: string;
}

export type CommandResult =
  | { type: "prompt"; content: string }
  | { type: "action"; message: string }
  | { type: "error"; message: string };

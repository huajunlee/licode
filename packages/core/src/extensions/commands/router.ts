import type { SlashCommand, CommandContext, CommandResult } from "./registry.js";

export class CommandRouter {
  private commands: Map<string, SlashCommand> = new Map();

  register(cmd: SlashCommand): void {
    this.commands.set(cmd.name, cmd);
  }

  registerAll(cmds: SlashCommand[]): void {
    for (const cmd of cmds) {
      this.register(cmd);
    }
  }

  list(): SlashCommand[] {
    return [...this.commands.values()];
  }

  async route(
    input: string,
    context: CommandContext
  ): Promise<CommandResult | null> {
    if (!input.startsWith("/")) return null;

    const parts = input.slice(1).split(/\s+/);
    if (parts.length === 0 || !parts[0]) return null;

    const name = parts[0];
    const args = parts.slice(1);

    const cmd = this.commands.get(name);
    if (!cmd) {
      return {
        type: "error",
        message: `Unknown command: /${name}. Type /help for available commands.`,
      };
    }

    return cmd.execute(args, context);
  }
}

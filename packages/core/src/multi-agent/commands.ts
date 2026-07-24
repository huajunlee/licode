import type {
  CommandContext,
  CommandResult,
  SlashCommand,
} from "../extensions/commands/registry.js";

export class SubAgentSettings {
  private enabled = false;

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

export function subagentCommand(settings: SubAgentSettings): SlashCommand {
  return {
    name: "subagent",
    description: "Enable, disable, or inspect subagent support.",
    args: [
      {
        name: "action",
        description: "on, off, or status",
        required: true,
      },
    ],
    async execute(args: string[], _context: CommandContext): Promise<CommandResult> {
      const action = args[0] ?? "status";
      if (action === "on") {
        settings.enable();
        return { type: "action", message: "Subagent support enabled." };
      }
      if (action === "off") {
        settings.disable();
        return { type: "action", message: "Subagent support disabled." };
      }
      if (action === "status") {
        return {
          type: "action",
          message: `Subagent support is ${
            settings.isEnabled() ? "enabled" : "disabled"
          }.`,
        };
      }

      return {
        type: "error",
        message: "Usage: /subagent on|off|status",
      };
    },
  };
}

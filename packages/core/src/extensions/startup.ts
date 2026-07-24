import * as fs from "node:fs";
import * as path from "node:path";
import type { SystemPrompt } from "../conversation/system-prompt.js";
import type { EventPipeline } from "../events/pipeline.js";
import type { ToolRegistry } from "../tools/registry.js";
import { CommandRouter } from "./commands/router.js";
import { clearCommand } from "./commands/builtin/clear.js";
import { contextCommand } from "./commands/builtin/context.js";
import { helpCommand } from "./commands/builtin/help.js";
import { memoryCommand } from "./commands/builtin/memory.js";
import { HookManager, hookMiddleware } from "./hooks/manager.js";
import type { HookConfig, HookPosition } from "./hooks/types.js";
import { MCPClientManager } from "./mcp/client.js";
import { loadMCPConfig } from "./mcp/config.js";
import { subagentCommand, SubAgentSettings } from "../multi-agent/commands.js";
import { createAgentTool } from "../multi-agent/agent-tool.js";
import { SubAgentManager } from "../multi-agent/subagent.js";
import type { AgentRunner } from "../multi-agent/types.js";
import { skillToPromptLayer, skillToolToAdapter } from "./skills/adapter.js";
import { SkillLoader } from "./skills/loader.js";
import type { Skill } from "./skills/loader.js";

export interface InitializeExtensionsOptions {
  workingDirectory: string;
  toolRegistry: ToolRegistry;
  systemPrompt: SystemPrompt;
  commandRouter?: CommandRouter;
  userSkillsDirectory?: string;
  subAgentRunner?: AgentRunner;
}

export interface InitializedExtensions {
  mcp: MCPClientManager;
  hooks: HookManager;
  commands: CommandRouter;
  skills: Skill[];
  shutdown(): Promise<void>;
}

const BUILTIN_COMMANDS = [
  helpCommand,
  clearCommand,
  contextCommand,
  memoryCommand,
  subagentCommand(new SubAgentSettings()),
];

function resolveProjectPath(workingDirectory: string, ...parts: string[]): string {
  return path.join(workingDirectory, ".licode", ...parts);
}

function loadHookConfig(configPath: string): Record<string, HookConfig> {
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as Record<string, HookConfig>;
}

export async function initializeExtensions(
  options: InitializeExtensionsOptions
): Promise<InitializedExtensions> {
  const commands = options.commandRouter ?? new CommandRouter();
  commands.registerAll(BUILTIN_COMMANDS);
  if (options.subAgentRunner) {
    options.toolRegistry.register(
      createAgentTool(new SubAgentManager({ runner: options.subAgentRunner }))
    );
  }

  const mcp = new MCPClientManager();
  await mcp.initialize(loadMCPConfig(resolveProjectPath(options.workingDirectory, "mcp", "config.json")));
  options.toolRegistry.registerAll(mcp.getTools());

  const skillLoader = new SkillLoader();
  const skills = await skillLoader.loadAll(
    options.userSkillsDirectory,
    resolveProjectPath(options.workingDirectory, "skills")
  );
  for (const skill of skills) {
    options.systemPrompt.addLayer(skillToPromptLayer(skill));
    options.toolRegistry.registerAll(
      skill.tools.map((tool) => skillToolToAdapter(tool, skill.dir))
    );
  }

  const hooks = new HookManager();
  hooks.load(loadHookConfig(resolveProjectPath(options.workingDirectory, "hooks.json")));

  return {
    mcp,
    hooks,
    commands,
    skills,
    async shutdown() {
      await Promise.all(
        mcp.listServers().map((server) => mcp.disconnect(server.name))
      );
    },
  };
}

export function registerExtensionMiddleware(
  pipeline: EventPipeline,
  extensions: InitializedExtensions,
  position: HookPosition
): EventPipeline {
  return pipeline.use(`hook:${position}`, hookMiddleware(extensions.hooks, position));
}

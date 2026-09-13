import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SystemPrompt } from "../conversation/system-prompt.js";
import type { EventPipeline } from "../events/pipeline.js";
import type { ToolRegistry } from "../tools/registry.js";
import { CommandRouter } from "./commands/router.js";
import { clearCommand } from "./commands/builtin/clear.js";
import { contextCommand } from "./commands/builtin/context.js";
import { helpCommand, helpRecipesCommand, helpShortcutsCommand, helpToolsCommand } from "./commands/builtin/help.js";
import { memoryCommand, memoryListCommand, memoryAddCommand, memoryDeleteCommand } from "./commands/builtin/memory.js";
import { HookManager, hookMiddleware } from "./hooks/manager.js";
import type { HookConfig, HookPosition } from "./hooks/types.js";
import { MCPClientManager } from "./mcp/client.js";
import { loadMCPConfig } from "./mcp/config.js";
import { subagentCommand, SubAgentSettings } from "../multi-agent/commands.js";
import { createAgentTool } from "../multi-agent/agent-tool.js";
import { SubAgentManager } from "../multi-agent/subagent.js";
import type { AgentRunner } from "../multi-agent/types.js";
import { skillsToPromptLayer } from "./skills/adapter.js";
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
  helpRecipesCommand,
  helpShortcutsCommand,
  helpToolsCommand,
  clearCommand,
  contextCommand,
  memoryCommand,
  memoryListCommand,
  memoryAddCommand,
  memoryDeleteCommand,
  subagentCommand(new SubAgentSettings()),
];

function resolveProjectPath(workingDirectory: string, ...parts: string[]): string {
  return path.join(workingDirectory, ".licode", ...parts);
}

/**
 * 随 @licode/core 一起发布的内置技能目录。构建脚本把它从
 * src/extensions/skills/builtin 拷到 dist/extensions/skills/builtin，
 * 故这里按本模块（编译后在 dist/extensions/）所在目录解析。
 */
function builtinSkillsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "skills", "builtin");
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
  // 顺序即优先级：内置 < 用户 < 项目（后加载的同名技能覆盖先加载的）
  const skills = await skillLoader.loadAll(
    builtinSkillsDir(),
    options.userSkillsDirectory,
    resolveProjectPath(options.workingDirectory, "skills")
  );
  const skillLayer = skillsToPromptLayer(skills);
  if (skillLayer) options.systemPrompt.addLayer(skillLayer);

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

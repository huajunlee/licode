import React from "react";
import { render } from "ink";
import {
  initSpec,
  listSpecs,
  loadCLAUDE,
  loadSpecFiles,
  specStatus,
  validateSpec,
} from "@licode/spec-kit";
import App from "./app.js";
import {
  AnthropicProvider,
  builtinTools,
  CommandRouter,
  ConversationManager,
  initializeExtensions,
  loadDefaultLayers,
  currentDateLayer,
  MemoryStore,
  MemoryLoader,
  SystemPrompt,
  ToolRegistry,
} from "@licode/core";
import type { InitializedExtensions } from "@licode/core";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunCliOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  renderApp?: (props: {
    apiKey: string;
    model?: string;
    sessionId?: string;
    baseUrl?: string;
    existingSessions: Awaited<ReturnType<typeof ConversationManager.listSessions>>;
  }) => Promise<void>;
}

export interface ConversationRuntimeOptions {
  cwd: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  sessionId?: string;
}

export interface ConversationRuntime {
  provider: AnthropicProvider;
  manager: ConversationManager;
  tools: ToolRegistry;
  commands: CommandRouter;
  extensions: InitializedExtensions;
}

interface ParsedArgs {
  sessionId?: string;
  model?: string;
  baseUrl?: string;
  help: boolean;
  spec?: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = { help: false };

  if (args[0] === "spec") {
    result.spec = args.slice(1);
    return result;
  }

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session" && i + 1 < args.length) {
      result.sessionId = args[i + 1];
      i++;
    } else if (args[i] === "--model" && i + 1 < args.length) {
      result.model = args[i + 1];
      i++;
    } else if (args[i] === "--base-url" && i + 1 < args.length) {
      result.baseUrl = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      result.help = true;
    }
  }

  return result;
}

function helpText(): string {
  return `LICode - AI Coding Assistant

Usage: licode [options]
       licode spec <init|list|status|validate> [name]

Options:
  --session <id>    Resume an existing session
  --model <name>    Specify the model (default: claude-sonnet-4-6)
  --base-url <url>  LLM API base URL. Supports Anthropic-compatible APIs.
  --help, -h        Show this help message
`;
}

async function runSpecCommand(
  args: string[],
  cwd: string
): Promise<CliResult> {
  const command = args[0] ?? "help";
  if (command === "init") {
    const name = args.slice(1).join(" ");
    const created = await initSpec(name, { cwd });
    return {
      code: 0,
      stdout: `Created spec ${created.name} at ${created.directory}`,
      stderr: "",
    };
  }
  if (command === "list") {
    const specs = await listSpecs({ cwd });
    return {
      code: 0,
      stdout: specs.map((spec) => `${spec.name}\t${spec.status}`).join("\n"),
      stderr: "",
    };
  }
  if (command === "status") {
    const status = await specStatus({ cwd });
    return {
      code: 0,
      stdout: `Specs: ${status.total}, active: ${status.active}`,
      stderr: "",
    };
  }
  if (command === "validate") {
    const name = args[1];
    if (!name) {
      return { code: 1, stdout: "", stderr: "Usage: licode spec validate <name>" };
    }
    const result = await validateSpec(name, { cwd });
    return {
      code: result.ok ? 0 : 1,
      stdout: result.ok ? `Spec ${name} is valid` : "",
      stderr: result.errors.join("\n"),
    };
  }

  return {
    code: 1,
    stdout: "",
    stderr: "Usage: licode spec <init|list|status|validate> [name]",
  };
}

export async function initializeConversationRuntime(
  options: ConversationRuntimeOptions
): Promise<ConversationRuntime> {
  const provider = new AnthropicProvider({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
  });
  const model = options.model ?? "deepseek-chat";
  const manager = options.sessionId
    ? await ConversationManager.load(options.sessionId)
    : new ConversationManager({ model });
  const tools = new ToolRegistry();
  tools.registerAll(builtinTools);

  const systemPrompt = new SystemPrompt();
  for (const layer of loadDefaultLayers()) {
    systemPrompt.addLayer(layer);
  }
  systemPrompt.addLayer(currentDateLayer());
  await loadCLAUDE(systemPrompt, { cwd: options.cwd });
  await loadSpecFiles(systemPrompt, { cwd: options.cwd });
  manager.systemPrompt = systemPrompt;

  const commands = new CommandRouter();
  const extensions = await initializeExtensions({
    workingDirectory: options.cwd,
    toolRegistry: tools,
    systemPrompt,
    commandRouter: commands,
  });

  // Load persisted memories into system prompt
  const memoryStore = new MemoryStore(`${options.cwd}/.licode/memory`);
  const memoryLoader = new MemoryLoader(memoryStore);
  await memoryLoader.loadInto(systemPrompt);

  return { provider, manager, tools, commands, extensions };
}

export async function runCli(
  args: string[],
  options: RunCliOptions = {}
): Promise<CliResult> {
  const parsed = parseArgs(args);
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  if (parsed.help) {
    return { code: 0, stdout: helpText(), stderr: "" };
  }

  if (parsed.spec) {
    return runSpecCommand(parsed.spec, cwd);
  }

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      code: 1,
      stdout: "",
      stderr:
        "Error: ANTHROPIC_API_KEY environment variable is not set.\nSet it with: export ANTHROPIC_API_KEY=<your-api-key>",
    };
  }

  const resolvedBaseUrl = parsed.baseUrl ?? env.ANTHROPIC_BASE_URL;

  // 启动诊断：检查关键配置是否有值
  if (!resolvedBaseUrl) {
    console.error(
      "⚠️  未设置 ANTHROPIC_BASE_URL。如果你用的不是 Anthropic 官方 API，请设置：\n" +
        "   export ANTHROPIC_BASE_URL=\"https://your-api-endpoint\"\n" +
        "   例如 DeepSeek: export ANTHROPIC_BASE_URL=\"https://api.deepseek.com/anthropic\"\n"
    );
  }

  const sessions = await ConversationManager.listSessions();
  const renderApp =
    options.renderApp ??
    ((props: {
      apiKey: string;
      model?: string;
      sessionId?: string;
      baseUrl?: string;
      existingSessions: Awaited<ReturnType<typeof ConversationManager.listSessions>>;
    }) => {
      const { waitUntilExit } = render(React.createElement(App, props));
      return waitUntilExit();
    });

  await renderApp({
    apiKey,
    model: parsed.model,
    sessionId: parsed.sessionId,
    baseUrl: resolvedBaseUrl,
    existingSessions: sessions,
  });

  return { code: 0, stdout: "", stderr: "" };
}

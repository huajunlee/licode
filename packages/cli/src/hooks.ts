import { useState, useCallback, useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadCLAUDE, loadSpecFiles } from "@licode/spec-kit";
import {
  AnthropicProvider,
  ConversationManager,
  SystemPrompt,
  loadDefaultLayers,
  EventPipeline,
  tokenCountingMiddleware,
  ToolRegistry,
  builtinTools,
  createAgentLoopMiddleware,
  CommandRouter,
  initializeExtensions,
  registerExtensionMiddleware,
  MemoryStore,
  MemoryLoader,
  MemoryExtractor,
  memoryMiddleware,
} from "@licode/core";
import type {
  Message,
  PipelineEvent,
  AgentConfig,
  EventBus,
  InitializedExtensions,
} from "@licode/core";
import type { ThinkingBlock } from "./components/thinking-accordion.js";
import { inferPurpose } from "./components/thinking-accordion.js";
import type { ToolCallState } from "./components/tool-call-card.js";

export interface UseConversationConfig {
  model?: string;
  sessionId?: string;
  apiKey: string;
  baseUrl?: string;
  existingSessions?: Array<{ id: string }>;
}

export interface UseConversationResult {
  messages: Message[];
  streaming: string;
  isLoading: boolean;
  tokenCount: number;
  error: string | null;
  sessionId: string;
  thinkingBlocks: ThinkingBlock[];
  activeToolCalls: ToolCallState[];
  commandMessage: string | null;
  /** Available slash commands and skills for autocomplete */
  slashCommands: Array<{ name: string; description: string }>;
  handleSubmit: (input: string) => Promise<void>;
}

const SESSIONS_DIR = ".licode/sessions";

function resolveSessionPath(sessionId: string): string | null {
  const sessionsDir = path.resolve(SESSIONS_DIR);

  const exactPath = path.join(sessionsDir, `${sessionId}.json`);
  if (fs.existsSync(exactPath)) return exactPath;

  if (fs.existsSync(sessionsDir)) {
    const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
    const matches = files.filter((f) => f.startsWith(sessionId));
    if (matches.length === 1) {
      return path.join(sessionsDir, matches[0]);
    }
  }

  return null;
}

function createEventBus(
  setStreaming: (s: string) => void,
  setThinkingBlocks: (blocks: ThinkingBlock[]) => void,
  setActiveToolCalls: Dispatch<SetStateAction<ToolCallState[]>>,
  setError: (e: string | null) => void
): EventBus {
  let streamText = "";
  const blocks: ThinkingBlock[] = [];
  let blockIdCounter = 0;
  let currentThinking = "";

  return {
    emit(event: PipelineEvent) {
      switch (event.type) {
        case "llm-token":
          streamText += event.text;
          setStreaming(streamText);
          break;

        case "llm-thinking":
          currentThinking += event.text;
          {
            const updated = [...blocks];
            const last = updated[updated.length - 1];
            if (last && last.isStreaming) {
              last.reasoning = currentThinking;
            } else {
              updated.push({
                id: ++blockIdCounter,
                purpose: "🤔 正在推理...",
                reasoning: currentThinking,
                isStreaming: true,
              });
            }
            blocks.length = 0;
            blocks.push(...updated);
            setThinkingBlocks([...blocks]);
          }
          break;

        case "llm-thinking-complete":
          {
            const updated = [...blocks];
            const last = updated[updated.length - 1];
            if (last) {
              last.purpose = inferPurpose(last.reasoning);
              last.isStreaming = false;
            }
            blocks.length = 0;
            blocks.push(...updated);
            setThinkingBlocks([...blocks]);
            currentThinking = "";
          }
          break;

        case "tool-use-detected":
          setActiveToolCalls(
            event.toolUses.map((tu) => ({
              toolName: tu.name,
              status: "pending" as const,
              detail: JSON.stringify(tu.input).slice(0, 80),
            }))
          );
          break;

        case "tool-execute-start":
          setActiveToolCalls((prev) =>
            prev.map((c) =>
              c.toolName === event.toolName && c.status === "pending"
                ? { ...c, status: "running" as const }
                : c
            )
          );
          break;

        case "tool-execute-complete":
          setActiveToolCalls((prev) =>
            prev.map((c) =>
              c.toolName === event.toolName && c.status === "running"
                ? {
                    ...c,
                    status:
                      event.result.status === "success" ? "done" : "error",
                    result:
                      event.result.status === "success"
                        ? event.result.content
                        : event.result.error,
                  }
                : c
            )
          );
          break;

        case "agent-loop-complete":
          setStreaming("");
          setThinkingBlocks([]);
          setActiveToolCalls([]);
          break;

        case "error":
          setError(`${event.context}: ${event.error.message}`);
          break;
      }
    },
  };
}

export function useConversation(
  config: UseConversationConfig
): UseConversationResult {
  const model = config.model ?? "deepseek-chat";
  const apiKey = config.apiKey;
  const baseUrl = config.baseUrl;

  const providerRef = useRef<AnthropicProvider | null>(null);
  const managerRef = useRef<ConversationManager | null>(null);
  const toolsRef = useRef<ToolRegistry>(new ToolRegistry());
  const extensionsRef = useRef<InitializedExtensions | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [tokenCount, setTokenCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [thinkingBlocks, setThinkingBlocks] = useState<ThinkingBlock[]>([]);
  const [activeToolCalls, setActiveToolCalls] = useState<ToolCallState[]>([]);
  const [commandMessage, setCommandMessage] = useState<string | null>(null);
  const [slashCommands, setSlashCommands] = useState<Array<{ name: string; description: string }>>([]);

  const commandRouterRef = useRef<CommandRouter>(new CommandRouter());
  const memoryStoreRef = useRef<MemoryStore>(
    new MemoryStore(path.join(process.cwd(), ".licode", "memory"))
  );
  const memoryExtractorRef = useRef<MemoryExtractor>(new MemoryExtractor());

  useEffect(() => {
    if (!apiKey) return;

    const provider = new AnthropicProvider({ apiKey, baseUrl });
    providerRef.current = provider;

    // Initialize ToolRegistry with builtin tools
    const tools = new ToolRegistry();
    tools.registerAll(builtinTools);
    toolsRef.current = tools;

    const initManager = async () => {
      let manager: ConversationManager;

      if (config.sessionId) {
        const resolvedPath = resolveSessionPath(config.sessionId);
        if (resolvedPath) {
          manager = await ConversationManager.load(resolvedPath);
        } else {
          setError(
            `会话 ${config.sessionId} 未找到。使用 --session <id> 恢复已有会话，或直接 Enter 新建。`
          );
          manager = new ConversationManager({ model });
        }
      } else {
        manager = new ConversationManager({ model });
      }

      const systemPrompt = new SystemPrompt();
      const layers = loadDefaultLayers();
      for (const layer of layers) {
        systemPrompt.addLayer(layer);
      }
      await loadCLAUDE(systemPrompt, { cwd: process.cwd() });
      await loadSpecFiles(systemPrompt, { cwd: process.cwd() });
      manager.systemPrompt = systemPrompt;

      const extensions = await initializeExtensions({
        workingDirectory: process.cwd(),
        toolRegistry: tools,
        systemPrompt,
        commandRouter: commandRouterRef.current,
      });
      extensionsRef.current = extensions;

      // Load persisted memories into system prompt
      const memoryLoader = new MemoryLoader(memoryStoreRef.current);
      await memoryLoader.loadInto(systemPrompt);

      // Populate slash commands for autocomplete (commands + skills)
      const cmds = extensions.commands.list().map((c) => ({
        name: `/${c.name}`,
        description: c.description,
      }));
      const skillItems = extensions.skills.map((s) => ({
        name: `/${s.name}`,
        description: s.description.slice(0, 80),
      }));
      setSlashCommands([...cmds, ...skillItems]);

      // Register skills as prompt-pass-through commands so /skill-name
      // is recognized by the router and forwarded to the LLM
      for (const skill of extensions.skills) {
        commandRouterRef.current.register({
          name: skill.name,
          description: skill.description.slice(0, 80),
          async execute(args: string[], _ctx): Promise<{
            type: "prompt";
            content: string;
          }> {
            const fullInput = [skill.name, ...args].join(" ");
            return { type: "prompt", content: fullInput };
          },
        });
      }

      managerRef.current = manager;
      setSessionId(manager.id);
      setMessages([...manager.getMessages()]);
    };

    initManager();
  }, [apiKey, model, config.sessionId, baseUrl]);

  const handleSubmit = useCallback(
    async (input: string) => {
      const provider = providerRef.current;
      const manager = managerRef.current;
      const tools = toolsRef.current;
      const router = commandRouterRef.current;
      if (!provider || !manager || !input.trim()) return;

      setIsLoading(true);
      setStreaming("");
      setError(null);
      setThinkingBlocks([]);
      setActiveToolCalls([]);
      setCommandMessage(null);

      // Phase 3: route / commands before pipeline
      const cmdResult = await router.route(input.trim(), {
        conversation: manager,
        toolRegistry: tools,
        workingDirectory: process.cwd(),
      });

      if (cmdResult !== null) {
        setIsLoading(false);
        if (cmdResult.type === "action") {
          setCommandMessage(cmdResult.message);
          setMessages([...manager.getMessages()]);
        } else if (cmdResult.type === "error") {
          setCommandMessage(cmdResult.message);
        } else if (cmdResult.type === "prompt") {
          // Fall through to pipeline with the prompt content
          // Recurse with the prompt content
          setIsLoading(true);
          setCommandMessage(null);
          const promptContent = (cmdResult as { type: "prompt"; content: string }).content;
          try {
            const eventBus = createEventBus(
              setStreaming,
              setThinkingBlocks,
              setActiveToolCalls,
              setError
            );

            const pipeline = new EventPipeline();
            registerExtensionMiddleware(pipeline, extensionsRef.current!, "before:agentLoop");

            pipeline
              .use(memoryMiddleware(memoryExtractorRef.current, memoryStoreRef.current))
              .use(tokenCountingMiddleware((total) => setTokenCount(total)))
              .use(
                createAgentLoopMiddleware({
                  llm: provider,
                  conversation: manager,
                  tools,
                  eventBus,
                })
              )
              .use("hook:after:agentLoop", async (event, next) => {
                const extensions = extensionsRef.current;
                if (extensions) {
                  await extensions.hooks.onEvent(
                    event,
                    extensions.hooks.getHooksAt("after:agentLoop")
                  );
                }
                await next();
              })
              .use(async (event: PipelineEvent, next) => {
                if (event.type === "error") {
                  setError(`${event.context}: ${event.error.message}`);
                  return;
                }
                await next();
              });

            async function* singleEvent(): AsyncGenerator<PipelineEvent> {
              yield { type: "user-message", content: promptContent };
            }
            await pipeline.run(singleEvent());

            setMessages([...manager.getMessages()]);
            setStreaming("");
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setIsLoading(false);
          }
        }
        return;
      }

      try {
        const eventBus = createEventBus(
          setStreaming,
          setThinkingBlocks,
          setActiveToolCalls,
          setError
        );

        const pipeline = new EventPipeline();
        registerExtensionMiddleware(pipeline, extensionsRef.current!, "before:agentLoop");

        pipeline
          .use(memoryMiddleware(memoryExtractorRef.current, memoryStoreRef.current))
          .use(tokenCountingMiddleware((total) => setTokenCount(total)))
          .use(
            createAgentLoopMiddleware({
              llm: provider,
              conversation: manager,
              tools,
              eventBus,
            })
          )
          .use("hook:after:agentLoop", async (event, next) => {
            const extensions = extensionsRef.current;
            if (extensions) {
              await extensions.hooks.onEvent(
                event,
                extensions.hooks.getHooksAt("after:agentLoop")
              );
            }
            await next();
          })
          .use(async (event: PipelineEvent, next) => {
            if (event.type === "error") {
              setError(`${event.context}: ${event.error.message}`);
              return;
            }
            await next();
          });

        // Push a single user-message event to kick off the pipeline.
        // AgentLoop intercepts it and drives the entire ReAct loop.
        async function* singleEvent(): AsyncGenerator<PipelineEvent> {
          yield { type: "user-message", content: input };
        }
        await pipeline.run(singleEvent());

        setMessages([...manager.getMessages()]);
        setStreaming("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  return {
    messages,
    streaming,
    isLoading,
    tokenCount,
    error,
    sessionId,
    thinkingBlocks,
    activeToolCalls,
    commandMessage,
    slashCommands,
    handleSubmit,
  };
}

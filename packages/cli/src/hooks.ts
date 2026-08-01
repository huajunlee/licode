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
  ToolRegistry,
  builtinTools,
  createAgentLoopMiddleware,
  CommandRouter,
  initializeExtensions,
  registerExtensionMiddleware,
  MemoryStore,
  MemoryLoader,
  MemoryExtractor,
  MemoryRecall,
  createMemoryRecallHandler,
  createMemoryExtractionHook,
  createMemoryExtractionState,
  MemoryDream,
  createMemoryDreamHook,
  createMemoryDreamState,
  emitAfterAgentLoop,
  ContextCompressor,
  CompressionAssistant,
  JournalStore,
  CuratedIndex,
  DiaryExtractor,
  DiarySession,
  CurationSession,
  autoPromoteEntry,
  autoFileEntry,
  MemoryCuration,
  ProfileCuration,
  PersonProfileStore,
  handleDiaryInput,
  handleCurationInput,
} from "@licode/core";
import type {
  Message,
  PipelineEvent,
  AgentConfig,
  EventBus,
  InitializedExtensions,
  MemoryExtractionState,
  DreamState,
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
  contextWindow: number;
  error: string | null;
  sessionId: string;
  thinkingBlocks: ThinkingBlock[];
  activeToolCalls: ToolCallState[];
  commandMessage: string | null;
  /** Available slash commands and skills for autocomplete */
  slashCommands: Array<{ name: string; description: string }>;
  /** True while a memory dream consolidation is running in the background. */
  isDreaming: boolean;
  /** Phase 4: notice shown after a dream archives memories (null = none). */
  archivedNotice: string | null;
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

/**
 * Phase 2: build the structure-aware context compressor. Summarization runs
 * on a cheap side model (default deepseek-chat) via a separate provider, so
 * the main loop's provider is untouched. Summarizer failure degrades to trim
 * inside the compressor - never breaks the loop.
 */
export function readContextFlags(): {
  rollingSummary: boolean;
  selectiveRetention: boolean;
  fileChangeCompaction: boolean;
  summaryMaxTokens: number;
} {
  const off = (v?: string) => v === "off";
  return {
    rollingSummary: !off(process.env.LICODE_CONTEXT_ROLLING),
    selectiveRetention: !off(process.env.LICODE_CONTEXT_SELECTIVE),
    fileChangeCompaction: !off(process.env.LICODE_CONTEXT_FILECHANGE),
    summaryMaxTokens: Number(process.env.LICODE_CONTEXT_SUMMARY_MAX_TOKENS) || 2048,
  };
}

function createContextCompressor(
  apiKey: string,
  baseUrl: string | undefined,
  model: string,
  workingDirectory: string
): ContextCompressor {
  const flags = readContextFlags();
  const sideProvider = new AnthropicProvider({ apiKey, baseUrl });
  const assistant = new CompressionAssistant({
    generate: async (prompt) => {
      const res = await sideProvider.chat({
        messages: [
          { role: "user", content: prompt, timestamp: new Date().toISOString() },
        ],
        model,
        maxTokens: 2048,
      });
      return res.content;
    },
    summaryMaxTokens: flags.summaryMaxTokens,
  });
  return new ContextCompressor({
    compressionAssistant: assistant,
    workingDirectory,
    rollingSummary: flags.rollingSummary,
    selectiveRetention: flags.selectiveRetention,
    fileChangeCompaction: flags.fileChangeCompaction,
    summaryMaxTokens: flags.summaryMaxTokens,
  });
}

export function readDiaryFlags(): { enabled: boolean; model: string; curateModel: string } {
  return {
    enabled: process.env.LICODE_DIARY !== "off",
    model: process.env.LICODE_DIARY_MODEL || "deepseek-chat",
    curateModel: process.env.LICODE_DIARY_CURATE_MODEL || process.env.LICODE_DIARY_MODEL || "deepseek-chat",
  };
}

function createDiaryExtractor(
  apiKey: string,
  baseUrl: string | undefined,
  model: string
): DiaryExtractor {
  const sideProvider = new AnthropicProvider({ apiKey, baseUrl });
  return new DiaryExtractor({
    generate: async (prompt) => {
      const res = await sideProvider.chat({
        messages: [
          { role: "user", content: prompt, timestamp: new Date().toISOString() },
        ],
        model,
        maxTokens: 2048,
      });
      return res.content;
    },
  });
}

function createMemoryCuration(
  apiKey: string,
  baseUrl: string | undefined,
  model: string
): MemoryCuration {
  const sideProvider = new AnthropicProvider({ apiKey, baseUrl });
  return new MemoryCuration({
    generate: async (prompt) => {
      const res = await sideProvider.chat({
        messages: [
          { role: "user", content: prompt, timestamp: new Date().toISOString() },
        ],
        model,
        maxTokens: 2048,
      });
      return res.content;
    },
  });
}

function createProfileCuration(
  apiKey: string,
  baseUrl: string | undefined,
  model: string
): ProfileCuration {
  const sideProvider = new AnthropicProvider({ apiKey, baseUrl });
  return new ProfileCuration({
    generate: async (prompt) => {
      const res = await sideProvider.chat({
        messages: [
          { role: "user", content: prompt, timestamp: new Date().toISOString() },
        ],
        model,
        maxTokens: 2048,
      });
      return res.content;
    },
  });
}

export function createEventBus(
  setStreaming: (s: string) => void,
  setThinkingBlocks: (blocks: ThinkingBlock[]) => void,
  setActiveToolCalls: Dispatch<SetStateAction<ToolCallState[]>>,
  setError: (e: string | null) => void,
  setTokenCount: (n: number) => void,
  getTokenCount: () => number,
  setContextWindow: (n: number) => void,
  getContextWindow: () => number,
  setCommandMessage?: (message: string) => void
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
          // Refresh the status bar with the calibrated context size. The
          // agent-loop path never emits the llm-response-complete event that
          // tokenCountingMiddleware listened for, so we read the live count
          // here instead.
          setTokenCount(getTokenCount());
          setContextWindow(getContextWindow());
          break;

        case "context-compressed":
          // Phase 2: surface that older turns were summarized/trimmed so the
          // user understands why earlier detail is gone.
          setCommandMessage?.(
            `已压缩 ${event.removedMessages ?? 0} 条消息（${
              event.method === "trim" ? "裁剪" : "摘要"
            }）`
          );
          setTokenCount(getTokenCount());
          setContextWindow(getContextWindow());
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
  const [contextWindow, setContextWindow] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [thinkingBlocks, setThinkingBlocks] = useState<ThinkingBlock[]>([]);
  const [activeToolCalls, setActiveToolCalls] = useState<ToolCallState[]>([]);
  const [commandMessage, setCommandMessage] = useState<string | null>(null);
  const [slashCommands, setSlashCommands] = useState<Array<{ name: string; description: string }>>([]);
  const [isDreaming, setIsDreaming] = useState(false);
  const [archivedNotice, setArchivedNotice] = useState<string | null>(null);

  const commandRouterRef = useRef<CommandRouter>(new CommandRouter());
  const memoryStoreRef = useRef<MemoryStore>(
    new MemoryStore(path.join(process.cwd(), ".licode", "memory"))
  );
  const memoryExtractorRef = useRef<MemoryExtractor>(
    new MemoryExtractor({ apiKey, baseUrl, model })
  );
  // Shared with the memory extraction hook (registered once) — must be a
  // stable object identity, so the ref's .current is passed by reference.
  const memoryExtractionStateRef = useRef<MemoryExtractionState>(
    createMemoryExtractionState()
  );
  // Phase 3: dream consolidation (after:agentLoop, fire-and-forget).
  // Shared with the extraction hook AND the recall handler (yield-while-dreaming).
  const memoryDreamStateRef = useRef<DreamState>(createMemoryDreamState());
  // Phase 2: per-turn memory recall (side query -> synthetic tool_call pair).
  // Phase 4: dreamState passed in so recordUsage yields while dreaming.
  const memoryRecallHandlerRef = useRef(
    createMemoryRecallHandler({
      recall: new MemoryRecall({ apiKey, baseUrl, model }),
      store: memoryStoreRef.current,
      dreamState: memoryDreamStateRef.current,
    })
  );
  const dreamMemoryDir = path.join(process.cwd(), ".licode", "memory");
  const dreamSessionsDir = path.join(process.cwd(), ".licode", "sessions");
  const memoryDreamHookRef = useRef(
    process.env.LICODE_MEMORY_DREAM === "off"
      ? null
      : createMemoryDreamHook({
          dream: new MemoryDream({ apiKey, baseUrl, model }),
          store: memoryStoreRef.current,
          state: memoryDreamStateRef.current,
          sessionsDir: dreamSessionsDir,
          memoryDir: dreamMemoryDir,
          onStateChange: setIsDreaming,
          onArchived: (slugs) =>
            setArchivedNotice(
              `🌙 记忆整理完成：已归档 ${slugs.length} 条 [${slugs.join(", ")}]，可用 /memory-restore <slug> 恢复`
            ),
        })
  );
  // Phase 2: structure-aware context compressor (summarize older turns when
  // near the context window). Constructed once the provider is ready.
  const compressorRef = useRef<ContextCompressor | null>(null);
  // diary capture: independent journal store + side-model extractor + session
  const diaryStoreRef = useRef<JournalStore>(
    new JournalStore(path.join(process.cwd(), ".licode", "journal"))
  );
  const diaryEnabledRef = useRef<boolean>(readDiaryFlags().enabled);
  const diaryExtractorRef = useRef<DiaryExtractor | null>(null);
  const diarySessionRef = useRef<DiarySession | null>(null);
  const curatedIndexRef = useRef<CuratedIndex>(
    new CuratedIndex(path.join(process.cwd(), ".licode", "journal", ".curated.json"))
  );
  const memoryCurationRef = useRef<MemoryCuration | null>(null);
  const curationSessionRef = useRef<CurationSession | null>(null);
  const profileStoreRef = useRef<PersonProfileStore>(
    new PersonProfileStore(path.join(process.cwd(), ".licode", "people"))
  );
  const profileCurationRef = useRef<ProfileCuration | null>(null);

  useEffect(() => {
    if (!apiKey) return;

    const provider = new AnthropicProvider({ apiKey, baseUrl });
    providerRef.current = provider;
    compressorRef.current = createContextCompressor(apiKey, baseUrl, model, process.cwd());
    const diaryFlags = readDiaryFlags();
    diaryEnabledRef.current = diaryFlags.enabled;
    if (diaryFlags.enabled) {
      diaryExtractorRef.current = createDiaryExtractor(apiKey, baseUrl, diaryFlags.model);
      memoryCurationRef.current = createMemoryCuration(apiKey, baseUrl, diaryFlags.curateModel);
      profileCurationRef.current = createProfileCuration(apiKey, baseUrl, diaryFlags.curateModel);
    }

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

      // Register in-process memory extraction hook (Step 2)
      // Fires after each agent loop, fire-and-forget (non-blocking)
      extensions.hooks.register({
        name: "memory-extraction",
        events: ["agent-loop-complete"],
        fn: createMemoryExtractionHook(
          memoryExtractorRef.current,
          memoryStoreRef.current,
          manager,
          memoryExtractionStateRef.current,
          memoryDreamStateRef.current
        ),
        resolvedPosition: "after:agentLoop",
        blocking: false,
      });

      // Register in-process memory dream hook (Phase 3)
      // Fires after each agent loop, fire-and-forget; disabled via LICODE_MEMORY_DREAM=off.
      if (memoryDreamHookRef.current) {
        extensions.hooks.register({
          name: "memory-dream",
          events: ["agent-loop-complete"],
          fn: memoryDreamHookRef.current,
          resolvedPosition: "after:agentLoop",
          blocking: false,
        });
      }

      // Populate slash commands for autocomplete (commands + skills)
      const cmds = extensions.commands.list().map((c) => ({
        name: `/${c.name}`,
        description: c.description,
      }));
      const skillItems = extensions.skills.map((s) => ({
        name: `/${s.name}`,
        description: s.description.slice(0, 80),
      }));
      setSlashCommands([
        ...cmds,
        ...skillItems,
        { name: "/diary", description: "日记捕获（进入模式）" },
        { name: "/diary-end", description: "结束日记会话并保存" },
        { name: "/diary-list", description: "列出日记条目（/diary-list 日期）" },
        { name: "/diary-find", description: "搜索日记（/diary-find 关键词）" },
        { name: "/diary-show", description: "查看某条日记（/diary-show id）" },
        { name: "/diary-curate", description: "整理日记候选到记忆/档案（/diary-curate apply 确认）" },
      ]);

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
      const compressor = compressorRef.current;
      const router = commandRouterRef.current;
      if (!provider || !manager || !input.trim()) return;

      // Mark the start of this agent loop so the memory extraction hook
      // can detect memory files written by the main agent mid-loop.
      memoryExtractionStateRef.current.loopStartedAt = Date.now();

      setIsLoading(true);
      setStreaming("");
      setError(null);
      setArchivedNotice(null);
      setThinkingBlocks([]);
      setActiveToolCalls([]);
      setCommandMessage(null);

      // ── curation: /diary-curate（须在 /diary 之前判，因 /diary-curate 也以 /diary 开头）──
      if (diaryEnabledRef.current && memoryCurationRef.current && profileCurationRef.current && input.trim().startsWith("/diary-curate")) {
        const outcome = await handleCurationInput(input, {
          session: curationSessionRef.current,
          journalStore: diaryStoreRef.current,
          memoryStore: memoryStoreRef.current,
          curatedIndex: curatedIndexRef.current,
          memoryCuration: memoryCurationRef.current,
          profileStore: profileStoreRef.current,
          profileCuration: profileCurationRef.current,
          now: () => new Date(),
        });
        if (outcome) {
          curationSessionRef.current = outcome.nextSession;
          setCommandMessage(outcome.result.message);
        }
        setIsLoading(false);
        setMessages([...manager.getMessages()]);
        return;
      }

      // ── diary capture: /diary commands + capture during active session ──
      if (diaryEnabledRef.current && diaryExtractorRef.current) {
        const outcome = await handleDiaryInput(input, {
          session: diarySessionRef.current,
          extractor: diaryExtractorRef.current,
          store: diaryStoreRef.current,
          now: () => new Date(),
        });
        if (outcome !== null) {
          const wasEnd = diarySessionRef.current !== null && outcome.nextSession === null && outcome.result.type === "action";
          diarySessionRef.current = outcome.nextSession;
          setIsLoading(false);
          setCommandMessage(outcome.result.message);
          setMessages([...manager.getMessages()]);
          if (wasEnd && diaryEnabledRef.current) {
            try {
              const recent = await diaryStoreRef.current.listRecent(1);
              if (recent[0]) {
                const pr = await autoPromoteEntry(recent[0], {
                  memoryStore: memoryStoreRef.current,
                  curatedIndex: curatedIndexRef.current,
                  now: () => new Date(),
                });
                const fr = await autoFileEntry(recent[0], {
                  profileStore: profileStoreRef.current,
                  curatedIndex: curatedIndexRef.current,
                  now: () => new Date(),
                });
                const notes: string[] = [];
                if (pr.promoted.length) notes.push(`✨ 已自动提升 ${pr.promoted.length} 条到记忆`);
                if (fr.filed.length) notes.push(`👤 已自动入档 ${fr.filed.length} 人`);
                if (notes.length) setCommandMessage(outcome.result.message + "\n" + notes.join("；") + "。");
              }
            } catch { /* 自动提升/入档失败不阻断；候选留待 /diary-curate */ }
          }
          return;
        }
      }

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
              setError,
              setTokenCount,
              () => manager.getTokenCount(),
              setContextWindow,
              () => manager.getBudgetInfo().contextWindow,
              setCommandMessage
            );

            const pipeline = new EventPipeline();
            registerExtensionMiddleware(pipeline, extensionsRef.current!, "before:agentLoop");

            pipeline
              .use(
                createAgentLoopMiddleware({
                  llm: provider,
                  conversation: manager,
                  tools,
                  eventBus,
                  compressor: compressor ?? undefined,
                  ...(process.env.LICODE_MEMORY_RECALL === "off"
                    ? {}
                    : { onTurnStart: memoryRecallHandlerRef.current }),
                })
              )
              // after:agentLoop fires shell hooks + in-process function hooks (e.g. memory extraction)
              .use("hook:after:agentLoop", async (_event, next) => {
                await next();
                const extensions = extensionsRef.current;
                if (extensions) {
                  await emitAfterAgentLoop(extensions.hooks);
                }
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
          setError,
          setTokenCount,
          () => manager.getTokenCount(),
          setContextWindow,
          () => manager.getBudgetInfo().contextWindow,
          setCommandMessage
        );

        const pipeline = new EventPipeline();
        registerExtensionMiddleware(pipeline, extensionsRef.current!, "before:agentLoop");

        pipeline
          .use(
            createAgentLoopMiddleware({
              llm: provider,
              conversation: manager,
              tools,
              eventBus,
              compressor: compressor ?? undefined,
              ...(process.env.LICODE_MEMORY_RECALL === "off"
                ? {}
                : { onTurnStart: memoryRecallHandlerRef.current }),
            })
          )
          // after:agentLoop fires shell hooks + in-process function hooks (e.g. memory extraction)
          .use("hook:after:agentLoop", async (_event, next) => {
            await next();
            const extensions = extensionsRef.current;
            if (extensions) {
              await emitAfterAgentLoop(extensions.hooks);
            }
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
    contextWindow,
    error,
    sessionId,
    thinkingBlocks,
    activeToolCalls,
    commandMessage,
    slashCommands,
    isDreaming,
    archivedNotice,
    handleSubmit,
  };
}

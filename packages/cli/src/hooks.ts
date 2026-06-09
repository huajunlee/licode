import { useState, useCallback, useEffect, useRef } from "react";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AnthropicProvider,
  ConversationManager,
  SystemPrompt,
  loadDefaultLayers,
  EventPipeline,
  generateChatEvents,
  tokenCountingMiddleware,
} from "@licode/core";
import type { Message, PipelineEvent } from "@licode/core";
import type { ThinkingBlock } from "./components/thinking-accordion.js";
import { inferPurpose } from "./components/thinking-accordion.js";

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

export function useConversation(
  config: UseConversationConfig
): UseConversationResult {
  const model = config.model ?? "deepseek-v4-pro";
  const apiKey = config.apiKey;
  const baseUrl = config.baseUrl;

  const providerRef = useRef<AnthropicProvider | null>(null);
  const managerRef = useRef<ConversationManager | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [tokenCount, setTokenCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [thinkingBlocks, setThinkingBlocks] = useState<ThinkingBlock[]>([]);

  useEffect(() => {
    if (!apiKey) return;

    const provider = new AnthropicProvider({ apiKey, baseUrl });
    providerRef.current = provider;

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
      manager.systemPrompt = systemPrompt;

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
      if (!provider || !manager || !input.trim()) return;

      setIsLoading(true);
      setStreaming("");
      setError(null);
      // Reset thinking blocks for this turn
      const blocks: ThinkingBlock[] = [];
      let blockIdCounter = 0;
      let currentThinking = "";
      setThinkingBlocks([]);

      try {
        const pipeline = new EventPipeline();
        let streamText = "";

        pipeline
          .use(async (event: PipelineEvent, next) => {
            if (event.type === "user-message") {
              setMessages([...manager.getMessages()]);
            }
            await next();
          })
          .use(tokenCountingMiddleware((total) => setTokenCount(total)))
          .use(async (event: PipelineEvent, next) => {
            if (event.type === "llm-thinking") {
              currentThinking += event.text;
              // Update or create current block as streaming
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
              // Use blocks mutation directly (pipeline is synchronous per-event)
              blocks.length = 0;
              blocks.push(...updated);
              setThinkingBlocks([...blocks]);
            } else if (event.type === "llm-thinking-complete") {
              // Finalize current block
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
            } else if (event.type === "llm-token") {
              streamText += event.text;
              setStreaming(streamText);
            } else if (event.type === "stream-complete") {
              // Clear thinking blocks once the full response finishes.
              setThinkingBlocks([]);
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

        const events = generateChatEvents(input, manager, provider);
        await pipeline.run(events);

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
    handleSubmit,
  };
}

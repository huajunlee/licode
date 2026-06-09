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
  handleSubmit: (input: string) => Promise<void>;
}

const SESSIONS_DIR = ".licode/sessions";

/**
 * Resolve a session ID to a file path.
 * Supports exact match and prefix match — users can type partial UUIDs
 * (as displayed in the welcome screen) to resume a session.
 */
function resolveSessionPath(sessionId: string): string | null {
  const sessionsDir = path.resolve(SESSIONS_DIR);

  // Try exact match first
  const exactPath = path.join(sessionsDir, `${sessionId}.json`);
  if (fs.existsSync(exactPath)) return exactPath;

  // Try prefix match (user typed truncated UUID)
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

  // Initialize provider and manager
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
          // Session not found — create new with error
          setError(
            `会话 ${config.sessionId} 未找到。使用 --session <id> 恢复已有会话，或直接 Enter 新建。`
          );
          manager = new ConversationManager({ model });
        }
      } else {
        manager = new ConversationManager({ model });
      }

      // Set up system prompt layers
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

      try {
        const pipeline = new EventPipeline();
        let streamText = "";

        pipeline
          .use(async (event: PipelineEvent, next) => {
            if (event.type === "user-message") {
              // Show user question immediately, before streaming starts
              setMessages([...manager.getMessages()]);
            }
            await next();
          })
          .use(tokenCountingMiddleware((total) => setTokenCount(total)))
          .use(async (event: PipelineEvent, next) => {
            if (event.type === "llm-token") {
              streamText += event.text;
              setStreaming(streamText);
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
    handleSubmit,
  };
}

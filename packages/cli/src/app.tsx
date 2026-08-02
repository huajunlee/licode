import React, { useState, useCallback, useReducer } from "react";
import { Box, Text, useInput } from "ink";
import { ConversationManager } from "@licode/core";
import { ChatView } from "./components/chat-view.js";
import { StreamRenderer } from "./components/stream-renderer.js";
import { WaitingIndicator } from "./components/waiting-indicator.js";
import { DreamIndicator } from "./components/dream-indicator.js";
import { ThinkingAccordion } from "./components/thinking-accordion.js";
import { InputBox } from "./components/input-box.js";
import { StatusBar } from "./components/status-bar.js";
import { SessionList } from "./components/session-list.js";
import { BANNER_LINES, TAGLINE } from "./banner.js";
import { WelcomeInput } from "./components/welcome-input.js";
import { ToolCallCards } from "./components/tool-call-card.js";
import { useConversation } from "./hooks.js";
import { useSessionSelector } from "./components/use-session-selector.js";
import { createAppViewState, appViewReducer } from "./app-view.js";
import { COLORS } from "./theme.js";

export interface AppProps {
  apiKey: string;
  model?: string;
  sessionId?: string;
  baseUrl?: string;
  existingSessions?: Array<{
    id: string;
    title?: string;
    createdAt: string;
    updatedAt: string;
    model: string;
    messageCount: number;
  }>;
}

function App({ apiKey, model, sessionId: initialSessionId, baseUrl, existingSessions }: AppProps) {
  const [state, dispatch] = useReducer(
    appViewReducer,
    initialSessionId,
    createAppViewState
  );
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(initialSessionId);
  const [welcomeError, setWelcomeError] = useState<string | null>(null);
  const [sessions, setSessions] = useState(existingSessions ?? []);

  const refreshSessions = useCallback(async () => {
    try {
      const updated = await ConversationManager.listSessions();
      setSessions(updated);
    } catch {
      // silently ignore refresh errors
    }
  }, []);
  const {
    cursorIndex,
    moveDown,
    moveUp,
    selectedId,
    isOnNewSession,
    visibleItems,
    windowStart,
  } = useSessionSelector(sessions, { includeCreateNew: true });

  const enterSession = useCallback(
    (id: string) => {
      setActiveSessionId(id);
      dispatch("enter-chat");
    },
    []
  );

  const newSession = useCallback(() => {
    setActiveSessionId(undefined);
    dispatch("enter-chat");
  }, []);

  const goBack = useCallback(() => {
    setActiveSessionId(undefined);
    dispatch("go-back");
    refreshSessions();
  }, [refreshSessions]);

  const handleWelcomeSubmit = useCallback(
    (input: string) => {
      const trimmed = input.trim();

      if (trimmed.toLowerCase().startsWith("--session")) {
        const parts = trimmed.split(/\s+/);
        if (parts.length < 2) {
          setWelcomeError("--session 需要一个会话 ID，例如 --session abc123-def456");
          return;
        }
        const sessionId = parts[1];
        let fullId = sessionId;
        if (sessions.length > 0) {
          const match = sessions.find((s) => s.id.startsWith(sessionId));
          if (match) fullId = match.id;
        }
        enterSession(fullId);
      } else if (trimmed === "") {
        // Empty Enter: create new if on new-session, else enter selected session
        if (selectedId === null) {
          newSession();
        } else {
          enterSession(selectedId);
        }
      } else {
        newSession();
      }
    },
    [sessions, selectedId, enterSession, newSession]
  );

  const isWelcome = state.view === "welcome";

  // Welcome screen: arrow key navigation + Ctrl+N new session
  useInput(
    (input, key) => {
      if (!isWelcome) return;
      if (key.upArrow) moveUp();
      else if (key.downArrow) moveDown();
      else if (key.ctrl && (input === "n" || input === "\x0e")) newSession();
    },
    { isActive: isWelcome }
  );

  // Chat screen: Ctrl+Q to return to session list
  useInput(
    (input, key) => {
      if (isWelcome) return;
      if (key.ctrl && (input === "q" || input === "\x11")) goBack();
    },
    { isActive: !isWelcome }
  );

  if (isWelcome) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box flexDirection="column" marginBottom={1}>
          {BANNER_LINES.map((line, i) => (
            <Text key={i} color={COLORS.accent}>{line}</Text>
          ))}
          <Text color={COLORS.faint}>  {TAGLINE} · v0.1.0</Text>
        </Box>
        <SessionList
          visibleItems={visibleItems}
          totalCount={sessions.length}
          windowStart={windowStart}
          showCreateNew={true}
          isOnNewSession={isOnNewSession}
        />
        <Box marginTop={1}>
          <Text color={COLORS.faint}>
            ↑↓ 选择 · enter 进入 · ctrl+n 新建 · --session {"<id>"} 恢复
          </Text>
        </Box>
        {welcomeError && (
          <Box marginTop={1}>
            <Text color={COLORS.error}>{welcomeError}</Text>
          </Box>
        )}
        <WelcomeInput onSubmit={handleWelcomeSubmit} />
      </Box>
    );
  }

  return (
    <ChatApp
      apiKey={apiKey}
      model={model}
      sessionId={activeSessionId}
      baseUrl={baseUrl}
      existingSessions={sessions}
      onGoBack={goBack}
    />
  );
}

function ChatApp({
  apiKey,
  model,
  sessionId,
  baseUrl,
  existingSessions,
  onGoBack,
}: {
  apiKey: string;
  model?: string;
  sessionId?: string;
  baseUrl?: string;
  existingSessions?: Array<{ id: string }>;
  onGoBack: () => void;
}) {
  const {
    messages,
    streaming,
    isLoading,
    tokenCount,
    contextWindow,
    error,
    sessionId: currentSessionId,
    thinkingBlocks,
    activeToolCalls,
    commandMessage,
    slashCommands,
    isDreaming,
    archivedNotice,
    handleSubmit,
  } = useConversation({ apiKey, model, sessionId, baseUrl, existingSessions });

  // Accordion navigation: Ctrl+↑/↓ to move, -1 = no focus (input mode)
  const [focusedIndex, setFocusedIndex] = useState(-1);

  // Ctrl+↑↓ navigation, Enter to collapse
  useInput(
    (input, key) => {
      if (key.ctrl && key.upArrow) {
        setFocusedIndex((prev) => {
          if (thinkingBlocks.length === 0) return -1;
          return Math.max(prev - 1, -1);
        });
      } else if (key.ctrl && key.downArrow) {
        setFocusedIndex((prev) => {
          if (thinkingBlocks.length === 0) return -1;
          return Math.min(prev + 1, thinkingBlocks.length - 1);
        });
      } else if (key.return && focusedIndex >= 0) {
        // Enter collapses the currently focused accordion item
        setFocusedIndex(-1);
      }
    },
    { isActive: true }
  );

  const hasThinking = thinkingBlocks.length > 0;

  return (
    <Box flexDirection="column" padding={1}>
      <ChatView messages={messages} />
      {isDreaming && (
        <Box marginBottom={1}>
          <DreamIndicator />
        </Box>
      )}
      {archivedNotice && (
        <Box marginBottom={1}>
          <Text color="yellow">{archivedNotice}</Text>
        </Box>
      )}
      {hasThinking && (
        <ThinkingAccordion blocks={thinkingBlocks} focusedIndex={focusedIndex} />
      )}
      {activeToolCalls.length > 0 && (
        <ToolCallCards calls={activeToolCalls} />
      )}
      {isLoading && !streaming && !hasThinking && (
        <Box marginBottom={1}>
          <WaitingIndicator isActive={true} />
        </Box>
      )}
      <StreamRenderer text={streaming} />
      {error && (
        <Box marginY={1}>
          <Text color={COLORS.error}>Error: {error}</Text>
        </Box>
      )}
      {commandMessage && (
        <Box marginY={1}>
          <Text color={COLORS.warning}>{commandMessage}</Text>
        </Box>
      )}
      <InputBox onSubmit={handleSubmit} loading={isLoading} disabled={focusedIndex >= 0} slashCommands={slashCommands} />
      <StatusBar
        model={model ?? "deepseek-v4-pro"}
        tokens={tokenCount}
        contextWindow={contextWindow}
        sessionId={currentSessionId}
      />
    </Box>
  );
}

export default App;

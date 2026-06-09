import React, { useState, useCallback, useReducer } from "react";
import { Box, Text, useInput } from "ink";
import { ChatView } from "./components/chat-view.js";
import { StreamRenderer } from "./components/stream-renderer.js";
import { WaitingIndicator } from "./components/waiting-indicator.js";
import { InputBox } from "./components/input-box.js";
import { StatusBar } from "./components/status-bar.js";
import { SessionList } from "./components/session-list.js";
import { WelcomeInput } from "./components/welcome-input.js";
import { useConversation } from "./hooks.js";
import { useSessionSelector } from "./components/use-session-selector.js";
import { createAppViewState, appViewReducer } from "./app-view.js";

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

  const sessions = existingSessions ?? [];
  const { cursorIndex, moveDown, moveUp, selectedId, visibleItems, windowStart } =
    useSessionSelector(sessions);

  const enterSession = useCallback(
    (id: string) => {
      setActiveSessionId(id);
      dispatch("enter-chat");
    },
    []
  );

  const goBack = useCallback(() => {
    dispatch("go-back");
  }, []);

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
      } else if (trimmed === "" && selectedId) {
        enterSession(selectedId);
      } else {
        dispatch("enter-chat");
      }
    },
    [sessions, selectedId, enterSession]
  );

  const isWelcome = state.view === "welcome";

  // Two separate useInput hooks with isActive guards:
  // - welcome screen: arrow key navigation
  // - chat screen: Ctrl+Q to return to session list
  useInput(
    (_input, key) => {
      if (!isWelcome) return;
      if (key.upArrow) moveUp();
      else if (key.downArrow) moveDown();
    },
    { isActive: isWelcome }
  );

  // Global Ctrl+Q to return to session list from chat
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
        <Box marginBottom={1}>
          <Text bold>LICode v0.1.0</Text>
        </Box>
        {sessions.length > 0 && (
          <SessionList
            visibleItems={visibleItems}
            totalCount={sessions.length}
            windowStart={windowStart}
          />
        )}
        <Box marginTop={1}>
          <Text dimColor>
            ↑↓ 选择会话 · Enter 进入 · 或输入 --session {"<id>"} · 输入关键字进入新对话
          </Text>
        </Box>
        {welcomeError && (
          <Box marginTop={1}>
            <Text color="red">{welcomeError}</Text>
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
      existingSessions={existingSessions}
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
    error,
    sessionId: currentSessionId,
    handleSubmit,
  } = useConversation({ apiKey, model, sessionId, baseUrl, existingSessions });

  return (
    <Box flexDirection="column" padding={1}>
      <ChatView messages={messages} />
      {isLoading && !streaming && (
        <Box marginBottom={1}>
          <WaitingIndicator isActive={true} />
        </Box>
      )}
      <StreamRenderer text={streaming} />
      {error && (
        <Box marginY={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}
      <InputBox onSubmit={handleSubmit} loading={isLoading} />
      <StatusBar
        model={model ?? "deepseek-v4-pro"}
        tokens={tokenCount}
        sessionId={currentSessionId}
      />
    </Box>
  );
}

export default App;

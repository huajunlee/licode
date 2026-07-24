import React from "react";
import { Box, Text } from "ink";
import type { Message } from "@licode/core";

interface ChatViewProps {
  messages: Message[];
}

function renderContent(msg: Message): string {
  if (typeof msg.content === "string") {
    return msg.content;
  }
  // ToolUseMessage or ToolResultMessage
  if (msg.role === "assistant") {
    // ToolUseMessage: content is ToolUseBlock[]
    const names = msg.content.map((b: { name: string }) => b.name).join(", ");
    return `[调用工具: ${names}]`;
  }
  // ToolResultMessage: content is ToolResultBlock[]
  return msg.content
    .map(
      (b: { content: string; is_error?: boolean }) =>
        `${b.is_error ? "✗" : "✓"} ${b.content.slice(0, 100)}`
    )
    .join("\n");
}

export function ChatView({ messages }: ChatViewProps) {
  if (messages.length === 0) {
    return (
      <Box marginBottom={1}>
        <Text dimColor>开始对话...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {messages
        .filter((m) => m.role !== "system")
        .map((msg, i) => (
          <Box key={i} flexDirection="column" marginY={1}>
            <Text color={msg.role === "user" ? "green" : undefined}>
              {msg.role === "user" ? "> " : ""}
              {renderContent(msg)}
            </Text>
          </Box>
        ))}
    </Box>
  );
}

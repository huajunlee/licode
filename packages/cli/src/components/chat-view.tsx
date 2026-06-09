import React from "react";
import { Box, Text } from "ink";
import type { Message } from "@licode/core";

interface ChatViewProps {
  messages: Message[];
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
              {msg.content}
            </Text>
          </Box>
        ))}
    </Box>
  );
}

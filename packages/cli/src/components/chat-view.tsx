import React from "react";
import { Box, Text } from "ink";
import type { Message } from "@licode/core";
import { classifyMessage, toolNames } from "./message-classify.js";
import { MarkdownText } from "./markdown-text.js";
import { COLORS, ICONS } from "../theme.js";

interface ChatViewProps {
  messages: Message[];
}

export function ChatView({ messages }: ChatViewProps) {
  const visible = messages.filter((m) => {
    const kind = classifyMessage(m);
    return kind === "user" || kind === "assistant-text" || kind === "tool-use";
  });

  if (visible.length === 0) {
    return (
      <Box marginBottom={1}>
        <Text color={COLORS.faint}>开始对话…</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {visible.map((msg, i) => {
        const kind = classifyMessage(msg);

        if (kind === "user") {
          return (
            <Box key={i} marginTop={1}>
              <Text color={COLORS.accent}>{ICONS.prompt} </Text>
              <Text>{msg.content as string}</Text>
            </Box>
          );
        }

        if (kind === "tool-use") {
          return (
            <Box key={i} marginLeft={2}>
              <Text color={COLORS.muted}>
                {ICONS.toolDone} 调用工具: {toolNames(msg)}
              </Text>
            </Box>
          );
        }

        // assistant-text: ◆ marker aligned with the first content line
        return (
          <Box key={i} marginTop={1}>
            <Text color={COLORS.accent}>{ICONS.assistant} </Text>
            <MarkdownText>{msg.content as string}</MarkdownText>
          </Box>
        );
      })}
    </Box>
  );
}

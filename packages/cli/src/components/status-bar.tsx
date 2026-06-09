import React from "react";
import { Box, Text } from "ink";

interface StatusBarProps {
  model: string;
  tokens: number;
  sessionId: string;
}

export function StatusBar({ model, tokens, sessionId }: StatusBarProps) {
  const shortId = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;

  return (
    <Box marginTop={1} flexDirection="column">
      <Box flexDirection="row" gap={2}>
        <Text dimColor>{model}</Text>
        <Text dimColor>·</Text>
        <Text dimColor>{tokens} tokens</Text>
        <Text dimColor>·</Text>
        <Text dimColor>session: {shortId}</Text>
      </Box>
      <Text dimColor>Ctrl+Q 返回会话列表 · Ctrl+↑↓ 查看推理过程 · Enter 收起</Text>
    </Box>
  );
}

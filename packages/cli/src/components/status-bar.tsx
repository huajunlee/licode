import React from "react";
import { Box, Text } from "ink";
import { COLORS, BORDERS, SPACING } from "../theme.js";

interface StatusBarProps {
  model: string;
  tokens: number;
  contextWindow: number;
  sessionId: string;
}

function formatK(n: number): string {
  if (n < 1000) return `${n}`;
  const k = n / 1000;
  return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
}

function tokenDisplay(tokens: number, contextWindow: number): string {
  if (contextWindow > 0) {
    const pct = Math.round((tokens / contextWindow) * 100);
    return `${pct}% (${formatK(tokens)}/${formatK(contextWindow)})`;
  }
  return formatK(tokens);
}

export function StatusBar({ model, tokens, contextWindow, sessionId }: StatusBarProps) {
  const shortId = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
  const tokenStr = tokenDisplay(tokens, contextWindow);

  return (
    <Box
      flexDirection="column"
      marginTop={SPACING.sm}
      borderStyle={BORDERS.popup}
      paddingX={SPACING.sm}
    >
      {/* Info row */}
      <Box flexDirection="row" gap={SPACING.md}>
        <Text>
          <Text dimColor>model: </Text>
          <Text bold>{model}</Text>
        </Text>
        <Text dimColor>│</Text>
        <Text>
          <Text dimColor>tokens: </Text>
          <Text>{tokenStr}</Text>
        </Text>
        <Text dimColor>│</Text>
        <Text>
          <Text dimColor>session: </Text>
          <Text dimColor>{shortId}</Text>
        </Text>
      </Box>

      {/* Shortcuts row */}
      <Box>
        <Text dimColor>
          Ctrl+Q 返回{"  "}│{"  "}
          <Text color={COLORS.info}>Ctrl+↑↓</Text> 推理{"  "}│{"  "}
          Enter 收起
        </Text>
      </Box>
    </Box>
  );
}

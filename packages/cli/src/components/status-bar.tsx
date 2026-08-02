import React from "react";
import { Box, Text, useStdout } from "ink";
import { formatStatusWide, formatStatusNarrow } from "./status-line.js";
import { COLORS, ICONS } from "../theme.js";

interface StatusBarProps {
  model: string;
  tokens: number;
  /** Context window in tokens; 0/omitted hides the percentage. */
  contextWindow?: number;
  sessionId: string;
}

export function StatusBar({ model, tokens, contextWindow = 0, sessionId }: StatusBarProps) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const line =
    cols < 60
      ? formatStatusNarrow(model, tokens)
      : formatStatusWide(model, tokens, sessionId, contextWindow);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={COLORS.faint}>{ICONS.separator.repeat(Math.max(10, cols - 2))}</Text>
      <Text color={COLORS.faint}>{line}</Text>
    </Box>
  );
}

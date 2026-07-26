import React from "react";
import { Box, Text } from "ink";
import { COLORS, BORDERS, SPACING } from "../theme.js";

interface StatusBarProps {
  model: string;
  tokens: number;
  sessionId: string;
}

function formatTokens(n: number): string {
  return n.toLocaleString();
}

export function StatusBar({ model, tokens, sessionId }: StatusBarProps) {
  const shortId = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
  const formattedTokens = formatTokens(tokens);

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
          <Text>{formattedTokens}</Text>
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

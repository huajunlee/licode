import React from "react";
import { Box, Text } from "ink";
import type { VisibleItem } from "./use-session-selector.js";
import type { SessionInfo } from "./use-session-selector.js";

interface SessionListProps {
  visibleItems: VisibleItem<SessionInfo>[];
  totalCount: number;
  windowStart: number;
}

export function SessionList({ visibleItems, totalCount, windowStart }: SessionListProps) {
  if (visibleItems.length === 0) return null;

  const truncatedTop = windowStart > 0;
  const truncatedBottom = windowStart + visibleItems.length < totalCount;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>历史会话 (↑↓ 选择, Enter 进入):</Text>
      {truncatedTop && (
        <Box marginLeft={2}>
          <Text dimColor>... 上方还有 {windowStart} 个会话</Text>
        </Box>
      )}
      {visibleItems.map(({ item: s, isCursor }) => (
        <Box key={s.id} marginLeft={2}>
          <Text color={isCursor ? "green" : undefined}>
            {isCursor ? "> " : "  "}
            {s.id} · {s.model} · {s.messageCount} 条消息 ·{" "}
            {new Date(s.updatedAt).toLocaleDateString()}
            {s.title ? ` · ${s.title}` : ""}
          </Text>
        </Box>
      ))}
      {truncatedBottom && (
        <Box marginLeft={2}>
          <Text dimColor>
            ... 下方还有 {totalCount - windowStart - visibleItems.length} 个会话
          </Text>
        </Box>
      )}
    </Box>
  );
}

import React from "react";
import { Box, Text, useStdout } from "ink";
import type { VisibleItem } from "./use-session-selector.js";
import type { SessionInfo } from "./use-session-selector.js";
import { formatSessionRow } from "./session-row.js";
import { COLORS, ICONS } from "../theme.js";

interface SessionListProps {
  visibleItems: VisibleItem<SessionInfo>[];
  totalCount: number;
  windowStart: number;
  /** Whether the "+ 新建会话" virtual item is active */
  showCreateNew?: boolean;
  /** Is the cursor currently on the new-session item? */
  isOnNewSession?: boolean;
}

export function SessionList({
  visibleItems,
  totalCount,
  windowStart,
  showCreateNew = false,
  isOnNewSession = false,
}: SessionListProps) {
  const { stdout } = useStdout();
  // App padding (1 col each side) + list indent (2 cols each side)
  const width = (stdout?.columns ?? 80) - 6;
  const now = new Date();

  const truncatedTop = windowStart > 0;
  const truncatedBottom = windowStart + visibleItems.length < totalCount;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginLeft={2} marginBottom={1}>
        <Text color={COLORS.faint}>最近会话</Text>
      </Box>

      {showCreateNew && (
        <Box marginLeft={2}>
          <Text color={isOnNewSession ? COLORS.accent : undefined} bold={isOnNewSession}>
            {isOnNewSession ? `${ICONS.prompt} ` : "  "}
            {ICONS.newSession} 新建会话
          </Text>
        </Box>
      )}

      {truncatedTop && (
        <Box marginLeft={2}>
          <Text color={COLORS.faint}>… 上方还有 {windowStart} 个会话</Text>
        </Box>
      )}

      {visibleItems.map(({ item: s, isCursor }) => {
        const row = formatSessionRow(s, width, now);
        return (
          <Box key={s.id} marginLeft={2}>
            <Text color={isCursor ? COLORS.accent : undefined} bold={isCursor}>
              {isCursor ? `${ICONS.prompt} ` : "  "}
              <Text color={COLORS.faint} bold={false}>{row.idText}</Text>
              {"   "}
              {row.titleText}
              {" ".repeat(row.titlePad + 2)}
              <Text color={COLORS.faint} bold={false}>{row.rightText}</Text>
            </Text>
          </Box>
        );
      })}

      {truncatedBottom && (
        <Box marginLeft={2}>
          <Text color={COLORS.faint}>
            … 下方还有 {totalCount - windowStart - visibleItems.length} 个会话
          </Text>
        </Box>
      )}
    </Box>
  );
}

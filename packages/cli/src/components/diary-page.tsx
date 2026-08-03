import React from "react";
import { Box, Text } from "ink";
import { COLORS } from "../theme.js";
import { InputBox } from "./input-box.js";
import type { Segment } from "@licode/core";

interface DiaryPageProps {
  date: string;
  segments: Segment[];
  commandMessage: string | null;
  onSubmit: (input: string) => Promise<void>;
  loading: boolean;
  slashCommands: Array<{ name: string; description: string }>;
}

export function DiaryPage({
  date,
  segments,
  commandMessage,
  onSubmit,
  loading,
  slashCommands,
}: DiaryPageProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={COLORS.diaryAccent}
      paddingX={1}
      marginTop={1}
    >
      <Text color={COLORS.diaryAccent}>✎ 日记 · {date}</Text>
      {commandMessage && (
        <Text color={COLORS.success}>{commandMessage}</Text>
      )}
      <Box flexDirection="column" marginTop={1} marginLeft={2}>
        {segments.map((s, i) => (
          <Text key={i}>{s.content}</Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <InputBox
          onSubmit={onSubmit}
          loading={loading}
          slashCommands={slashCommands}
          diaryMode={true}
        />
      </Box>
    </Box>
  );
}

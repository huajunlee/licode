import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { formatToolLine, truncate } from "./tool-line.js";
import type { ToolCallState } from "./tool-line.js";
import { COLORS, ICONS } from "../theme.js";

export type { ToolCallStatus, ToolCallState } from "./tool-line.js";

interface ToolCallCardProps extends ToolCallState {
  /** Braille frame shown next to running tools */
  spinnerFrame?: string;
}

export function ToolCallCard({
  toolName,
  status,
  detail,
  result,
  spinnerFrame,
}: ToolCallCardProps) {
  const line = formatToolLine({ toolName, status, detail, result });

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={line.color}>{line.icon} </Text>
        <Text bold>{line.name}</Text>
        {line.detail !== "" && <Text color={COLORS.muted}>  {line.detail}</Text>}
        {status === "done" && <Text color={COLORS.success}> {ICONS.inlineOk}</Text>}
        {line.summary !== "" && <Text color={COLORS.muted}> {line.summary}</Text>}
        {status === "running" && (
          <Text color={COLORS.muted}> 运行中 {spinnerFrame ?? ""}</Text>
        )}
      </Box>
      {status === "error" && result && (
        <Box marginLeft={4}>
          <Text color={COLORS.error}>{truncate(result, 200)}</Text>
        </Box>
      )}
    </Box>
  );
}

export function ToolCallCards({ calls }: { calls: ToolCallState[] }) {
  const [frame, setFrame] = useState(0);
  const anyRunning = calls.some((c) => c.status === "running");

  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(
      () => setFrame((f) => (f + 1) % ICONS.spinnerFrames.length),
      100
    );
    return () => clearInterval(timer);
  }, [anyRunning]);

  if (calls.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={1} marginLeft={2}>
      {calls.map((call, i) => (
        <ToolCallCard
          key={`${call.toolName}-${i}`}
          {...call}
          spinnerFrame={ICONS.spinnerFrames[frame]}
        />
      ))}
    </Box>
  );
}

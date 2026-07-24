import React from "react";
import { Box, Text } from "ink";

export type ToolCallStatus = "pending" | "running" | "done" | "error";

export interface ToolCallState {
  toolName: string;
  status: ToolCallStatus;
  detail?: string;
  result?: string;
}

interface ToolCallCardProps {
  toolName: string;
  status: ToolCallStatus;
  detail?: string;
  result?: string;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

const STATUS_ICONS: Record<ToolCallStatus, string> = {
  pending: "⏳",
  running: "⚙",
  done: "✓",
  error: "✗",
};

const STATUS_COLORS: Record<ToolCallStatus, string | undefined> = {
  pending: "yellow",
  running: "cyan",
  done: "green",
  error: "red",
};

export function ToolCallCard({
  toolName,
  status,
  detail,
  result,
}: ToolCallCardProps) {
  const icon = STATUS_ICONS[status];
  const color = STATUS_COLORS[status];
  const borderColor = status === "error" ? "red" : "blue";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      marginBottom={1}
    >
      <Box>
        <Text color={color}>
          {icon} {toolName}
        </Text>
        {detail && <Text dimColor> {truncate(detail, 80)}</Text>}
      </Box>
      {status === "done" && result && (
        <Box marginTop={1}>
          <Text dimColor>{truncate(result, 200)}</Text>
        </Box>
      )}
      {status === "error" && result && (
        <Box marginTop={1}>
          <Text color="red">{truncate(result, 200)}</Text>
        </Box>
      )}
    </Box>
  );
}

export function ToolCallCards({ calls }: { calls: ToolCallState[] }) {
  if (calls.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {calls.map((call, i) => (
        <ToolCallCard
          key={`${call.toolName}-${i}`}
          toolName={call.toolName}
          status={call.status}
          detail={call.detail}
          result={call.result}
        />
      ))}
    </Box>
  );
}

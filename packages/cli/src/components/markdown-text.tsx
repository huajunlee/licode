import React from "react";
import { Box, Text } from "ink";
import { buildViewModel, type MdSpan } from "./markdown.js";
import { COLORS } from "../theme.js";

interface MarkdownTextProps {
  children: string;
}

function spanColor(span: MdSpan): string | undefined {
  if (span.accent) return COLORS.accent;
  if (span.muted) return COLORS.muted;
  if (span.faint) return COLORS.faint;
  return undefined;
}

export function MarkdownText({ children }: MarkdownTextProps) {
  const lines = buildViewModel(children);
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Box key={i} marginLeft={line.indent}>
          <Text>
            {line.spans.map((span, j) => (
              <Text
                key={j}
                color={spanColor(span)}
                bold={span.bold}
                italic={span.italic}
              >
                {span.text}
              </Text>
            ))}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

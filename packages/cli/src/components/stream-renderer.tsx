import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { MarkdownText } from "./markdown-text.js";
import { COLORS } from "../theme.js";

interface StreamRendererProps {
  text: string;
}

export function StreamRenderer({ text }: StreamRendererProps) {
  const [showCursor, setShowCursor] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setShowCursor((prev) => !prev);
    }, 500);
    return () => clearInterval(interval);
  }, []);

  if (!text) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <MarkdownText>{text}</MarkdownText>
      {showCursor && <Text color={COLORS.accent}>█</Text>}
    </Box>
  );
}

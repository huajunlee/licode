import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
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
    <Box marginBottom={1}>
      <Text>
        {text}
        {showCursor && <Text color={COLORS.accent}>█</Text>}
      </Text>
    </Box>
  );
}

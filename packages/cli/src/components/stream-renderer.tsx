import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";

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
        {showCursor && <Text color="blue">█</Text>}
      </Text>
    </Box>
  );
}

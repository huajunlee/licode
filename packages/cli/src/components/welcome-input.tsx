import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { COLORS } from "../theme.js";

interface WelcomeInputProps {
  onSubmit: (input: string) => void;
}

export function WelcomeInput({ onSubmit }: WelcomeInputProps) {
  const [value, setValue] = useState("");

  const handleSubmit = (text: string) => {
    onSubmit(text);
  };

  return (
    <Box marginTop={1}>
      <Text color={COLORS.primary}>{"> "}</Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder="--session <id> 或直接 Enter"
      />
    </Box>
  );
}

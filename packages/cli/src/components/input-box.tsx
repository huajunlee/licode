import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

interface InputBoxProps {
  onSubmit: (input: string) => Promise<void>;
  loading: boolean;
}

export function InputBox({ onSubmit, loading }: InputBoxProps) {
  const [value, setValue] = useState("");

  const handleSubmit = (text: string) => {
    if (!text.trim() || loading) return;
    onSubmit(text);
    setValue("");
  };

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="green">{"> "}</Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
        />
        {loading && <Text color="yellow"> ⏳</Text>}
      </Box>
      <Box>
        <Text dimColor>
          {loading ? "等待回复完成..." : "Enter 发送 · Ctrl+C 退出"}
        </Text>
      </Box>
    </Box>
  );
}

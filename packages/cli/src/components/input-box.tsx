import React, { useState, useRef } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { navigateHistory, pushHistory } from "./history-navigator.js";

interface InputBoxProps {
  onSubmit: (input: string) => Promise<void>;
  loading: boolean;
  disabled?: boolean;
}

export function InputBox({ onSubmit, loading, disabled }: InputBoxProps) {
  const [value, setValue] = useState("");
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number>(0);

  const handleSubmit = (text: string) => {
    if (!text.trim() || loading) return;
    if (disabled) return;
    historyRef.current = pushHistory(historyRef.current, text);
    historyIndexRef.current = historyRef.current.length;
    onSubmit(text);
    setValue("");
  };

  // Shell-style ↑↓ history navigation
  useInput(
    (_input, key) => {
      if (disabled || loading) return;
      if (key.upArrow) {
        const result = navigateHistory(
          historyRef.current,
          historyIndexRef.current,
          "up"
        );
        historyIndexRef.current = result.newIndex;
        setValue(result.text);
      } else if (key.downArrow) {
        const result = navigateHistory(
          historyRef.current,
          historyIndexRef.current,
          "down"
        );
        historyIndexRef.current = result.newIndex;
        setValue(result.text);
      }
    },
    { isActive: !disabled }
  );

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={disabled ? "dim" : "green"}>{"> "}</Text>
        <TextInput
          value={value}
          onChange={(v) => {
            setValue(v);
            // When user types manually, reset history cursor to end
            if (historyIndexRef.current !== historyRef.current.length) {
              historyIndexRef.current = historyRef.current.length;
            }
          }}
          onSubmit={handleSubmit}
        />
        {loading && <Text color="yellow"> ⏳</Text>}
      </Box>
      <Box>
        <Text dimColor>
          {loading
            ? "等待回复完成..."
            : disabled
            ? "Ctrl+↑↓ 查看推理 · Enter 收起"
            : "Enter 发送 · ↑↓ 历史 · Ctrl+C 退出"}
        </Text>
      </Box>
    </Box>
  );
}

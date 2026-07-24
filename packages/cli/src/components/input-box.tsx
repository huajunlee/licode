import React, { useState, useRef, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { navigateHistory, pushHistory } from "./history-navigator.js";

interface InputBoxProps {
  onSubmit: (input: string) => Promise<void>;
  loading: boolean;
  disabled?: boolean;
  /** Available slash commands and skills for autocomplete */
  slashCommands?: Array<{ name: string; description: string }>;
}

export function InputBox({
  onSubmit,
  loading,
  disabled,
  slashCommands = [],
}: InputBoxProps) {
  const [value, setValue] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number>(0);

  // Filter matching commands based on input
  const suggestions = useMemo(() => {
    if (!value.startsWith("/")) return [];
    const query = value.slice(1).toLowerCase();
    return slashCommands
      .filter((cmd) => cmd.name.toLowerCase().includes(query))
      .slice(0, 8);
  }, [value, slashCommands]);

  const showSuggestions = suggestions.length > 0;

  const completeSuggestion = () => {
    if (suggestions.length === 0) return;
    const idx = Math.min(selectedIndex, suggestions.length - 1);
    setValue(suggestions[idx].name + " ");
    setSelectedIndex(0);
  };

  const handleSubmit = (text: string) => {
    if (!text.trim() || loading) return;
    if (disabled) return;
    historyRef.current = pushHistory(historyRef.current, text);
    historyIndexRef.current = historyRef.current.length;
    onSubmit(text);
    setValue("");
    setSelectedIndex(0);
  };

  // Arrow keys: navigate suggestions when showing, otherwise navigate history
  useInput(
    (_input, key) => {
      if (disabled || loading) return;

      if (showSuggestions) {
        if (key.upArrow) {
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          return;
        }
        if (key.downArrow) {
          setSelectedIndex((prev) =>
            Math.min(prev + 1, suggestions.length - 1)
          );
          return;
        }
        if (key.tab || _input === "\t") {
          completeSuggestion();
          return;
        }
        // For any other key in suggestion mode, don't process as history
        return;
      }

      // Normal mode: ↑↓ history navigation
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
      {showSuggestions && (
        <Box
          flexDirection="column"
          marginBottom={1}
          borderStyle="single"
          borderColor="dim"
          paddingX={1}
        >
          {suggestions.map((cmd, i) => {
            const isSelected = i === selectedIndex;
            return (
              <Box key={cmd.name}>
                <Text color={isSelected ? "cyan" : undefined}>
                  {isSelected ? "❯ " : "  "}
                  <Text bold={isSelected}>{cmd.name}</Text>
                  {"  "}
                  <Text dimColor={!isSelected}>
                    {cmd.description.length > 60
                      ? cmd.description.slice(0, 60) + "…"
                      : cmd.description}
                  </Text>
                </Text>
              </Box>
            );
          })}
        </Box>
      )}
      <Box>
        <Text color={disabled ? "dim" : "green"}>{"> "}</Text>
        <TextInput
          value={value}
          onChange={(v) => {
            // Strip tab characters and trigger completion instead
            if (v.includes("\t")) {
              completeSuggestion();
              return;
            }
            setValue(v);
            // Reset suggestion index when input changes
            setSelectedIndex(0);
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
            : showSuggestions
            ? "Tab 补全 · ↑↓ 选择 · Enter 发送 · 继续输入以过滤"
            : "Enter 发送 · ↑↓ 历史 · / 查看命令 · Ctrl+C 退出"}
        </Text>
      </Box>
    </Box>
  );
}

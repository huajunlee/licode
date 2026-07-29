import React, { useState, useEffect } from "react";
import { Text } from "ink";
import { ICONS } from "../theme.js";

/**
 * Bottom indicator shown while a memory dream consolidation runs in the
 * background. Mirrors WaitingIndicator's spinner; disappears when isDreaming
 * becomes false.
 */
export function DreamIndicator() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % ICONS.spinnerFrames.length);
    }, 100);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text dimColor>
      {ICONS.spinnerFrames[frame]} 🌙 记忆整理中...
    </Text>
  );
}

import React, { useState, useEffect, useRef } from "react";
import { Text } from "ink";
import { ICONS } from "../theme.js";

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

interface WaitingIndicatorProps {
  isActive: boolean;
}

export function WaitingIndicator({ isActive }: WaitingIndicatorProps) {
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(0);

  useEffect(() => {
    if (!isActive) {
      // Reset state when hidden, so next activation starts fresh.
      setFrame(0);
      setElapsed(0);
      return;
    }
    startRef.current = Date.now();
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % ICONS.spinnerFrames.length);
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 100);
    return () => clearInterval(timer);
  }, [isActive]);

  if (!isActive) return null;

  return (
    <Text dimColor>
      {ICONS.spinnerFrames[frame]} 等待中 · {formatElapsed(elapsed)}
    </Text>
  );
}

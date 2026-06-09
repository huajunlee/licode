export function navigateHistory(
  history: string[],
  currentIndex: number,
  direction: "up" | "down"
): { newIndex: number; text: string } {
  const len = history.length;
  if (len === 0) return { newIndex: 0, text: "" };

  if (direction === "up") {
    const newIndex = Math.max(currentIndex - 1, 0);
    return { newIndex, text: history[newIndex] };
  }
  // down — move toward len, beyond last entry = empty input
  const newIndex = Math.min(currentIndex + 1, len);
  if (newIndex >= len) return { newIndex: len, text: "" };
  return { newIndex, text: history[newIndex] };
}

export function pushHistory(history: string[], input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) return history;
  // Deduplicate consecutive identical entries
  if (history.length > 0 && history[history.length - 1] === trimmed)
    return history;
  return [...history, trimmed];
}

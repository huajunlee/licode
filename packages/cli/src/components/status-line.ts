export function formatTokens(n: number): string {
  return n.toLocaleString();
}

export function formatStatusWide(
  model: string,
  tokens: number,
  sessionId: string,
  contextWindow: number = 0
): string {
  const tok =
    contextWindow > 0
      ? `${formatTokens(tokens)} tok (${Math.round((tokens / contextWindow) * 100)}%)`
      : `${formatTokens(tokens)} tok`;
  return `${model} · ${tok} · ${sessionId.slice(0, 8)}`;
}

export function formatStatusNarrow(model: string, tokens: number): string {
  return `${model} · ${formatTokens(tokens)} tok`;
}

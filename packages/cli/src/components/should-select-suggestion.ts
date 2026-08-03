/**
 * Decide whether Enter, pressed while the suggestion panel is open,
 * should select the highlighted suggestion (true) instead of sending (false).
 * Panel-open = input starts with "/" and at least one suggestion matches.
 */
export function shouldSelectSuggestion(
  value: string,
  suggestions: { name: string }[]
): boolean {
  return value.startsWith("/") && suggestions.length > 0;
}

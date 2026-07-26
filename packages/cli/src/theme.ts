/**
 * LICode Theme System
 *
 * Central design tokens for all terminal UI components.
 * Every visual constant in the app is defined here.
 * Components import from this file instead of using hardcoded strings.
 */

// ---- Semantic Color Palette ----
// All colors use Ink v5 named color strings.
// No hex values are used to ensure maximum terminal compatibility.

export const COLORS = {
  /** User messages, selected items, prompt arrow, success states */
  primary: "green",
  /** Success status */
  success: "green",
  /** Warning, pending status, loading spinner, command messages */
  warning: "yellow",
  /** Error messages, failed tools */
  error: "red",
  /** Focused accordion items, running tools, selected suggestions */
  info: "cyan",
  /** Stream cursor, tool card neutral border, emphasis */
  accent: "blue",

  /** ToolCallCard status-specific colors */
  toolPending: "yellow",
  toolRunning: "cyan",
  toolDone: "green",
  toolError: "red",
  toolCardBorder: "blue",
  toolCardBorderError: "red",
} as const;

// ---- Border Styles ----
// Standardized border types by usage context.

export const BORDERS = {
  /** Popups, dropdowns, suggestion panels, status bar */
  popup: "single",
  /** Cards, tool call displays */
  card: "round",
} as const;

// ---- Spacing ----
// Consistent spacing values for Ink Box props.

export const SPACING = {
  /** Tight gap: icon-to-text, inline padding */
  xs: 1,
  /** Section marginBottom, card padding */
  sm: 1,
  /** Element gap between items in a row, marginY */
  md: 2,
  /** Deep indent for expanded content */
  lg: 4,
} as const;

// ---- Icons ----
// Central registry of emoji/unicode icons.
// Change them here to update everywhere.

export const ICONS = {
  prompt: "> ",
  selected: "❯ ",
  expand: "▸ ",
  success: "✓",
  error: "✗",
  pending: "⏳",
  running: "⚙",
  newSession: "🆕",
  spinner: "⏳",
  thinking: "🤔",

  /** Braille spinner animation frames (10 frames) */
  spinnerFrames: [
    "⠋",
    "⠙",
    "⠹",
    "⠸",
    "⠼",
    "⠴",
    "⠦",
    "⠧",
    "⠇",
    "⠏",
  ] as readonly string[],
} as const;

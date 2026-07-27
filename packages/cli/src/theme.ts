/**
 * LICode Theme System
 *
 * Central design tokens for all terminal UI components.
 * Every visual constant in the app is defined here.
 * Components import from this file instead of using hardcoded strings.
 */

// ---- Semantic Color Palette ----
// Truecolor hex values. chalk (used by Ink) degrades automatically
// to 256/16-color terminals — no manual fallback needed.

export const COLORS = {
  /** Warm amber: prompt ❯, selection, inline code, running state, banner */
  accent: "#E5A567",
  /** Primary body text */
  text: "#C8CCD8",
  /** Secondary text: labels, tool details, summaries */
  muted: "#8A8F9E",
  /** Weakest: help lines, separators, session ids, status bar */
  faint: "#565B68",
  /** Tool done ●, inline ✓ */
  success: "#9ECE6A",
  /** Command messages */
  warning: "#E0AF68",
  /** Errors, failed tools ✗ */
  error: "#F7768E",

  // ---- Legacy aliases (transitional — removed in final cleanup task) ----
  /** @deprecated use accent */ primary: "#E5A567",
  /** @deprecated use accent */ info: "#E5A567",
  /** @deprecated use muted */ toolPending: "#8A8F9E",
  /** @deprecated use accent */ toolRunning: "#E5A567",
  /** @deprecated use success */ toolDone: "#9ECE6A",
  /** @deprecated use error */ toolError: "#F7768E",
  /** @deprecated use faint */ toolCardBorder: "#565B68",
  /** @deprecated use error */ toolCardBorderError: "#F7768E",
} as const;

// ---- Icons ----
// Geometric unicode only — no emoji. Width-stable across terminals.

export const ICONS = {
  /** Input prompt, selection cursor, user message prefix */
  prompt: "❯",
  /** Assistant turn marker */
  assistant: "◆",
  toolDone: "●",
  toolRunning: "◐",
  toolPending: "○",
  toolError: "✗",
  inlineOk: "✓",
  /** Focused thinking-accordion item */
  expand: "▸",
  /** Fullwidth plus — aligns with CJK text */
  newSession: "＋",
  /** Code block / quote left border */
  codeBorder: "│",
  /** Separator line unit */
  separator: "─",

  /** Braille spinner animation frames (10 frames) */
  spinnerFrames: [
    "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
  ] as readonly string[],

  // ---- Legacy aliases (transitional — removed in final cleanup task) ----
  /** @deprecated use toolPending */ pending: "○",
  /** @deprecated use toolRunning */ running: "◐",
  /** @deprecated use toolDone */ success: "●",
  /** @deprecated use toolError */ error: "✗",
} as const;

// ---- Legacy exports (transitional — removed in final cleanup task) ----

/** @deprecated borders are being removed from the design */
export const BORDERS = { popup: "single", card: "round" } as const;

/** @deprecated use inline spacing values */
export const SPACING = { xs: 1, sm: 1, md: 2, lg: 4 } as const;

/**
 * ASCII art banner printed on the welcome screen (Spring Boot style).
 * Pure ASCII, equal-width lines, safe for narrow terminals.
 */

const RAW_LINES = [
  " _      ___   ____           _",
  "| |    |_ _| / ___|___    __| | ___",
  "| |     | | | |   / _ \\  / _` |/ _ \\",
  "| |___  | | | |__| (_) || (_| |  __/",
  "|_____|___| \\____\\___/  \\__,_|\\___|",
] as const;

const WIDTH = Math.max(...RAW_LINES.map((l) => l.length));

/** Equal-width banner lines, right-padded with spaces. */
export const BANNER_LINES: readonly string[] = RAW_LINES.map((l) =>
  l.padEnd(WIDTH)
);

export const TAGLINE = "终端里的 AI 编程伙伴";

import { relativeTime } from "./relative-time.js";

export interface SessionRowData {
  id: string;
  title?: string;
  summary?: string;
  messageCount: number;
  updatedAt: string;
}

export interface SessionRow {
  /** 8-char short id - render faint */
  idText: string;
  /** Title / summary / placeholder, truncated to fit - render normal */
  titleText: string;
  /** "N 条 · 3 天前" - render faint, right-aligned */
  rightText: string;
  /** Spaces to pad after titleText so rightText lands right-aligned */
  titlePad: number;
}

function charWidth(cp: number): number {
  if (cp >= 0x2e80 && cp <= 0x9fff) return 2; // CJK radicals .. CJK unified
  if (cp >= 0xf900 && cp <= 0xfaff) return 2; // CJK compat ideographs
  if (cp >= 0xff00 && cp <= 0xff60) return 2; // fullwidth forms
  if (cp >= 0x20000) return 2; // CJK ext B and beyond
  return 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch.codePointAt(0)!);
  return width;
}

export function truncateToWidth(text: string, maxCols: number): string {
  if (displayWidth(text) <= maxCols) return text;
  let result = "";
  let width = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0)!);
    if (width + w > maxCols - 1) break; // reserve 1 column for …
    result += ch;
    width += w;
  }
  return result + "…";
}

const ID_GAP = 3; // columns between id and title
const RIGHT_GAP = 2; // columns between title and right column

export function formatSessionRow(
  session: SessionRowData,
  width: number,
  now: Date
): SessionRow {
  const idText = session.id.slice(0, 8);
  const rightText = `${session.messageCount} 条 · ${relativeTime(session.updatedAt, now)}`;
  const rawTitle = session.title?.trim() || session.summary || "（无消息）";
  const titleCols = Math.max(
    1,
    width - idText.length - ID_GAP - RIGHT_GAP - displayWidth(rightText)
  );
  const titleText = truncateToWidth(rawTitle, titleCols);
  const titlePad = titleCols - displayWidth(titleText);
  return { idText, titleText, rightText, titlePad };
}

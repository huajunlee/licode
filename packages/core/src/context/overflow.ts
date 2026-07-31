import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolResult } from "../tools/types.js";

export interface OverflowOptions {
  workingDirectory: string;
  maxInlineBytes?: number;
}

const PREVIEW_LINES = 50;
const PREVIEW_MAX_BYTES = 4096;

/**
 * If `content` fits `maxInlineBytes` (default 64KB), return it inline.
 * Otherwise spill the full content to `.licode/overflow/<ts>-<rand>.txt` and
 * return a pointer + a small head preview + line/byte counts + a paging hint,
 * so the model can decide whether and how to recover the full output via Read
 * (offset/limit) instead of flooding the context.
 */
export async function overflowToolResult(
  content: string,
  options: OverflowOptions
): Promise<ToolResult> {
  const maxInlineBytes = options.maxInlineBytes ?? 64 * 1024;
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes <= maxInlineBytes) {
    return { status: "success", content };
  }

  const dir = path.join(options.workingDirectory, ".licode", "overflow");
  await fs.promises.mkdir(dir, { recursive: true });
  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  const filePath = path.join(dir, fileName);
  await fs.promises.writeFile(filePath, content, "utf-8");
  const relativePath = path.relative(options.workingDirectory, filePath);

  const lines = content.split("\n");
  const lineCount = lines.length;
  const previewLines = lines.slice(0, PREVIEW_LINES);
  let preview = previewLines.join("\n");
  // Byte-cap the preview so a single huge line can't flood the pointer.
  if (Buffer.byteLength(preview, "utf-8") > PREVIEW_MAX_BYTES) {
    preview =
      Buffer.from(preview, "utf-8").subarray(0, PREVIEW_MAX_BYTES).toString("utf-8") + "…";
  }

  const pointer = [
    `Tool output exceeded inline limit (${bytes} bytes, ${lineCount} lines). Full output written to ${relativePath}.`,
    `First ${previewLines.length} lines:`,
    preview,
    `... use Read with offset/limit on ${relativePath} to page through the full output.`,
  ].join("\n");

  return {
    status: "success",
    content: pointer,
    metadata: { overflowPath: filePath, bytes, lines: lineCount },
  };
}

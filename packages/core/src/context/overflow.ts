import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolResult } from "../tools/types.js";

export interface OverflowOptions {
  workingDirectory: string;
  maxInlineBytes?: number;
}

export async function overflowToolResult(
  content: string,
  options: OverflowOptions
): Promise<ToolResult> {
  const maxInlineBytes = options.maxInlineBytes ?? 64 * 1024;
  if (Buffer.byteLength(content, "utf-8") <= maxInlineBytes) {
    return { status: "success", content };
  }

  const dir = path.join(options.workingDirectory, ".licode", "overflow");
  await fs.promises.mkdir(dir, { recursive: true });
  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  const filePath = path.join(dir, fileName);
  await fs.promises.writeFile(filePath, content, "utf-8");
  const relativePath = path.relative(options.workingDirectory, filePath);

  return {
    status: "success",
    content: `Tool output exceeded inline limit. Full output written to ${relativePath}.`,
    metadata: { overflowPath: filePath },
  };
}

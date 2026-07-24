import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool } from "../types.js";

const ReadParams = z.object({
  file_path: z.string().describe("Absolute path to the file to read"),
  offset: z.number().optional().describe("Line number to start reading from"),
  limit: z.number().optional().describe("Number of lines to read"),
});

export const readTool: Tool<typeof ReadParams> = {
  name: "Read",
  description:
    "Reads a file from the local filesystem. Returns content with line numbers " +
    "(cat -n format). Supports offset and limit for partial reads.",
  parameters: ReadParams,

  async execute(input, context) {
    const filePath = path.resolve(context.workingDirectory, input.file_path);

    if (!fs.existsSync(filePath)) {
      return {
        status: "error",
        error: `File not found: ${input.file_path}`,
        errorType: "execution",
      };
    }

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      const start = input.offset ?? 0;
      const end = input.limit ? start + input.limit : lines.length;
      const selected = lines.slice(start, end);

      const formatted = selected
        .map((line, i) => {
          const lineNum = String(start + i + 1).padStart(6, " ");
          return `${lineNum}\t${line}`;
        })
        .join("\n");

      return {
        status: "success",
        content: formatted || "(empty file)",
      };
    } catch (err) {
      return {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        errorType: "execution",
      };
    }
  },
};

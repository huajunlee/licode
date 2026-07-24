import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool } from "../types.js";

const WriteParams = z.object({
  file_path: z.string().describe("Absolute path to the file to write"),
  content: z.string().describe("Content to write to the file"),
});

export const writeTool: Tool<typeof WriteParams> = {
  name: "Write",
  description:
    "Writes a file to the local filesystem. Creates parent directories if needed. " +
    "Use for creating new files or overwriting existing ones.",
  parameters: WriteParams,

  async execute(input, context) {
    const filePath = path.resolve(context.workingDirectory, input.file_path);

    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(filePath, input.content, "utf-8");
      const bytes = Buffer.byteLength(input.content, "utf-8");

      return {
        status: "success",
        content: `Wrote ${bytes} bytes to ${input.file_path}`,
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

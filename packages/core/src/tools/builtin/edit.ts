import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool } from "../types.js";

const EditParams = z.object({
  file_path: z.string().describe("Absolute path to the file to edit"),
  old_string: z.string().describe("The exact text to replace"),
  new_string: z.string().describe("The replacement text"),
  replace_all: z
    .boolean()
    .optional()
    .default(false)
    .describe("Replace all occurrences instead of just the first"),
});

export const editTool: Tool<typeof EditParams> = {
  name: "Edit",
  description:
    "Performs exact string replacements in a file. " +
    "When replace_all is false, old_string must match exactly once. " +
    "Use for precise, surgical edits.",
  parameters: EditParams,

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

      if (input.replace_all) {
        const count = content.split(input.old_string).length - 1;
        if (count === 0) {
          return {
            status: "error",
            error: `String not found in file: "${input.old_string.slice(0, 100)}"`,
            errorType: "execution",
          };
        }
        const newContent = content.split(input.old_string).join(input.new_string);
        fs.writeFileSync(filePath, newContent, "utf-8");
        return {
          status: "success",
          content: `Replaced ${count} occurrence(s) in ${input.file_path}`,
        };
      }

      const firstIndex = content.indexOf(input.old_string);
      if (firstIndex === -1) {
        return {
          status: "error",
          error: `String not found in file: "${input.old_string.slice(0, 100)}"`,
          errorType: "execution",
        };
      }

      const secondIndex = content.indexOf(
        input.old_string,
        firstIndex + input.old_string.length
      );
      if (secondIndex !== -1) {
        return {
          status: "error",
          error:
            `Found multiple occurrences of the string. Use replace_all: true ` +
            `to replace all, or provide more context to make the match unique.`,
          errorType: "execution",
        };
      }

      const newContent =
        content.slice(0, firstIndex) +
        input.new_string +
        content.slice(firstIndex + input.old_string.length);

      fs.writeFileSync(filePath, newContent, "utf-8");
      return {
        status: "success",
        content: `Replaced 1 occurrence in ${input.file_path}`,
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

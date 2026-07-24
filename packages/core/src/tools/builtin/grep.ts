import { z } from "zod";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "../types.js";

const execAsync = promisify(exec);

const GrepParams = z.object({
  pattern: z.string().describe("The regex pattern to search for"),
  path: z.string().optional().describe("Base directory or file path for the search"),
  include: z.string().optional().describe("File glob pattern to filter (e.g., *.ts)"),
});

export const grepTool: Tool<typeof GrepParams> = {
  name: "Grep",
  description:
    "Searches for a regex pattern in files. " +
    "Returns matching lines with file path, line number, and content. " +
    "Use for finding usages, definitions, or patterns in the codebase.",
  parameters: GrepParams,

  async execute(input, context) {
    try {
      const args: string[] = ["-rn", "--color=never"];
      if (input.include) {
        args.push(`--include=${input.include}`);
      }
      args.push(input.pattern);
      if (input.path) args.push(input.path);
      else args.push(context.workingDirectory);

      const { stdout } = await execAsync(`grep ${args.map((a) => JSON.stringify(a)).join(" ")}`, {
        cwd: context.workingDirectory,
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const truncated =
        stdout.length > 10000 ? stdout.slice(0, 10000) + "\n... (truncated)" : stdout;
      return {
        status: "success",
        content: truncated || "(no matches)",
      };
    } catch (err: unknown) {
      const e = err as Error & { stdout?: string; stderr?: string; code?: number };
      // grep exits with code 1 when no matches found
      if (e.code === 1) {
        return {
          status: "success",
          content: "(no matches)",
        };
      }
      return {
        status: "error",
        error: e.stderr || e.message,
        errorType: "execution",
      };
    }
  },
};

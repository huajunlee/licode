import { z } from "zod";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "../types.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const BashParams = z.object({
  command: z.string().describe("The bash command to execute"),
  timeout: z
    .number()
    .optional()
    .default(120000)
    .describe("Timeout in milliseconds"),
});

export const bashTool: Tool<typeof BashParams> = {
  name: "Bash",
  description:
    "Executes a bash command in the working directory. " +
    "Use for running tests, building, installing dependencies, " +
    "git operations, and file system queries.",
  parameters: BashParams,
  requiresApproval: true,

  async execute(input, context) {
    try {
      const wrapped = context.sandbox?.wrapCommand(input.command);
      const execOptions = {
        cwd: context.workingDirectory,
        timeout: input.timeout,
        signal: context.signal,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      };
      const { stdout, stderr } = wrapped
        ? await execFileAsync(wrapped.command, wrapped.args, execOptions)
        : await execAsync(input.command, execOptions);
      return {
        status: "success",
        content: stdout || stderr || "(no output)",
      };
    } catch (err: unknown) {
      const e = err as Error & { stdout?: string; stderr?: string; killed?: boolean };
      if (e.killed) {
        return {
          status: "error",
          error: `Command timed out after ${input.timeout}ms`,
          errorType: "timeout",
        };
      }
      return {
        status: "error",
        error: e.message,
        errorType: "execution",
      };
    }
  },
};

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

/**
 * 失败时塞进 error 的 stdout/stderr 上限。executor 只对 success 做溢出转存
 * （executor.ts:86），错误路径不过那道闸，而 maxBuffer 允许 10MB，
 * 不设上限会把整段输出灌进对话。
 */
const MAX_INLINE_CHARS = 4000;

function clip(text: string): string {
  if (text.length <= MAX_INLINE_CHARS) return text;
  const head = text.slice(0, 3000);
  const tail = text.slice(-1000);
  return `${head}\n…（省略 ${text.length - MAX_INLINE_CHARS} 字符）…\n${tail}`;
}

/**
 * 成功时的 content。
 * 无 stderr 时原样返回 stdout（保持既有行为，`content` 就是命令的标准输出）；
 * 有 stderr 时追加一段，因为警告类信息（git/npm/build 的 warning）以前会被静默丢掉，
 * 模型看不到就只能靠猜。
 */
function composeContent(stdout: string, stderr: string): string {
  if (stderr.trim() === "") return stdout || "(no output)";
  const head = stdout.trimEnd();
  return head ? `${head}\n[stderr]\n${stderr.trimEnd()}` : `[stderr]\n${stderr.trimEnd()}`;
}

/**
 * 失败时的 error。
 * 以前只返回 Node 的 `Command failed: <命令>\n<stderr>`，**成功的 stdout 被整个丢弃**。
 * 而「跑一串诊断命令、其中一条失败」正是最常见的用法，模型于是拿不到任何有用信息、
 * 只能换条命令重试。现在按 退出码 / stdout / stderr 分段如实回报。
 */
function composeFailure(err: {
  stdout?: string;
  stderr?: string;
  code?: number | string;
  message: string;
}): string {
  const stdout = (err.stdout ?? "").trimEnd();
  const stderr = (err.stderr ?? "").trimEnd();
  const code = typeof err.code === "number" ? err.code : null;

  const lines = [code !== null ? `命令以退出码 ${code} 失败` : "命令执行失败"];
  if (stdout) lines.push(`[stdout]\n${clip(stdout)}`);
  if (stderr) lines.push(`[stderr]\n${clip(stderr)}`);
  // stdout 与 stderr 都空时（例如命令自己 2>/dev/null 了），至少回显原始信息
  if (!stdout && !stderr) lines.push(err.message);
  return lines.join("\n");
}

export const bashTool: Tool<typeof BashParams> = {
  name: "Bash",
  description:
    "Executes a bash command in the working directory. " +
    "Use for running tests, building, installing dependencies, " +
    "git operations, and file system queries. " +
    "Reports the exit code plus stdout and stderr separately, so keep `2>/dev/null` off " +
    "unless you truly don't care why a command failed. " +
    "Prefer several small commands over one long `a; b; c` chain: a chain only tells you " +
    "the exit code of its last command.",
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
        content: composeContent(stdout, stderr),
      };
    } catch (err: unknown) {
      const e = err as Error & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        killed?: boolean;
      };
      if (e.killed) {
        return {
          status: "error",
          error: `Command timed out after ${input.timeout}ms`,
          errorType: "timeout",
        };
      }
      return {
        status: "error",
        error: composeFailure(e),
        errorType: "execution",
      };
    }
  },
};

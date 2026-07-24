import { spawn } from "node:child_process";
import * as path from "node:path";
import type { Tool, ToolResult } from "../../tools/types.js";
import type { Skill, SkillToolDef } from "./loader.js";
import { skillParamsToZod } from "./parser.js";
import type { SystemPromptLayer } from "../../conversation/system-prompt.js";

function spawnScript(
  scriptPath: string,
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(scriptPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err: Error) => {
      reject(err);
    });

    proc.on("close", (code: number | null) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 1 });
    });

    if (signal) {
      signal.addEventListener("abort", () => {
        proc.kill();
      });
    }

    proc.stdin!.write(JSON.stringify(input));
    proc.stdin!.end();
  });
}

export function skillToolToAdapter(
  skillTool: SkillToolDef,
  skillDir: string
): Tool {
  return {
    name: `skill__${skillTool.name}`,
    description: skillTool.description,
    parameters: skillParamsToZod(skillTool.parameters),

    async execute(input, context): Promise<ToolResult> {
      const scriptPath = path.resolve(skillDir, skillTool.script);

      try {
        const { stdout, stderr, exitCode } = await spawnScript(
          scriptPath,
          input,
          context.signal
        );

        if (exitCode === 0) {
          return { status: "success", content: stdout || stderr };
        }
        return {
          status: "error",
          error: stderr || stdout || `exit code ${exitCode}`,
          errorType: "execution",
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
}

export function skillToPromptLayer(skill: Skill): SystemPromptLayer {
  return {
    name: `skill:${skill.name}`,
    priority: 15,
    always: false,
    content: skill.description,
  };
}

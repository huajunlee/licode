import { spawn } from "node:child_process";
import * as path from "node:path";
import type { GitResult, WorktreeContext } from "./types.js";

export interface WorktreeManagerConfig {
  repoPath: string;
  worktreeRoot?: string;
  runGit?: (args: string[]) => Promise<GitResult>;
}

function defaultRunGit(repoPath: string): (args: string[]) => Promise<GitResult> {
  return (args) =>
    new Promise((resolve) => {
      const proc = spawn("git", args, { cwd: repoPath });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.on("close", (code) => {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
      proc.on("error", (err) => {
        resolve({ stdout, stderr: err.message, exitCode: 1 });
      });
    });
}

export class WorktreeManager {
  private runGit: (args: string[]) => Promise<GitResult>;
  private root: string;

  constructor(private config: WorktreeManagerConfig) {
    this.root =
      config.worktreeRoot ?? path.join(config.repoPath, ".licode", "worktrees");
    this.runGit = config.runGit ?? defaultRunGit(config.repoPath);
  }

  async create(name: string): Promise<WorktreeContext> {
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "-");
    const worktreePath = path.join(this.root, safeName);
    const branch = `licode/${safeName}`;
    const result = await this.runGit([
      "worktree",
      "add",
      worktreePath,
      "-b",
      branch,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "failed to create worktree");
    }
    return { name: safeName, path: worktreePath, branch };
  }

  async remove(context: WorktreeContext): Promise<void> {
    const result = await this.runGit([
      "worktree",
      "remove",
      context.path,
      "--force",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "failed to remove worktree");
    }
  }
}

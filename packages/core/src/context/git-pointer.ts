import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface RecoveryPointer {
  version: string;
  method: "git" | "spill";
  /** Relative path to the spilled file, set only when method === "spill". */
  spillPath?: string;
}

/**
 * Produce a recoverable pointer for `content`:
 * - In a git repo: `git hash-object -w --stdin` stores the blob and returns its
 *   hash (no commit). Recover via `git cat-file -p <hash>`.
 * - Otherwise: spill the content to `.licode/overflow/<sha1>.txt` and return the
 *   sha1 + relative path. Recover via `read` on the spill path.
 */
export async function getRecoveryPointer(
  content: string,
  workingDirectory: string
): Promise<RecoveryPointer> {
  try {
    const hash = execSync("git hash-object -w --stdin", {
      cwd: workingDirectory,
      input: content,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (/^[0-9a-f]{40}$/.test(hash)) {
      return { version: hash, method: "git" };
    }
  } catch {
    // not a git repo or git unavailable -> fall through to spill
  }
  const hash = crypto.createHash("sha1").update(content, "utf-8").digest("hex");
  const overflowDir = path.join(workingDirectory, ".licode", "overflow");
  await fs.promises.mkdir(overflowDir, { recursive: true });
  const filePath = path.join(overflowDir, `${hash}.txt`);
  await fs.promises.writeFile(filePath, content, "utf-8");
  return { version: hash, method: "spill", spillPath: path.relative(workingDirectory, filePath) };
}

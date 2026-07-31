import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getRecoveryPointer } from "./git-pointer.js";

describe("getRecoveryPointer", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it("spills to .licode/overflow when not a git repo, with a recoverable content hash", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-gp-"));
    const content = "line1\nline2\n";
    const p = await getRecoveryPointer(content, dir);
    expect(p.method).toBe("spill");
    expect(p.spillPath).toBeTruthy();
    const abs = path.join(dir, p.spillPath!);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, "utf-8")).toBe(content);
    // version is the sha1 of the content (40 hex)
    expect(p.version).toMatch(/^[0-9a-f]{40}$/);
  });

  it("uses git blob hash when inside a git repo", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-gp-"));
    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd: dir });
    const p = await getRecoveryPointer("hello", dir);
    expect(p.method).toBe("git");
    expect(p.version).toMatch(/^[0-9a-f]{40}$/);
    expect(p.spillPath).toBeUndefined();
    // the blob is recoverable via git cat-file
    const out = execSync(`git cat-file -p ${p.version}`, { cwd: dir, encoding: "utf-8" });
    expect(out).toBe("hello");
  });
});

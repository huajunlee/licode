import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { grepTool } from "./grep.js";

describe("grepTool", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "licode-grep-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns full output beyond the old 10000-char cap (no lossy truncation)", async () => {
    // ~300 lines × ~40-char output each ≈ 12000 chars: above the old 10000
    // cap, below the 64KB overflow threshold.
    const lines = Array.from({ length: 300 }, (_, i) => `match line ${i}`).join("\n");
    const file = path.join(dir, "big.txt");
    fs.writeFileSync(file, lines, "utf-8");

    const result = await grepTool.execute(
      { pattern: "match", path: file },
      { workingDirectory: dir, sessionId: "" }
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    // No lossy truncation marker anymore.
    expect(result.content).not.toContain("... (truncated)");
    // Full output: first and last matches both present.
    expect(result.content).toContain("match line 0");
    expect(result.content).toContain("match line 299");
  });
});

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationManager } from "../conversation/manager.js";
import { ContextCompressor, splitIntoTurns } from "./compressor.js";
import { overflowToolResult } from "./overflow.js";
import { TokenBudget } from "./token-budget.js";
import type { Message } from "../llm/provider.js";
import type { CompressionAssistResult } from "./summarizer.js";
import { FILE_CHANGE_PREFIX } from "./file-change.js";

/** A duck-typed CompressionAssistant that returns a canned result. */
function fakeAssistant(over: Partial<CompressionAssistResult> = {}): {
  assist: (input: { existingSummary: string | null; turns: unknown[] }) => Promise<CompressionAssistResult>;
} {
  return {
    async assist(input) {
      return {
        updatedSummary: over.updatedSummary ?? `SUMMARY(${input.existingSummary ? "roll" : "new"})`,
        classifications: over.classifications ?? [],
        fileChanges: over.fileChanges ?? [],
      };
    },
  };
}

const ts = () => new Date().toISOString();
const U = (content: string): Message => ({ role: "user", content, timestamp: ts() });
const A = (content: string): Message => ({ role: "assistant", content, timestamp: ts() });
const aT = (id: string, name: string, input: Record<string, unknown>): Message => ({
  role: "assistant",
  content: [{ id, name, input }],
  timestamp: ts(),
});
const uR = (id: string, content: string, isError?: boolean): Message => ({
  role: "user",
  content: [{ tool_use_id: id, content, is_error: isError }],
  timestamp: ts(),
});

describe("TokenBudget", () => {
  it("reports when messages exceed the configured budget", () => {
    const budget = new TokenBudget({ maxTokens: 10, warningRatio: 0.8 });
    const usage = budget.measureText("one two three four five six seven eight nine ten eleven");

    expect(usage.isOverBudget).toBe(true);
    expect(usage.isNearLimit).toBe(true);
  });
});

describe("splitIntoTurns", () => {
  it("keeps tool pairs within a turn (never splits mid-pair)", () => {
    const msgs = [
      U("task"),
      aT("t1", "read", { path: "x" }),
      uR("t1", "file content"),
      A("done with read"),
      U("next"),
      aT("t2", "edit", { path: "y" }),
      uR("t2", "ok"),
    ];
    const turns = splitIntoTurns(msgs);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual(msgs.slice(0, 4));
    expect(turns[1]).toEqual(msgs.slice(4));
  });

  it("keeps recall pairs within a turn", () => {
    const msgs = [
      U("task"),
      aT("mrec_1", "memory_recall", { query: "task" }),
      uR("mrec_1", "recalled memory"),
      A("answer"),
      U("next"),
    ];
    const turns = splitIntoTurns(msgs);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual(msgs.slice(0, 4));
  });
});

describe("ContextCompressor (Phase 5)", () => {
  it("keeps firstUser + rolling SUMMARY + recent; folds the middle", async () => {
    const mgr = new ConversationManager({ model: "m" });
    mgr.replaceMessages([
      U("turn1"), A("a1"),
      U("turn2"), A("a2"),
      U("turn3"), A("a3"),
      U("turn4"), A("a4"),
    ]);
    const compressor = new ContextCompressor({
      compressionAssistant: fakeAssistant({ updatedSummary: "rolled" }),
      workingDirectory: process.cwd(),
    });
    const result = await compressor.compress(mgr, { keepRecentTurns: 2 });

    expect(result.compressed).toBe(true);
    expect(result.method).toBe("summarize"); // first compression, no prior summary
    expect(result.summaryUpdated).toBe(true);
    const out = mgr.getMessages();
    expect(out[0]).toMatchObject({ role: "user", content: "turn1" });
    expect(out[1]).toMatchObject({ role: "assistant", content: "Previous conversation summary: rolled" });
    expect(out.at(-1)).toMatchObject({ role: "assistant", content: "a4" });
    const roles = out.map((m) => m.role);
    // user, assistant, user, assistant, user, assistant
    expect(roles).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
  });

  it("second compression is rolling (existing summary passed to the assistant)", async () => {
    const mgr = new ConversationManager({ model: "m" });
    mgr.replaceMessages([
      U("t1"), A("a1"),
      U("t2"), A("a2"),
      U("t3"), A("a3"),
      U("t4"), A("a4"),
    ]);
    const seen: (string | null)[] = [];
    const compressor = new ContextCompressor({
      workingDirectory: process.cwd(),
      compressionAssistant: {
        async assist(input: { existingSummary: string | null; turns: unknown[] }) {
          seen.push(input.existingSummary);
          return { updatedSummary: "S2", classifications: [], fileChanges: [] };
        },
      },
    });
    await compressor.compress(mgr, { keepRecentTurns: 1 });
    // add more turns, compress again -> existing summary present
    mgr.replaceMessages([...mgr.getMessages(), U("t5"), A("a5"), U("t6"), A("a6")]);
    const r2 = await compressor.compress(mgr, { keepRecentTurns: 1 });
    expect(seen[1]).toBe("S2"); // prior summary fed back in
    expect(r2.method).toBe("rolling");
  });

  it("retains must-keep error + write turns; compacts write into a file_change note", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "licode-p5-"));
    try {
      const mgr = new ConversationManager({ model: "m" });
      mgr.replaceMessages([
        U("t1"), A("a1"),
        U("t2"), aT("e1", "Bash", {}), uR("e1", "boom", true), A("fixed"),
        U("t3"), aT("w1", "Write", { file_path: "a.txt", content: "hello\nworld" }), uR("w1", "ok"),
        U("t4"), A("a4"),
      ]);
      const compressor = new ContextCompressor({
        workingDirectory: dir,
        compressionAssistant: fakeAssistant({
          fileChanges: [{ index: 2, symbols: ["greet"], summary: { kind: "add greeting" } }],
        }),
      });
      const result = await compressor.compress(mgr, { keepRecentTurns: 1 });
      const out = mgr.getMessages();
      // error turn retained verbatim
      expect(out.some((m) => m.role === "user" && Array.isArray(m.content) &&
        (m.content as { tool_use_id: string }[]).some((b) => b.tool_use_id === "e1"))).toBe(true);
      // write turn compacted to a file_change note (no raw tool_use 'w1' remains)
      expect(out.some((m) => m.role === "assistant" && Array.isArray(m.content) &&
        (m.content as { id: string }[]).some((b) => b.id === "w1"))).toBe(false);
      expect(out.some((m) => typeof m.content === "string" && m.content.startsWith(FILE_CHANGE_PREFIX))).toBe(true);
      expect(result.compactedTurns).toBe(1);
      expect(result.retainedTurns).toBeGreaterThanOrEqual(2); // error + recent at least
      // no orphan tool_result
      for (const m of out) {
        if (m.role === "user" && Array.isArray(m.content)) {
          for (const b of m.content as { tool_use_id: string }[]) {
            expect(out.some((mm) => mm.role === "assistant" && Array.isArray(mm.content) &&
              (mm.content as { id: string }[]).some((x) => x.id === b.tool_use_id))).toBe(true);
          }
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps important candidate turns when budget allows; sheds them when over budget", async () => {
    const mgr = new ConversationManager({ model: "m" });
    mgr.replaceMessages([
      U("t1"), A("a1"),
      U("t2 important"), A("a2"),
      U("t3"), A("a3"),
      U("t4"), A("a4"),
    ]);
    const important = [{ index: 1, keep: "important" as const }];
    // budget large -> important retained
    const cBig = new ContextCompressor({
      workingDirectory: process.cwd(),
      compressionAssistant: fakeAssistant({ classifications: important }),
    });
    await cBig.compress(mgr, { keepRecentTurns: 1, budgetTokens: 1_000_000 });
    expect(mgr.getMessages().some((m) => m.role === "user" && m.content === "t2 important")).toBe(true);

    // reset and compress with tiny budget -> important shed (folded; only in summary)
    mgr.replaceMessages([
      U("t1"), A("a1"),
      U("t2 important"), A("a2"),
      U("t3"), A("a3"),
      U("t4"), A("a4"),
    ]);
    const cSmall = new ContextCompressor({
      workingDirectory: process.cwd(),
      compressionAssistant: fakeAssistant({ classifications: important }),
    });
    await cSmall.compress(mgr, { keepRecentTurns: 1, budgetTokens: 1 });
    expect(mgr.getMessages().some((m) => m.role === "user" && m.content === "t2 important")).toBe(false);
  });

  it("degrades to trim when the assistant throws", async () => {
    const mgr = new ConversationManager({ model: "m" });
    mgr.replaceMessages([U("t1"), A("a1"), U("t2"), A("a2"), U("t3"), A("a3")]);
    const compressor = new ContextCompressor({
      workingDirectory: process.cwd(),
      compressionAssistant: { async assist() { throw new Error("down"); } } as never,
    });
    const result = await compressor.compress(mgr, { keepRecentTurns: 2 });
    expect(result.compressed).toBe(true);
    expect(result.method).toBe("trim");
    expect(result.summaryUpdated).toBe(false);
    const out = mgr.getMessages();
    expect(out[0]).toMatchObject({ role: "user" });
    expect(out[0].content as string).toContain("Earlier task");
  });

  it("does not compress when there are not enough turns", async () => {
    const mgr = new ConversationManager({ model: "m" });
    mgr.replaceMessages([U("only"), A("ans")]);
    const compressor = new ContextCompressor({
      workingDirectory: process.cwd(),
      compressionAssistant: fakeAssistant(),
    });
    const result = await compressor.compress(mgr, { keepRecentTurns: 2 });
    expect(result.compressed).toBe(false);
    expect(mgr.getMessages()).toHaveLength(2);
  });
});

describe("overflowToolResult", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it("spills long tool output into a file and returns a pointer", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-overflow-"));
    const result = await overflowToolResult("x".repeat(50), {
      workingDirectory: dir,
      maxInlineBytes: 10,
    });

    if (result.status !== "success") {
      throw new Error(result.error);
    }
    expect(result.content).toContain(".licode/overflow/");
    expect(result.metadata?.overflowPath).toBeTruthy();
    expect(readFileSync(result.metadata!.overflowPath as string, "utf-8")).toBe(
      "x".repeat(50)
    );
  });

  it("pointer includes a head preview of the first lines", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-overflow-"));
    const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = await overflowToolResult(content, {
      workingDirectory: dir,
      maxInlineBytes: 10,
    });
    if (result.status !== "success") throw new Error(result.error);
    expect(result.content).toContain("First 50 lines:");
    expect(result.content).toContain("line 1");
    expect(result.content).toContain("line 50");
    expect(result.content).not.toContain("line 51");
  });

  it("pointer reports total bytes and line count", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-overflow-"));
    const result = await overflowToolResult("a\nb\nc\n", {
      workingDirectory: dir,
      maxInlineBytes: 2,
    });
    if (result.status !== "success") throw new Error(result.error);
    expect(result.content).toMatch(/\d+ bytes/);
    expect(result.content).toMatch(/\d+ lines/);
  });

  it("pointer includes a paging hint mentioning Read + offset/limit + path", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-overflow-"));
    const result = await overflowToolResult("x".repeat(100), {
      workingDirectory: dir,
      maxInlineBytes: 10,
    });
    if (result.status !== "success") throw new Error(result.error);
    expect(result.content).toContain("Read with offset/limit");
    expect(result.content).toContain(".licode/overflow/");
  });

  it("preview is byte-capped so a huge single line does not flood it", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-overflow-"));
    const hugeLine = "y".repeat(10000);
    const result = await overflowToolResult(hugeLine, {
      workingDirectory: dir,
      maxInlineBytes: 10,
    });
    if (result.status !== "success") throw new Error(result.error);
    expect(result.content.length).toBeLessThan(hugeLine.length);
    expect(result.content).toContain("…");
  });

  it("small content is returned inline unchanged", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-overflow-"));
    const result = await overflowToolResult("small output", { workingDirectory: dir });
    if (result.status !== "success") throw new Error(result.error);
    expect(result.content).toBe("small output");
    expect(result.metadata?.overflowPath).toBeUndefined();
  });
});

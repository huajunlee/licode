import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationManager } from "../conversation/manager.js";
import { ContextCompressor, splitIntoTurns } from "./compressor.js";
import { overflowToolResult } from "./overflow.js";
import { TokenBudget } from "./token-budget.js";
import type { Message } from "../llm/provider.js";

const ts = () => new Date().toISOString();
const U = (content: string): Message => ({ role: "user", content, timestamp: ts() });
const A = (content: string): Message => ({ role: "assistant", content, timestamp: ts() });
const aT = (id: string, name: string, input: Record<string, unknown>): Message => ({
  role: "assistant",
  content: [{ id, name, input }],
  timestamp: ts(),
});
const uR = (id: string, content: string): Message => ({
  role: "user",
  content: [{ tool_use_id: id, content }],
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

describe("ContextCompressor", () => {
  it("keeps first user + recent turns, summarizes the middle as an assistant SUMMARY", async () => {
    const mgr = new ConversationManager({ model: "test-model" });
    mgr.replaceMessages([
      U("turn1 question"), A("turn1 answer"),
      U("turn2 question"), A("turn2 answer"),
      U("turn3 question"), A("turn3 answer"),
      U("turn4 question"), A("turn4 answer"),
    ]);

    const compressor = new ContextCompressor({
      summarizer: async (m) => `SUMMARY of ${m.length} msgs`,
    });
    const result = await compressor.compress(mgr, { keepRecentTurns: 2 });

    expect(result.compressed).toBe(true);
    expect(result.method).toBe("summarize");
    const out = mgr.getMessages();
    // [firstUser, SUMMARY(assistant), ...last 2 turns (4 msgs)]
    expect(out[0]).toMatchObject({ role: "user", content: "turn1 question" });
    expect(out[1]).toMatchObject({
      role: "assistant",
      content: expect.stringContaining("SUMMARY of"),
    });
    expect(out.slice(2)).toHaveLength(4);
    expect(out.at(-1)).toMatchObject({ role: "assistant", content: "turn4 answer" });
    // summarized region = turn1 answer + turn2 (U,A) = 3 msgs
    expect(result.removedMessages).toBe(3);
    // Role alternation: user, assistant, user, assistant, user, assistant
    const roles = out.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
  });

  it("keeps recent tool pairs atomic (no orphan tool_result)", async () => {
    const mgr = new ConversationManager({ model: "test-model" });
    mgr.replaceMessages([
      U("turn1"), aT("t1", "read", {}), uR("t1", "content1"),
      U("turn2"), aT("t2", "read", {}), uR("t2", "content2"),
      U("turn3 current"), aT("t3", "read", {}), uR("t3", "content3"),
    ]);

    const compressor = new ContextCompressor({ summarizer: async () => "S" });
    const result = await compressor.compress(mgr, { keepRecentTurns: 2 });
    expect(result.compressed).toBe(true);

    const out = mgr.getMessages();
    // Every tool_result block must have its tool_use present (no orphans).
    for (const m of out) {
      if (m.role === "user" && Array.isArray(m.content)) {
        for (const block of m.content as { tool_use_id: string }[]) {
          const hasUse = out.some(
            (mm) =>
              mm.role === "assistant" &&
              Array.isArray(mm.content) &&
              (mm.content as { id: string }[]).some((b) => b.id === block.tool_use_id)
          );
          expect(hasUse).toBe(true);
        }
      }
    }
    // The most recent tool pair (t3) is preserved intact.
    expect(out.some((m) => m.role === "assistant" && Array.isArray(m.content) &&
      (m.content as { id: string }[]).some((b) => b.id === "t3"))).toBe(true);
  });

  it("keeps a recall pair in the current turn intact", async () => {
    const mgr = new ConversationManager({ model: "test-model" });
    mgr.replaceMessages([
      U("turn1"), A("answer1"),
      U("turn2 current"),
      aT("mrec_1", "memory_recall", { query: "turn2" }),
      uR("mrec_1", "recalled memory"),
    ]);

    const compressor = new ContextCompressor({ summarizer: async () => "S" });
    await compressor.compress(mgr, { keepRecentTurns: 1 });

    const out = mgr.getMessages();
    const hasRecallResult = out.some(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        (m.content as { tool_use_id: string }[]).some((b) => b.tool_use_id === "mrec_1")
    );
    const hasRecallUse = out.some(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        (m.content as { id: string }[]).some((b) => b.id === "mrec_1")
    );
    expect(hasRecallResult).toBe(true);
    expect(hasRecallUse).toBe(true);
  });

  it("degrades to trim when the summarizer throws", async () => {
    const mgr = new ConversationManager({ model: "test-model" });
    mgr.replaceMessages([
      U("turn1"), A("a1"),
      U("turn2"), A("a2"),
      U("turn3"), A("a3"),
    ]);

    const compressor = new ContextCompressor({
      summarizer: async () => {
        throw new Error("LLM down");
      },
    });
    const result = await compressor.compress(mgr, { keepRecentTurns: 2 });

    expect(result.compressed).toBe(true);
    expect(result.method).toBe("trim");
    expect(result.summary).toBeUndefined();
    const out = mgr.getMessages();
    // No SUMMARY message.
    expect(
      out.some(
        (m) =>
          m.role === "assistant" &&
          typeof m.content === "string" &&
          m.content.includes("Previous conversation summary")
      )
    ).toBe(false);
    // firstUser intent folded into the first recent user message (still user-first).
    expect(out[0]).toMatchObject({ role: "user" });
    expect(out[0].content as string).toContain("Earlier task");
    // last 2 turns kept (4 messages), no summary message.
    expect(out).toHaveLength(4);
  });

  it("does not compress when there are not enough turns to summarize", async () => {
    const mgr = new ConversationManager({ model: "test-model" });
    mgr.replaceMessages([U("only turn"), A("answer")]);

    const compressor = new ContextCompressor({ summarizer: async () => "S" });
    const result = await compressor.compress(mgr, { keepRecentTurns: 2 });

    expect(result.compressed).toBe(false);
    expect(result.removedMessages).toBe(0);
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

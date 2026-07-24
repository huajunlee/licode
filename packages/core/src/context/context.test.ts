import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationManager } from "../conversation/manager.js";
import { ContextCompressor } from "./compressor.js";
import { overflowToolResult } from "./overflow.js";
import { TokenBudget } from "./token-budget.js";

describe("TokenBudget", () => {
  it("reports when messages exceed the configured budget", () => {
    const budget = new TokenBudget({ maxTokens: 10, warningRatio: 0.8 });
    const usage = budget.measureText("one two three four five six seven eight nine ten eleven");

    expect(usage.isOverBudget).toBe(true);
    expect(usage.isNearLimit).toBe(true);
  });
});

describe("ContextCompressor", () => {
  it("trims the oldest messages and emits a compression summary", async () => {
    const manager = new ConversationManager({ model: "test-model" });
    manager.addUserMessage("first message with lots of words");
    manager.appendToAssistantMessage("first answer with lots of words");
    manager.addUserMessage("second message stays");
    manager.appendToAssistantMessage("second answer stays");

    const compressor = new ContextCompressor({
      maxTokens: 20,
      summarizer: async (messages) => `Compressed ${messages.length} messages`,
    });
    const result = await compressor.compress(manager);

    expect(result.compressed).toBe(true);
    expect(manager.getMessages()[0]).toMatchObject({
      role: "assistant",
      content: expect.stringContaining("Compressed"),
    });
    expect(manager.getMessages().at(-1)).toMatchObject({
      role: "assistant",
      content: expect.stringContaining("second answer"),
    });
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
});

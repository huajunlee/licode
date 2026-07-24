import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ConversationManager } from "./manager.js";
import { SystemPrompt } from "./system-prompt.js";
import type { AssistantMessage } from "../llm/provider.js";

describe("ConversationManager", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "licode-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a new conversation with a UUID", () => {
    const mgr = new ConversationManager({
      model: "claude-sonnet-4-6",
    });
    expect(mgr.id).toBeTruthy();
    expect(mgr.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("accepts a custom ID", () => {
    const mgr = new ConversationManager({
      id: "custom-id",
      model: "test-model",
    });
    expect(mgr.id).toBe("custom-id");
  });

  it("adds user messages correctly", () => {
    const mgr = new ConversationManager({ model: "test" });
    mgr.addUserMessage("Hello");
    const messages = mgr.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "user",
      content: "Hello",
    });
  });

  it("appends to assistant message incrementally", () => {
    const mgr = new ConversationManager({ model: "test" });
    mgr.appendToAssistantMessage("Hello");
    mgr.appendToAssistantMessage(" world");
    const messages = mgr.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: "Hello world",
    });
  });

  it("finalizes assistant message with usage", () => {
    const mgr = new ConversationManager({ model: "test" });
    mgr.appendToAssistantMessage("Hi");
    mgr.finalizeAssistantMessage({ input: 10, output: 2 });
    const messages = mgr.getMessages();
    const firstMsg = messages[0] as AssistantMessage;
    expect(firstMsg.role).toBe("assistant");
    expect(firstMsg.usage).toEqual({ input: 10, output: 2 });
  });

  it("builds messages with system prompt", () => {
    const sp = new SystemPrompt();
    sp.addLayer({
      name: "role",
      priority: 0,
      always: true,
      content: "You are a helpful assistant.",
    });

    const mgr = new ConversationManager({ model: "test", systemPrompt: sp });
    mgr.addUserMessage("Hi");

    const messages = mgr.buildMessages();
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[1]).toMatchObject({ role: "user", content: "Hi" });
  });

  it("save and load round-trips", async () => {
    const sp = new SystemPrompt();
    sp.addLayer({
      name: "role",
      priority: 0,
      always: true,
      content: "Test role.",
    });

    const mgr = new ConversationManager({
      model: "test-model",
      systemPrompt: sp,
    });
    mgr.addUserMessage("Hello");
    mgr.appendToAssistantMessage("Hi there");
    mgr.finalizeAssistantMessage({ input: 10, output: 2 });

    const filePath = path.join(tmpDir, "test-session.json");
    await mgr.save(filePath);

    expect(fs.existsSync(filePath)).toBe(true);

    const loaded = await ConversationManager.load(filePath);
    expect(loaded.id).toBe(mgr.id);
    expect(loaded.metadata.model).toBe("test-model");
    expect(loaded.getMessages()).toHaveLength(2);
  });

  it("listSessions returns session summaries", async () => {
    const dir = path.join(tmpDir, ".licode", "sessions");
    fs.mkdirSync(dir, { recursive: true });

    const mgr1 = new ConversationManager({ id: "s1", model: "m1" });
    mgr1.addUserMessage("test");
    await mgr1.save(path.join(dir, "s1.json"));

    const mgr2 = new ConversationManager({ id: "s2", model: "m2" });
    mgr2.addUserMessage("test");
    await mgr2.save(path.join(dir, "s2.json"));

    const sessions = await ConversationManager.listSessions(dir);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  });

  it("listSessions returns empty array for non-existent dir", async () => {
    const sessions = await ConversationManager.listSessions(
      "/nonexistent/path"
    );
    expect(sessions).toEqual([]);
  });

  it("getTokenCount and getMessageCount return correct values", () => {
    const mgr = new ConversationManager({ model: "test" });
    mgr.addUserMessage("Hello");
    mgr.addUserMessage("World");
    expect(mgr.getMessageCount()).toBe(2);
    expect(mgr.getTokenCount()).toBeGreaterThan(0);
  });

  it("trimToBudget keeps recent messages within budget", () => {
    const mgr = new ConversationManager({ model: "test" });
    // Add 3 rounds of conversation
    mgr.addUserMessage("Round 1 question");
    mgr.appendToAssistantMessage("Round 1 answer here yes ok");
    mgr.addUserMessage("Round 2 question that is longer");
    mgr.appendToAssistantMessage("Round 2 answer goes here");
    mgr.addUserMessage("Round 3 question latest one");
    mgr.appendToAssistantMessage("Round 3 answer final reply");

    const beforeCount = mgr.getMessageCount();
    expect(beforeCount).toBe(6); // 3 user + 3 assistant

    // Tight budget — room for ~2 rounds max
    mgr.trimToBudget(20);

    const afterMessages = mgr.getMessages();
    // Should have kept only recent messages
    expect(afterMessages.length).toBeLessThan(beforeCount);
    // At minimum, the last round should be preserved
    expect(
      afterMessages.some(
        (m) => m.role === "user" && m.content === "Round 3 question latest one"
      )
    ).toBe(true);
  });

  it("trimToBudget preserves all messages when budget is large", () => {
    const mgr = new ConversationManager({ model: "test" });
    mgr.addUserMessage("Hello");
    mgr.appendToAssistantMessage("Hi there");

    const beforeCount = mgr.getMessageCount();
    mgr.trimToBudget(10000);
    expect(mgr.getMessageCount()).toBe(beforeCount);
  });

  it("trimToBudget handles empty conversation gracefully", () => {
    const mgr = new ConversationManager({ model: "test" });
    expect(() => mgr.trimToBudget(100)).not.toThrow();
    expect(mgr.getMessageCount()).toBe(0);
  });

  // --- Phase 3: /clear and /context support ---

  it("clear() removes all messages", () => {
    const mgr = new ConversationManager({ model: "test" });
    mgr.addUserMessage("Hello");
    mgr.appendToAssistantMessage("Hi");

    expect(mgr.getMessageCount()).toBe(2);

    mgr.clear();

    expect(mgr.getMessageCount()).toBe(0);
  });

  it("getStats() returns session summary", () => {
    const mgr = new ConversationManager({ model: "test-model" });
    mgr.addUserMessage("Hello");
    mgr.appendToAssistantMessage("Hi");

    const stats = mgr.getStats();

    expect(stats.model).toBe("test-model");
    expect(stats.sessionId).toBe(mgr.id);
    expect(stats.messageCount).toBe(2);
    expect(typeof stats.tokenCount).toBe("number");
    expect(stats.tokenCount).toBeGreaterThan(0);
  });
});

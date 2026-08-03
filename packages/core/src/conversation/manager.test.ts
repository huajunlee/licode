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

  describe("listSessions summary", () => {
    it("extracts summary from the first string-content user message", async () => {
      const dir = path.join(tmpDir, ".licode", "sessions-summary");
      fs.mkdirSync(dir, { recursive: true });

      const mgr = new ConversationManager({ id: "s-sum", model: "m" });
      mgr.addUserMessage("修复登录 bug\n涉及 verifyToken");
      await mgr.save(path.join(dir, "s-sum.json"));

      const sessions = await ConversationManager.listSessions(dir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].summary).toBe("修复登录 bug 涉及 verifyToken");
    });

    it("returns undefined summary when no user message exists", async () => {
      const dir = path.join(tmpDir, ".licode", "sessions-nosummary");
      fs.mkdirSync(dir, { recursive: true });

      const mgr = new ConversationManager({ id: "s-empty", model: "m" });
      await mgr.save(path.join(dir, "s-empty.json"));

      const sessions = await ConversationManager.listSessions(dir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].summary).toBeUndefined();
    });
  });

  it("getTokenCount and getMessageCount return correct values", () => {
    const mgr = new ConversationManager({ model: "test" });
    mgr.addUserMessage("Hello");
    mgr.addUserMessage("World");
    expect(mgr.getMessageCount()).toBe(2);
    expect(mgr.getTokenCount()).toBeGreaterThan(0);
  });

  it("getMessageTokenBase returns the raw uncalibrated estimate of messages", () => {
    const mgr = new ConversationManager({ model: "test" });
    mgr.addUserMessage("Hello world");
    const base = mgr.getMessageTokenBase();
    expect(base).toBeGreaterThan(0);
    // Before any calibration (ratio is 1) it equals getTokenCount.
    expect(mgr.getTokenCount()).toBe(base);
  });

  it("applies calibration from observeUsage to getTokenCount", () => {
    const mgr = new ConversationManager({ model: "test" });
    mgr.addUserMessage("Hello world this is a test message");
    const base = mgr.getMessageTokenBase();
    expect(base).toBeGreaterThan(0);
    // Real backend reports 2x the base estimate.
    mgr.observeUsage(base, base * 2);
    // getTokenCount now reflects the learned ratio (2).
    expect(mgr.getTokenCount()).toBe(base * 2);
    // The raw base stays uncalibrated.
    expect(mgr.getMessageTokenBase()).toBe(base);
  });

  // --- Phase 2: calibration upgrade (base = messages + system + tools) ---

  it("setToolTokenBase includes tool tokens in getMessageTokenBase", () => {
    const mgr = new ConversationManager({ model: "test" });
    mgr.addUserMessage("Hello world");
    const before = mgr.getMessageTokenBase(); // messages only (no system, no tools)
    mgr.setToolTokenBase(123);
    expect(mgr.getMessageTokenBase()).toBe(before + 123);
  });

  it("getMessageTokenBase includes the system prompt estimate", () => {
    const mgr = new ConversationManager({ model: "test" });
    mgr.addUserMessage("Hello world");
    const before = mgr.getMessageTokenBase(); // no system layers
    mgr.systemPrompt.addLayer({
      name: "role",
      priority: 0,
      always: true,
      content: "You are a helpful assistant with a decently long system prompt.",
    });
    expect(mgr.getMessageTokenBase()).toBeGreaterThan(before);
  });

  it("calibration with full base keeps ratio near 1 (no clamp-4 inflation)", () => {
    // Under the old message-only base, large system+tools would force
    // ratio = real/messages to clamp at 4. With the upgrade, base includes
    // system+tools, so ratio = real/base ≈ 1.
    const mgr = new ConversationManager({ model: "test" });
    mgr.addUserMessage("Hi"); // tiny message
    mgr.systemPrompt.addLayer({
      name: "role",
      priority: 0,
      always: true,
      content: "x".repeat(2000),
    });
    mgr.setToolTokenBase(500);
    const base = mgr.getMessageTokenBase(); // messages + ~500 system + 500 tools
    // Backend reports the true full input, which ≈ base (all components counted).
    mgr.observeUsage(base, base);
    // ratio is exactly 1 -> getTokenCount == base, NOT messages × 4.
    expect(mgr.getTokenCount()).toBe(base);
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

  // --- Phase 2: budget info for /context ---

  it("getBudgetInfo reports window, reserve, used, remaining", () => {
    const mgr = new ConversationManager({ model: "test" });
    mgr.addUserMessage("Hello world");
    mgr.setContextBudget({ contextWindow: 1000, outputReserve: 100 });
    const info = mgr.getBudgetInfo();
    expect(info.contextWindow).toBe(1000);
    expect(info.outputReserve).toBe(100);
    expect(info.used).toBe(mgr.getTokenCount());
    expect(info.remaining).toBe(1000 - mgr.getTokenCount());
  });
});

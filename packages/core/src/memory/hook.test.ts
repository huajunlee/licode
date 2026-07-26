import { describe, expect, it, vi } from "vitest";
import { createMemoryExtractionHook } from "./hook.js";
import type { PipelineEvent } from "../events/types.js";
import type { MemoryStore } from "./store.js";
import type { MemoryExtractor } from "./extractor.js";
import type { ConversationManager } from "../conversation/manager.js";
import type { Message } from "../llm/provider.js";

function mockExtractor(shouldExtract = true): MemoryExtractor {
  return {
    shouldExtract: vi.fn().mockReturnValue(shouldExtract),
    extract: vi.fn().mockResolvedValue(undefined),
  } as unknown as MemoryExtractor;
}

function mockStore(): MemoryStore {
  return {
    save: vi.fn(),
    loadIndex: vi.fn().mockResolvedValue(""),
  } as unknown as MemoryStore;
}

function mockConversation(messages: Message[] = []): ConversationManager {
  return {
    getMessages: vi.fn().mockReturnValue(messages),
  } as unknown as ConversationManager;
}

function agentLoopCompleteEvent(): PipelineEvent {
  return {
    type: "agent-loop-complete",
    message: "Done!",
    usage: { input: 100, output: 200 },
  };
}

describe("createMemoryExtractionHook", () => {
  it("returns a function", () => {
    const fn = createMemoryExtractionHook(mockExtractor(), mockStore(), mockConversation());
    expect(typeof fn).toBe("function");
  });

  it("calls extract when event is agent-loop-complete and shouldExtract returns true", async () => {
    const extractor = mockExtractor(true);
    const store = mockStore();
    const conv = mockConversation([
      { role: "user", content: "我喜欢吃辣", timestamp: new Date().toISOString() },
    ]);

    const fn = createMemoryExtractionHook(extractor, store, conv);
    await fn(agentLoopCompleteEvent());

    expect(extractor.shouldExtract).toHaveBeenCalled();
    expect(extractor.extract).toHaveBeenCalled();
  });

  it("skips extraction when shouldExtract returns false", async () => {
    const extractor = mockExtractor(false);
    const store = mockStore();
    const conv = mockConversation([
      { role: "user", content: "hello", timestamp: new Date().toISOString() },
    ]);

    const fn = createMemoryExtractionHook(extractor, store, conv);
    await fn(agentLoopCompleteEvent());

    expect(extractor.shouldExtract).toHaveBeenCalled();
    expect(extractor.extract).not.toHaveBeenCalled();
  });

  it("does nothing for non-agent-loop-complete events", async () => {
    const extractor = mockExtractor(true);
    const store = mockStore();
    const conv = mockConversation();

    const fn = createMemoryExtractionHook(extractor, store, conv);
    await fn({ type: "user-message", content: "hello" });

    expect(extractor.shouldExtract).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createMemoryExtractionHook,
  createMemoryExtractionState,
} from "./hook.js";
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

function mockStore(hasChanges = false): MemoryStore {
  return {
    save: vi.fn(),
    loadIndex: vi.fn().mockResolvedValue(""),
    hasChangesSince: vi.fn().mockResolvedValue(hasChanges),
    rebuildIndex: vi.fn().mockResolvedValue(undefined),
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

const userMessages: Message[] = [
  { role: "user", content: "我喜欢吃辣", timestamp: new Date().toISOString() },
];

describe("createMemoryExtractionState", () => {
  it("creates a fresh state with zeroed timestamps and no running extraction", () => {
    const state = createMemoryExtractionState();
    expect(state.lastExtractedAt).toBe(0);
    expect(state.loopStartedAt).toBe(0);
    expect(state.running).toBe(false);
  });
});

describe("createMemoryExtractionHook", () => {
  it("returns a function", () => {
    const fn = createMemoryExtractionHook(
      mockExtractor(),
      mockStore(),
      mockConversation(),
      createMemoryExtractionState()
    );
    expect(typeof fn).toBe("function");
  });

  it("normal path: calls extract with sinceMs and updates lastExtractedAt", async () => {
    const extractor = mockExtractor(true);
    const store = mockStore();
    const conv = mockConversation(userMessages);
    const state = createMemoryExtractionState();

    const fn = createMemoryExtractionHook(extractor, store, conv, state);
    await fn(agentLoopCompleteEvent());

    expect(extractor.shouldExtract).toHaveBeenCalledWith(userMessages, {
      lastExtractedAt: 0,
    });
    expect(extractor.extract).toHaveBeenCalledWith(userMessages, store, {
      sinceMs: 0,
    });
    expect(state.lastExtractedAt).toBeGreaterThan(0);
    expect(state.running).toBe(false);
  });

  it("skips extraction when shouldExtract returns false (lastExtractedAt untouched)", async () => {
    const extractor = mockExtractor(false);
    const store = mockStore();
    const conv = mockConversation(userMessages);
    const state = createMemoryExtractionState();

    const fn = createMemoryExtractionHook(extractor, store, conv, state);
    await fn(agentLoopCompleteEvent());

    expect(extractor.shouldExtract).toHaveBeenCalled();
    expect(extractor.extract).not.toHaveBeenCalled();
    expect(state.lastExtractedAt).toBe(0);
  });

  it("does nothing for non-agent-loop-complete events", async () => {
    const extractor = mockExtractor(true);
    const store = mockStore();
    const conv = mockConversation();

    const fn = createMemoryExtractionHook(
      extractor,
      store,
      conv,
      createMemoryExtractionState()
    );
    await fn({ type: "user-message", content: "hello" });

    expect(extractor.shouldExtract).not.toHaveBeenCalled();
    expect(extractor.extract).not.toHaveBeenCalled();
  });

  it("skips entirely when another extraction is already running (no queueing)", async () => {
    const extractor = mockExtractor(true);
    const store = mockStore();
    const conv = mockConversation(userMessages);
    const state = createMemoryExtractionState();
    state.running = true;

    const fn = createMemoryExtractionHook(extractor, store, conv, state);
    await fn(agentLoopCompleteEvent());

    expect(extractor.shouldExtract).not.toHaveBeenCalled();
    expect(extractor.extract).not.toHaveBeenCalled();
    expect(store.hasChangesSince).not.toHaveBeenCalled();
  });

  it("rebuilds the index and skips extraction when the main agent already wrote memories this loop", async () => {
    const extractor = mockExtractor(true);
    const store = mockStore(true); // hasChangesSince → true
    const conv = mockConversation(userMessages);
    const state = createMemoryExtractionState();
    state.loopStartedAt = Date.now() - 1000;

    const fn = createMemoryExtractionHook(extractor, store, conv, state);
    await fn(agentLoopCompleteEvent());

    expect(store.hasChangesSince).toHaveBeenCalledWith(state.loopStartedAt);
    expect(store.rebuildIndex).toHaveBeenCalled();
    expect(extractor.shouldExtract).not.toHaveBeenCalled();
    expect(extractor.extract).not.toHaveBeenCalled();
    // lastExtractedAt must NOT advance — next loop still sees the messages
    expect(state.lastExtractedAt).toBe(0);
  });

  it("does not check for main-agent writes when loopStartedAt is 0", async () => {
    const extractor = mockExtractor(true);
    const store = mockStore(true);
    const conv = mockConversation(userMessages);
    const state = createMemoryExtractionState(); // loopStartedAt = 0

    const fn = createMemoryExtractionHook(extractor, store, conv, state);
    await fn(agentLoopCompleteEvent());

    expect(store.hasChangesSince).not.toHaveBeenCalled();
    expect(extractor.shouldExtract).toHaveBeenCalled();
    expect(extractor.extract).toHaveBeenCalled();
  });

  it("runs only once when two events arrive concurrently", async () => {
    const extractor = mockExtractor(true);
    let resolveExtract!: () => void;
    (extractor.extract as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<void>((r) => {
        resolveExtract = r;
      })
    );
    const store = mockStore();
    const conv = mockConversation(userMessages);
    const state = createMemoryExtractionState(); // loopStartedAt = 0 → no await before running=true

    const fn = createMemoryExtractionHook(extractor, store, conv, state);
    const p1 = fn(agentLoopCompleteEvent());
    const p2 = fn(agentLoopCompleteEvent());

    await p2; // second call returns immediately: running === true
    expect(extractor.extract).toHaveBeenCalledTimes(1);

    resolveExtract();
    await p1;
    expect(extractor.extract).toHaveBeenCalledTimes(1);
    expect(state.running).toBe(false);
  });

  it("resets running and still advances lastExtractedAt when extract rejects", async () => {
    const extractor = mockExtractor(true);
    (extractor.extract as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("boom")
    );
    const store = mockStore();
    const conv = mockConversation(userMessages);
    const state = createMemoryExtractionState();

    const fn = createMemoryExtractionHook(extractor, store, conv, state);
    await expect(fn(agentLoopCompleteEvent())).rejects.toThrow("boom");

    expect(state.running).toBe(false);
    // The attempt counts — prevents a failure storm every loop
    expect(state.lastExtractedAt).toBeGreaterThan(0);
  });
});

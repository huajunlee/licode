import { describe, it, expect } from "vitest";
import { generateChatEvents } from "./generator.js";
import { ConversationManager } from "../conversation/manager.js";
import { SystemPrompt } from "../conversation/system-prompt.js";
import type { LLMProvider, StreamChunk, ChatRequest } from "../llm/provider.js";
import type { PipelineEvent } from "./types.js";

/**
 * A stub LLMProvider that yields a controlled sequence of StreamChunks.
 */
function stubProvider(
  chunks: AsyncIterable<StreamChunk>,
  overrides: Partial<LLMProvider> = {}
): LLMProvider {
  return {
    name: "stub",
    maxContextTokens: 100_000,
    chat: async () => ({
      content: "",
      usage: { input: 0, output: 0 },
      stopReason: "end_turn",
    }),
    stream: async function* (_req: ChatRequest) {
      yield* chunks;
    },
    countTokens: () => 0,
    ...overrides,
  };
}

async function collectEvents(
  manager: ConversationManager,
  provider: LLMProvider,
  input: string
): Promise<PipelineEvent[]> {
  const events: PipelineEvent[] = [];
  for await (const event of generateChatEvents(input, manager, provider)) {
    events.push(event);
  }
  return events;
}

describe("generateChatEvents", () => {
  it("yields user-message as the first event", async () => {
    const manager = new ConversationManager({ model: "test-model" });
    const provider = stubProvider(
      (async function* () {
        yield {
          type: "stop" as const,
          stopReason: "end_turn",
          usage: { input: 1, output: 1 },
        };
      })()
    );

    const events = await collectEvents(manager, provider, "Hello");

    expect(events[0]).toEqual({ type: "user-message", content: "Hello" });
  });

  it("yields llm-token for each token chunk from provider", async () => {
    const manager = new ConversationManager({ model: "test-model" });
    const provider = stubProvider(
      (async function* () {
        yield { type: "token" as const, text: "Hi", index: 0 };
        yield { type: "token" as const, text: " there", index: 1 };
        yield {
          type: "stop" as const,
          stopReason: "end_turn",
          usage: { input: 2, output: 2 },
        };
      })()
    );

    const events = await collectEvents(manager, provider, "Hello");

    expect(events).toContainEqual({
      type: "llm-token",
      text: "Hi",
      index: 0,
    });
    expect(events).toContainEqual({
      type: "llm-token",
      text: " there",
      index: 1,
    });
  });

  it("appends tokens to the assistant message in conversation", async () => {
    const manager = new ConversationManager({ model: "test-model" });
    const provider = stubProvider(
      (async function* () {
        yield { type: "token" as const, text: "Hello", index: 0 };
        yield { type: "token" as const, text: " world", index: 1 };
        yield {
          type: "stop" as const,
          stopReason: "end_turn",
          usage: { input: 10, output: 2 },
        };
      })()
    );

    await collectEvents(manager, provider, "Hi");

    const messages = manager.getMessages();
    expect(messages).toHaveLength(2); // user + assistant
    expect(messages[0]).toMatchObject({ role: "user", content: "Hi" });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "Hello world",
    });
  });

  it("yields llm-response-complete on stop with usage", async () => {
    const manager = new ConversationManager({ model: "test-model" });
    const usage = { input: 100, output: 50 };
    const provider = stubProvider(
      (async function* () {
        yield {
          type: "stop" as const,
          stopReason: "end_turn",
          usage,
        };
      })()
    );

    const events = await collectEvents(manager, provider, "Test");

    expect(events).toContainEqual({
      type: "llm-response-complete",
      usage,
    });
  });

  it("yields stream-complete as the last event with all messages", async () => {
    const manager = new ConversationManager({ model: "test-model" });
    const provider = stubProvider(
      (async function* () {
        yield {
          type: "stop" as const,
          stopReason: "end_turn",
          usage: { input: 5, output: 3 },
        };
      })()
    );

    const events = await collectEvents(manager, provider, "Final test");
    const lastEvent = events[events.length - 1];

    expect(lastEvent.type).toBe("stream-complete");
    if (lastEvent.type === "stream-complete") {
      expect(lastEvent.messages).toHaveLength(2); // user + assistant
    }
  });

  it("yields error event when provider yields an error chunk", async () => {
    const manager = new ConversationManager({ model: "test-model" });
    const err = new Error("API unavailable");
    const provider = stubProvider(
      (async function* () {
        yield { type: "error" as const, error: err };
        yield {
          type: "stop" as const,
          stopReason: "error",
          usage: { input: 1, output: 0 },
        };
      })()
    );

    const events = await collectEvents(manager, provider, "Test");

    expect(events).toContainEqual({
      type: "error",
      error: err,
      context: "llm-stream",
    });
  });

  it("yields error event when provider throws", async () => {
    const manager = new ConversationManager({ model: "test-model" });
    const provider: LLMProvider = {
      name: "crashing",
      maxContextTokens: 100_000,
      chat: async () => ({
        content: "",
        usage: { input: 0, output: 0 },
        stopReason: "end_turn",
      }),
      stream: async function* () {
        throw new Error("Connection reset");
      },
      countTokens: () => 0,
    };

    const events = await collectEvents(manager, provider, "Test");

    expect(events).toContainEqual({
      type: "error",
      error: expect.objectContaining({ message: "Connection reset" }),
      context: "chat-generation",
    });
  });

  it("builds messages with system prompt context", async () => {
    const sp = new SystemPrompt();
    sp.addLayer({
      name: "role",
      priority: 0,
      always: true,
      content: "You are a test assistant.",
    });

    const manager = new ConversationManager({
      model: "test-model",
      systemPrompt: sp,
    });
    const provider = stubProvider(
      (async function* () {
        yield {
          type: "stop" as const,
          stopReason: "end_turn",
          usage: { input: 10, output: 5 },
        };
      })()
    );

    await collectEvents(manager, provider, "Hello");

    const messages = manager.getMessages();
    // system prompt should be in buildMessages, not stored in manager directly
    // but the user message should be there
    expect(messages[0]).toMatchObject({ role: "user" });
  });

  it("saves the conversation after stream completes", async () => {
    const manager = new ConversationManager({ model: "test-model" });
    let saved = false;

    // Override save to track if called
    const originalSave = manager.save.bind(manager);
    manager.save = async (...args: Parameters<typeof originalSave>) => {
      saved = true;
      return originalSave(...args);
    };

    const provider = stubProvider(
      (async function* () {
        yield {
          type: "stop" as const,
          stopReason: "end_turn",
          usage: { input: 1, output: 1 },
        };
      })()
    );

    await collectEvents(manager, provider, "Save test");
    expect(saved).toBe(true);
  });

  it("yields llm-thinking events for thinking chunks", async () => {
    const manager = new ConversationManager({ model: "test-model" });
    const provider = stubProvider(
      (async function* () {
        yield { type: "thinking" as const, text: "Let me think" };
        yield { type: "thinking" as const, text: " about this..." };
        yield { type: "token" as const, text: "Answer", index: 0 };
        yield {
          type: "stop" as const,
          stopReason: "end_turn",
          usage: { input: 10, output: 2 },
        };
      })()
    );

    const events = await collectEvents(manager, provider, "Q");

    expect(events).toContainEqual({
      type: "llm-thinking",
      text: "Let me think",
    });
    expect(events).toContainEqual({
      type: "llm-thinking",
      text: " about this...",
    });
  });

  it("yields llm-thinking-complete when first token arrives after thinking", async () => {
    const manager = new ConversationManager({ model: "test-model" });
    const provider = stubProvider(
      (async function* () {
        yield { type: "thinking" as const, text: "Hmm" };
        yield { type: "token" as const, text: "OK", index: 0 };
        yield {
          type: "stop" as const,
          stopReason: "end_turn",
          usage: { input: 5, output: 1 },
        };
      })()
    );

    const events = await collectEvents(manager, provider, "Q");

    const eventTypes = events.map((e) => e.type);
    const thinkingIdx = eventTypes.indexOf("llm-thinking");
    const completeIdx = eventTypes.indexOf("llm-thinking-complete");
    const tokenIdx = eventTypes.indexOf("llm-token");

    expect(thinkingIdx).toBeLessThan(completeIdx);
    expect(completeIdx).toBeLessThan(tokenIdx);
  });

  it("yields llm-thinking-complete before stop when thinking-only (no tokens)", async () => {
    const manager = new ConversationManager({ model: "test-model" });
    const provider = stubProvider(
      (async function* () {
        yield { type: "thinking" as const, text: "Just thinking" };
        yield {
          type: "stop" as const,
          stopReason: "end_turn",
          usage: { input: 5, output: 0 },
        };
      })()
    );

    const events = await collectEvents(manager, provider, "Q");

    expect(events).toContainEqual({ type: "llm-thinking-complete" });
  });
});

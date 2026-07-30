import { describe, expect, it, vi } from "vitest";
import { AgentLoop } from "./loop.js";
import { ConversationManager } from "../conversation/manager.js";
import { ToolRegistry } from "../tools/registry.js";
import type { LLMProvider, StreamChunk } from "../llm/provider.js";

function mockLLM(events: string[]): LLMProvider {
  return {
    name: "mock-llm",
    maxContextTokens: 200000,
    chat: vi.fn(),
    stream: vi.fn(async function* (): AsyncIterable<StreamChunk> {
      events.push("stream");
      yield { type: "token", text: "好的", index: 0 };
      yield { type: "stop", stopReason: "end_turn", usage: { input: 1, output: 1 } };
    }),
    countTokens: vi.fn(() => 0),
  };
}

function makeManager(): ConversationManager {
  const mgr = new ConversationManager({ model: "test-model" });
  vi.spyOn(mgr, "save").mockResolvedValue(); // 不在测试中写 .licode/sessions
  return mgr;
}

describe("AgentLoop onTurnStart", () => {
  it("fires after addUserMessage and before the first LLM call", async () => {
    const events: string[] = [];
    const conversation = makeManager();
    const loop = new AgentLoop({
      llm: mockLLM(events),
      conversation,
      tools: new ToolRegistry(),
      onTurnStart: async (conv) => {
        events.push("onTurnStart");
        const msgs = conv.getMessages();
        expect(msgs[msgs.length - 1].content).toBe("你好");
      },
    });
    await loop.run("你好");
    expect(events).toEqual(["onTurnStart", "stream"]);
  });

  it("keeps the loop alive when onTurnStart throws", async () => {
    const events: string[] = [];
    const conversation = makeManager();
    const loop = new AgentLoop({
      llm: mockLLM(events),
      conversation,
      tools: new ToolRegistry(),
      onTurnStart: async () => { throw new Error("boom"); },
    });
    const result = await loop.run("你好");
    expect(result.type).toBe("stream-complete");
    expect(events).toEqual(["stream"]);
  });

  it("works without onTurnStart (regression)", async () => {
    const conversation = makeManager();
    const loop = new AgentLoop({
      llm: mockLLM([]),
      conversation,
      tools: new ToolRegistry(),
    });
    const result = await loop.run("你好");
    expect(result.type).toBe("stream-complete");
  });
});

describe("AgentLoop calibration", () => {
  it("feeds real usage.input into the conversation calibrator each turn", async () => {
    const conversation = makeManager();
    const llm: LLMProvider = {
      name: "mock-llm",
      maxContextTokens: 200000,
      chat: vi.fn(),
      countTokens: vi.fn(() => 0),
      stream: vi.fn(async function* (): AsyncIterable<StreamChunk> {
        yield { type: "token", text: "好的好的好的好的", index: 0 };
        yield {
          type: "stop",
          stopReason: "end_turn",
          usage: { input: 500, output: 2 },
        };
      }),
    };
    const loop = new AgentLoop({ llm, conversation, tools: new ToolRegistry() });
    await loop.run("你好你好你好你好");

    // usage.input (500) >> the base estimate, so the learned ratio is > 1 and
    // the calibrated getTokenCount must exceed the raw uncalibrated base.
    expect(conversation.getTokenCount()).toBeGreaterThan(
      conversation.getMessageTokenBase()
    );
  });
});

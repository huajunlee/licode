import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentLoop } from "./loop.js";
import { ConversationManager } from "../conversation/manager.js";
import { SystemPrompt } from "../conversation/system-prompt.js";
import { ToolRegistry } from "../tools/registry.js";
import { ContextCompressor } from "../context/compressor.js";
import type { CompressionResult, CompressOptions } from "../context/compressor.js";
import type { LLMProvider, StreamChunk, ChatRequest, Message } from "../llm/provider.js";
import type { PipelineEvent } from "../events/types.js";

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

  it("feeds tool-definition tokens into the conversation base (full-base calibration)", async () => {
    const conversation = makeManager();
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "echoes the input back to the caller for testing",
      parameters: z.object({ text: z.string() }),
      execute: async () => ({ status: "success", content: "ok" }),
    });
    const setSpy = vi.spyOn(conversation, "setToolTokenBase");
    const loop = new AgentLoop({ llm: mockLLM([]), conversation, tools });
    await loop.run("hi");

    // The loop fed a positive tool-token estimate into the base.
    expect(setSpy).toHaveBeenCalled();
    expect(setSpy.mock.calls[0][0]).toBeGreaterThan(0);
    // Combined with the manager (Cycle 1), getMessageTokenBase now includes
    // tool tokens; the loop's requestBase = getMessageTokenBase() therefore
    // captures the full base (system + tools + messages) for calibration.
  });
});

describe("AgentLoop context budget", () => {
  /** Build a mock LLM that captures the system prompt it is sent. */
  function capturingLLM(
    maxContextTokens: number,
    captured: { system: string }
  ): LLMProvider {
    return {
      name: "mock-llm",
      maxContextTokens,
      chat: vi.fn(),
      countTokens: vi.fn(() => 0),
      stream: vi.fn(async function* (req: ChatRequest): AsyncIterable<StreamChunk> {
        const sys = req.messages.find((m) => m.role === "system");
        captured.system = sys && typeof sys.content === "string" ? sys.content : "";
        yield { type: "stop", stopReason: "end_turn", usage: { input: 1, output: 1 } };
      }),
    };
  }

  function makeManager(sp?: SystemPrompt): ConversationManager {
    const mgr = new ConversationManager({ model: "test-model", systemPrompt: sp });
    vi.spyOn(mgr, "save").mockResolvedValue();
    return mgr;
  }

  it("under pressure: optional system layers are dropped, always layers kept", async () => {
    const sp = new SystemPrompt();
    sp.addLayer({ name: "role", priority: 0, always: true, content: "ROLE_MARKER" });
    sp.addLayer({
      name: "tool-use",
      priority: 10,
      always: false,
      content: "OPTIONAL_MARKER ".repeat(40),
    });
    const conversation = makeManager(sp);
    const captured = { system: "" };
    // Small window + large message -> systemBudget collapses to ~0 -> optional dropped.
    const loop = new AgentLoop({
      llm: capturingLLM(1000, captured),
      conversation,
      tools: new ToolRegistry(),
      context: { outputReserve: 100 },
    });
    await loop.run("x".repeat(4000));

    expect(captured.system).toContain("ROLE_MARKER");
    expect(captured.system).not.toContain("OPTIONAL_MARKER");
  });

  it("short conversation: all system layers sent, no trimming (regression)", async () => {
    const sp = new SystemPrompt();
    sp.addLayer({ name: "role", priority: 0, always: true, content: "ROLE_MARKER" });
    sp.addLayer({ name: "tool-use", priority: 10, always: false, content: "OPTIONAL_MARKER" });
    const conversation = makeManager(sp);
    const captured = { system: "" };
    const loop = new AgentLoop({
      llm: capturingLLM(200_000, captured),
      conversation,
      tools: new ToolRegistry(),
    });
    await loop.run("hi");

    expect(captured.system).toContain("ROLE_MARKER");
    expect(captured.system).toContain("OPTIONAL_MARKER");
  });
});

describe("AgentLoop compression", () => {
  function textLLM(maxContextTokens: number): LLMProvider {
    return {
      name: "mock-llm",
      maxContextTokens,
      chat: vi.fn(),
      countTokens: vi.fn(() => 0),
      stream: vi.fn(async function* (): AsyncIterable<StreamChunk> {
        yield { type: "token", text: "ok", index: 0 };
        yield { type: "stop", stopReason: "end_turn", usage: { input: 1, output: 1 } };
      }),
    };
  }

  function capturingEventBus(): { bus: { emit(e: PipelineEvent): void }; events: PipelineEvent[] } {
    const events: PipelineEvent[] = [];
    return { bus: { emit: (e) => events.push(e) }, events };
  }

  it("compresses over threshold, emits context-compressed, then continues", async () => {
    const conversation = makeManager();
    // 4 turns, ~400 tokens each -> ~1600 tokens, over 0.85 * 1000.
    for (let i = 0; i < 4; i++) {
      conversation.addUserMessage(`turn${i} ` + "x".repeat(800));
      conversation.appendToAssistantMessage(`answer${i} ` + "y".repeat(800));
    }
    const { bus, events } = capturingEventBus();
    let summarized: unknown | null = null;
    const compressor = new ContextCompressor({
      workingDirectory: process.cwd(),
      compressionAssistant: {
        async assist(input) {
          summarized = input.turns;
          return { updatedSummary: "SUMMARY", classifications: [], fileChanges: [] };
        },
      },
    });
    const loop = new AgentLoop({
      llm: textLLM(1000),
      conversation,
      tools: new ToolRegistry(),
      context: { outputReserve: 100 },
      compressor,
      eventBus: bus,
    });
    const result = await loop.run("continue");

    expect(result.type).toBe("stream-complete");
    expect(summarized).not.toBeNull();
    const evt = events.find((e) => e.type === "context-compressed");
    expect(evt).toBeDefined();
    expect(evt).toMatchObject({ type: "context-compressed", method: "summarize" });
    if (evt && evt.type === "context-compressed") {
      expect(evt.removedMessages).toBeGreaterThan(0);
    }
    // SUMMARY landed in the conversation right after the first user message.
    const out = conversation.getMessages();
    expect(out[1]).toMatchObject({
      role: "assistant",
      content: expect.stringContaining("SUMMARY"),
    });
  });

  it("hard-stops when still over maxTokens after compression (fallback)", async () => {
    const conversation = makeManager();
    conversation.addUserMessage("turn0 " + "x".repeat(200));
    conversation.appendToAssistantMessage("a0 " + "y".repeat(200));
    // Turns 1-3 are huge so the recent window alone exceeds maxTokens.
    for (let i = 1; i <= 3; i++) {
      conversation.addUserMessage(`turn${i} ` + "x".repeat(1400));
      conversation.appendToAssistantMessage(`a${i} ` + "y".repeat(1400));
    }
    const { bus, events } = capturingEventBus();
    const compressor = new ContextCompressor({
      workingDirectory: process.cwd(),
      compressionAssistant: {
        async assist() {
          return { updatedSummary: "SUMMARY", classifications: [], fileChanges: [] };
        },
      },
    });
    const loop = new AgentLoop({
      llm: textLLM(1000),
      conversation,
      tools: new ToolRegistry(),
      context: { outputReserve: 100 },
      termination: { maxTokens: 600 },
      compressor,
      eventBus: bus,
    });
    const result = await loop.run("continue");

    // Compressed first, then the gate still tripped -> terminated.
    expect(result.type).toBe("stream-complete");
    expect(events.some((e) => e.type === "context-compressed")).toBe(true);
    expect(events.some((e) => e.type === "agent-loop-terminated")).toBe(true);
  });

  it("short conversation: no compression, no context-compressed event (regression)", async () => {
    const conversation = makeManager();
    const { bus, events } = capturingEventBus();
    let summarized = false;
    const compressor = new ContextCompressor({
      workingDirectory: process.cwd(),
      compressionAssistant: {
        async assist() {
          summarized = true;
          return { updatedSummary: "S", classifications: [], fileChanges: [] };
        },
      },
    });
    const loop = new AgentLoop({
      llm: textLLM(200_000),
      conversation,
      tools: new ToolRegistry(),
      compressor,
      eventBus: bus,
    });
    await loop.run("hi");

    expect(summarized).toBe(false);
    expect(events.some((e) => e.type === "context-compressed")).toBe(false);
  });

  it("passes budgetTokens to compress() and emits rolling retention stats", async () => {
    const conversation = makeManager();
    // Seed enough tokens to trip the threshold (0.85 * 1000 = 850).
    for (let i = 0; i < 4; i++) {
      conversation.addUserMessage(`turn${i} ` + "x".repeat(800));
      conversation.appendToAssistantMessage(`answer${i} ` + "y".repeat(800));
    }
    const { bus, events } = capturingEventBus();
    const seen: { keepRecentTurns?: number; budgetTokens?: number } = {};
    const fakeCompressor = {
      async compress(
        _conv: ConversationManager,
        opts: CompressOptions
      ): Promise<CompressionResult> {
        seen.keepRecentTurns = opts.keepRecentTurns;
        seen.budgetTokens = opts.budgetTokens;
        return {
          compressed: true,
          removedMessages: 3,
          method: "rolling",
          retainedTurns: 2,
          compactedTurns: 1,
          summaryUpdated: true,
        };
      },
    } as unknown as ContextCompressor;
    const loop = new AgentLoop({
      llm: textLLM(1000),
      conversation,
      tools: new ToolRegistry(),
      context: { outputReserve: 100 },
      compressor: fakeCompressor,
      eventBus: bus,
    });
    const result = await loop.run("continue");

    expect(result.type).toBe("stream-complete");
    // compress() received a numeric budgetTokens = round(0.85 * 1000) = 850.
    expect(seen.budgetTokens).toBe(850);
    expect(seen.keepRecentTurns).toBe(2);
    const evt = events.find(
      (e): e is Extract<PipelineEvent, { type: "context-compressed" }> =>
        e.type === "context-compressed"
    );
    expect(evt).toBeDefined();
    expect(evt).toMatchObject({
      type: "context-compressed",
      method: "rolling",
      removedMessages: 3,
      retainedTurns: 2,
      compactedTurns: 1,
      summaryUpdated: true,
    });
  });
});

describe("AgentLoop overflow config", () => {
  it("passes ContextConfig.overflowMaxBytes to the ToolExecutor", () => {
    const loop = new AgentLoop({
      llm: mockLLM([]),
      conversation: makeManager(),
      tools: new ToolRegistry(),
      context: { overflowMaxBytes: 1234 },
    });
    expect((loop as unknown as { executor: { overflowMaxBytes: number } }).executor.overflowMaxBytes).toBe(1234);
  });

  it("defaults overflowMaxBytes to 64KB when not configured", () => {
    const loop = new AgentLoop({
      llm: mockLLM([]),
      conversation: makeManager(),
      tools: new ToolRegistry(),
    });
    expect((loop as unknown as { executor: { overflowMaxBytes: number } }).executor.overflowMaxBytes).toBe(64 * 1024);
  });
});

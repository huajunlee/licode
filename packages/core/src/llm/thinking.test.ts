import { describe, it, expect } from "vitest";
import { AnthropicProvider } from "./anthropic.js";
import { collectResponse } from "../agent/react.js";
import type {
  Message,
  LLMProvider,
  ChatRequest,
  StreamChunk,
  ThinkingBlock,
} from "./provider.js";
import { ConversationManager } from "../conversation/manager.js";

const THINKING: ThinkingBlock = { thinking: "先看看用户想要什么", signature: "sig-abc123" };

function provider() {
  return new AnthropicProvider({ apiKey: "sk-ant-test" });
}

// toAnthropicMessages 是 private，但它正是出过错的地方，直接调它做单测
function toMessages(p: AnthropicProvider, messages: Message[]) {
  return (p as unknown as {
    toAnthropicMessages(m: Message[]): Array<{ role: string; content: unknown }>;
  }).toAnthropicMessages(messages);
}

describe("thinking 块回传（否则 thinking 模式端点整轮 400）", () => {
  it("纯文本助手消息带 thinking -> thinking 排在最前，正文包成 text 块", () => {
    const msgs: Message[] = [
      { role: "user", content: "问题", timestamp: "t" },
      { role: "assistant", content: "回答", thinking: [THINKING], timestamp: "t" },
    ];
    const out = toMessages(provider(), msgs);
    expect(out[1].content).toEqual([
      { type: "thinking", thinking: THINKING.thinking, signature: THINKING.signature },
      { type: "text", text: "回答" },
    ]);
  });

  it("tool_use 消息带 thinking -> thinking 在 tool_use 之前", () => {
    const msgs: Message[] = [
      { role: "user", content: "问题", timestamp: "t" },
      {
        role: "assistant",
        content: [{ id: "tu1", name: "Read", input: { file_path: "x" } }],
        thinking: [THINKING],
        timestamp: "t",
      },
    ];
    const out = toMessages(provider(), msgs);
    expect(out[1].content).toEqual([
      { type: "thinking", thinking: THINKING.thinking, signature: THINKING.signature },
      { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "x" } },
    ]);
  });

  it("tool_use 消息带同轮文本 -> 文本块在 tool_use 之前（拆两条会被 400）", () => {
    const msgs: Message[] = [
      { role: "user", content: "问题", timestamp: "t" },
      {
        role: "assistant",
        content: [{ id: "tu1", name: "Read", input: {} }],
        thinking: [THINKING],
        text: "我来看一下。",
        timestamp: "t",
      },
    ];
    const out = toMessages(provider(), msgs);
    expect(out[1].content).toEqual([
      { type: "thinking", thinking: THINKING.thinking, signature: THINKING.signature },
      { type: "text", text: "我来看一下。" },
      { type: "tool_use", id: "tu1", name: "Read", input: {} },
    ]);
  });

  it("没有 thinking 时保持原样（纯字符串 content，不做块包装）", () => {
    const msgs: Message[] = [
      { role: "user", content: "问题", timestamp: "t" },
      { role: "assistant", content: "回答", timestamp: "t" },
    ];
    const out = toMessages(provider(), msgs);
    expect(out[1].content).toBe("回答");
  });

  it("多个 thinking 块按原顺序保留", () => {
    const second: ThinkingBlock = { thinking: "再想想", signature: "sig-def" };
    const msgs: Message[] = [
      { role: "user", content: "问题", timestamp: "t" },
      { role: "assistant", content: "回答", thinking: [THINKING, second], timestamp: "t" },
    ];
    const out = toMessages(provider(), msgs);
    const blocks = out[1].content as Array<{ type: string; signature?: string }>;
    // 末尾还会有一个 text 块，这里只看 thinking 块
    expect(blocks.filter((b) => b.type === "thinking").map((b) => b.signature)).toEqual([
      "sig-abc123",
      "sig-def",
    ]);
  });
});

describe("collectResponse 收集完整 thinking 块", () => {
  function fakeLLM(chunks: StreamChunk[]): LLMProvider {
    return {
      name: "fake",
      maxContextTokens: 1000,
      countTokens: () => 0,
      async chat(_req: ChatRequest) {
        return { content: "", usage: { input: 0, output: 0 } };
      },
      async *stream() {
        for (const c of chunks) yield c;
      },
    } as unknown as LLMProvider;
  }

  it("thinking-block 块被收进结果（增量 thinking 只用于展示，不进历史）", async () => {
    const llm = fakeLLM([
      { type: "thinking", text: "先看" },
      { type: "thinking", text: "看用户" },
      { type: "thinking-block", block: THINKING },
      { type: "token", text: "回答", index: 0 },
      { type: "stop", stopReason: "end_turn", usage: { input: 1, output: 1 } },
    ]);
    const mgr = new ConversationManager({ model: "m" });
    const res = await collectResponse(llm, [], [], mgr);
    expect(res.type).toBe("text");
    expect(res.thinking).toEqual([THINKING]);
  });

  it("tool-use 分支同样带上 thinking", async () => {
    const llm = fakeLLM([
      { type: "thinking-block", block: THINKING },
      { type: "tool-use", toolUse: { id: "tu1", name: "Read", input: {} } },
      { type: "stop", stopReason: "tool_use", usage: { input: 1, output: 1 } },
    ]);
    const mgr = new ConversationManager({ model: "m" });
    const res = await collectResponse(llm, [], [], mgr);
    expect(res.type).toBe("tool-use");
    expect(res.thinking).toEqual([THINKING]);
  });
});

describe("ConversationManager 把 thinking 留在消息上", () => {
  it("finalizeAssistantMessage 接受 thinking", () => {
    const mgr = new ConversationManager({ model: "m" });
    mgr.appendToAssistantMessage("回答");
    mgr.finalizeAssistantMessage({ input: 1, output: 1 }, [THINKING]);
    const last = mgr.getLastAssistantMessage() as { thinking?: ThinkingBlock[] };
    expect(last.thinking).toEqual([THINKING]);
  });

  it("addToolMessages 接受 thinking 与同轮文本", () => {
    const mgr = new ConversationManager({ model: "m" });
    mgr.addToolMessages(
      [{ id: "tu1", name: "Read", input: {} }],
      [{ status: "success", content: "ok" }],
      [THINKING],
      "我来看一下。"
    );
    const msgs = mgr.getMessages();
    const assistant = msgs.find((m) => m.role === "assistant") as {
      thinking?: ThinkingBlock[];
      text?: string;
    };
    expect(assistant.thinking).toEqual([THINKING]);
    expect(assistant.text).toBe("我来看一下。");
    // 关键：不能同时留下一条独立的文本助手消息
    expect(msgs.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("takeTrailingAssistantText 回收流式落下的文本消息", () => {
    const mgr = new ConversationManager({ model: "m" });
    mgr.appendToAssistantMessage("我来看");
    mgr.appendToAssistantMessage("一下。");
    expect(mgr.takeTrailingAssistantText()).toBe("我来看一下。");
    // 已移除，不残留第二条助手消息
    expect(mgr.getMessages().filter((m) => m.role === "assistant")).toHaveLength(0);
  });

  it("takeTrailingAssistantText 在末尾不是助手文本消息时返回空串且不动历史", () => {
    const mgr = new ConversationManager({ model: "m" });
    mgr.addToolMessages([{ id: "tu1", name: "Read", input: {} }], [{ status: "success", content: "ok" }]);
    const before = mgr.getMessages().length;
    expect(mgr.takeTrailingAssistantText()).toBe("");
    expect(mgr.getMessages()).toHaveLength(before);
  });
});

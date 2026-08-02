import { describe, it, expect } from "vitest";
import { classifyMessage, toolNames } from "./message-classify.js";
import type { Message } from "@licode/core";

const userMsg: Message = { role: "user", content: "你好", timestamp: "" } as Message;
const assistantMsg: Message = { role: "assistant", content: "回答", timestamp: "" } as Message;
const systemMsg: Message = { role: "system", content: "sys" } as Message;
const toolUseMsg: Message = {
  role: "assistant",
  content: [{ id: "t1", name: "Read", input: {} }, { id: "t2", name: "Grep", input: {} }],
  timestamp: "",
} as Message;
const toolResultMsg: Message = {
  role: "user",
  content: [{ tool_use_id: "t1", content: "ok" }],
  timestamp: "",
} as Message;

describe("classifyMessage", () => {
  it("classifies the five message shapes", () => {
    expect(classifyMessage(userMsg)).toBe("user");
    expect(classifyMessage(assistantMsg)).toBe("assistant-text");
    expect(classifyMessage(systemMsg)).toBe("system");
    expect(classifyMessage(toolUseMsg)).toBe("tool-use");
    expect(classifyMessage(toolResultMsg)).toBe("tool-result");
  });
});

describe("toolNames", () => {
  it("joins tool names", () => {
    expect(toolNames(toolUseMsg)).toBe("Read, Grep");
  });

  it("returns empty string for string content", () => {
    expect(toolNames(userMsg)).toBe("");
  });
});

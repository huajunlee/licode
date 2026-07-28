import { describe, expect, it } from "vitest";
import {
  MEMORY_RECALL_TOOL_NAME,
  buildRecallPair,
  pruneRecallMessages,
} from "./recall.js";
import type { Message, ToolUseBlock, ToolResultBlock } from "../llm/provider.js";
import type { Memory } from "./types.js";

function makeMemory(slug: string, name = slug, content = `${slug} 正文`): Memory {
  return {
    slug,
    type: slug.split("/")[0] as Memory["type"],
    name,
    description: `${name} 描述`,
    content,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

function userText(text: string): Message {
  return { role: "user", content: text, timestamp: "2026-07-28T01:00:00.000Z" };
}

describe("buildRecallPair", () => {
  it("returns assistant tool_use + user tool_result with linked ids", () => {
    const [tu, tr] = buildRecallPair("今晚吃什么好？", [makeMemory("user/food", "食物偏好")]);
    expect(tu.role).toBe("assistant");
    expect(tr.role).toBe("user");
    const useBlock = (tu.content as ToolUseBlock[])[0];
    const resultBlock = (tr.content as ToolResultBlock[])[0];
    expect(useBlock.name).toBe(MEMORY_RECALL_TOOL_NAME);
    expect(resultBlock.tool_use_id).toBe(useBlock.id);
    expect(useBlock.input).toEqual({ query: "今晚吃什么好？" });
    expect(resultBlock.content).toContain("## 食物偏好 (user/food)");
    expect(resultBlock.content).toContain("user/food 正文");
    expect(resultBlock.content).toContain("# Recalled Memories");
  });

  it("truncates query preview to 200 chars", () => {
    const long = "x".repeat(250);
    const [tu] = buildRecallPair(long, [makeMemory("user/a")]);
    const block = (tu.content as ToolUseBlock[])[0];
    expect((block.input as { query: string }).query.length).toBe(201); // 200 + "…"
  });
});

describe("pruneRecallMessages", () => {
  it("removes a recall pair from the middle of history (restored session)", () => {
    const [tu, tr] = buildRecallPair("q", [makeMemory("user/a")]);
    const messages: Message[] = [userText("第一问"), tu, tr, userText("第二问")];
    const pruned = pruneRecallMessages(messages);
    expect(pruned).toHaveLength(2);
    expect(pruned.every((m) => typeof m.content === "string")).toBe(true);
  });

  it("preserves normal tool call pairs", () => {
    const normalUse: Message = {
      role: "assistant",
      content: [{ id: "t1", name: "Read", input: { path: "x" } }],
      timestamp: "2026-07-28T01:00:00.000Z",
    };
    const normalResult: Message = {
      role: "user",
      content: [{ tool_use_id: "t1", content: "file content" }],
      timestamp: "2026-07-28T01:00:01.000Z",
    };
    const [tu, tr] = buildRecallPair("q", [makeMemory("user/a")]);
    const pruned = pruneRecallMessages([normalUse, normalResult, tu, tr]);
    expect(pruned).toEqual([normalUse, normalResult]);
  });

  it("returns the same array reference when there is nothing to prune", () => {
    const messages: Message[] = [userText("hello")];
    expect(pruneRecallMessages(messages)).toBe(messages);
  });
});

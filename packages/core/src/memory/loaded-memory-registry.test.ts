// packages/core/src/memory/loaded-memory-registry.test.ts
import { describe, expect, it } from "vitest";
import { LoadedMemoryRegistry } from "./loaded-memory-registry.js";
import type { Message } from "../llm/provider.js";

function toolPair(toolName: string, slugs: string[]): [Message, Message] {
  const id = `${toolName}_1`;
  const content = slugs.map((s) => `## ${s} (${s})\n${s} 正文`).join("\n\n");
  return [
    { role: "assistant", content: [{ id, name: toolName, input: {} }], timestamp: "" },
    { role: "user", content: [{ tool_use_id: id, content }], timestamp: "" },
  ];
}

describe("LoadedMemoryRegistry", () => {
  it("add/has round-trip", () => {
    const r = new LoadedMemoryRegistry();
    expect(r.has("user/a")).toBe(false);
    r.add("user/a");
    expect(r.has("user/a")).toBe(true);
  });

  it("add is idempotent (Set semantics)", () => {
    const r = new LoadedMemoryRegistry();
    r.add("user/a");
    r.add("user/a");
    expect(r.has("user/a")).toBe(true);
  });

  it("rebuild extracts slugs from memory_recall pairs", () => {
    const r = new LoadedMemoryRegistry();
    r.rebuild(toolPair("memory_recall", ["user/food"]));
    expect(r.has("user/food")).toBe(true);
  });

  it("rebuild extracts slugs from legacy memory_fetch pairs", () => {
    const r = new LoadedMemoryRegistry();
    r.rebuild(toolPair("memory_fetch", ["user/a", "user/b"]));
    expect(r.has("user/a")).toBe(true);
    expect(r.has("user/b")).toBe(true);
  });

  it("rebuild clears previous state", () => {
    const r = new LoadedMemoryRegistry();
    r.add("user/old");
    r.rebuild([]);
    expect(r.has("user/old")).toBe(false);
  });

  it("rebuild ignores unrelated tool pairs (Read)", () => {
    const r = new LoadedMemoryRegistry();
    const use: Message = { role: "assistant", content: [{ id: "r1", name: "Read", input: {} }], timestamp: "" };
    const res: Message = { role: "user", content: [{ tool_use_id: "r1", content: "## x (user/y)\n..." }], timestamp: "" };
    r.rebuild([use, res]);
    expect(r.has("user/y")).toBe(false);
  });
});

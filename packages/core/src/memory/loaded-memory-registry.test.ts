// packages/core/src/memory/loaded-memory-registry.test.ts
import { describe, expect, it } from "vitest";
import { LoadedMemoryRegistry } from "./loaded-memory-registry.js";
import { buildRecallPair } from "./recall.js";
import type { Message } from "../llm/provider.js";
import type { Memory } from "./types.js";

function mem(slug: string): Memory {
  return {
    slug, type: slug.split("/")[0] as Memory["type"],
    name: slug, description: "d", content: `${slug} 正文`,
    createdAt: "", updatedAt: "",
  };
}
function fetchPair(slugs: string[]): [Message, Message] {
  const id = "mf_1";
  const content = slugs.map((s) => `## ${s} (${s})\n${s} 正文`).join("\n\n");
  return [
    { role: "assistant", content: [{ id, name: "memory_fetch", input: {} }], timestamp: "" },
    { role: "user", content: [{ tool_use_id: id, content }], timestamp: "" },
  ];
}

describe("LoadedMemoryRegistry", () => {
  it("add/has/get/remove round-trip", () => {
    const r = new LoadedMemoryRegistry();
    expect(r.has("user/a")).toBe(false);
    r.add("user/a", "active");
    expect(r.has("user/a")).toBe(true);
    expect(r.get("user/a")).toBe("active");
    r.remove("user/a");
    expect(r.has("user/a")).toBe(false);
  });

  it("add overwrites source", () => {
    const r = new LoadedMemoryRegistry();
    r.add("user/a", "sidequery");
    r.add("user/a", "active");
    expect(r.get("user/a")).toBe("active");
  });

  it("getAll returns entries", () => {
    const r = new LoadedMemoryRegistry();
    r.add("user/a", "active");
    r.add("user/b", "sidequery");
    expect(r.getAll()).toEqual([
      { slug: "user/a", source: "active" },
      { slug: "user/b", source: "sidequery" },
    ]);
  });

  it("rebuild extracts sidequery slugs from memory_recall pairs", () => {
    const r = new LoadedMemoryRegistry();
    const [tu, tr] = buildRecallPair("q", [mem("user/food")]);
    r.rebuild([tu, tr]);
    expect(r.get("user/food")).toBe("sidequery");
  });

  it("rebuild extracts active slugs from memory_fetch pairs", () => {
    const r = new LoadedMemoryRegistry();
    const [u, res] = fetchPair(["user/a", "user/b"]);
    r.rebuild([u, res]);
    expect(r.get("user/a")).toBe("active");
    expect(r.get("user/b")).toBe("active");
  });

  it("rebuild clears previous state", () => {
    const r = new LoadedMemoryRegistry();
    r.add("user/old", "active");
    r.rebuild([]);
    expect(r.getAll()).toEqual([]);
  });

  it("rebuild ignores unrelated tool pairs (Read)", () => {
    const r = new LoadedMemoryRegistry();
    const use: Message = { role: "assistant", content: [{ id: "r1", name: "Read", input: {} }], timestamp: "" };
    const res: Message = { role: "user", content: [{ tool_use_id: "r1", content: "## x (user/y)\n..." }], timestamp: "" };
    r.rebuild([use, res]);
    expect(r.getAll()).toEqual([]);
  });
});

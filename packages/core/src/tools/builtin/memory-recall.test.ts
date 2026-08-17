import { describe, it, expect } from "vitest";
import { createMemoryRecallTool } from "./memory-recall.js";
import { LoadedMemoryRegistry } from "../../memory/loaded-memory-registry.js";
import type { MemoryStore } from "../../memory/store.js";
import type { Memory } from "../../memory/types.js";

const FOOD: Memory = {
  name: "食物偏好", slug: "user/food-preferences", description: "喜欢蛋挞",
  content: "用户喜欢吃蛋挞。", keywords: ["蛋挞"],
  type: "user", createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z",
} as Memory;

function fakeStore(all: Memory[], usage: string[] = []) {
  return {
    store: {
      load: async (slug: string) => all.find((m) => m.slug === slug) ?? null,
      recordUsage: async (slug: string) => { usage.push(slug); },
    } as unknown as MemoryStore,
    usage,
  };
}

function deps(over: Partial<Parameters<typeof createMemoryRecallTool>[0]> = {}, all: Memory[] = [FOOD]) {
  const { store, usage } = fakeStore(all);
  const registry = new LoadedMemoryRegistry();
  return {
    store, usage, registry,
    deps: {
      runRecall: async () => ["user/food-preferences"],
      store,
      registry,
      ...over,
    },
  };
}

describe("memory_recall tool", () => {
  it("returns formatted memory content and records usage + registry", async () => {
    const { deps: d, usage, registry } = deps();
    const tool = createMemoryRecallTool(d);
    const res = await tool.execute(
      { query: "宵夜吃什么", keywords: ["宵夜"] },
      { workingDirectory: "/tmp", sessionId: "s" }
    );
    expect(res.status).toBe("success");
    if (res.status !== "success") return;
    expect(res.content).toContain("## 食物偏好 (user/food-preferences)");
    expect(res.content).toContain("用户喜欢吃蛋挞。");
    expect(usage).toEqual(["user/food-preferences"]);
    expect(registry.has("user/food-preferences")).toBe(true);
  });

  it("skips already-loaded memories and says so", async () => {
    const { deps: d, registry, usage } = deps();
    registry.add("user/food-preferences", "active");
    const tool = createMemoryRecallTool(d);
    const res = await tool.execute({ query: "q", keywords: [] }, { workingDirectory: "/tmp", sessionId: "s" });
    expect(res.status).toBe("success");
    if (res.status !== "success") return;
    expect(res.content).toContain("已在上下文");
    expect(res.content).not.toContain("用户喜欢吃蛋挞。");
    expect(usage).toEqual([]);
  });

  it("returns 未找到相关记忆 when recall selects nothing", async () => {
    const { deps: d } = deps({ runRecall: async () => [] });
    const tool = createMemoryRecallTool(d);
    const res = await tool.execute({ query: "q", keywords: [] }, { workingDirectory: "/tmp", sessionId: "s" });
    expect(res.status).toBe("success");
    if (res.status !== "success") return;
    expect(res.content).toContain("未找到相关记忆");
  });

  it("degrades to 未找到相关记忆 when runRecall throws (never throws)", async () => {
    const { deps: d } = deps({
      runRecall: async () => { throw new Error("boom"); },
    });
    const tool = createMemoryRecallTool(d);
    const res = await tool.execute({ query: "q", keywords: [] }, { workingDirectory: "/tmp", sessionId: "s" });
    expect(res.status).toBe("success");
    if (res.status !== "success") return;
    expect(res.content).toContain("未找到相关记忆");
  });

  it("skips recordUsage while dream is running", async () => {
    const { deps: d, usage } = deps({ dreamState: { running: true } as never });
    const tool = createMemoryRecallTool(d);
    await tool.execute({ query: "q", keywords: [] }, { workingDirectory: "/tmp", sessionId: "s" });
    expect(usage).toEqual([]);
  });

  it("excerpts memories whose content is >= 500 tokens", async () => {
    const long: Memory = { ...FOOD, slug: "project/big", name: "大文件", content: "字".repeat(3000) };
    const { deps: d } = deps({ runRecall: async () => ["project/big"] }, [long]);
    const tool = createMemoryRecallTool(d);
    const res = await tool.execute({ query: "q", keywords: [] }, { workingDirectory: "/tmp", sessionId: "s" });
    expect(res.status).toBe("success");
    if (res.status !== "success") return;
    expect(res.content).toContain("…（摘录）");
    expect(res.content.length).toBeLessThan(2600);
  });
});

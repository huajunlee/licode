// packages/core/src/tools/builtin/memory-fetch.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createMemoryFetchTool } from "./memory-fetch.js";
import { MemoryStore } from "../../memory/store.js";
import { createLoadedMemoryRegistry } from "../../memory/loaded-memory-registry.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Memory } from "../../memory/types.js";

function mem(slug: string, name = slug): Memory {
  return {
    slug, type: slug.split("/")[0] as Memory["type"], name,
    description: `${name} 描述`, content: `${name} 正文`,
    createdAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z",
  };
}

describe("memory_fetch tool", () => {
  let dir: string | null = null;
  let store: MemoryStore;
  let registry: ReturnType<typeof createLoadedMemoryRegistry>;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mfetch-"));
    store = new MemoryStore(dir);
    await store.save(mem("user/food", "食物偏好"));
    await store.save(mem("user/editor", "编辑器"));
    registry = createLoadedMemoryRegistry();
  });
  afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });

  const ctx = { workingDirectory: dir!, sessionId: "s1" };

  it("loads memories by slug in buildRecallPair format", async () => {
    const tool = createMemoryFetchTool({ store, registry });
    const res = await tool.execute({ slugs: ["user/food"] }, ctx as any);
    expect(res.status).toBe("success");
    const content = (res as { content: string }).content;
    expect(content).toContain("## 食物偏好 (user/food)");
    expect(content).toContain("食物偏好 正文");
  });

  it("registers loaded slugs as active in registry", async () => {
    const tool = createMemoryFetchTool({ store, registry });
    await tool.execute({ slugs: ["user/food"] }, ctx as any);
    expect(registry.get("user/food")).toBe("active");
  });

  it("skips already-loaded slugs (dedup) and reports them", async () => {
    registry.add("user/food", "sidequery");
    const tool = createMemoryFetchTool({ store, registry });
    const res = await tool.execute({ slugs: ["user/food", "user/editor"] }, ctx as any);
    expect(res.status).toBe("success");
    const content = (res as { content: string }).content;
    expect(content).toContain("user/editor");       // loaded
    expect(content).toContain("已在上下文");          // user/food skipped note
    expect(content).not.toContain("食物偏好 正文");  // user/food body not re-included
  });

  it("records usage for newly loaded memories", async () => {
    const spy = vi.spyOn(store, "recordUsage");
    const tool = createMemoryFetchTool({ store, registry });
    await tool.execute({ slugs: ["user/food"] }, ctx as any);
    expect(spy).toHaveBeenCalledWith("user/food");
  });

  it("does not record usage for already-loaded (skipped) slugs", async () => {
    registry.add("user/food", "active");
    const spy = vi.spyOn(store, "recordUsage");
    const tool = createMemoryFetchTool({ store, registry });
    await tool.execute({ slugs: ["user/food"] }, ctx as any);
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips unknown slug and returns partial + note", async () => {
    const tool = createMemoryFetchTool({ store, registry });
    const res = await tool.execute({ slugs: ["user/ghost", "user/food"] }, ctx as any);
    expect(res.status).toBe("success");
    const content = (res as { content: string }).content;
    expect(content).toContain("user/food");
    expect(content).toContain("未找到");
  });

  it("returns error when all slugs unknown/loaded", async () => {
    registry.add("user/food", "active");
    const tool = createMemoryFetchTool({ store, registry });
    const res = await tool.execute({ slugs: ["user/food", "user/ghost"] }, ctx as any);
    expect(res.status).toBe("error");
  });
});

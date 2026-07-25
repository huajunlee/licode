import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SystemPrompt } from "../conversation/system-prompt.js";
import { MemoryLoader } from "./loader.js";
import { MemoryStore } from "./store.js";
import type { Memory } from "./types.js";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    slug: "user/test-preference",
    type: "user",
    name: "测试偏好",
    description: "用户偏好测试记忆",
    content: "The user prefers testing with vitest.",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("MemoryStore (new API)", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  // --- save ---

  it("saves a memory as a markdown file with YAML frontmatter in typed subdirectory", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);
    const mem = makeMemory();

    await store.save(mem);

    const filePath = path.join(dir, "user", "test-preference.md");
    expect(existsSync(filePath)).toBe(true);

    const raw = require("node:fs").readFileSync(filePath, "utf-8");
    expect(raw).toContain("---");
    expect(raw).toContain("name: 测试偏好");
    expect(raw).toContain("type: user");
    expect(raw).toContain("The user prefers testing with vitest.");
  });

  // --- append merge ---

  it("appends content when saving to an existing slug", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);
    const mem = makeMemory();

    await store.save(mem);
    // Save a second time with new content
    await store.save({
      ...makeMemory(),
      content: "Also the user prefers TypeScript.",
      description: "Updated preference",
    });

    const loaded = await store.load("user/test-preference");
    expect(loaded?.content).toContain("The user prefers testing with vitest.");
    expect(loaded?.content).toContain("Also the user prefers TypeScript.");
    expect(loaded?.description).toBe("Updated preference");
  });

  // --- load ---

  it("loads a single memory by slug", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);
    await store.save(makeMemory());

    const loaded = await store.load("user/test-preference");
    expect(loaded).not.toBeNull();
    expect(loaded?.slug).toBe("user/test-preference");
    expect(loaded?.type).toBe("user");
    expect(loaded?.name).toBe("测试偏好");
    expect(loaded?.content).toContain("vitest");
  });

  it("returns null when loading a non-existent slug", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);
    const loaded = await store.load("nonexistent/slug");
    expect(loaded).toBeNull();
  });

  // --- delete ---

  it("deletes a memory by slug", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);
    await store.save(makeMemory());

    await store.delete("user/test-preference");

    const filePath = path.join(dir, "user", "test-preference.md");
    expect(existsSync(filePath)).toBe(false);
    const loaded = await store.load("user/test-preference");
    expect(loaded).toBeNull();
  });

  // --- listAll ---

  it("lists all memories across all types", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);
    await store.save(makeMemory({ slug: "user/a", type: "user" }));
    await store.save(makeMemory({ slug: "user/b", type: "user" }));
    await store.save(makeMemory({
      slug: "project/init",
      type: "project",
      name: "项目初始",
      description: "项目初始化决策",
      content: "Use pnpm as package manager.",
    }));

    const all = await store.listAll();
    expect(all).toHaveLength(3);
    // Should be sorted by slug
    expect(all[0].slug).toBe("project/init");
    expect(all[1].slug).toBe("user/a");
    expect(all[2].slug).toBe("user/b");
  });

  it("returns empty array when no memories exist", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);
    const all = await store.listAll();
    expect(all).toHaveLength(0);
  });

  // --- MEMORY.md index ---

  it("generates MEMORY.md index after save", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);
    await store.save(makeMemory());

    const indexPath = path.join(dir, "MEMORY.md");
    expect(existsSync(indexPath)).toBe(true);

    const indexContent = require("node:fs").readFileSync(indexPath, "utf-8");
    expect(indexContent).toContain("# User Memory");
    expect(indexContent).toContain("[测试偏好](user/test-preference.md)");
    expect(indexContent).toContain("用户偏好测试记忆");
  });

  it("removes entry from MEMORY.md index after delete", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);
    await store.save(makeMemory());
    await store.delete("user/test-preference");

    const indexContent = await store.loadIndex();
    expect(indexContent).not.toContain("test-preference");
  });

  it("loadIndex returns empty string when no memories exist", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);
    const content = await store.loadIndex();
    expect(content).toBe("");
  });
});

describe("MemoryLoader (new behaviour)", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it("injects MEMORY.md index content into system prompt, not full memory bodies", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);

    await store.save(makeMemory({
      slug: "user/identity",
      name: "身份信息",
      description: "用户名和角色",
      content: "The user's name is huajun and they are a full-stack developer.",
    }));

    const systemPrompt = new SystemPrompt();
    const loader = new MemoryLoader(store);
    await loader.loadInto(systemPrompt);

    const memoryLayer = systemPrompt
      .getLayers()
      .find((layer) => layer.name === "memory");

    expect(memoryLayer).toBeDefined();
    expect(memoryLayer?.priority).toBe(5);
    // Should contain index line (description), not the full memory body
    expect(memoryLayer?.content).toContain("[身份信息](user/identity.md)");
    expect(memoryLayer?.content).toContain("用户名和角色");
    // Should NOT contain the full content body
    expect(memoryLayer?.content).not.toContain("full-stack developer");
  });

  it("does not add a memory layer when there are no memories", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);

    const systemPrompt = new SystemPrompt();
    const loader = new MemoryLoader(store);
    await loader.loadInto(systemPrompt);

    const memoryLayer = systemPrompt
      .getLayers()
      .find((layer) => layer.name === "memory");
    expect(memoryLayer).toBeUndefined();
  });
});

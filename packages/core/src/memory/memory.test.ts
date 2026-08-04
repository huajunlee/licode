import { mkdtempSync, rmSync, existsSync, utimesSync, writeFileSync, mkdirSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SystemPrompt } from "../conversation/system-prompt.js";
import { MemoryLoader } from "./loader.js";
import { MemoryStore, validateMemory } from "./store.js";
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

  it("save() skips a memory with invalid type and does not create a dir", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await store.save({ ...makeMemory(), type: "bogus" as Memory["type"], slug: "bogus/x" });
    expect(spy).toHaveBeenCalled();
    expect(existsSync(path.join(dir, "bogus"))).toBe(false);
    spy.mockRestore();
  });

  it("save() downgrades feedback missing Why/How to user (writes to user/ dir)", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);
    await store.save({
      ...makeMemory(),
      type: "feedback", slug: "feedback/use-pnpm",
      content: "用 pnpm 而非 npm",
    });
    expect(existsSync(path.join(dir, "feedback", "use-pnpm.md"))).toBe(false);
    expect(existsSync(path.join(dir, "user", "use-pnpm.md"))).toBe(true);
    const raw = readFileSync(path.join(dir, "user", "use-pnpm.md"), "utf-8");
    expect(raw).toContain("type: user");
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
    expect(indexContent).toContain("[测试偏好](");
    expect(indexContent).toContain("](user/test-preference.md)");
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

describe("MemoryStore actions", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  // --- update ---

  it("update replaces content, preserves createdAt, refreshes updatedAt", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);
    await store.save(makeMemory({
      content: "用户喜欢红烧排骨。",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));

    await store.save(makeMemory({
      content: "用户不再吃红烧排骨了。",
      updatedAt: "2026-06-01T00:00:00.000Z",
    }), "update");

    const loaded = await store.load("user/test-preference");
    expect(loaded?.content).toBe("用户不再吃红烧排骨了。");
    expect(loaded?.content).not.toContain("喜欢红烧排骨");
    expect(loaded?.createdAt).toBe("2026-01-01T00:00:00.000Z");
    // updatedAt must be refreshed by the store, not taken from the input
    expect(loaded?.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
    expect(loaded?.updatedAt).not.toBe("2026-06-01T00:00:00.000Z");
  });

  it("update on a non-existent slug creates the file", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);

    await store.save(makeMemory(), "update");

    const loaded = await store.load("user/test-preference");
    expect(loaded).not.toBeNull();
    expect(loaded?.content).toContain("vitest");
  });

  // --- append ---

  it("append adds new paragraphs and skips duplicate paragraphs", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);
    await store.save(makeMemory({ content: "段落一。\n\n段落二。" }));

    await store.save(makeMemory({ content: "段落二。\n\n段落三。" }), "append");

    const loaded = await store.load("user/test-preference");
    expect(loaded?.content).toBe("段落一。\n\n段落二。\n\n段落三。");
  });

  // --- create fallback ---

  it("create on an existing slug falls back to append (keeps old content)", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);
    await store.save(makeMemory({ content: "旧内容。" }));

    await store.save(makeMemory({ content: "新内容。" }), "create");

    const loaded = await store.load("user/test-preference");
    expect(loaded?.content).toContain("旧内容。");
    expect(loaded?.content).toContain("新内容。");
  });

  it("save without action defaults to create semantics (legacy append-merge)", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);
    await store.save(makeMemory({ content: "第一段。" }));

    await store.save(makeMemory({ content: "第二段。" }));

    const loaded = await store.load("user/test-preference");
    expect(loaded?.content).toContain("第一段。");
    expect(loaded?.content).toContain("第二段。");
  });

  // --- rebuildIndex ---

  it("rebuildIndex picks up files written directly to disk (bypassing save)", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);
    mkdirSync(path.join(dir, "user"), { recursive: true });
    writeFileSync(path.join(dir, "user", "direct-write.md"), [
      "---",
      "name: 直接写入",
      "description: 绕过 save 的文件",
      "type: user",
      "createdAt: 2026-01-01T00:00:00.000Z",
      "updatedAt: 2026-01-01T00:00:00.000Z",
      "---",
      "",
      "正文",
      "",
    ].join("\n"));

    await store.rebuildIndex();

    const index = await store.loadIndex();
    expect(index).toContain("[直接写入](user/direct-write.md)");
    expect(index).toContain("绕过 save 的文件");
  });

  it("rebuildIndex tolerates files with broken frontmatter", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);
    mkdirSync(path.join(dir, "project"), { recursive: true });
    writeFileSync(path.join(dir, "project", "no-frontmatter.md"), "没有 frontmatter 的正文\n");

    await expect(store.rebuildIndex()).resolves.toBeUndefined();

    const index = await store.loadIndex();
    expect(index).toContain("no-frontmatter");
  });

  it("generates index with relative paths", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);
    await store.save(makeMemory());

    const index = await store.loadIndex();
    expect(index).toContain("- [测试偏好](user/test-preference.md) — 用户偏好测试记忆");
    expect(index).not.toContain(dir);
  });

  // --- hasChangesSince ---

  it("hasChangesSince returns true only when a memory file mtime >= threshold", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);
    await store.save(makeMemory());
    const filePath = path.join(dir, "user", "test-preference.md");

    const threshold = Date.now() + 60_000;
    // All memory files are older than the threshold
    const past = new Date(threshold - 120_000);
    utimesSync(filePath, past, past);
    expect(await store.hasChangesSince(threshold)).toBe(false);

    // Move one file's mtime beyond the threshold
    const future = new Date(threshold + 1_000);
    utimesSync(filePath, future, future);
    expect(await store.hasChangesSince(threshold)).toBe(true);
  });

  it("hasChangesSince ignores the MEMORY.md index file", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);
    await store.save(makeMemory());

    const threshold = Date.now() + 60_000;
    const past = new Date(threshold - 120_000);
    utimesSync(path.join(dir, "user", "test-preference.md"), past, past);
    // MEMORY.md is newer than the threshold — must not affect the result
    const future = new Date(threshold + 60_000);
    utimesSync(path.join(dir, "MEMORY.md"), future, future);

    expect(await store.hasChangesSince(threshold)).toBe(false);
  });

  it("hasChangesSince returns false when the memory directory does not exist", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(path.join(dir, "nonexistent"));
    expect(await store.hasChangesSince(Date.now())).toBe(false);
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
    expect(memoryLayer?.content).toContain("[身份信息](");
    expect(memoryLayer?.content).toContain("](user/identity.md)");
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

describe("MemoryStore usage tracking (Phase 4)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-usage-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parse reads usageCount/lastUsedAt; missing -> 0/empty", async () => {
    const store = new MemoryStore(dir);
    await store.save(makeMemory({ slug: "user/a" }));
    const m = await store.load("user/a");
    expect(m?.usageCount).toBe(0);
    expect(m?.lastUsedAt).toBe("");
  });

  it("save(create) writes usage fields (0/empty for new memory)", async () => {
    const store = new MemoryStore(dir);
    await store.save(makeMemory({ slug: "user/a" }));
    const raw = require("node:fs").readFileSync(
      path.join(dir, "user", "a.md"),
      "utf-8"
    );
    expect(raw).toContain("usageCount: 0");
    expect(raw).toContain("lastUsedAt:");
  });

  it("save(update) preserves existing usage (does not reset)", async () => {
    const store = new MemoryStore(dir);
    await store.save(makeMemory({ slug: "user/a" }));
    await store.recordUsage("user/a"); // -> usageCount=1, lastUsedAt=now
    const before = await store.load("user/a");
    await store.save(makeMemory({ slug: "user/a", content: "新内容" }), "update");
    const after = await store.load("user/a");
    expect(after?.content).toBe("新内容");
    expect(after?.usageCount).toBe(before!.usageCount);
    expect(after?.lastUsedAt).toBe(before!.lastUsedAt);
  });

  it("recordUsage increments usageCount, sets lastUsedAt, preserves content + updatedAt", async () => {
    const store = new MemoryStore(dir);
    await store.save(
      makeMemory({
        slug: "user/a",
        content: "正文",
        updatedAt: "2026-07-01T00:00:00Z",
      })
    );
    await store.recordUsage("user/a");
    const m = await store.load("user/a");
    expect(m?.usageCount).toBe(1);
    expect(m?.lastUsedAt).toBeTruthy();
    expect(m?.content).toBe("正文");
    expect(m?.updatedAt).toBe("2026-07-01T00:00:00Z"); // 不被计数改写
  });

  it("recordUsage does NOT rebuildIndex (MEMORY.md untouched)", async () => {
    const store = new MemoryStore(dir);
    await store.save(makeMemory({ slug: "user/a" }));
    const idxPath = path.join(dir, "MEMORY.md");
    const idxMtimeBefore = statSync(idxPath).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));
    await store.recordUsage("user/a");
    expect(statSync(idxPath).mtimeMs).toBe(idxMtimeBefore); // 索引未重写
  });

  it("recordUsage restores mtime -> invisible to hasChangesSince (坑回归)", async () => {
    const store = new MemoryStore(dir);
    await store.save(makeMemory({ slug: "user/a" }));
    const filePath = path.join(dir, "user", "a.md");
    const mtimeBefore = statSync(filePath).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));
    const loopStartedAt = Date.now(); // 模拟 handleSubmit 置位
    await new Promise((r) => setTimeout(r, 10));
    await store.recordUsage("user/a");
    // mtime 恢复到写入前（< loopStartedAt）
    expect(statSync(filePath).mtimeMs).toBe(mtimeBefore);
    expect(await store.hasChangesSince(loopStartedAt)).toBe(false);
    // 但 usage 确实记录了
    expect((await store.load("user/a"))?.usageCount).toBe(1);
  });

  it("recordUsage on missing slug is a silent no-op", async () => {
    const store = new MemoryStore(dir);
    await expect(store.recordUsage("user/ghost")).resolves.toBeUndefined();
  });
});

describe("MemoryStore archive/restore (Phase 4)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-archive-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("archive moves file to archive/<type>/ and drops from index", async () => {
    const store = new MemoryStore(dir);
    await store.save(makeMemory({ slug: "user/old" }));
    await store.archive("user/old");
    expect(existsSync(path.join(dir, "user", "old.md"))).toBe(false);
    expect(existsSync(path.join(dir, "archive", "user", "old.md"))).toBe(true);
    expect(await store.load("user/old")).toBeNull(); // listAll/load 不扫 archive/
    await store.rebuildIndex();
    expect((await store.loadIndex()).includes("user/old")).toBe(false);
  });

  it("archive on missing slug is a no-op", async () => {
    const store = new MemoryStore(dir);
    await expect(store.archive("user/ghost")).resolves.toBeUndefined();
  });

  it("listArchived lists archived memories (with usage fields)", async () => {
    const store = new MemoryStore(dir);
    await store.save(makeMemory({ slug: "user/old" }));
    await store.archive("user/old");
    const archived = await store.listArchived();
    expect(archived).toHaveLength(1);
    expect(archived[0].slug).toBe("user/old");
  });

  it("listArchived returns [] when no archive dir", async () => {
    const store = new MemoryStore(dir);
    expect(await store.listArchived()).toEqual([]);
  });

  it("restore moves back to <type>/ and re-indexes", async () => {
    const store = new MemoryStore(dir);
    await store.save(makeMemory({ slug: "user/old" }));
    await store.archive("user/old");
    const restored = await store.restore("user/old");
    expect(restored?.slug).toBe("user/old");
    expect(existsSync(path.join(dir, "user", "old.md"))).toBe(true);
    expect(existsSync(path.join(dir, "archive", "user", "old.md"))).toBe(false);
    expect((await store.loadIndex()).includes("user/old")).toBe(true);
  });

  it("restore on missing slug returns null", async () => {
    const store = new MemoryStore(dir);
    expect(await store.restore("user/ghost")).toBeNull();
  });
});

describe("MemoryStore date normalization", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; }
    vi.useRealTimers();
  });

  it("save normalizes relative dates in content AND description", async () => {
    vi.useFakeTimers({ now: new Date(2026, 7, 1) });
    dir = mkdtempSync(path.join(tmpdir(), "licode-norm-"));
    const store = new MemoryStore(dir);
    const mem = makeMemory({
      slug: "project/launch",
      type: "project",
      content: "用户去年启动了项目，上个月完成评审。",
      description: "去年定的方案",
    });
    await store.save(mem);
    const raw = readFileSync(path.join(dir, "project", "launch.md"), "utf-8");
    expect(raw).toContain("2025年");
    expect(raw).toContain("2026年7月");
    expect(raw).not.toContain("去年");
    expect(raw).not.toContain("上个月");
  });

  it("save seals the description blind spot (description-only relative date)", async () => {
    vi.useFakeTimers({ now: new Date(2026, 7, 5) }); // 2026-08-05 Wed
    dir = mkdtempSync(path.join(tmpdir(), "licode-norm-"));
    const store = new MemoryStore(dir);
    const mem = makeMemory({
      slug: "project/progress",
      type: "project",
      content: "无相对日期的正文。",
      description: "上周的进展",
    });
    await store.save(mem);
    const raw = readFileSync(path.join(dir, "project", "progress.md"), "utf-8");
    // 上周 of 2026-08-05 -> 2026-07-27~2026-08-02
    expect(raw).toContain("2026-07-27~2026-08-02");
    expect(raw).not.toContain("上周");
  });

  it("save is idempotent across rewrites (no drift with later now)", async () => {
    vi.useFakeTimers({ now: new Date(2026, 7, 1) });
    dir = mkdtempSync(path.join(tmpdir(), "licode-norm-"));
    const store = new MemoryStore(dir);
    await store.save(makeMemory({
      slug: "project/launch", type: "project",
      content: "去年启动", description: "去年方案",
    }), "create");
    // 6 个月后 update 同一文件，旧已绝对化的日期不被新 now 重算
    vi.useFakeTimers({ now: new Date(2027, 1, 1) });
    await store.save(makeMemory({
      slug: "project/launch", type: "project",
      content: "2025年启动，新增内容", description: "2025年方案",
    }), "update");
    const raw = readFileSync(path.join(dir, "project", "launch.md"), "utf-8");
    expect(raw).toContain("2025年启动");
    expect(raw).not.toContain("去年");
  });

  it("save also normalizes the name field", async () => {
    vi.useFakeTimers({ now: new Date(2026, 7, 1) });
    dir = mkdtempSync(path.join(tmpdir(), "licode-norm-"));
    const store = new MemoryStore(dir);
    await store.save(makeMemory({
      slug: "project/launch", type: "project",
      name: "今年启动的项目",
      content: "正文",
      description: "desc",
    }));
    const raw = readFileSync(path.join(dir, "project", "launch.md"), "utf-8");
    expect(raw).toContain("2026年启动的项目");
    expect(raw).not.toContain("今年");
  });
});

describe("MemoryStore.normalizeChangedSince (Write-path safety net)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; }
    vi.useRealTimers();
  });

  const NOW = new Date(2026, 7, 1); // 2026-08-01 local
  const PAST = new Date(2026, 0, 1); // 2026-01-01 local

  // Simulate the agent writing a memory file directly with the Write tool
  // (bypassing save), leaving "今年" unconverted in name/description/content.
  function writeDirect(filePath: string, name: string, description: string, content: string, pinned = false): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      `---\nname: ${name}\ndescription: ${description}\ntype: user\ncreatedAt: 2026-08-01\nupdatedAt: 2026-08-01\npinned: ${pinned}\n---\n\n${content}\n`,
      "utf-8"
    );
  }

  it("normalizes name+description+content of a directly-written file and preserves pinned", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-ncs-"));
    const store = new MemoryStore(dir);
    const filePath = path.join(dir, "user", "competition-goal.md");
    writeDirect(filePath, "今年目标", "用户今年的核心目标", "用户今年的目标是夺得头等奖。", true);
    utimesSync(filePath, NOW, NOW);
    await store.normalizeChangedSince(NOW.getTime() - 1000, NOW);
    const raw = readFileSync(filePath, "utf-8");
    expect(raw).toContain("2026年");
    expect(raw).not.toContain("今年");
    expect(raw).toContain("pinned: true");
  });

  it("preserves mtime (invisible to hasChangesSince)", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-ncs-"));
    const store = new MemoryStore(dir);
    const filePath = path.join(dir, "user", "goal.md");
    writeDirect(filePath, "今年目标", "d", "今年做事");
    utimesSync(filePath, NOW, NOW);
    const mtimeBefore = statSync(filePath).mtimeMs;
    await store.normalizeChangedSince(NOW.getTime() - 1000, NOW);
    expect(statSync(filePath).mtimeMs).toBe(mtimeBefore);
  });

  it("leaves unchanged files alone (mtime < tsMs)", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-ncs-"));
    const store = new MemoryStore(dir);
    const filePath = path.join(dir, "user", "old.md");
    writeDirect(filePath, "今年目标", "d", "今年做事");
    utimesSync(filePath, PAST, PAST); // old mtime
    await store.normalizeChangedSince(NOW.getTime(), NOW); // tsMs > PAST -> unchanged
    const raw = readFileSync(filePath, "utf-8");
    expect(raw).toContain("今年"); // not normalized
  });

  it("skips files with no relative dates (no rewrite, mtime preserved)", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-ncs-"));
    const store = new MemoryStore(dir);
    const filePath = path.join(dir, "user", "clean.md");
    writeDirect(filePath, "纯净标题", "无日期", "普通正文。");
    utimesSync(filePath, NOW, NOW);
    const mtimeBefore = statSync(filePath).mtimeMs;
    await store.normalizeChangedSince(NOW.getTime() - 1000, NOW);
    const raw = readFileSync(filePath, "utf-8");
    expect(raw).toContain("纯净标题");
    expect(statSync(filePath).mtimeMs).toBe(mtimeBefore);
  });

  it("normalizeChangedSince downgrades an agent-written feedback file (missing Why/How) to user/", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const fbPath = path.join(dir, "feedback", "use-pnpm.md");
    mkdirSync(path.join(dir, "feedback"), { recursive: true });
    writeFileSync(fbPath, [
      "---", "name: 用pnpm", "description: d", "type: feedback",
      "createdAt: 2026-08-04T00:00:00.000Z", "updatedAt: 2026-08-04T00:00:00.000Z",
      "---", "", "用 pnpm 而非 npm", "",
    ].join("\n"));
    const ts = Date.now() - 1000;
    const store = new MemoryStore(dir);
    await store.normalizeChangedSince(ts);
    expect(existsSync(fbPath)).toBe(false);
    expect(existsSync(path.join(dir, "user", "use-pnpm.md"))).toBe(true);
    const raw = readFileSync(path.join(dir, "user", "use-pnpm.md"), "utf-8");
    expect(raw).toContain("type: user");
  });
});

describe("validateMemory", () => {
  const base: Memory = {
    slug: "user/x", type: "user", name: "n", description: "d",
    content: "c", createdAt: "2026-08-04T00:00:00.000Z", updatedAt: "2026-08-04T00:00:00.000Z",
  };

  it("rejects type not in the four valid types", () => {
    const r = validateMemory({ ...base, type: "foo" as Memory["type"] });
    expect(r.ok).toBe(false);
  });

  it("passes a valid user memory unchanged", () => {
    const r = validateMemory(base);
    expect(r).toEqual({ ok: true, type: "user", slug: "user/x" });
  });

  it("downgrades feedback missing Why:/How to apply: to user (slug prefix fixed)", () => {
    const r = validateMemory({ ...base, type: "feedback", slug: "feedback/use-pnpm", content: "用 pnpm" });
    expect(r.ok).toBe(true);
    expect(r.type).toBe("user");
    expect(r.slug).toBe("user/use-pnpm");
  });

  it("keeps feedback that has both Why: and How to apply: as feedback", () => {
    const r = validateMemory({
      ...base, type: "feedback", slug: "feedback/use-pnpm",
      content: "用 pnpm\nWhy: 用户要求\nHow to apply: 安装时用 pnpm",
    });
    expect(r).toEqual({ ok: true, type: "feedback", slug: "feedback/use-pnpm" });
  });
});

describe("MemoryStore keywords (Phase B)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it("save() writes keywords frontmatter and load() reads them back", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);
    await store.save({ ...makeMemory(), keywords: ["pnpm", "包管理器"] });
    const loaded = await store.load("user/test-preference");
    expect(loaded?.keywords).toEqual(["pnpm", "包管理器"]);
  });

  it("load() tolerates missing keywords (old memories) -> undefined", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(dir);
    // 手写一个无 keywords 的旧记忆文件
    const fp = path.join(dir, "user", "old.md");
    mkdirSync(path.join(dir, "user"), { recursive: true });
    writeFileSync(fp, ["---", "name: old", "description: d", "type: user",
      "createdAt: 2026-01-01T00:00:00.000Z", "updatedAt: 2026-01-01T00:00:00.000Z", "---", "", "c", ""].join("\n"));
    const loaded = await store.load("user/old");
    expect(loaded?.keywords).toBeUndefined();
  });

  it("load() tolerates malformed keywords frontmatter -> undefined", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const fp = path.join(dir, "user", "bad.md");
    mkdirSync(path.join(dir, "user"), { recursive: true });
    writeFileSync(fp, ["---", "name: bad", "description: d", "type: user",
      "keywords: not-json", "createdAt: 2026-01-01T00:00:00.000Z", "updatedAt: 2026-01-01T00:00:00.000Z",
      "---", "", "c", ""].join("\n"));
    const store = new MemoryStore(dir);
    const loaded = await store.load("user/bad");
    expect(loaded?.keywords).toBeUndefined();
  });
});

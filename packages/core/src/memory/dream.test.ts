import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  createMemoryDreamState,
  MemoryDream,
  acquireLock,
  releaseLock,
  readState,
  writeState,
} from "./dream.js";
import { MemoryStore } from "./store.js";
import type { Memory } from "./types.js";

vi.mock("../llm/anthropic.js", () => ({
  AnthropicProvider: vi.fn().mockImplementation(() => ({
    name: "mock",
    maxContextTokens: 200000,
    chat: vi.fn(),
    stream: vi.fn(),
    countTokens: vi.fn(() => 0),
  })),
}));

function makeMemory(slug: string): Memory {
  return {
    slug,
    type: slug.split("/")[0] as Memory["type"],
    name: slug,
    description: `${slug} desc`,
    content: `${slug} 正文`,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
  };
}

describe("lock & state files", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "dream-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("acquireLock succeeds when no lock exists", async () => {
    const lock = path.join(dir, ".dream.lock");
    expect(await acquireLock(lock, 30000)).toBe(true);
  });

  it("acquireLock fails when a fresh lock exists", async () => {
    const lock = path.join(dir, ".dream.lock");
    expect(await acquireLock(lock, 30000)).toBe(true);
    expect(await acquireLock(lock, 30000)).toBe(false);
  });

  it("acquireLock overwrites an expired lock", async () => {
    const lock = path.join(dir, ".dream.lock");
    writeFileSync(lock, JSON.stringify({ pid: 1, acquiredAt: Date.now() - 60000 }));
    expect(await acquireLock(lock, 30000)).toBe(true);
  });

  it("releaseLock removes the lock", async () => {
    const lock = path.join(dir, ".dream.lock");
    await acquireLock(lock, 30000);
    await releaseLock(lock);
    expect(await acquireLock(lock, 30000)).toBe(true);
  });

  it("readState returns 0 when no state file", async () => {
    expect(await readState(path.join(dir, ".dream.state"))).toBe(0);
  });

  it("writeState/readState round-trip", async () => {
    const sp = path.join(dir, ".dream.state");
    await writeState(sp, 12345);
    expect(await readState(sp)).toBe(12345);
  });
});

describe("MemoryDream.shouldDream", () => {
  let memoryDir: string;
  let sessionsDir: string;
  beforeEach(() => {
    memoryDir = mkdtempSync(path.join(tmpdir(), "dream-mem-"));
    sessionsDir = mkdtempSync(path.join(tmpdir(), "dream-ses-"));
  });
  afterEach(() => {
    rmSync(memoryDir, { recursive: true, force: true });
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  function makeSession(id: string, updatedAtIso: string) {
    writeFileSync(
      path.join(sessionsDir, `${id}.json`),
      JSON.stringify({
        id,
        createdAt: updatedAtIso,
        updatedAt: updatedAtIso,
        model: "m",
        totalTokens: 0,
        messageCount: 0,
        systemPromptLayers: [],
        messages: [],
        metadata: { model: "m", createdAt: updatedAtIso, updatedAt: updatedAtIso },
      })
    );
  }

  it("returns false when < minIntervalMs since last consolidation", async () => {
    const dream = new MemoryDream({ minIntervalMs: 24 * 3600 * 1000, minNewSessions: 5 });
    await writeState(path.join(memoryDir, ".dream.state"), Date.now() - 1000); // 1s ago
    makeSession("s1", new Date().toISOString());
    expect(await dream.shouldDream(sessionsDir, memoryDir)).toBe(false);
  });

  it("returns false when enough time but < minNewSessions", async () => {
    const dream = new MemoryDream({ minIntervalMs: 1000, minNewSessions: 5 });
    await writeState(path.join(memoryDir, ".dream.state"), Date.now() - 2000);
    for (let i = 0; i < 4; i++) makeSession(`s${i}`, new Date().toISOString());
    expect(await dream.shouldDream(sessionsDir, memoryDir)).toBe(false);
  });

  it("returns true when ≥ minIntervalMs and ≥ minNewSessions", async () => {
    const dream = new MemoryDream({ minIntervalMs: 1000, minNewSessions: 5 });
    await writeState(path.join(memoryDir, ".dream.state"), Date.now() - 2000);
    for (let i = 0; i < 5; i++) makeSession(`s${i}`, new Date().toISOString());
    expect(await dream.shouldDream(sessionsDir, memoryDir)).toBe(true);
  });

  it("counts only sessions updated after lastConsolidatedAt (new-session口径)", async () => {
    const dream = new MemoryDream({ minIntervalMs: 1000, minNewSessions: 2 });
    const old = new Date(Date.now() - 10 * 86400 * 1000).toISOString();
    await writeState(path.join(memoryDir, ".dream.state"), Date.now() - 2000);
    makeSession("old1", old); // 未动过的旧 session，不计
    makeSession("old2", old);
    makeSession("new1", new Date().toISOString());
    makeSession("new2", new Date().toISOString());
    expect(await dream.shouldDream(sessionsDir, memoryDir)).toBe(true); // 只有 2 个新 session，刚好达标
  });

  it("returns false when sessions dir is empty", async () => {
    const dream = new MemoryDream({ minIntervalMs: 1000, minNewSessions: 1 });
    await writeState(path.join(memoryDir, ".dream.state"), Date.now() - 2000);
    expect(await dream.shouldDream(sessionsDir, memoryDir)).toBe(false);
  });
});

describe("MemoryDream.orient", () => {
  it("parses suspicions and includes existing memory content in the prompt", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dream-orient-"));
    try {
      const store = new MemoryStore(dir);
      await store.save(makeMemory("user/food"));
      const dream = new MemoryDream();
      (dream as any).llm.chat = vi.fn().mockResolvedValue({
        content: '```json\n[{"slug":"user/food","keywords":["红烧排骨","喜欢"],"reason":"可能漂移"}]\n```',
        usage: { input: 1, output: 1 },
        model: "mock",
        stopReason: "end_turn",
      });
      const suspicions = await (dream as any).orient(store);
      expect(suspicions).toEqual([
        { slug: "user/food", keywords: ["红烧排骨", "喜欢"], reason: "可能漂移" },
      ]);
      const prompt = (dream as any).llm.chat.mock.calls[0][0].messages[0].content as string;
      expect(prompt).toContain("user/food 正文");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops suspicions with hallucinated slugs", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dream-orient2-"));
    try {
      const store = new MemoryStore(dir);
      await store.save(makeMemory("user/food"));
      const dream = new MemoryDream();
      (dream as any).llm.chat = vi.fn().mockResolvedValue({
        content: '[{"slug":"user/ghost","keywords":["x"],"reason":"r"}]',
        usage: { input: 1, output: 1 },
        model: "mock",
        stopReason: "end_turn",
      });
      expect(await (dream as any).orient(store)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MemoryDream.gather", () => {
  it("only searches messages newer than lastConsolidatedAt and captures keyword hits + neighbor", async () => {
    const sessionsDir = mkdtempSync(path.join(tmpdir(), "dream-gather-"));
    try {
      const oldTs = "2026-07-01T00:00:00Z";
      const newTs = new Date().toISOString();
      writeFileSync(
        path.join(sessionsDir, "s1.json"),
        JSON.stringify({
          id: "s1",
          createdAt: oldTs,
          updatedAt: newTs,
          model: "m",
          totalTokens: 0,
          messageCount: 3,
          systemPromptLayers: [],
          metadata: { model: "m", createdAt: oldTs, updatedAt: newTs },
          messages: [
            { role: "user", content: "旧消息 红烧排骨", timestamp: oldTs },
            { role: "assistant", content: "好的", timestamp: oldTs },
            { role: "user", content: "我现在不喜欢红烧排骨了", timestamp: newTs },
          ],
        })
      );
      const dream = new MemoryDream();
      const evidence = await (dream as any).gather(
        [{ slug: "user/food", keywords: ["红烧排骨"], reason: "r" }],
        sessionsDir,
        Date.parse("2026-07-15T00:00:00Z")
      );
      const snippets = evidence.get("user/food");
      expect(snippets).toBeDefined();
      expect(snippets.length).toBeGreaterThan(0);
      expect(snippets[0]).toContain("不喜欢红烧排骨");
      expect(snippets[0]).not.toContain("旧消息"); // 旧消息不进证据（除非作为相邻上下文）
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it("returns empty map when no keyword hits", async () => {
    const sessionsDir = mkdtempSync(path.join(tmpdir(), "dream-gather2-"));
    try {
      const newTs = new Date().toISOString();
      writeFileSync(
        path.join(sessionsDir, "s1.json"),
        JSON.stringify({
          id: "s1",
          createdAt: newTs,
          updatedAt: newTs,
          model: "m",
          totalTokens: 0,
          messageCount: 1,
          systemPromptLayers: [],
          metadata: { model: "m", createdAt: newTs, updatedAt: newTs },
          messages: [{ role: "user", content: "无关内容", timestamp: newTs }],
        })
      );
      const dream = new MemoryDream();
      const evidence = await (dream as any).gather(
        [{ slug: "user/food", keywords: ["红烧排骨"], reason: "r" }],
        sessionsDir,
        Date.now() - 2000
      );
      expect(evidence.size).toBe(0);
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });
});

function fsExists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

describe("MemoryDream.dream (consolidate + prune)", () => {
  let memoryDir: string;
  let sessionsDir: string;
  beforeEach(() => {
    memoryDir = mkdtempSync(path.join(tmpdir(), "dream-c-mem-"));
    sessionsDir = mkdtempSync(path.join(tmpdir(), "dream-c-ses-"));
  });
  afterEach(() => {
    rmSync(memoryDir, { recursive: true, force: true });
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  it("applies update from consolidate and updates state on success", async () => {
    const store = new MemoryStore(memoryDir);
    await store.save(makeMemory("user/food"));
    const dream = new MemoryDream({ minIntervalMs: 1, minNewSessions: 1 });
    (dream as any).llm.chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '[{"slug":"user/food","keywords":["红烧排骨"],"reason":"r"}]',
        usage: { input: 1, output: 1 },
        model: "mock",
        stopReason: "end_turn",
      })
      .mockResolvedValueOnce({
        content:
          '[{"action":"update","slug":"user/food","type":"user","name":"食物偏好","description":"d","content":"不喜欢红烧排骨"}]',
        usage: { input: 1, output: 1 },
        model: "mock",
        stopReason: "end_turn",
      });
    await dream.dream(store, sessionsDir, memoryDir);
    const updated = await store.load("user/food");
    expect(updated?.content).toBe("不喜欢红烧排骨");
    expect(await readState(path.join(memoryDir, ".dream.state"))).toBeGreaterThan(0);
  });

  it("backs up before delete and removes the file", async () => {
    const store = new MemoryStore(memoryDir);
    await store.save(makeMemory("user/food"));
    const dream = new MemoryDream({ minIntervalMs: 1, minNewSessions: 1 });
    (dream as any).llm.chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '[{"slug":"user/food","keywords":["x"],"reason":"r"}]',
        usage: { input: 1, output: 1 },
        model: "mock",
        stopReason: "end_turn",
      })
      .mockResolvedValueOnce({
        content: '[{"action":"delete","slug":"user/food","reason":"失效"}]',
        usage: { input: 1, output: 1 },
        model: "mock",
        stopReason: "end_turn",
      });
    await dream.dream(store, sessionsDir, memoryDir);
    expect(await store.load("user/food")).toBeNull();
    expect(fsExists(path.join(memoryDir, ".dream-backup", "user", "food.md"))).toBe(true);
  });

  it("drops delete ops with hallucinated slug (no backup, no delete)", async () => {
    const store = new MemoryStore(memoryDir);
    await store.save(makeMemory("user/food"));
    const dream = new MemoryDream({ minIntervalMs: 1, minNewSessions: 1 });
    (dream as any).llm.chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '[{"slug":"user/food","keywords":["x"],"reason":"r"}]',
        usage: { input: 1, output: 1 },
        model: "mock",
        stopReason: "end_turn",
      })
      .mockResolvedValueOnce({
        content: '[{"action":"delete","slug":"user/ghost","reason":"r"}]',
        usage: { input: 1, output: 1 },
        model: "mock",
        stopReason: "end_turn",
      });
    await dream.dream(store, sessionsDir, memoryDir);
    expect(await store.load("user/food")).not.toBeNull();
  });

  it("never rejects when LLM throws (state not updated)", async () => {
    const store = new MemoryStore(memoryDir);
    await store.save(makeMemory("user/food"));
    const dream = new MemoryDream({ minIntervalMs: 1, minNewSessions: 1, timeoutMs: 50 });
    (dream as any).llm.chat = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(dream.dream(store, sessionsDir, memoryDir)).resolves.toBeUndefined();
    expect(await readState(path.join(memoryDir, ".dream.state"))).toBe(0);
  });
});

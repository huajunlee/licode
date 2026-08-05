import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  createMemoryDreamState,
  MemoryDream,
  createMemoryDreamHook,
  acquireLock,
  releaseLock,
  readState,
  writeState,
  isArchiveCandidate,
} from "./dream.js";
import { MemoryStore } from "./store.js";
import type { Memory } from "./types.js";
import type { PipelineEvent } from "../events/types.js";

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

  it("consolidate persists keywords from LLM response (backfill on update)", async () => {
    const store = new MemoryStore(memoryDir);
    await store.save(makeMemory("user/food"));
    const dream = new MemoryDream({ minIntervalMs: 1, minNewSessions: 1 });
    (dream as any).llm.chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: "[]",
        usage: { input: 1, output: 1 },
        model: "mock",
        stopReason: "end_turn",
      })
      .mockResolvedValueOnce({
        content:
          '[{"action":"update","slug":"user/food","type":"user","name":"食物偏好","description":"d","content":"不喜欢红烧排骨","keywords":["红烧排骨","口味"]}]',
        usage: { input: 1, output: 1 },
        model: "mock",
        stopReason: "end_turn",
      });
    await dream.dream(store, sessionsDir, memoryDir);
    const updated = await store.load("user/food");
    expect(updated?.content).toBe("不喜欢红烧排骨");
    expect(updated?.keywords).toEqual(["红烧排骨", "口味"]);
  });

  it("consolidate prompt contains the type decision tree (feedback->reference->project->user)", async () => {
    const store = new MemoryStore(memoryDir);
    await store.save(makeMemory("user/food"));
    const dream = new MemoryDream({ minIntervalMs: 1, minNewSessions: 1 });
    let capturedConsolidatePrompt = "";
    (dream as any).llm.chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '[{"slug":"user/food","keywords":["红烧排骨"],"reason":"r"}]',
        usage: { input: 1, output: 1 },
        model: "mock",
        stopReason: "end_turn",
      })
      .mockImplementationOnce(async (req: { messages: Array<{ content: string }> }) => {
        capturedConsolidatePrompt = req.messages[0].content;
        return { content: "[]", usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn" };
      });
    await dream.dream(store, sessionsDir, memoryDir);
    expect(capturedConsolidatePrompt).toMatch(/feedback.*reference.*project.*user/s);
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
    await expect(dream.dream(store, sessionsDir, memoryDir)).resolves.toEqual([]);
    expect(await readState(path.join(memoryDir, ".dream.state"))).toBe(0);
  });
});

describe("MemoryDream.parseDreamResponse keywords", () => {
  it("attaches valid keywords on create/update/append ops", () => {
    const dream = new MemoryDream();
    const ops = (dream as any).parseDreamResponse(
      '[{"action":"update","slug":"user/food","type":"user","name":"n","description":"d","content":"c","keywords":["k1","k2"]}]',
      new Set(["user/food"])
    );
    expect(ops).toHaveLength(1);
    expect(ops[0].keywords).toEqual(["k1", "k2"]);
  });

  it("tolerates missing keywords (op still valid, no keywords)", () => {
    const dream = new MemoryDream();
    const ops = (dream as any).parseDreamResponse(
      '[{"action":"create","slug":"user/food","type":"user","name":"n","description":"d","content":"c"}]',
      new Set()
    );
    expect(ops).toHaveLength(1);
    expect(ops[0].keywords).toBeUndefined();
  });

  it("tolerates malformed keywords (op still valid, no keywords)", () => {
    const dream = new MemoryDream();
    const ops = (dream as any).parseDreamResponse(
      '[{"action":"update","slug":"user/food","type":"user","name":"n","description":"d","content":"c","keywords":["ok",5,null]}]',
      new Set(["user/food"])
    );
    expect(ops).toHaveLength(1);
    expect(ops[0].keywords).toBeUndefined();
  });
});


describe("createMemoryDreamHook", () => {
  let memoryDir: string;
  let sessionsDir: string;
  beforeEach(() => {
    memoryDir = mkdtempSync(path.join(tmpdir(), "dream-hook-mem-"));
    sessionsDir = mkdtempSync(path.join(tmpdir(), "dream-hook-ses-"));
  });
  afterEach(() => {
    rmSync(memoryDir, { recursive: true, force: true });
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  function makeEvent(): PipelineEvent {
    return { type: "agent-loop-complete" } as unknown as PipelineEvent;
  }

  function seedNewSession(): void {
    const ts = new Date().toISOString();
    writeFileSync(
      path.join(sessionsDir, "s1.json"),
      JSON.stringify({
        id: "s1",
        createdAt: ts,
        updatedAt: ts,
        model: "m",
        totalTokens: 0,
        messageCount: 0,
        systemPromptLayers: [],
        messages: [],
        metadata: { model: "m", createdAt: ts, updatedAt: ts },
      })
    );
  }

  it("does not dream when shouldDream is false", async () => {
    const dream = new MemoryDream({ minIntervalMs: 24 * 3600 * 1000, minNewSessions: 5 });
    const spy = vi.spyOn(dream, "dream").mockResolvedValue([]);
    const state = createMemoryDreamState();
    const onStateChange = vi.fn();
    const hook = createMemoryDreamHook({
      dream,
      store: new MemoryStore(memoryDir),
      state,
      sessionsDir,
      memoryDir,
      onStateChange,
    });
    await hook(makeEvent());
    expect(spy).not.toHaveBeenCalled();
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it("fires dream fire-and-forget and signals state on start/end", async () => {
    const dream = new MemoryDream({ minIntervalMs: 1, minNewSessions: 1 });
    seedNewSession();
    await writeState(path.join(memoryDir, ".dream.state"), Date.now() - 2000);
    const spy = vi.spyOn(dream, "dream").mockImplementation(async () => []);
    const state = createMemoryDreamState();
    const onStateChange = vi.fn();
    const hook = createMemoryDreamHook({
      dream,
      store: new MemoryStore(memoryDir),
      state,
      sessionsDir,
      memoryDir,
      onStateChange,
    });
    await hook(makeEvent()); // fire-and-forget: hook returns immediately
    await new Promise((r) => setTimeout(r, 50)); // let background dream settle
    expect(spy).toHaveBeenCalled();
    expect(onStateChange).toHaveBeenCalledWith(true);
    expect(onStateChange).toHaveBeenCalledWith(false);
    expect(state.running).toBe(false);
    expect(await acquireLock(path.join(memoryDir, ".dream.lock"), 30000)).toBe(true); // 锁已释放
  });

  it("skips when already running (mutex)", async () => {
    const dream = new MemoryDream({ minIntervalMs: 1, minNewSessions: 1 });
    seedNewSession();
    await writeState(path.join(memoryDir, ".dream.state"), Date.now() - 2000);
    let resolveDream: (v: string[]) => void = () => {};
    const spy = vi.spyOn(dream, "dream").mockImplementation(
      () => new Promise<string[]>((r) => {
        resolveDream = r;
      })
    );
    const state = createMemoryDreamState();
    const hook = createMemoryDreamHook({
      dream,
      store: new MemoryStore(memoryDir),
      state,
      sessionsDir,
      memoryDir,
      onStateChange: () => {},
    });
    await hook(makeEvent());
    await hook(makeEvent()); // 第二次：running，应跳过
    expect(spy).toHaveBeenCalledTimes(1);
    resolveDream([]);
    await new Promise((r) => setTimeout(r, 20));
  });

  it("ignores non agent-loop-complete events", async () => {
    const dream = new MemoryDream();
    const spy = vi.spyOn(dream, "dream").mockResolvedValue([]);
    const hook = createMemoryDreamHook({
      dream,
      store: new MemoryStore(memoryDir),
      state: createMemoryDreamState(),
      sessionsDir,
      memoryDir,
      onStateChange: () => {},
    });
    await hook({ type: "user-message" } as unknown as PipelineEvent);
    expect(spy).not.toHaveBeenCalled();
  });
});

/** save(create) 默认 lastUsedAt=""，需手动 seed 旧值造归档候选。 */
async function seedLastUsedAt(store: MemoryStore, slug: string, lastUsedAt: string, usageCount = 1) {
  const m = await store.load(slug);
  if (!m) return;
  const storeDir = (store as unknown as Record<string, unknown>).dir as string;
  const file = path.join(storeDir, m.type, `${path.basename(slug)}.md`);
  writeFileSync(file, [
    "---", `name: ${m.name}`, `description: ${m.description}`, `type: ${m.type}`,
    `createdAt: ${m.createdAt}`, `updatedAt: ${m.updatedAt}`,
    `usageCount: ${usageCount}`, `lastUsedAt: ${lastUsedAt}`, "---", "", m.content, "",
  ].join("\n"));
}

describe("MemoryDream consolidate archive (Phase 4)", () => {
  let memoryDir: string;
  let sessionsDir: string;
  beforeEach(() => {
    memoryDir = mkdtempSync(path.join(tmpdir(), "dream-arc-mem-"));
    sessionsDir = mkdtempSync(path.join(tmpdir(), "dream-arc-ses-"));
  });
  afterEach(() => {
    rmSync(memoryDir, { recursive: true, force: true });
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  it("auto-archives a stale candidate when LLM emits nothing (default-archive)", async () => {
    const store = new MemoryStore(memoryDir);
    await store.save(makeMemory("user/old"));
    await seedLastUsedAt(store, "user/old", new Date(Date.now() - 35 * 86400 * 1000).toISOString());
    const dream = new MemoryDream({ minIntervalMs: 1, minNewSessions: 1, archiveThresholdMs: 30 * 86400 * 1000 });
    (dream as any).llm.chat = vi.fn()
      .mockResolvedValueOnce({ content: "[]", usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn" })
      .mockResolvedValueOnce({ content: "[]", usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn" });
    await dream.dream(store, sessionsDir, memoryDir);
    expect(await store.load("user/old")).toBeNull();
    expect(fsExists(path.join(memoryDir, "archive", "user", "old.md"))).toBe(true);
  });

  it("pinned candidate is not archived (hard protection)", async () => {
    const store = new MemoryStore(memoryDir);
    await store.save(makeMemory("user/old"));
    await seedLastUsedAt(store, "user/old", new Date(Date.now() - 35 * 86400 * 1000).toISOString());
    await store.setPinned("user/old", true); // pinned -> never a candidate
    const dream = new MemoryDream({ minIntervalMs: 1, minNewSessions: 1, archiveThresholdMs: 30 * 86400 * 1000 });
    (dream as any).llm.chat = vi.fn()
      .mockResolvedValueOnce({ content: "[]", usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn" })
      .mockResolvedValueOnce({ content: "[]", usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn" });
    const archived = await dream.dream(store, sessionsDir, memoryDir);
    expect(archived).toEqual([]); // nothing archived
    expect(await store.load("user/old")).not.toBeNull(); // still active
    expect(fsExists(path.join(memoryDir, "archive", "user", "old.md"))).toBe(false);
  });

  it("archives all candidates when LLM returns [] (default-archive)", async () => {
    const store = new MemoryStore(memoryDir);
    await store.save(makeMemory("user/old1"));
    await store.save(makeMemory("user/old2"));
    await seedLastUsedAt(store, "user/old1", new Date(Date.now() - 35 * 86400 * 1000).toISOString());
    await seedLastUsedAt(store, "user/old2", new Date(Date.now() - 40 * 86400 * 1000).toISOString());
    const dream = new MemoryDream({ minIntervalMs: 1, minNewSessions: 1, archiveThresholdMs: 30 * 86400 * 1000 });
    (dream as any).llm.chat = vi.fn()
      .mockResolvedValueOnce({ content: "[]", usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn" })
      .mockResolvedValueOnce({ content: "[]", usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn" });
    await dream.dream(store, sessionsDir, memoryDir);
    expect(await store.load("user/old1")).toBeNull();
    expect(await store.load("user/old2")).toBeNull();
  });

  it("delete op on a candidate takes precedence over auto-archive", async () => {
    const store = new MemoryStore(memoryDir);
    await store.save(makeMemory("user/old"));
    await seedLastUsedAt(store, "user/old", new Date(Date.now() - 35 * 86400 * 1000).toISOString());
    const dream = new MemoryDream({ minIntervalMs: 1, minNewSessions: 1, archiveThresholdMs: 30 * 86400 * 1000 });
    (dream as any).llm.chat = vi.fn()
      .mockResolvedValueOnce({ content: "[]", usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn" })
      .mockResolvedValueOnce({ content: '[{"action":"delete","slug":"user/old","reason":"失效"}]', usage: { input: 1, output: 1 }, model: "mock", stopReason: "end_turn" });
    await dream.dream(store, sessionsDir, memoryDir);
    expect(await store.load("user/old")).toBeNull();
    expect(fsExists(path.join(memoryDir, "archive", "user", "old.md"))).toBe(false);
    expect(fsExists(path.join(memoryDir, ".dream-backup", "user", "old.md"))).toBe(true);
  });

  it("isArchiveCandidate: never-used is not a candidate; stale is; pinned is not", async () => {
    const store = new MemoryStore(memoryDir);
    await store.save(makeMemory("user/never")); // lastUsedAt="" (默认)
    const now = Date.now();
    const all = await store.listAll();
    expect(all.filter((m) => isArchiveCandidate(m, now, 1)).map((m) => m.slug)).toEqual([]);
    await seedLastUsedAt(store, "user/never", new Date(Date.now() - 2 * 86400 * 1000).toISOString());
    const all2 = await store.listAll();
    expect(all2.filter((m) => isArchiveCandidate(m, now, 1)).map((m) => m.slug)).toEqual(["user/never"]);
    // pin it -> no longer a candidate even though stale
    await store.setPinned("user/never", true);
    const all3 = await store.listAll();
    expect(all3.filter((m) => isArchiveCandidate(m, now, 1)).map((m) => m.slug)).toEqual([]);
  });
});

describe("MemoryDream.buildConsolidatePrompt date injection", () => {
  it("includes today's date, the field-explicit rule, and per-memory description", () => {
    const dream = new MemoryDream();
    const mem = makeMemory("user/food");
    mem.description = "去年定的口味";
    const prompt = (dream as any).buildConsolidatePrompt(
      "## index", [mem], [], new Map(), new Set(), new Date(2026, 7, 1).getTime()
    );
    expect(prompt).toContain("2026-08-01");
    expect(prompt).toMatch(/相对日期/);
    expect(prompt).toContain("description");
    expect(prompt).toContain("去年定的口味"); // description 现在可见
  });

  it("includes keywords in output format and a backfill rule", () => {
    const dream = new MemoryDream();
    const prompt = (dream as any).buildConsolidatePrompt(
      "## index", [makeMemory("user/food")], [], new Map(), new Set(), Date.now()
    );
    expect(prompt).toContain('"keywords"');
    expect(prompt).toMatch(/补全 keywords/);
  });
});

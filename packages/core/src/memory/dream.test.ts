import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

vi.mock("../llm/anthropic.js", () => ({
  AnthropicProvider: vi.fn().mockImplementation(() => ({
    name: "mock",
    maxContextTokens: 200000,
    chat: vi.fn(),
    stream: vi.fn(),
    countTokens: vi.fn(() => 0),
  })),
}));

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

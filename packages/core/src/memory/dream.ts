import * as fs from "node:fs";
import * as path from "node:path";
import { AnthropicProvider } from "../llm/anthropic.js";
import { ConversationManager } from "../conversation/manager.js";

const DEFAULT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_MIN_NEW_SESSIONS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const LOCK_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

/** Shared mutable state for the dream hook (pass-by-reference, like MemoryExtractionState). */
export interface DreamState {
  /** Epoch ms of the last *successful* consolidation. 0 = never. */
  lastConsolidatedAt: number;
  /** In-process mutex: true while a dream is in flight. */
  running: boolean;
}

export function createMemoryDreamState(): DreamState {
  return { lastConsolidatedAt: 0, running: false };
}

export interface DreamConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Minimum interval since last consolidation. Default 24h. */
  minIntervalMs?: number;
  /** Minimum new sessions since last consolidation. Default 5. */
  minNewSessions?: number;
  /** Per-LLM-call timeout. Default 30s. */
  timeoutMs?: number;
}

/**
 * Atomically acquire a lock file (O_EXCL). Overwrites an expired lock so a
 * crashed dream doesn't block forever. Returns false if a fresh lock is held.
 */
export async function acquireLock(
  lockPath: string,
  timeoutMs = LOCK_TIMEOUT_MS
): Promise<boolean> {
  try {
    const raw = await fs.promises.readFile(lockPath, "utf-8");
    const lock = JSON.parse(raw);
    if (Date.now() - lock.acquiredAt < timeoutMs) return false;
    await fs.promises.unlink(lockPath).catch(() => {});
  } catch {
    /* no lock yet */
  }
  try {
    const fd = await fs.promises.open(lockPath, "wx");
    await fd.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
    await fd.close();
    return true;
  } catch {
    return false;
  }
}

export async function releaseLock(lockPath: string): Promise<void> {
  await fs.promises.unlink(lockPath).catch(() => {});
}

export async function readState(statePath: string): Promise<number> {
  try {
    const raw = await fs.promises.readFile(statePath, "utf-8");
    return JSON.parse(raw).lastConsolidatedAt ?? 0;
  } catch {
    return 0;
  }
}

export async function writeState(
  statePath: string,
  lastConsolidatedAt: number
): Promise<void> {
  await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
  await fs.promises.writeFile(statePath, JSON.stringify({ lastConsolidatedAt }));
}

/**
 * Dream consolidation engine: four-phase memory tidy (Orient -> Gather ->
 * Consolidate -> Prune). Never throws - every failure degrades to a no-op.
 */
export class MemoryDream {
  protected llm: AnthropicProvider;
  protected model: string;
  protected minIntervalMs: number;
  protected minNewSessions: number;
  protected timeoutMs: number;

  constructor(config?: DreamConfig) {
    const apiKey =
      config?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
    const baseUrl =
      config?.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? process.env.OPENAI_BASE_URL;
    this.model = config?.model ?? "deepseek-chat";
    this.minIntervalMs = config?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.minNewSessions = config?.minNewSessions ?? DEFAULT_MIN_NEW_SESSIONS;
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.llm = new AnthropicProvider({ apiKey, baseUrl });
  }

  /**
   * Zero-LLM gate: enough time elapsed AND enough new sessions since the last
   * consolidation. "New" = sessions whose updatedAt > lastConsolidatedAt.
   */
  async shouldDream(sessionsDir: string, memoryDir: string): Promise<boolean> {
    const lastConsolidatedAt = await readState(path.join(memoryDir, ".dream.state"));
    if (Date.now() - lastConsolidatedAt < this.minIntervalMs) return false;
    const sessions = await ConversationManager.listSessions(sessionsDir);
    const newCount = sessions.filter(
      (s) => Date.parse(s.updatedAt) > lastConsolidatedAt
    ).length;
    return newCount >= this.minNewSessions;
  }

  /** Provider has no abort signal - race a timer and drop the loser. */
  protected withTimeout<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error("memory dream timeout")), this.timeoutMs)
      ),
    ]);
  }
}

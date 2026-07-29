import * as fs from "node:fs";
import * as path from "node:path";
import { AnthropicProvider } from "../llm/anthropic.js";
import { ConversationManager } from "../conversation/manager.js";
import type { MemoryStore } from "./store.js";
import type { Memory } from "./types.js";

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

  /** Phase 1 - Orient: review existing memories, output suspicions to grep for. */
  protected async orient(store: MemoryStore): Promise<Suspicion[]> {
    const all = await store.listAll();
    const index = await store.loadIndex();
    const prompt = this.buildOrientPrompt(index, all);
    try {
      const response = await this.withTimeout(
        this.llm.chat({
          messages: [
            { role: "user", content: prompt, timestamp: new Date().toISOString() },
          ],
          model: this.model,
          maxTokens: 1024,
          temperature: 0,
        })
      );
      return this.parseSuspicions(response.content, new Set(all.map((m) => m.slug)));
    } catch {
      return [];
    }
  }

  private buildOrientPrompt(indexContent: string, all: readonly Memory[]): string {
    const parts: string[] = [];
    if (indexContent) parts.push(indexContent.trim());
    for (const m of all) {
      parts.push(
        `### ${m.slug}\nname: ${m.name}\ndescription: ${m.description}\ncontent:\n${m.content}`
      );
    }
    return [
      "You are performing a dream - a reflective pass over the memory system.",
      "Review the existing memories and identify what may need consolidation.",
      "",
      "## Existing memories (index + full content)",
      parts.length ? parts.join("\n\n") : "(No existing memories yet.)",
      "",
      "## Instructions",
      "审视现有记忆，找出需要整理的点，输出 JSON 数组（无需整理则 []）：",
      '[{"slug":"user/food-preferences","keywords":["红烧排骨","喜欢"],"reason":"可能漂移，需查证"}]',
      "",
      "Rules:",
      "- slug 必须来自上面的现有记忆",
      "- 每点给 2-5 个搜索关键词，用于在历史会话中检索证据",
      "- 重点找：可能漂移（与当前状态矛盾）、重复主题、信息失效、相对日期待转换",
      "- 只输出 JSON，不要解释",
    ].join("\n");
  }

  private parseSuspicions(raw: string, knownSlugs: Set<string>): Suspicion[] {
    try {
      let json = raw.trim();
      const fence = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (fence) json = fence[1].trim();
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed)) return [];
      const out: Suspicion[] = [];
      for (const item of parsed) {
        if (
          item &&
          typeof item.slug === "string" &&
          knownSlugs.has(item.slug) &&
          Array.isArray(item.keywords) &&
          item.keywords.every((k: unknown) => typeof k === "string")
        ) {
          out.push({
            slug: item.slug,
            keywords: item.keywords,
            reason: typeof item.reason === "string" ? item.reason : "",
          });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Phase 2 - Gather (no LLM): grep recent-session new messages for suspicion keywords. */
  protected async gather(
    suspicions: Suspicion[],
    sessionsDir: string,
    lastConsolidatedAt: number
  ): Promise<Map<string, string[]>> {
    const evidence = new Map<string, string[]>();
    if (suspicions.length === 0) return evidence;
    const sessions = (await ConversationManager.listSessions(sessionsDir)).filter((s) =>
      Date.parse(s.updatedAt) > lastConsolidatedAt
    );
    for (const susp of suspicions) {
      const lowerKws = susp.keywords.map((k) => k.toLowerCase());
      const snippets: string[] = [];
      for (const s of sessions) {
        let mgr: ConversationManager | null = null;
        try {
          mgr = await ConversationManager.load(path.join(sessionsDir, `${s.id}.json`));
        } catch {
          continue;
        }
        const msgs = mgr.getMessages();
        for (let i = 0; i < msgs.length; i++) {
          const m = msgs[i];
          if (!("timestamp" in m)) continue;
          if (Date.parse(m.timestamp) <= lastConsolidatedAt) continue; // only new messages
          const text = messageText(m).toLowerCase();
          if (lowerKws.some((kw) => text.includes(kw))) {
            const ctx = [msgs[i - 1], m, msgs[i + 1]]
              .filter(Boolean)
              .map(messageText)
              .join("\n");
            snippets.push(ctx.slice(0, 500));
            if (snippets.length >= 5) break;
          }
        }
        if (snippets.length >= 5) break;
      }
      if (snippets.length) evidence.set(susp.slug, snippets);
    }
    return evidence;
  }
}

export interface Suspicion {
  slug: string;
  keywords: string[];
  reason: string;
}

/** Extract plain text from a message (string content or tool blocks). */
function messageText(m: { content: unknown }): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((b: { content?: unknown; name?: unknown }) =>
        typeof b?.content === "string" ? b.content : typeof b?.name === "string" ? b.name : ""
      )
      .join(" ");
  }
  return "";
}

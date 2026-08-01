import * as fs from "node:fs";
import * as path from "node:path";
import { AnthropicProvider } from "../llm/anthropic.js";
import { ConversationManager } from "../conversation/manager.js";
import type { MemoryStore, MemoryAction } from "./store.js";
import type { Memory, MemoryType } from "./types.js";
import type { PipelineEvent } from "../events/types.js";

const DEFAULT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_MIN_NEW_SESSIONS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const LOCK_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const DEFAULT_ARCHIVE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30d (Phase 4)

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
  /** Phase 4: memories unused longer than this are archive candidates. Default 30d. */
  archiveThresholdMs?: number;
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
  protected archiveThresholdMs: number;

  constructor(config?: DreamConfig) {
    const apiKey =
      config?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
    const baseUrl =
      config?.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? process.env.OPENAI_BASE_URL;
    this.model = config?.model ?? "deepseek-chat";
    this.minIntervalMs = config?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.minNewSessions = config?.minNewSessions ?? DEFAULT_MIN_NEW_SESSIONS;
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.archiveThresholdMs = config?.archiveThresholdMs ?? DEFAULT_ARCHIVE_THRESHOLD_MS;
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
    // LLM errors bubble to dream(); only parse failures degrade to [].
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

  private static readonly MEMORY_ACTIONS = ["create", "update", "append"];

  /** Phase 3 - Consolidate: LLM emits ops; program persists (backup before delete). */
  protected async consolidate(
    store: MemoryStore,
    suspicions: Suspicion[],
    evidence: Map<string, string[]>
  ): Promise<string[]> {
    const all = await store.listAll();
    const now = Date.now();
    const candidateSlugs = new Set(
      all
        .filter((m) => isArchiveCandidate(m, now, this.archiveThresholdMs))
        .map((m) => m.slug)
    );
    const index = await store.loadIndex();
    const prompt = this.buildConsolidatePrompt(index, all, suspicions, evidence, candidateSlugs, now);
    // LLM errors bubble to dream(); parse failures degrade to [].
    const response = await this.withTimeout(
      this.llm.chat({
        messages: [
          { role: "user", content: prompt, timestamp: new Date().toISOString() },
        ],
        model: this.model,
        maxTokens: 2048,
        temperature: 0,
      })
    );
    const knownSlugs = new Set(all.map((m) => m.slug));
    const ops = this.parseDreamResponse(response.content, knownSlugs);
    for (const op of ops) {
      if (op.action === "delete") {
        await this.backupAndDelete(store, op.slug);
      } else {
        const nowIso = new Date().toISOString();
        await store.save(
          {
            slug: op.slug,
            type: op.type as MemoryType,
            name: op.name!,
            description: op.description!,
            content: op.content!,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
          op.action as MemoryAction
        );
      }
    }
    // Phase 4: rule-driven auto-archive. Stale candidates (>30d unused, not
    // pinned) not content-deleted above are archived (recoverable). Pinned
    // memories never reach candidateSlugs (isArchiveCandidate excludes them).
    const archived: string[] = [];
    for (const slug of candidateSlugs) {
      if (!(await store.load(slug))) continue; // already deleted via a delete op
      await store.archive(slug);
      archived.push(slug);
    }
    return archived;
  }

  private buildConsolidatePrompt(
    indexContent: string,
    all: readonly Memory[],
    suspicions: Suspicion[],
    evidence: Map<string, string[]>,
    candidateSlugs: Set<string>,
    now: number
  ): string {
    const today = new Date(now);
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const memParts: string[] = [];
    if (indexContent) memParts.push(indexContent.trim());
    for (const m of all) memParts.push(`### ${m.slug}\ndescription: ${m.description}\ncontent:\n${m.content}`);
    const suspText =
      suspicions.map((s) => `- ${s.slug}: ${s.reason}`).join("\n") || "(无)";
    const eviText =
      [...evidence.entries()]
        .map(([slug, snips]) => `### ${slug}\n${snips.join("\n---\n")}`)
        .join("\n\n") || "(无证据)";
    const candText =
      all
        .filter((m) => candidateSlugs.has(m.slug))
        .map((m) => {
          const ageDays = Math.floor((now - Date.parse(m.lastUsedAt!)) / 86_400_000);
          return `- ${m.slug} | usageCount=${m.usageCount ?? 0} | lastUsedAt=${m.lastUsedAt} | 已 ${ageDays} 天未用`;
        })
        .join("\n") || "(无)";
    return [
      "You are performing a dream - consolidate the memory system based on evidence.",
      `今天是 ${todayStr}。`,
      "",
      "## Existing memories (index + full content)",
      memParts.join("\n\n"),
      "",
      "## Suspicions from Orient",
      suspText,
      "",
      "## Evidence gathered from recent sessions",
      eviText,
      "",
      "## Archive candidates（>30 天未被召回，将自动归档）",
      candText,
      "",
      "## Instructions",
      "基于证据整理记忆，输出 JSON 数组（无改动则 []）：",
      '[{"action":"create|update|append|delete","slug":"<type>/<kebab-case>","type":"user|feedback|project|reference","name":"简短名称","description":"一句话描述","content":"完整正文"}]',
      "",
      "Rules:",
      "- create：新主题；update：改写已有文件正文（slug 须匹配现有文件）；append：向已有文件补充新段落",
      "- delete：删除整条失效/被合并的记忆文件（仅当内容本身失效/重复/矛盾时使用；用 reason 说明理由，不需 content）",
      "- 上面的归档候选将被自动归档（移入归档区，可经 /memory-restore 恢复），无需你输出 archive；pinned 记忆不会出现在候选中。若某候选内容同时失效/重复/矛盾，用 delete 优先删除（内容维度优先于热度）",
      "- 新信息与现有记忆矛盾时，用 update 重写或 delete 删除，禁止矛盾并存",
      "- 优先把新信息合并进已有 topic 文件，避免创建重复文件",
      "- 把 description 与 content 中的相对日期转换为绝对日期；精确词（昨天/上周/去年）转确切日期，模糊词（最近/前阵子）转大致范围（如\"2026年7月前后\"）",
      "- 遵守 user/feedback/project/reference 四分类与\"What NOT to save\"（不存代码模式、git 历史、调试方案、任务进度）",
      "- 只使用上述证据中的内容；不要臆测",
    ].join("\n");
  }

  private parseDreamResponse(
    raw: string,
    knownSlugs: Set<string>
  ): Array<{
    action: string;
    slug: string;
    type?: string;
    name?: string;
    description?: string;
    content?: string;
    reason?: string;
  }> {
    try {
      let json = raw.trim();
      const fence = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (fence) json = fence[1].trim();
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed)) return [];
      const out: Array<{
        action: string;
        slug: string;
        type?: string;
        name?: string;
        description?: string;
        content?: string;
        reason?: string;
      }> = [];
      for (const item of parsed) {
        if (!item || typeof item.action !== "string" || typeof item.slug !== "string") continue;
        if (item.action === "delete") {
          if (knownSlugs.has(item.slug)) {
            out.push({
              action: "delete",
              slug: item.slug,
              reason: typeof item.reason === "string" ? item.reason : "",
            });
          }
        } else if (
          MemoryDream.MEMORY_ACTIONS.includes(item.action) &&
          typeof item.type === "string" &&
          ["user", "feedback", "project", "reference"].includes(item.type) &&
          item.slug.startsWith(`${item.type}/`) &&
          typeof item.name === "string" &&
          typeof item.description === "string" &&
          typeof item.content === "string"
        ) {
          out.push({
            action: item.action,
            slug: item.slug,
            type: item.type,
            name: item.name,
            description: item.description,
            content: item.content,
          });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Backup a to-be-deleted file + index, then delete. */
  private async backupAndDelete(store: MemoryStore, slug: string): Promise<void> {
    const memory = await store.load(slug);
    if (!memory) return;
    const storeDir = (store as unknown as Record<string, unknown>).dir as string;
    const backupDir = path.join(storeDir, ".dream-backup", memory.type);
    await fs.promises.mkdir(backupDir, { recursive: true });
    const base = `${path.basename(slug)}.md`;
    await fs.promises
      .copyFile(path.join(storeDir, memory.type, base), path.join(backupDir, base))
      .catch(() => {});
    await fs.promises
      .copyFile(
        path.join(storeDir, "MEMORY.md"),
        path.join(storeDir, ".dream-backup", "MEMORY.md")
      )
      .catch(() => {});
    await store.delete(slug);
  }

  /** Phase 4 - Prune: rebuild index, shrink descriptions if over limits. */
  protected async prune(store: MemoryStore): Promise<void> {
    await store.rebuildIndex();
    const index = await store.loadIndex();
    const lines = index.split("\n").length;
    const size = Buffer.byteLength(index, "utf-8");
    if (lines <= 200 && size <= 25 * 1024) return;
    // Over limits: ask LLM to shorten descriptions (best-effort, errors swallowed).
    try {
      const all = await store.listAll();
      const prompt = [
        "缩短以下记忆索引描述，每条 description 不超过 150 字符，保留关键信息。输出 JSON 数组：",
        '[{"slug":"...","description":"..."}]',
        "",
        "## Current",
        index,
      ].join("\n");
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
      const shortenMap = this.parseShortenResponse(
        response.content,
        new Set(all.map((m) => m.slug))
      );
      for (const m of all) {
        if (shortenMap.has(m.slug)) {
          await store.save({ ...m, description: shortenMap.get(m.slug)! }, "update");
        }
      }
      await store.rebuildIndex();
    } catch {
      // keep original index
    }
  }

  private parseShortenResponse(raw: string, knownSlugs: Set<string>): Map<string, string> {
    const map = new Map<string, string>();
    try {
      let json = raw.trim();
      const fence = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (fence) json = fence[1].trim();
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed)) return map;
      for (const item of parsed) {
        if (
          item &&
          typeof item.slug === "string" &&
          typeof item.description === "string" &&
          knownSlugs.has(item.slug)
        ) {
          map.set(item.slug, item.description.slice(0, 150));
        }
      }
    } catch {
      /* empty */
    }
    return map;
  }

  /**
   * Run the four phases. Never rejects. Updates .dream.state only on full
   * success; on any failure logs and leaves state unchanged so the next run
   * can retry. Returns the slugs archived this run (for user notification).
   */
  async dream(
    store: MemoryStore,
    sessionsDir: string,
    memoryDir: string
  ): Promise<string[]> {
    const statePath = path.join(memoryDir, ".dream.state");
    const lastConsolidatedAt = await readState(statePath);
    try {
      const suspicions = await this.orient(store);
      const evidence = await this.gather(suspicions, sessionsDir, lastConsolidatedAt);
      const archived = await this.consolidate(store, suspicions, evidence);
      await this.prune(store);
      await writeState(statePath, Date.now());
      return archived;
    } catch (err) {
      this.logError(memoryDir, err);
      return []; // do NOT update state - next run can retry
    }
  }

  private logError(memoryDir: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const detail = err instanceof Error ? err.stack ?? message : message;
    console.error("[MemoryDream] failed:", message);
    try {
      const logDir = path.join(path.dirname(memoryDir), "logs");
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(
        path.join(logDir, "dream.log"),
        `[${new Date().toISOString()}] ${detail}\n`,
        "utf-8"
      );
    } catch {
      // give up
    }
  }
}

export interface Suspicion {
  slug: string;
  keywords: string[];
  reason: string;
}

/**
 * Phase 4: archive candidate = recalled before (lastUsedAt set) and stale.
 *
 * Only lastUsedAt is considered, NOT createdAt: a never-recalled memory is not
 * a candidate (it may simply never have matched a query, or recall may be off
 * -- using createdAt would mass-archive everything when recall is disabled).
 * Never-recalled junk is left to Phase 3's content-driven delete.
 */
export function isArchiveCandidate(
  m: { lastUsedAt?: string; pinned?: boolean },
  now: number,
  thresholdMs: number
): boolean {
  if (m.pinned) return false; // Phase 4: pinned 永不归档（硬条件，不靠 LLM 判断）
  if (!m.lastUsedAt) return false;
  const lu = Date.parse(m.lastUsedAt);
  if (!lu) return false;
  return now - lu > thresholdMs;
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

/**
 * after:agentLoop hook: on agent-loop-complete, if shouldDream + lock acquired,
 * fire-and-forget dream(). The hook returns immediately (does NOT await dream),
 * so the user is never blocked. onStateChange signals the TUI indicator.
 */
export function createMemoryDreamHook(deps: {
  dream: MemoryDream;
  store: MemoryStore;
  state: DreamState;
  sessionsDir: string;
  memoryDir: string;
  onStateChange?: (running: boolean) => void;
  /** Phase 4: called when a dream completes with the slugs it archived (may be []). */
  onArchived?: (archivedSlugs: string[]) => void;
}): (event: PipelineEvent) => Promise<void> {
  const { dream, store, state, sessionsDir, memoryDir, onStateChange, onArchived } = deps;
  const lockPath = path.join(memoryDir, ".dream.lock");
  return async (event: PipelineEvent) => {
    if (event.type !== "agent-loop-complete") return;
    if (state.running) return;
    if (!(await dream.shouldDream(sessionsDir, memoryDir))) return;
    if (!(await acquireLock(lockPath))) return;

    state.running = true;
    onStateChange?.(true);
    // fire-and-forget - do NOT await; the hook must return immediately.
    dream
      .dream(store, sessionsDir, memoryDir)
      .then((archived) => {
        if (archived.length > 0) onArchived?.(archived);
      })
      .catch(() => {
        /* dream() never rejects, but guard anyway */
      })
      .finally(async () => {
        state.running = false;
        onStateChange?.(false);
        await releaseLock(lockPath);
      });
  };
}

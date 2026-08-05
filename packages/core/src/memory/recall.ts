import { AnthropicProvider } from "../llm/anthropic.js";
import type {
  Message,
  ToolResultBlock,
  ToolUseBlock,
  ToolUseMessage,
  ToolResultMessage,
} from "../llm/provider.js";
import type { ConversationManager } from "../conversation/manager.js";
import type { MemoryStore } from "./store.js";
import type { Memory } from "./types.js";
import type { DreamState } from "./dream.js";
import type { LoadedMemoryEntry } from "./loaded-memory-registry.js";

/** tool_use name identifying a synthetic recall pair (also the prune key). */
export const MEMORY_RECALL_TOOL_NAME = "memory_recall";

const QUERY_PREVIEW_LEN = 200;

/**
 * Remove every synthetic recall pair from `messages` (assistant tool_use
 * named memory_recall + the user tool_result referencing its id). Handles
 * pairs sitting mid-history (restored sessions). Returns the SAME array
 * reference when there is nothing to prune. Normal tool pairs are preserved;
 * mixed messages (never produced here) are kept untouched.
 */
export function pruneRecallMessages(messages: Message[]): Message[] {
  const recallIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content as ToolUseBlock[]) {
        if (b && b.name === MEMORY_RECALL_TOOL_NAME) recallIds.add(b.id);
      }
    }
  }
  if (recallIds.size === 0) return messages;

  return messages.filter((m) => {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const blocks = m.content as ToolUseBlock[];
      const hasRecall = blocks.some((b) => recallIds.has(b.id));
      // drop only pure recall messages; keep (never-produced) mixed ones
      return !(hasRecall && blocks.every((b) => recallIds.has(b.id)));
    }
    if (m.role === "user" && Array.isArray(m.content)) {
      const blocks = m.content as ToolResultBlock[];
      const hasRecall = blocks.some((b) => recallIds.has(b.tool_use_id));
      return !(hasRecall && blocks.every((b) => recallIds.has(b.tool_use_id)));
    }
    return true;
  });
}

/**
 * Build the synthetic pair injected after the current user message:
 * assistant tool_use(memory_recall) + user tool_result(memory content).
 */
export function buildRecallPair(
  query: string,
  memories: Memory[]
): [ToolUseMessage, ToolResultMessage] {
  const id = `mrec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const preview =
    query.length > QUERY_PREVIEW_LEN ? query.slice(0, QUERY_PREVIEW_LEN) + "…" : query;

  const body = memories
    .map((m) => `## ${m.name} (${m.slug})\n${m.content}`)
    .join("\n\n");
  const content = [
    "# Recalled Memories",
    "",
    "以下记忆与当前查询相关（由记忆召回系统自动选择）：",
    "",
    body,
  ].join("\n");

  const now = new Date().toISOString();
  return [
    {
      role: "assistant",
      content: [{ id, name: MEMORY_RECALL_TOOL_NAME, input: { query: preview } }],
      timestamp: now,
    },
    {
      role: "user",
      content: [{ tool_use_id: id, content }],
      timestamp: now,
    },
  ];
}

export interface MemoryRecallConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Max memories injected per turn. Default 5. */
  maxResults?: number;
  /** Side-query timeout; on expiry the turn degrades to index-only. Default 10s. */
  timeoutMs?: number;
}

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Side-query engine: given the current user message, a small model picks
 * the most relevant memories from the on-disk MEMORY.md index. Never throws -
 * every failure mode degrades to an empty selection (index-only recall).
 */
export class MemoryRecall {
  private llm: AnthropicProvider;
  private model: string;
  private maxResults: number;
  private timeoutMs: number;

  constructor(config?: MemoryRecallConfig) {
    const apiKey =
      config?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
    const baseUrl =
      config?.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? process.env.OPENAI_BASE_URL;
    this.model = config?.model ?? "deepseek-chat";
    this.maxResults = config?.maxResults ?? DEFAULT_MAX_RESULTS;
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.llm = new AnthropicProvider({ apiKey, baseUrl });
  }

  async select(
    userQuery: string,
    store: MemoryStore,
    loaded: LoadedMemoryEntry[] = []
  ): Promise<{ add: Memory[]; prune: string[] }> {
    try {
      const all = await store.listAll();
      if (all.length === 0) return { add: [], prune: [] };
      const knownSlugs = new Set(all.map((m) => m.slug));
      const loadedSlugs = new Set(loaded.map((l) => l.slug));
      const loadedSidequery = new Set(
        loaded.filter((l) => l.source === "sidequery").map((l) => l.slug)
      );
      // Rich index (in-memory): name - description [关键词] 「正文首行预览」.
      // Built from listAll() so the side-query sees keywords + first-line,
      // not just the bare MEMORY.md description. MEMORY.md itself is unchanged
      // and still refreshed by createMemoryRecallHandler as the system-prompt layer.
      const richIndex = all.map((m) => {
        const parts = [`- [${m.name}](${m.slug}.md) - ${m.description}`];
        if (m.keywords && m.keywords.length) parts.push(`[关键词: ${m.keywords.join(",")}]`);
        const first = (m.content.split("\n")[0] || "").trim();
        const preview = first.length > 60 ? first.slice(0, 60) + "…" : first;
        parts.push(`「${preview}」`);
        return parts.join(" ");
      }).join("\n");
      const loadedSection = loaded.length
        ? loaded.map((l) => `- ${l.slug} [${l.source}]`).join("\n")
        : "(无已加载记忆)";
      const response = await this.withTimeout(
        this.llm.chat({
          messages: [
            { role: "user", content: this.buildPrompt(richIndex, userQuery, loadedSection), timestamp: new Date().toISOString() },
          ],
          model: this.model,
          maxTokens: 512,
          temperature: 0,
        })
      );
      const parsed = this.parseResponse(response.content, knownSlugs);
      const bySlug = new Map(all.map((m) => [m.slug, m] as const));
      const add = parsed.add
        .filter((s) => !loadedSlugs.has(s))
        .slice(0, this.maxResults)
        .map((s) => bySlug.get(s)!)
        .filter(Boolean);
      const prune = parsed.prune.filter((s) => loadedSidequery.has(s));
      return { add, prune };
    } catch {
      return { add: [], prune: [] }; // store read error, LLM error, or timeout -> degrade to empty
    }
  }

  /** Provider has no abort signal - race a timer and drop the loser. */
  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error("memory recall timeout")), this.timeoutMs)
      ),
    ]);
  }

  private buildPrompt(indexContent: string, userQuery: string, loadedSection: string): string {
    return [
      "You are a STRICT memory-recall filter. Given the user's current message, the memory index, and the",
      "already-loaded memories, decide what to ADD (new, relevant, not yet loaded) and what to PRUNE",
      "(already-loaded side-query memories now irrelevant). 默认不新增、不剪除;不确定相关的不放进 add,不确定无关的不放进 prune。",
      "",
      "## Memory index（每条:名称 - 描述 [关键词] 「正文首行预览」）",
      indexContent.trim(),
      "",
      "## Already-loaded memories（当前上下文已存在的记忆）",
      loadedSection,
      "",
      "## User message",
      userQuery,
      "",
      "## 满足以下任意一条，才放入 add（新增注入）",
      "1. 该记忆包含当前请求明确需要使用的用户信息：偏好、约束、已确定的方案/选择/决策。",
      "2. 用户主动要求回忆已存在的记忆，且缺少会导致回答明显偏差。",
      '3. 当前请求明确在继续该记忆对应的历史任务（"继续之前的设计""按上次方案改"）。',
      "且该记忆必须未被加载（不在 already-loaded 中）。",
      "",
      "## 满足以下全部，才放入 prune（剪除已加载的 side-query 记忆）",
      "- 该记忆已在 already-loaded 中且来源为 sidequery。",
      "- 它与当前用户消息不算相关（明确无关）：删除后当前回答仍然成立。",
      "主动召回（active）的记忆永不放入 prune。不确定无关的不要放入 prune（保留更安全）。",
      "",
      "## Output（严格 JSON 对象）",
      '- {"add": ["slug", ...], "prune": ["slug", ...]}',
      "- add 最多 5 个;无相关则 add:[]。prune 仅含明确无关的已加载 sidequery slug;无则 prune:[]。",
      "- slug 必须来自上面的索引，禁止编造；只输出 JSON，不要解释。",
      "",
      "## Examples",
      '用户消息"帮我查一下天气" -> {"add": [], "prune": []}',
      '用户消息"今晚吃什么好？"（索引含食物偏好，未加载）-> {"add": ["user/food-preferences"], "prune": []}',
      '用户消息"帮我重构函数"（已加载 user/food-preferences [sidequery]）-> {"add": [], "prune": ["user/food-preferences"]}',
    ].join("\n");
  }

  /** Parse {add, prune}; keep only strings that name real index entries; dedupe, preserve order. */
  private parseResponse(raw: string, knownSlugs: Set<string>): { add: string[]; prune: string[] } {
    try {
      let json = raw.trim();
      const fenceMatch = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (fenceMatch) json = fenceMatch[1].trim();
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { add: [], prune: [] };
      }
      const pick = (v: unknown): string[] => {
        if (!Array.isArray(v)) return [];
        const out: string[] = [];
        for (const item of v) {
          if (typeof item === "string" && knownSlugs.has(item) && !out.includes(item)) {
            out.push(item);
          }
        }
        return out;
      };
      return { add: pick((parsed as Record<string, unknown>).add), prune: pick((parsed as Record<string, unknown>).prune) };
    } catch {
      return { add: [], prune: [] };
    }
  }
}

/**
 * Build the AgentConfig.onTurnStart callback for memory recall.
 * Per turn: refresh the index layer (content-changed only) -> prune the
 * previous recall pair -> select -> append the new pair after the current
 * user message. Best-effort: never throws.
 */
export function createMemoryRecallHandler(deps: {
  recall: MemoryRecall;
  store: MemoryStore;
  /** Phase 4: when provided and running, skip usage recording (yield to Dream). */
  dreamState?: DreamState;
}): (conversation: ConversationManager) => Promise<void> {
  const { recall, store, dreamState } = deps;
  let lastIndexContent: string | null = null;

  return async (conversation: ConversationManager) => {
    try {
      // 1. Refresh the index layer so memories written this session become
      //    visible in the system prompt from the next turn.
      try {
        const indexContent = (await store.loadIndex()).trim();
        if (indexContent && indexContent !== lastIndexContent) {
          conversation.systemPrompt.addLayer({
            name: "memory",
            priority: 5,
            always: false,
            content: indexContent,
          });
          lastIndexContent = indexContent;
        }
      } catch {
        // keep the previous layer content
      }

      // 2. Prune the previous recall pair (at most one pair in history).
      const before = conversation.getMessages();
      const pruned = pruneRecallMessages([...before]);
      if (pruned.length !== before.length) {
        conversation.replaceMessages(pruned);
      }

      // 3. Select against the current user message (the one addUserMessage
      //    just appended) and append the fresh pair after it.
      const messages = conversation.getMessages();
      const last = messages[messages.length - 1];
      const query =
        last && last.role === "user" && typeof last.content === "string"
          ? last.content
          : "";
      if (!query) return;

      const { add: memories } = await recall.select(query, store);
      if (memories.length === 0) return;

      // Phase 4: 注入即计数（best-effort）。Dream 整理期间让位（同提取），
      // 避免 recordUsage 与 Dream consolidate 的写写竞态；recall 的读路径
      // （select/inject）服务用户当轮，不让位。
      if (!dreamState?.running) {
        await Promise.all(
          memories.map((m) => store.recordUsage(m.slug).catch(() => {}))
        ).catch(() => {});
      }

      const [toolUse, toolResult] = buildRecallPair(query, memories);
      conversation.replaceMessages([...conversation.getMessages(), toolUse, toolResult]);
    } catch {
      // recall is best-effort - never break the agent loop
    }
  };
}

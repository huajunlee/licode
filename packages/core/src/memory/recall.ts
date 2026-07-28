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

  async select(userQuery: string, store: MemoryStore): Promise<Memory[]> {
    const indexContent = await store.loadIndex();
    if (!indexContent || indexContent.trim().length === 0) return [];

    const all = await store.listAll();
    const knownSlugs = new Set(all.map((m) => m.slug));

    try {
      const response = await this.withTimeout(
        this.llm.chat({
          messages: [
            { role: "user", content: this.buildPrompt(indexContent, userQuery), timestamp: new Date().toISOString() },
          ],
          model: this.model,
          maxTokens: 512,
          temperature: 0,
        })
      );
      const slugs = this.parseResponse(response.content, knownSlugs).slice(0, this.maxResults);
      const bySlug = new Map(all.map((m) => [m.slug, m]));
      return slugs.map((s) => bySlug.get(s)!);
    } catch {
      return []; // LLM error or timeout -> degrade to index-only
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

  private buildPrompt(indexContent: string, userQuery: string): string {
    return [
      "You are a STRICT memory-recall filter. Given the user's current message and the memory index,",
      "decide which memories to recall. 默认不召回任何记忆；不满足下列相关性条件的一律输出 []。",
      "",
      "## Memory index",
      indexContent.trim(),
      "",
      "## User message",
      userQuery,
      "",
      "## 满足以下任意一条，该记忆才算相关",
      "1. 该记忆包含当前请求明确需要使用的用户信息：用户明确表达的偏好、用户明确提出的约束、用户过去已确定的方案/选择/决策。",
      "2. 用户主动要求回忆已存在的记忆，且缺少该记忆会导致回答出现明显偏差、无法满足用户真实需求（如按之前约定的技术方案继续、基于个人偏好推荐、遵守之前声明的限制条件）。",
      '3. 当前请求明确是在继续该记忆对应的历史任务/讨论/上下文，例如"继续之前的设计"、"按照上次的方案修改"、"刚才那个问题继续"。',
      "",
      "## 以下情况不算相关（不要召回）",
      "- 仅关键词或主题相似",
      "- 仅属于同一技术领域",
      "- 该记忆只能提供额外背景，但删除后当前回答仍然成立",
      "",
      "## Output",
      `- 输出 JSON 数组，0 到 ${this.maxResults} 个 slug，如 ["user/food-preferences"]；无相关则输出 []。`,
      "- slug 必须来自上面的索引，禁止编造；只输出 JSON，不要解释。",
      "",
      "## Examples",
      '用户消息"帮我查一下天气" -> []（仅关键词相似，记忆并非关于天气）',
      '用户消息"今晚吃什么好？"（索引含食物偏好记忆）-> ["user/food-preferences"]（明确需要用户偏好）',
    ].join("\n");
  }

  /** Keep only strings that name real index entries; dedupe, preserve order. */
  private parseResponse(raw: string, knownSlugs: Set<string>): string[] {
    try {
      let json = raw.trim();
      const fenceMatch = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (fenceMatch) json = fenceMatch[1].trim();
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed)) return [];
      const out: string[] = [];
      for (const item of parsed) {
        if (typeof item === "string" && knownSlugs.has(item) && !out.includes(item)) {
          out.push(item);
        }
      }
      return out;
    } catch {
      return [];
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
}): (conversation: ConversationManager) => Promise<void> {
  const { recall, store } = deps;
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

      const memories = await recall.select(query, store);
      if (memories.length === 0) return;

      const [toolUse, toolResult] = buildRecallPair(query, memories);
      conversation.replaceMessages([...conversation.getMessages(), toolUse, toolResult]);
    } catch {
      // recall is best-effort - never break the agent loop
    }
  };
}

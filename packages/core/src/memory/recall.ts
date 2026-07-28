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

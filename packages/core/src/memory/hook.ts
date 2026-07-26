import type { PipelineEvent } from "../events/types.js";
import type { ConversationManager } from "../conversation/manager.js";
import type { MemoryExtractor } from "./extractor.js";
import type { MemoryStore } from "./store.js";

/**
 * Hook function type compatible with {@link HookFunction}.
 * Reacts to `agent-loop-complete` events and triggers LLM-based
 * memory extraction.
 */
export type MemoryExtractionHookFn = (event: PipelineEvent) => Promise<void>;

/**
 * Create an in-process hook function for memory extraction (Step 2).
 *
 * The returned function is designed to be registered via
 * `HookManager.register()` at the `after:agentLoop` position with
 * `blocking: false` (fire-and-forget).
 *
 * @param extractor - The LLM-based MemoryExtractor
 * @param store - MemoryStore for persisting extracted memories
 * @param conversation - ConversationManager to read recent messages
 */
export function createMemoryExtractionHook(
  extractor: MemoryExtractor,
  store: MemoryStore,
  conversation: ConversationManager
): MemoryExtractionHookFn {
  return async (event: PipelineEvent) => {
    // Only react to agent-loop-complete
    if (event.type !== "agent-loop-complete") return;

    const messages = conversation.getMessages();

    // Lightweight pre-check — no LLM call
    if (!extractor.shouldExtract(messages)) return;

    // LLM extraction (fire-and-forget via non-blocking hook)
    await extractor.extract(messages, store);
  };
}

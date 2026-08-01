import type { PipelineEvent } from "../events/types.js";
import type { ConversationManager } from "../conversation/manager.js";
import type { MemoryExtractor } from "./extractor.js";
import type { MemoryStore } from "./store.js";
import type { DreamState } from "./dream.js";

/**
 * Hook function type compatible with {@link HookFunction}.
 * Reacts to `agent-loop-complete` events and triggers LLM-based
 * memory extraction.
 */
export type MemoryExtractionHookFn = (event: PipelineEvent) => Promise<void>;

/**
 * Shared mutable state for the memory extraction hook.
 *
 * The hook factory is called once at registration time, so this object
 * must be passed by reference and shared with the caller (e.g. a React
 * `useRef().current`, whose identity is stable across renders).
 */
export interface MemoryExtractionState {
  /** Epoch ms of the last extraction attempt. 0 = never extracted. */
  lastExtractedAt: number;
  /**
   * Epoch ms when the current agent loop started. 0 = unknown — the
   * "main agent already wrote memories" check is skipped entirely
   * (otherwise a restored session would match every old memory file
   * and extraction would be skipped forever).
   */
  loopStartedAt: number;
  /** In-process mutex: true while an extraction is in flight. */
  running: boolean;
}

export function createMemoryExtractionState(): MemoryExtractionState {
  return { lastExtractedAt: 0, loopStartedAt: 0, running: false };
}

/**
 * Create an in-process hook function for memory extraction.
 *
 * The returned function is designed to be registered via
 * `HookManager.register()` at the `after:agentLoop` position with
 * `blocking: false` (fire-and-forget).
 *
 * Flow per `agent-loop-complete` event:
 * 1. Another extraction is running → return (mutex, no queueing)
 * 2. Main agent wrote memory files this loop (mtime ≥ loopStartedAt)
 *    → rebuild the index (picks up direct Write-tool files) and skip
 *    extraction; lastExtractedAt is NOT advanced so the next loop
 *    still considers these messages
 * 3. Lightweight gate via {@link MemoryExtractor.shouldExtract}
 * 4. Advance lastExtractedAt BEFORE running (attempt counts — a
 *    failing extraction must not fire again on every loop)
 * 5. Run {@link MemoryExtractor.extract} under the mutex
 *
 * @param extractor - The LLM-based MemoryExtractor
 * @param store - MemoryStore for persisting extracted memories
 * @param conversation - ConversationManager to read recent messages
 * @param state - Shared mutable state (see {@link MemoryExtractionState})
 */
export function createMemoryExtractionHook(
  extractor: MemoryExtractor,
  store: MemoryStore,
  conversation: ConversationManager,
  state: MemoryExtractionState,
  dreamState?: DreamState
): MemoryExtractionHookFn {
  return async (event: PipelineEvent) => {
    // Only react to agent-loop-complete
    if (event.type !== "agent-loop-complete") return;

    // In-process mutex — overlapping events are dropped, not queued
    if (state.running) return;

    // Dream is running - yield. Dream is a fuller consolidation; don't race it.
    if (dreamState?.running) return;

    // Main agent already wrote memory files during this loop → just
    // rebuild the index (covers files written directly with the Write
    // tool, bypassing store.save) and skip the background extraction.
    if (state.loopStartedAt > 0 && (await store.hasChangesSince(state.loopStartedAt))) {
      await store.normalizeChangedSince(state.loopStartedAt);
      await store.rebuildIndex();
      return;
    }

    const messages = conversation.getMessages();

    // Lightweight pre-check — no LLM call
    if (
      !extractor.shouldExtract(messages, {
        lastExtractedAt: state.lastExtractedAt,
      })
    ) {
      return;
    }

    // Capture before updating: extract should only see messages newer
    // than the previous attempt. Advance unconditionally (attempt counts)
    // so a failing extraction cannot storm on every loop.
    const sinceMs = state.lastExtractedAt;
    state.lastExtractedAt = Date.now();

    state.running = true;
    try {
      await extractor.extract(messages, store, { sinceMs });
    } finally {
      state.running = false;
    }
  };
}

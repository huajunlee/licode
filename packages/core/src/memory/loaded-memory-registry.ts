// packages/core/src/memory/loaded-memory-registry.ts
import type { Message, ToolUseBlock, ToolResultBlock } from "../llm/provider.js";

/** Matches `## name (slug)` lines in memory_recall / legacy memory_fetch tool results. */
const SLUG_RE = /^## .* \(([^)]+)\)$/;

/**
 * Session-level set of memory slugs already loaded into the conversation,
 * used to dedupe repeated memory_recall calls. Rebuilt from messages on
 * session restore; parses both memory_recall and legacy memory_fetch tool
 * results so pre-refactor sessions still dedupe correctly.
 */
export class LoadedMemoryRegistry {
  private slugs = new Set<string>();

  has(slug: string): boolean {
    return this.slugs.has(slug);
  }

  add(slug: string): void {
    this.slugs.add(slug);
  }

  rebuild(messages: readonly Message[]): void {
    this.slugs.clear();
    const useNameById = new Map<string, string>();
    for (const m of messages) {
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const b of m.content as ToolUseBlock[]) {
          if (b?.id && b?.name) useNameById.set(b.id, b.name);
        }
      }
    }
    for (const m of messages) {
      if (m.role !== "user" || !Array.isArray(m.content)) continue;
      for (const b of m.content as ToolResultBlock[]) {
        const name = b.tool_use_id ? useNameById.get(b.tool_use_id) : undefined;
        if (name !== "memory_recall" && name !== "memory_fetch") continue;
        const content = typeof b.content === "string" ? b.content : "";
        for (const line of content.split("\n")) {
          const match = line.match(SLUG_RE);
          if (match) this.slugs.add(match[1]);
        }
      }
    }
  }
}

export function createLoadedMemoryRegistry(): LoadedMemoryRegistry {
  return new LoadedMemoryRegistry();
}

// packages/core/src/memory/loaded-memory-registry.ts
import type { Message, ToolUseBlock, ToolResultBlock } from "../llm/provider.js";

export type LoadedMemorySource = "sidequery" | "active";

export interface LoadedMemoryEntry {
  slug: string;
  source: LoadedMemorySource;
}

/** Matches `## name (slug)` lines produced by buildRecallPair / memory_fetch. */
const SLUG_RE = /^## .* \(([^)]+)\)$/;

/**
 * Session-level registry of memories already loaded into the conversation,
 * tagged by source. O(1) lookup; rebuilt from messages on session restore.
 */
export class LoadedMemoryRegistry {
  private map = new Map<string, LoadedMemorySource>();

  has(slug: string): boolean {
    return this.map.has(slug);
  }

  get(slug: string): LoadedMemorySource | undefined {
    return this.map.get(slug);
  }

  add(slug: string, source: LoadedMemorySource): void {
    this.map.set(slug, source);
  }

  remove(slug: string): void {
    this.map.delete(slug);
  }

  getAll(): LoadedMemoryEntry[] {
    return Array.from(this.map, ([slug, source]) => ({ slug, source }));
  }

  /** Rebuild from a message list (session restore). Pairs tool_use id -> name,
   *  then extracts `## name (slug)` from memory_recall/memory_fetch tool_results. */
  rebuild(messages: Message[]): void {
    this.map.clear();
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
        const source: LoadedMemorySource = name === "memory_fetch" ? "active" : "sidequery";
        const content = typeof b.content === "string" ? b.content : "";
        for (const line of content.split("\n")) {
          const match = line.match(SLUG_RE);
          if (match) this.map.set(match[1], source);
        }
      }
    }
  }
}

export function createLoadedMemoryRegistry(): LoadedMemoryRegistry {
  return new LoadedMemoryRegistry();
}

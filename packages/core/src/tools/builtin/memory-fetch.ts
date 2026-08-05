// packages/core/src/tools/builtin/memory-fetch.ts
import { z } from "zod";
import type { Tool } from "../types.js";
import type { MemoryStore } from "../../memory/store.js";
import type { LoadedMemoryRegistry } from "../../memory/loaded-memory-registry.js";
import type { ConversationManager } from "../../conversation/manager.js";

const MemoryFetchParams = z.object({
  slugs: z
    .array(z.string())
    .min(1)
    .describe("要取回正文的记忆 slug 列表（来自 MEMORY.md 索引，如 [\"user/food-preferences\"]）"),
});

export interface MemoryFetchToolDeps {
  store: MemoryStore;
  conversation: ConversationManager;
  registry: LoadedMemoryRegistry;
}

/**
 * memory_fetch: 主模型主动按 slug 取回已索引记忆的正文。
 * 工厂模式：ToolContext 不含 store/conversation/registry，通过闭包注入。
 * 去重（registry）、记账（recordUsage）、按召回格式返回。
 */
export function createMemoryFetchTool(deps: MemoryFetchToolDeps): Tool<typeof MemoryFetchParams> {
  const { store, registry } = deps;
  return {
    name: "memory_fetch",
    description:
      "按 slug 精确取回已索引记忆的完整正文。当你在记忆索引（MEMORY.md）中看到某条记忆的 slug 且需要其正文时调用。" +
      "已加载的记忆会自动跳过（去重），并记入用量（影响归档）。返回格式与自动召回一致（## 名称 (slug)）。" +
      "模糊搜索记忆用 Grep，读取非记忆文件用 Read。",
    parameters: MemoryFetchParams,

    async execute(input, _context) {
      const loaded: string[] = [];
      const skippedLoaded: string[] = [];
      const notFound: string[] = [];

      for (const slug of input.slugs) {
        if (registry.has(slug)) {
          skippedLoaded.push(slug);
          continue;
        }
        try {
          const m = await store.load(slug);
          if (!m) {
            notFound.push(slug);
            continue;
          }
          loaded.push(`## ${m.name} (${m.slug})\n${m.content}`);
          registry.add(slug, "active");
          try {
            await store.recordUsage(slug);
          } catch {
            // best-effort
          }
        } catch {
          notFound.push(slug);
        }
      }

      if (loaded.length === 0) {
        const notes: string[] = [];
        if (skippedLoaded.length) notes.push(`已在上下文，跳过：${skippedLoaded.join(", ")}`);
        if (notFound.length) notes.push(`未找到：${notFound.join(", ")}`);
        return {
          status: "error",
          error: notes.length ? notes.join("；") : "无记忆可加载",
          errorType: "execution",
        };
      }

      const parts = [...loaded];
      if (skippedLoaded.length) parts.push(`（已在上下文，跳过：${skippedLoaded.join(", ")}）`);
      if (notFound.length) parts.push(`（未找到：${notFound.join(", ")}）`);
      return { status: "success", content: parts.join("\n\n") };
    },
  };
}

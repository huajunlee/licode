import { z } from "zod";
import type { Tool } from "../types.js";
import type { MemoryStore } from "../../memory/store.js";
import type { LoadedMemoryRegistry } from "../../memory/loaded-memory-registry.js";
import type { DreamState } from "../../memory/dream.js";
import { TokenCounter } from "../../llm/token-counter.js";

const MemoryRecallParams = z.object({
  query: z
    .string()
    .min(1)
    .describe("召回意图的陈述：分析用户问题后，说明你想了解关于用户的什么（不要原样转发用户消息）"),
  keywords: z
    .array(z.string())
    .describe("辅助匹配的关键词，2-5 个（如偏好类型/人名/项目名）"),
});

export interface MemoryRecallToolDeps {
  runRecall: (query: string, keywords: string[]) => Promise<string[]>;
  store: MemoryStore;
  registry: LoadedMemoryRegistry;
  dreamState?: DreamState;
  maxResults?: number;
}

const EXCERPT_TOKEN_THRESHOLD = 500;
const EXCERPT_CHAR_LIMIT = 2000;

/**
 * memory_recall: 主模型自主召回长期记忆的元工具。
 * 内部由 recall 子 agent 完成选摘（见 memory/recall-agent.ts），
 * 本层负责去重、记账、拼装正文。永不抛出：失败降级为「未找到相关记忆」。
 */
export function createMemoryRecallTool(deps: MemoryRecallToolDeps): Tool<typeof MemoryRecallParams> {
  const { store, registry } = deps;
  const maxResults = deps.maxResults ?? 5;
  const tokenCounter = new TokenCounter();

  return {
    name: "memory_recall",
    description:
      "查询你的长期记忆（user 用户偏好 / feedback 纠偏反馈 / project 项目理解 / reference 外部资料）。" +
      "当回答可能受益于用户偏好、历史决定、进行中的项目或收藏的资料时调用；" +
      "纯技术问题、无状态问答不要调用。先想好要了解什么，再传入意图陈述和关键词。",
    parameters: MemoryRecallParams,

    async execute(input, _context) {
      let slugs: string[];
      try {
        slugs = (await deps.runRecall(input.query, input.keywords)).slice(0, maxResults);
      } catch {
        return { status: "success", content: "未找到相关记忆。" };
      }

      const fresh = slugs.filter((s) => !registry.has(s));
      const skipped = slugs.filter((s) => registry.has(s));

      if (fresh.length === 0) {
        return {
          status: "success",
          content: skipped.length
            ? `（相关记忆已在上下文，跳过：${skipped.join(", ")}）`
            : "未找到相关记忆。",
        };
      }

      const parts: string[] = [];
      for (const slug of fresh) {
        try {
          const m = await store.load(slug);
          if (!m) continue;
          let content = m.content;
          if (tokenCounter.estimate(content) >= EXCERPT_TOKEN_THRESHOLD) {
            content = content.slice(0, EXCERPT_CHAR_LIMIT) + "\n…（摘录）";
          }
          parts.push(`## ${m.name} (${m.slug})\n${content}`);
          registry.add(slug);
          // dream 整理期间让位，避免 recordUsage 与 consolidate 写写竞态（移植自旧 recall handler）
          if (!deps.dreamState?.running) {
            try { await store.recordUsage(slug); } catch { /* best-effort */ }
          }
        } catch {
          // 单条读取失败跳过，不影响其余
        }
      }

      if (parts.length === 0) return { status: "success", content: "未找到相关记忆。" };
      if (skipped.length) parts.push(`（已在上下文，跳过：${skipped.join(", ")}）`);
      return { status: "success", content: parts.join("\n\n") };
    },
  };
}

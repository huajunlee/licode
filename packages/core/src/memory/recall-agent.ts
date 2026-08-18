import type { LLMProvider } from "../llm/provider.js";
import { ConversationManager } from "../conversation/manager.js";
import { SystemPrompt } from "../conversation/system-prompt.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolExecutor } from "../tools/executor.js";
import { collectResponse } from "../agent/react.js";
import { z } from "zod";
import type { Tool } from "../tools/types.js";
import type { MemoryStore } from "./store.js";
import { buildRichIndex } from "./rich-index.js";

export interface RecallAgentConfig {
  llm: LLMProvider;
  model?: string;
  store: MemoryStore;
  maxSteps?: number;
  maxResults?: number;
  timeoutMs?: number;
}

export interface RecallAgent {
  run(query: string, keywords: string[]): Promise<string[]>;
}

const ReadMemoryParams = z.object({
  slug: z.string().min(1).describe("要读取的记忆 slug（来自索引）"),
});

/** 子 agent 唯一工具：按 slug 读记忆正文（只读）。 */
function createReadMemoryTool(store: MemoryStore): Tool<typeof ReadMemoryParams> {
  return {
    name: "read_memory",
    description: "按 slug 阅读一条记忆的完整正文，用于在决定召回前确认相关性。",
    parameters: ReadMemoryParams,
    async execute(input) {
      try {
        const m = await store.load(input.slug);
        if (!m) return { status: "error", error: `未找到：${input.slug}`, errorType: "execution" };
        return { status: "success", content: `## ${m.name} (${m.slug})\n${m.content}` };
      } catch {
        return { status: "error", error: `读取失败：${input.slug}`, errorType: "execution" };
      }
    },
  };
}

const SELECTED_RE = /^SELECTED:\s*(.+)$/m;

/** 从最终文本解析 `SELECTED: slug1, slug2` / `SELECTED: none`，过滤已知 slug、去重。
 *  容错：索引里 slug 以 `slug.md` 形式展示，模型常照抄 `.md` 后缀，这里剥掉再匹配。 */
export function parseSelected(text: string, knownSlugs: Set<string>): string[] {
  const match = text.match(SELECTED_RE);
  if (!match) return [];
  const out: string[] = [];
  for (const raw of match[1].split(",")) {
    const slug = raw.trim().replace(/\.md$/, "");
    if (slug && slug !== "none" && knownSlugs.has(slug) && !out.includes(slug)) out.push(slug);
  }
  return out;
}

function buildAgentPrompt(richIndex: string, maxResults: number): string {
  return [
    "你是记忆召回助手。根据主模型传来的查询意图，从下面的记忆索引中选出真正相关的记忆。",
    "",
    "## 记忆索引（每条：名称 - 描述 [关键词] 「首行预览」）",
    richIndex,
    "",
    "## 工作方式",
    `1. 先用索引初筛候选；拿不准时用 read_memory 工具阅读正文再判断（建议对每个候选读一次）。`,
    `2. 默认不选；不确定相关的不选。最多选 ${maxResults} 条。`,
    "3. 判断完成后，最后一行严格输出：SELECTED: slug1, slug2（无相关则 SELECTED: none）。",
    "4. slug 必须来自上面的索引，禁止编造；写路径部分即可，不要带 .md 后缀（如 user/food-preferences）。",
  ].join("\n");
}

/**
 * 召回子 agent：小模型在多步循环里读索引、按需读正文、输出 SELECTED slug 列表。
 * prompt 结构 = [固定指令 + 完整富索引（稳定前缀）] + [查询（尾部）]，缓存友好。
 * 永不抛出：任何失败/超时/超步数返回 []。
 */
export function createRecallAgent(config: RecallAgentConfig): RecallAgent {
  const maxSteps = config.maxSteps ?? 4;
  const maxResults = config.maxResults ?? 5;
  const timeoutMs = config.timeoutMs ?? 60_000;
  const model = config.model ?? "deepseek-chat";

  async function runOnce(query: string, keywords: string[]): Promise<string[]> {
    const all = await config.store.listAll();
    if (all.length === 0) return [];
    const knownSlugs = new Set(all.map((m) => m.slug));

    const conv = new ConversationManager({ model });
    conv.systemPrompt = new SystemPrompt();
    conv.systemPrompt.addLayer({
      name: "recall-agent",
      priority: 0,
      always: true,
      content: buildAgentPrompt(buildRichIndex(all), maxResults),
    });

    const tools = new ToolRegistry();
    tools.register(createReadMemoryTool(config.store));
    const executor = new ToolExecutor(tools);

    conv.addUserMessage(
      [`查询意图：${query}`, keywords.length ? `关键词：${keywords.join(", ")}` : ""]
        .filter(Boolean)
        .join("\n")
    );

    for (let step = 0; step < maxSteps; step++) {
      const res = await collectResponse(config.llm, conv.buildMessages(), tools.toLLMTools(), conv);
      if (res.type === "text") {
        return parseSelected(res.content, knownSlugs).slice(0, maxResults);
      }
      const results = await executor.executeParallel(res.toolUses);
      conv.addToolMessages(res.toolUses, results);
    }
    return [];
  }

  return {
    async run(query, keywords) {
      try {
        return await Promise.race([
          runOnce(query, keywords),
          new Promise<string[]>((resolve) => setTimeout(() => resolve([]), timeoutMs)),
        ]);
      } catch {
        return [];
      }
    },
  };
}

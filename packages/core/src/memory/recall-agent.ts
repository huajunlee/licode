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
  /** 可选轨迹记录：传入数组后，每步向其中追加一条人类可读描述（read_memory 调用 / 最终文本）。 */
  trace?: string[];
}

export interface RecallAgent {
  /** context 为可选的最近对话文本（见 buildRecentContext），供子代理解指代（如"它"→上下文中的健身房）。 */
  run(query: string, keywords: string[], context?: string): Promise<string[]>;
}

/** 从最近消息里提取「用户/助手」纯文本轮，传给子代理用于解指代。 */
export function buildRecentContext(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
  maxTurns = 3
): string {
  const lines: string[] = [];
  for (const m of messages.slice(-maxTurns)) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = typeof m.content === "string" ? m.content : "";
    if (!text.trim()) continue;
    lines.push(`${m.role === "user" ? "用户" : "助手"}：${text}`);
  }
  return lines.join("\n");
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
    "你是记忆召回助手。根据主模型传来的用户问题，从下面的记忆索引中选出真正相关的记忆。",
    "",
    "## 记忆索引（每条：名称 - 描述 [关键词] 「首行预览」）",
    richIndex,
    "",
    "## 工作方式",
    "0. 首要原则：只召回与查询主题/意图相关的记忆，宁可漏选（SELECTED: none），不可错选无关记忆。注意查询可能由『主题 + 具体探针』两部分组成（如『用户的音乐偏好，是否有关于孙燕姿的记忆』——主题是音乐偏好，孙燕姿是探针）。判定相关性以主题为准，不以探针值是否在索引中逐字命中为准；索引中无该探针值不代表该主题没有记忆，存在同主题记忆仍应选中，以便主模型据此合并更新；读后仍拿不准的，不选。",
    "1. 先用索引初筛候选；对每个候选先自检：这条记忆描述的是『用户的个人事实/历史决定』，而当前问题是『通用知识/教程/设计任务』吗？若是，说明看着相关实则无关，不要选。",
    "2. 拿不准时必须用 read_memory 工具阅读正文，凭正文而非索引预览判断；读后仍不确定就不选。",
    `3. 最多选 ${maxResults} 条；能少选就少选。`,
    "4. 判断完成后，最后一行严格输出：SELECTED: slug1, slug2（无相关则 SELECTED: none）。",
    "5. slug 必须来自上面的索引，禁止编造；写路径部分即可，不要带 .md 后缀（如 user/food-preferences）。",
  ].join("\n");
}

/**
 * 召回子 agent：小模型在多步循环里读索引、按需读正文、输出 SELECTED slug 列表。
 * prompt 结构 = [固定指令 + 完整富索引（稳定前缀）] + [查询（尾部）]，缓存友好。
 * 永不抛出：任何失败/超时/超步数返回 []。
 */
export function createRecallAgent(config: RecallAgentConfig): RecallAgent {
  const maxSteps = config.maxSteps ?? 4;
  const maxResults = config.maxResults ?? 3;
  const timeoutMs = config.timeoutMs ?? 60_000;
  const model = config.model ?? "deepseek-chat";

  async function runOnce(
    query: string,
    keywords: string[],
    context?: string
  ): Promise<string[]> {
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
      [
        `查询意图：${query}`,
        keywords.length ? `关键词：${keywords.join(", ")}` : "",
        context ? `最近对话：\n${context}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );

    for (let step = 0; step < maxSteps; step++) {
      const res = await collectResponse(config.llm, conv.buildMessages(), tools.toLLMTools(), conv);
      if (res.type === "text") {
        config.trace?.push(`step${step}: text: ${res.content.slice(0, 200)}`);
        return parseSelected(res.content, knownSlugs).slice(0, maxResults);
      }
      config.trace?.push(
        `step${step}: tool: ${res.toolUses.map((t) => `${t.name}(${JSON.stringify(t.input)})`).join(", ")}`
      );
      const results = await executor.executeParallel(res.toolUses);
      conv.addToolMessages(res.toolUses, results);
    }
    return [];
  }

  return {
    async run(query, keywords, context) {
      try {
        return await Promise.race([
          runOnce(query, keywords, context),
          new Promise<string[]>((resolve) => setTimeout(() => resolve([]), timeoutMs)),
        ]);
      } catch {
        return [];
      }
    },
  };
}

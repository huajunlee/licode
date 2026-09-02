// packages/core/scripts/eval-recall/adapters/recall-tool.ts
import type { LLMProvider } from "../../../src/llm/provider.js";
import type { MemoryStore } from "../../../src/memory/store.js";
import type { LoadedMemoryRegistry } from "../../../src/memory/loaded-memory-registry.js";
import { ConversationManager } from "../../../src/conversation/manager.js";
import { SystemPrompt, loadDefaultLayers, currentDateLayer } from "../../../src/conversation/system-prompt.js";
import { ToolRegistry } from "../../../src/tools/registry.js";
import { ToolExecutor } from "../../../src/tools/executor.js";
import { collectResponse } from "../../../src/agent/react.js";
import { createMemoryRecallTool } from "../../../src/tools/builtin/memory-recall.js";
import { createRecallAgent } from "../../../src/memory/recall-agent.js";
import { memoryPresenceLayer } from "../../../src/memory/presence-layer.js";
import type { RecallResult, Recaller } from "../lib/recaller.js";

export interface RecallToolRecallerDeps {
  llm: LLMProvider;
  model?: string;
  store: MemoryStore;
  registry: LoadedMemoryRegistry;
  /** 可注入（测试用）；默认走真实 recall-agent。 */
  runRecall?: (query: string, keywords: string[]) => Promise<string[]>;
  trace?: string[];
}

/** 从 memory_recall 工具返回内容解析选中 slug：`## name (slug)` 行。 */
export function parseSelectedSlugs(content: string): string[] {
  return [...content.matchAll(/^## .* \(([^)]+)\)$/gm)].map((m) => m[1]);
}

/**
 * v1 对照基线：主模型自主决定是否调 memory_recall（单轮简化，spec §4.2 决策 A）。
 * 只取第一次 collectResponse 的结果，不跑完整 agentic 循环。
 */
export function createRecallToolRecaller(deps: RecallToolRecallerDeps): Recaller {
  return {
    kind: "v1-tool",
    async retrieve(query, _opts): Promise<RecallResult> {
      const conv = new ConversationManager({ model: deps.model ?? "deepseek-chat" });
      const sp = new SystemPrompt();
      for (const layer of loadDefaultLayers()) sp.addLayer(layer);
      sp.addLayer(currentDateLayer());
      sp.addLayer(memoryPresenceLayer((await deps.store.listAll()).length));
      conv.systemPrompt = sp;
      conv.addUserMessage(query);

      const agent = createRecallAgent({ llm: deps.llm, model: deps.model ?? "deepseek-chat", store: deps.store, trace: deps.trace });
      const runRecall = deps.runRecall ?? ((q, kw) => agent.run(q, kw));
      const tools = new ToolRegistry();
      tools.register(createMemoryRecallTool({ runRecall, store: deps.store, registry: deps.registry }));

      const res = await collectResponse(deps.llm, conv.buildMessages(), tools.toLLMTools(), conv);
      if (res.type === "tool-use") {
        const call = res.toolUses.find((t) => t.name === "memory_recall");
        if (call) {
          const executor = new ToolExecutor(tools);
          const [toolRes] = await executor.executeParallel([call]);
          const content = toolRes.status === "success" ? toolRes.content : "";
          const slugs = parseSelectedSlugs(content);
          return { triggered: true, candidates: slugs.map((slug, i) => ({ slug, score: 1 - i / 10 })) };
        }
      }
      return { triggered: false, candidates: [] };
    },
  };
}

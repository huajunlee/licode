// 召回率评测脚本。用法：
//   ANTHROPIC_AUTH_TOKEN=... pnpm tsx packages/core/scripts/eval-recall.ts --mode=tool
//   （ANTHROPIC_API_KEY 亦可作为凭证回退；EVAL_MODEL 可覆盖默认模型 kimi-k3）
// 数据：seed-memories.json（写入临时 MemoryStore）、cases.json（评测用例）
// 输出：eval-recall/results-<mode>.json + 控制台汇总表
//
// baseline 模式已随旧召回机制（memory/recall.ts）一并删除；
// 基线数据存档于 eval-recall/results-baseline.json（recallA=100% falsePositiveB=0% precision=71%, kimi-k3）。
// tool 模式：候选 system prompt（默认层 + 日期 + 记忆存在提示）+ memory_recall 工具，
// 由主模型自主决定是否召回；temperature 固定为 0 以保证可复现。
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "../src/memory/store.js";
import { AnthropicProvider } from "../src/llm/anthropic.js";
import type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  StreamChunk,
  Message,
} from "../src/llm/provider.js";
import { ConversationManager } from "../src/conversation/manager.js";
import {
  SystemPrompt,
  loadDefaultLayers,
  currentDateLayer,
} from "../src/conversation/system-prompt.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { collectResponse } from "../src/agent/react.js";
import { createMemoryRecallTool } from "../src/tools/builtin/memory-recall.js";
import { createRecallAgent } from "../src/memory/recall-agent.js";
import { memoryPresenceLayer } from "../src/memory/presence-layer.js";
import { LoadedMemoryRegistry } from "../src/memory/loaded-memory-registry.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, "eval-recall");
const MODEL = process.env.EVAL_MODEL ?? "kimi-k3";

interface Seed { slug: string; name: string; description: string; type: string; keywords: string[]; content: string; }
interface Case { id: string; group: "A" | "B" | "C"; query: string; expectRecall: boolean | null; expectedSlugs: string[]; }

function writeSeedMemory(dir: string, seed: Seed): void {
  const file = path.join(dir, `${seed.slug}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fm = [
    "---",
    `name: ${seed.name}`,
    `description: ${seed.description}`,
    `type: ${seed.type}`,
    `createdAt: 2026-08-01T00:00:00.000Z`,
    `updatedAt: 2026-08-01T00:00:00.000Z`,
    `pinned: false`,
    // 必须与 store.ts 落盘格式一致（JSON.stringify）：parse() 对 keywords 行做
    // JSON.parse，手写 [a, b] 会解析失败导致关键词丢失（召回 rich index 会用到）。
    `keywords: ${JSON.stringify(seed.keywords)}`,
    "---",
    "",
    seed.content,
  ].join("\n");
  fs.writeFileSync(file, fm);
}

/** 包装 provider：强制 temperature=0（可复现性），其余透传。 */
class ZeroTempProvider implements LLMProvider {
  constructor(private inner: LLMProvider) {}
  get name(): string { return this.inner.name; }
  get maxContextTokens(): number { return this.inner.maxContextTokens; }
  chat(request: ChatRequest): Promise<ChatResponse> {
    return this.inner.chat({ ...request, temperature: 0 });
  }
  stream(request: ChatRequest): AsyncIterable<StreamChunk> {
    return this.inner.stream({ ...request, temperature: 0 });
  }
  countTokens(messages: Message[]): number {
    return this.inner.countTokens(messages);
  }
}

async function main(): Promise<void> {
  const mode = process.argv.find((a) => a.startsWith("--mode="))?.slice(7);
  if (mode === "baseline") {
    throw new Error(
      "baseline 模式已移除：旧召回机制（MemoryRecall）已删除，基线数据见 eval-recall/results-baseline.json"
    );
  }
  if (mode !== "tool") throw new Error(`unknown mode: ${mode ?? "(missing)"}（仅支持 --mode=tool）`);
  if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY)
    throw new Error("需要 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY 环境变量");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eval-recall-"));
  const seeds = JSON.parse(fs.readFileSync(path.join(DATA, "seed-memories.json"), "utf-8")) as Seed[];
  for (const s of seeds) writeSeedMemory(tmp, s);
  const store = new MemoryStore(tmp);
  await store.rebuildIndex();

  // 种子自检：写盘格式若与 parse() 不兼容，这里会暴露（0 条说明 frontmatter 写错）。
  const memories = await store.listAll();
  console.log(`种子记忆加载: ${memories.length}/${seeds.length} 条 (model=${MODEL}, temperature=0)`);
  if (memories.length !== seeds.length) throw new Error("种子记忆未被 MemoryStore 正确解析，检查 writeSeedMemory 格式");

  const cases = JSON.parse(fs.readFileSync(path.join(DATA, "cases.json"), "utf-8")) as Case[];
  const provider = new ZeroTempProvider(
    new AnthropicProvider({
      apiKey: (process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY)!,
      baseUrl: process.env.ANTHROPIC_BASE_URL,
    })
  );

  const perCase = [];
  for (const c of cases) {
    // 每个用例独立会话：模拟「候选 system prompt + 一条用户消息」的单轮
    const conv = new ConversationManager({ model: MODEL });
    const sp = new SystemPrompt();
    for (const layer of loadDefaultLayers()) sp.addLayer(layer);
    sp.addLayer(currentDateLayer());
    sp.addLayer(memoryPresenceLayer(memories.length));
    conv.systemPrompt = sp;
    conv.addUserMessage(c.query);

    const registry = new LoadedMemoryRegistry();
    const agent = createRecallAgent({ llm: provider, model: MODEL, store });
    const tools = new ToolRegistry();
    tools.register(
      createMemoryRecallTool({ runRecall: (q, kw) => agent.run(q, kw), store, registry })
    );

    const res = await collectResponse(provider, conv.buildMessages(), tools.toLLMTools(), conv);
    let triggered = false;
    let selectedSlugs: string[] = [];
    if (res.type === "tool-use") {
      const call = res.toolUses.find((t) => t.name === "memory_recall");
      if (call) {
        triggered = true;
        const executor = new ToolExecutor(tools);
        const [toolRes] = await executor.executeParallel([call]);
        const content = toolRes.status === "success" ? toolRes.content : "";
        selectedSlugs = [...content.matchAll(/^## .* \(([^)]+)\)$/gm)].map((m) => m[1]);
      }
    }
    const hit = c.expectedSlugs.length > 0 && c.expectedSlugs.every((s) => selectedSlugs.includes(s));
    perCase.push({ id: c.id, group: c.group, triggered, selectedSlugs, hit });
    console.log(`${c.id} [${c.group}] triggered=${triggered} hit=${hit} selected=${selectedSlugs.join(",") || "-"}`);
  }

  const groupA = perCase.filter((p) => p.group === "A");
  const groupB = perCase.filter((p) => p.group === "B");
  const totalSelected = perCase.reduce((n, p) => n + p.selectedSlugs.length, 0);
  const totalExpected = cases.flatMap((c) => c.expectedSlugs);
  const totalCorrect = perCase.reduce(
    (n, p) => n + p.selectedSlugs.filter((s) => totalExpected.includes(s)).length, 0);
  // C 组只记录不判分（expectRecall=null）
  const summary = {
    recallA: groupA.filter((p) => p.hit).length / groupA.length,
    falsePositiveB: groupB.filter((p) => p.triggered).length / groupB.length,
    precision: totalSelected === 0 ? 1 : totalCorrect / totalSelected,
  };
  console.log(`\nA组召回率=${(summary.recallA * 100).toFixed(0)}%  B组误召回率=${(summary.falsePositiveB * 100).toFixed(0)}%  选中准确率=${(summary.precision * 100).toFixed(0)}%`);

  const out = path.join(DATA, `results-${mode}.json`);
  fs.writeFileSync(out, JSON.stringify({ model: MODEL, temperature: 0, perCase, summary }, null, 2));
  console.log(`结果已写入 ${out}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

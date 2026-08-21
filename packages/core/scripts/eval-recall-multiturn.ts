// 多轮评测：新架构（memory_recall 工具召回）。与旧架构脚本 eval-recall-multiturn-old.ts 对称。
// 测量：① 多轮召回正确率（命中/误触发）② 跨轮缓存命中率（DeepSeek 前缀缓存，
//       Anthropic 格式 cache_read/cache_creation）③ 请求数与 token 用量。
// 方法：脚本化多轮对话（scenarios.json，user/assistant 内容两版一致），
//       每轮真实调用主模型决定是否 memory_recall，工具结果留历史；assistant 回复用脚本内容。
// 用法：ANTHROPIC_AUTH_TOKEN=... EVAL_MODEL=deepseek-chat pnpm tsx packages/core/scripts/eval-recall-multiturn.ts
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "../src/memory/store.js";
import { AnthropicProvider } from "../src/llm/anthropic.js";
import type { LLMProvider, ChatRequest, ChatResponse, StreamChunk, Message, TokenUsage } from "../src/llm/provider.js";
import { ConversationManager } from "../src/conversation/manager.js";
import { SystemPrompt, loadDefaultLayers, currentDateLayer } from "../src/conversation/system-prompt.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { collectResponse } from "../src/agent/react.js";
import { createMemoryRecallTool } from "../src/tools/builtin/memory-recall.js";
import { createRecallAgent, buildRecentContext } from "../src/memory/recall-agent.js";
import { memoryPresenceLayer } from "../src/memory/presence-layer.js";
import { LoadedMemoryRegistry } from "../src/memory/loaded-memory-registry.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, "eval-recall");
const MODEL = process.env.EVAL_MODEL ?? "deepseek-chat";

interface Seed { slug: string; name: string; description: string; type: string; keywords: string[]; content: string; }
interface Turn { text: string; reply: string; expectRecall: boolean; expectedSlugs: string[]; note: string; }
interface Scenario { id: string; name: string; turns: Turn[]; }
interface UsageRec { label: string; turn: number; input: number; output: number; cacheRead: number; cacheCreation: number; }

function writeSeedMemory(dir: string, seed: Seed): void {
  const file = path.join(dir, `${seed.slug}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    "---", `name: ${seed.name}`, `description: ${seed.description}`, `type: ${seed.type}`,
    "createdAt: 2026-08-01T00:00:00.000Z", "updatedAt: 2026-08-01T00:00:00.000Z", "pinned: false",
    `keywords: ${JSON.stringify(seed.keywords)}`, "---", "", seed.content,
  ].join("\n"));
}

/** 记录每调用 usage + 强制 temperature=0，用于缓存命中率统计。 */
class LoggingProvider implements LLMProvider {
  constructor(
    private inner: LLMProvider,
    private recs: UsageRec[],
    private label: string,
    private turnState: { turn: number }
  ) {}
  get name(): string { return this.inner.name; }
  get maxContextTokens(): number { return this.inner.maxContextTokens; }
  private log(u: TokenUsage): void {
    this.recs.push({ label: this.label, turn: this.turnState.turn, input: u.input, output: u.output, cacheRead: u.cacheRead ?? 0, cacheCreation: u.cacheCreation ?? 0 });
  }
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const res = await this.inner.chat({ ...request, temperature: 0 });
    this.log(res.usage);
    return res;
  }
  async *stream(request: ChatRequest): AsyncIterable<StreamChunk> {
    for await (const chunk of this.inner.stream({ ...request, temperature: 0 })) {
      if (chunk.type === "stop") this.log(chunk.usage);
      yield chunk;
    }
  }
  countTokens(messages: Message[]): number { return this.inner.countTokens(messages); }
}

async function runScenario(scenario: Scenario, store: MemoryStore, recs: UsageRec[], turnState: { turn: number }): Promise<unknown[]> {
  const conv = new ConversationManager({ model: MODEL });
  const sp = new SystemPrompt();
  for (const layer of loadDefaultLayers()) sp.addLayer(layer);
  sp.addLayer(currentDateLayer());
  sp.addLayer(memoryPresenceLayer((await store.listAll()).length));
  conv.systemPrompt = sp;

  const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_AUTH_TOKEN!, baseUrl: process.env.ANTHROPIC_BASE_URL });
  const mainProvider = new LoggingProvider(provider, recs, "main", turnState);
  const subProvider = new LoggingProvider(provider, recs, "subagent", turnState);
  const registry = new LoadedMemoryRegistry();
  const trace: string[] = [];
  const agent = createRecallAgent({ llm: subProvider, model: MODEL, store, trace });
  const tools = new ToolRegistry();
  tools.register(createMemoryRecallTool({
    runRecall: (q, kw) => agent.run(q, kw, buildRecentContext(conv.getMessages())),
    store, registry,
  }));

  const perTurn = [];
  for (let t = 0; t < scenario.turns.length; t++) {
    trace.length = 0; // 每轮清空，只留本轮子代理轨迹
    turnState.turn = t;
    const turn = scenario.turns[t];
    conv.addUserMessage(turn.text);

    const res = await collectResponse(mainProvider, conv.buildMessages(), tools.toLLMTools(), conv);
    let triggered = false;
    let selectedSlugs: string[] = [];
    if (res.type === "tool-use") {
      const call = res.toolUses.find((x) => x.name === "memory_recall");
      if (call) {
        triggered = true;
        const executor = new ToolExecutor(tools);
        const results = await executor.executeParallel(res.toolUses);
        conv.addToolMessages(res.toolUses, results); // 工具结果留历史（真实增长）
        const toolRes = results.find((r) => r.status === "success");
        const content = toolRes ? (typeof toolRes.content === "string" ? toolRes.content : "") : "";
        selectedSlugs = [...content.matchAll(/^## .* \(([^)]+)\)$/gm)].map((m) => m[1]);
      }
    }
    // 确保最后一条是脚本化 assistant 回复（两版对话内容一致）：
    // text 情形 collectResponse 已把模型文本追加进会话，这里替换；tool-use 情形直接追加。
    {
      const msgs = conv.getMessages().map((m) => ({ ...m }));
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant") {
        (last as { content: string; usage?: unknown }).content = turn.reply;
        (last as { usage?: unknown }).usage = undefined;
        conv.replaceMessages(msgs);
      } else {
        conv.appendToAssistantMessage(turn.reply);
        conv.finalizeAssistantMessage({ input: 0, output: 0 });
      }
    }

    // 命中判据：所需记忆是否已进入会话上下文（registry 累积集合，含去重跳过的已在上下文记忆）
    const inContext = registry.getAll();
    const hit = turn.expectRecall && turn.expectedSlugs.every((s) => inContext.includes(s));
    const freshHit = turn.expectRecall && turn.expectedSlugs.every((s) => selectedSlugs.includes(s));
    perTurn.push({ turn: t, text: turn.text, expectRecall: turn.expectRecall, expectedSlugs: turn.expectedSlugs, triggered, selectedSlugs, freshHit, hit, inContext, trace: [...trace], note: turn.note });
    console.log(`  t${t} ${turn.note}: trig=${triggered} freshHit=${freshHit} hit=${hit} sel=${selectedSlugs.join(",") || "-"} ctx=${inContext.length}`);
  }
  return perTurn;
}

function summarize(scenario: Scenario, perTurn: unknown[], recs: UsageRec[]): Record<string, unknown> {
  const turns = scenario.turns;
  const recallTurns = turns.filter((t) => t.expectRecall).length;
  const noRecallTurns = turns.length - recallTurns;
  const hits = perTurn.filter((p) => (p as { hit: boolean }).hit).length;
  const fps = perTurn.filter((p) => !(p as { expectRecall: boolean }).expectRecall && (p as { triggered: boolean }).triggered).length;
  const injFps = perTurn.filter((p) => !(p as { expectRecall: boolean }).expectRecall && (p as { selectedSlugs: string[] }).selectedSlugs.length > 0).length;
  const main = recs.filter((r) => r.label === "main");
  const all = recs;
  const agg = (list: UsageRec[]) => {
    const input = list.reduce((n, r) => n + r.input, 0);
    const output = list.reduce((n, r) => n + r.output, 0);
    const cacheRead = list.reduce((n, r) => n + r.cacheRead, 0);
    const cacheCreation = list.reduce((n, r) => n + r.cacheCreation, 0);
    const denom = input + cacheRead + cacheCreation;
    return { requests: list.length, input, output, cacheRead, cacheCreation, cacheHitRate: denom === 0 ? 0 : cacheRead / denom };
  };
  const rMain = agg(main);
  const rAll = agg(all);
  console.log(`  → 召回 ${hits}/${recallTurns}  误触发${fps}/${noRecallTurns}(注入${injFps})  main缓存=${(rMain.cacheHitRate * 100).toFixed(1)}%  总缓存=${(rAll.cacheHitRate * 100).toFixed(1)}%  请求=${rAll.requests}`);
  return { recallHit: hits / Math.max(recallTurns, 1), falsePositiveTrigger: fps / Math.max(noRecallTurns, 1), falsePositiveInject: injFps / Math.max(noRecallTurns, 1), main: rMain, all: rAll };
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY)
    throw new Error("需要 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY");
  const seeds = JSON.parse(fs.readFileSync(path.join(DATA, "seed-memories.json"), "utf-8")) as Seed[];
  const scenarios = JSON.parse(fs.readFileSync(path.join(DATA, "scenarios.json"), "utf-8")) as Scenario[];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eval-mt-"));
  for (const s of seeds) writeSeedMemory(tmp, s);
  const store = new MemoryStore(tmp);
  await store.rebuildIndex();
  const n = (await store.listAll()).length;
  console.log(`种子 ${n}/${seeds.length} (model=${MODEL})`);

  const out: Record<string, unknown> = { arch: "new", model: MODEL, temperature: 0, scenarios: [] };
  for (const scenario of scenarios) {
    console.log(`场景 ${scenario.name} (${scenario.turns.length} 轮):`);
    const recs: UsageRec[] = [];
    const perTurn = await runScenario(scenario, store, recs, { turn: 0 });
    out.scenarios.push({ id: scenario.id, name: scenario.name, perTurn, metrics: summarize(scenario, perTurn as never, recs), calls: recs });
  }
  const outPath = path.join(DATA, `results-multiturn-new.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`结果已写入 ${outPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

// 多轮评测：旧架构（side-query 两阶段注入）。与新版 eval-recall-multiturn.ts 对称。
//   ⚠️ 依赖旧版 memory/recall.ts（MemoryRecall + createMemoryRecallHandler），master 已删除：
//   需在 main-0817 checkout 运行——将本脚本 + eval-recall/{seed-memories,cases,scenarios}.json
//   一并复制到旧 checkout 的 packages/core/scripts/ 下，然后：
//   ANTHROPIC_AUTH_TOKEN=... EVAL_MODEL=deepseek-chat pnpm tsx packages/core/scripts/eval-recall-multiturn-old.ts
// 测量：① 多轮召回正确率（side-query 注入是否命中）② 跨轮缓存命中率 ③ 请求数与 token 用量。
// 方法：脚本化多轮对话（scenarios.json），每轮走真实旧 onTurnStart 流程（handler 刷新索引
//       + side-query select + 注入合成 pair），主模型纯调用测缓存；assistant 回复用脚本内容。
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "../src/memory/store.js";
import { AnthropicProvider } from "../src/llm/anthropic.js";
import type { LLMProvider, ChatRequest, ChatResponse, StreamChunk, Message, TokenUsage } from "../src/llm/provider.js";
import { ConversationManager } from "../src/conversation/manager.js";
import { SystemPrompt, loadDefaultLayers, currentDateLayer } from "../src/conversation/system-prompt.js";
import { MemoryRecall, createMemoryRecallHandler } from "../src/memory/recall.js";
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

class LoggingProvider implements LLMProvider {
  constructor(private inner: LLMProvider, private recs: UsageRec[], private label: string, private turnState: { turn: number }) {}
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

/** 从会话最后一条注入的合成 pair（tool_result）解析 slug。 */
function lastInjectedSlugs(conv: ConversationManager): string[] {
  const msgs = conv.getMessages();
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === "user" && Array.isArray(m.content)) {
      for (const b of m.content as Array<{ type: string; content?: string | unknown }>) {
        const content = typeof b.content === "string" ? b.content : "";
        const slugs = [...content.matchAll(/^## .* \(([^)]+)\)$/gm)].map((x) => x[1]);
        if (slugs.length) return slugs;
      }
    }
    if (m.role === "assistant") break; // 越过本轮注入区即可
  }
  return [];
}

async function runScenario(scenario: Scenario, store: MemoryStore, recs: UsageRec[], turnState: { turn: number }): Promise<unknown[]> {
  const conv = new ConversationManager({ model: MODEL });
  const sp = new SystemPrompt();
  for (const layer of loadDefaultLayers()) sp.addLayer(layer);
  sp.addLayer(currentDateLayer());
  conv.systemPrompt = sp;

  const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_AUTH_TOKEN!, baseUrl: process.env.ANTHROPIC_BASE_URL });
  const mainProvider = new LoggingProvider(provider, recs, "main", turnState);
  const sideProvider = new LoggingProvider(provider, recs, "sidequery", turnState);
  const recall = new MemoryRecall({ llm: sideProvider, model: MODEL });
  const registry = new LoadedMemoryRegistry();
  const handler = createMemoryRecallHandler({ recall, store, registry });

  const perTurn = [];
  for (let t = 0; t < scenario.turns.length; t++) {
    turnState.turn = t;
    const turn = scenario.turns[t];
    conv.addUserMessage(turn.text);
    await handler(conv); // 旧 onTurnStart：刷新索引 + side-query + 注入 pair

    const injected = lastInjectedSlugs(conv);
    const triggered = injected.length > 0;

    // 主模型纯调用（旧架构主对话收到注入内容），测缓存，内容丢弃
    await mainProvider.chat({ messages: conv.buildMessages(), model: MODEL, maxTokens: 32 });

    conv.appendToAssistantMessage(turn.reply);
    conv.finalizeAssistantMessage({ input: 0, output: 0 });

    // 命中判据：所需记忆是否已在会话上下文（registry 累积集合，旧架构注入过的保留）
    const inContext = registry.getAll().map((e) => e.slug);
    const hit = turn.expectRecall && turn.expectedSlugs.every((s) => inContext.includes(s));
    const freshHit = turn.expectRecall && turn.expectedSlugs.every((s) => injected.includes(s));
    perTurn.push({ turn: t, text: turn.text, expectRecall: turn.expectRecall, expectedSlugs: turn.expectedSlugs, triggered, selectedSlugs: injected, freshHit, hit, inContext, note: turn.note });
    console.log(`  t${t} ${turn.note}: trig=${triggered} freshHit=${freshHit} hit=${hit} sel=${injected.join(",") || "-"} ctx=${inContext.length}`);
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eval-mt-old-"));
  for (const s of seeds) writeSeedMemory(tmp, s);
  const store = new MemoryStore(tmp);
  await store.rebuildIndex();
  const n = (await store.listAll()).length;
  console.log(`种子 ${n}/${seeds.length} (model=${MODEL})`);

  const out: Record<string, unknown> = { arch: "old", model: MODEL, temperature: 0, scenarios: [] };
  for (const scenario of scenarios) {
    console.log(`场景 ${scenario.name} (${scenario.turns.length} 轮):`);
    const recs: UsageRec[] = [];
    const perTurn = await runScenario(scenario, store, recs, { turn: 0 });
    out.scenarios.push({ id: scenario.id, name: scenario.name, perTurn, metrics: summarize(scenario, perTurn as never, recs), calls: recs });
  }
  const outPath = path.join(DATA, `results-multiturn-old.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`结果已写入 ${outPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

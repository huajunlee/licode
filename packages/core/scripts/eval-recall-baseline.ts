// 旧架构（side-query 两阶段召回）召回率评测脚本。仅用于与新版 tool 架构做 A/B 对比。
//   ⚠️ 依赖旧版 memory/recall.ts 的 MemoryRecall 类，master 上已删除：
//   需在含旧实现的分支（如 main-0817）checkout 中运行——
//   将本脚本与 eval-recall/{seed-memories.json,cases.json} 一并复制到旧 checkout 的
//   packages/core/scripts/ 下，然后：
//   ANTHROPIC_AUTH_TOKEN=... pnpm tsx packages/core/scripts/eval-recall-baseline.ts
//   （EVAL_MODEL 可覆盖默认模型；AUTH/API KEY 作为凭证；temperature 固定 0 保证可复现）
//
// 测量对象：MemoryRecall.select(query, store) 的 side-query 选摘（旧架构每轮自动注入，
// 主模型无决策权），与新架构 eval-recall.ts --mode=tool（主模型自主调 memory_recall）对称。
// 数据/指标口径与 tool 模式完全一致（seed-memories.json + cases.json，A/B/C/D 四组）。
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "../src/memory/store.js";
import { MemoryRecall } from "../src/memory/recall.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, "eval-recall");
const MODEL = process.env.EVAL_MODEL ?? "kimi-k3";

interface Seed { slug: string; name: string; description: string; type: string; keywords: string[]; content: string; }
interface Case { id: string; group: "A" | "B" | "C" | "D"; query: string; expectRecall: boolean | null; expectedSlugs: string[]; }

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
    `keywords: ${JSON.stringify(seed.keywords)}`,
    "---",
    "",
    seed.content,
  ].join("\n");
  fs.writeFileSync(file, fm);
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY)
    throw new Error("需要 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY 环境变量");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eval-recall-baseline-"));
  const seeds = JSON.parse(fs.readFileSync(path.join(DATA, "seed-memories.json"), "utf-8")) as Seed[];
  for (const s of seeds) writeSeedMemory(tmp, s);
  const store = new MemoryStore(tmp);
  await store.rebuildIndex();

  const all = await store.listAll();
  console.log(`种子记忆加载: ${all.length}/${seeds.length} 条 (model=${MODEL}, temperature=0)`);
  if (all.length !== seeds.length) throw new Error("种子记忆未被 MemoryStore 正确解析，检查 writeSeedMemory 格式");

  const cases = JSON.parse(fs.readFileSync(path.join(DATA, "cases.json"), "utf-8")) as Case[];
  const recall = new MemoryRecall({
    apiKey: process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY,
    model: MODEL,
  });

  const perCase = [];
  for (const c of cases) {
    const { add } = await recall.select(c.query, store);
    const selectedSlugs = add.map((m) => m.slug);
    const hit = c.expectedSlugs.length > 0 && c.expectedSlugs.every((s) => selectedSlugs.includes(s));
    perCase.push({ id: c.id, group: c.group, triggered: selectedSlugs.length > 0, selectedSlugs, hit });
    console.log(`${c.id} [${c.group}] triggered=${selectedSlugs.length > 0} hit=${hit} selected=${selectedSlugs.join(",") || "-"}`);
  }

  const groupA = perCase.filter((p) => p.group === "A");
  const groupB = perCase.filter((p) => p.group === "B");
  const groupD = perCase.filter((p) => p.group === "D");
  const totalSelected = perCase.reduce((n, p) => n + p.selectedSlugs.length, 0);
  const totalExpected = cases.flatMap((c) => c.expectedSlugs);
  const totalCorrect = perCase.reduce(
    (n, p) => n + p.selectedSlugs.filter((s) => totalExpected.includes(s)).length, 0);
  const summary = {
    recallA: groupA.filter((p) => p.hit).length / groupA.length,
    // 旧版 side-query：triggered 定义为「注入 ≥1 条」（只会注入选中的，不存在空触发），
    // 故误触发率与误召回率数值恒等；为与新版输出对称，两个字段都给出。
    triggerRateB: groupB.filter((p) => p.triggered).length / groupB.length,
    falsePositiveB: groupB.filter((p) => p.selectedSlugs.length > 0).length / groupB.length,
    precision: totalSelected === 0 ? 1 : totalCorrect / totalSelected,
    fabricateD: groupD.filter((p) => p.selectedSlugs.length > 0).length / groupD.length,
  };
  console.log(`\nA组召回率=${(summary.recallA * 100).toFixed(0)}%  B组误触发率=${(summary.triggerRateB * 100).toFixed(0)}%  B组误召回率=${(summary.falsePositiveB * 100).toFixed(0)}%  选中准确率=${(summary.precision * 100).toFixed(0)}%  D组幻觉联想=${(summary.fabricateD * 100).toFixed(0)}%`);

  const out = path.join(DATA, `results-baseline.json`);
  fs.writeFileSync(out, JSON.stringify({ model: MODEL, temperature: 0, perCase, summary }, null, 2));
  console.log(`结果已写入 ${out}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

// 召回率评测脚本。用法：
//   ANTHROPIC_AUTH_TOKEN=... pnpm tsx packages/core/scripts/eval-recall.ts --mode=baseline
//   （ANTHROPIC_API_KEY 亦可作为凭证回退；EVAL_MODEL 可覆盖默认模型 kimi-k3）
// 数据：seed-memories.json（写入临时 MemoryStore）、cases.json（评测用例）
// 输出：eval-recall/results-<mode>.json + 控制台汇总表
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "../src/memory/store.js";
import { MemoryRecall } from "../src/memory/recall.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, "eval-recall");

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

async function main(): Promise<void> {
  const mode = process.argv.find((a) => a.startsWith("--mode="))?.slice(7) ?? "baseline";
  if (mode !== "baseline") throw new Error(`unknown mode: ${mode}（tool 模式由 Task 7 实现）`);
  if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY)
    throw new Error("需要 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY 环境变量");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eval-recall-"));
  const seeds = JSON.parse(fs.readFileSync(path.join(DATA, "seed-memories.json"), "utf-8")) as Seed[];
  for (const s of seeds) writeSeedMemory(tmp, s);
  const store = new MemoryStore(tmp);
  await store.rebuildIndex();

  // 种子自检：写盘格式若与 parse() 不兼容，这里会暴露（0 条说明 frontmatter 写错）。
  const all = await store.listAll();
  console.log(`种子记忆加载: ${all.length}/${seeds.length} 条`);
  if (all.length !== seeds.length) throw new Error("种子记忆未被 MemoryStore 正确解析，检查 writeSeedMemory 格式");

  const cases = JSON.parse(fs.readFileSync(path.join(DATA, "cases.json"), "utf-8")) as Case[];
  const recall = new MemoryRecall({
    apiKey: process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY,
    model: process.env.EVAL_MODEL ?? "kimi-k3",
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
  const totalSelected = perCase.reduce((n, p) => n + p.selectedSlugs.length, 0);
  const totalExpected = cases.flatMap((c) => c.expectedSlugs);
  const totalCorrect = perCase.reduce(
    (n, p) => n + p.selectedSlugs.filter((s) => totalExpected.includes(s)).length, 0);
  const summary = {
    recallA: groupA.filter((p) => p.hit).length / groupA.length,
    falsePositiveB: groupB.filter((p) => p.triggered).length / groupB.length,
    precision: totalSelected === 0 ? 1 : totalCorrect / totalSelected,
  };
  console.log(`\nA组召回率=${(summary.recallA * 100).toFixed(0)}%  B组误召回率=${(summary.falsePositiveB * 100).toFixed(0)}%  选中准确率=${(summary.precision * 100).toFixed(0)}%`);

  const out = path.join(DATA, `results-${mode}.json`);
  fs.writeFileSync(out, JSON.stringify({ perCase, summary }, null, 2));
  console.log(`结果已写入 ${out}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

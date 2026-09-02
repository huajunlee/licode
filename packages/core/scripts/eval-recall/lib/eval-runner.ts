// packages/core/scripts/eval-recall/lib/eval-runner.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStore } from "../../../src/memory/store.js";
import type { Seed, Case, CaseGroup, Recaller } from "./recaller.js";
import { DEFAULT_K } from "./recaller.js";
import { recallAtK, precisionAtK, mrr, computeBehaviorMetrics, type BehaviorMetrics } from "./metrics.js";
import { assertValidDataset } from "./validate.js";

/** 写一条种子记忆到目录（frontmatter 格式必须与 store.parse() 兼容，参照 eval-recall.ts）。 */
export function writeSeedMemory(dir: string, seed: Seed): void {
  const file = path.join(dir, `${seed.slug}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fm = [
    "---",
    `name: ${seed.name}`,
    `description: ${seed.description}`,
    `type: ${seed.type}`,
    "createdAt: 2026-08-01T00:00:00.000Z",
    "updatedAt: 2026-08-01T00:00:00.000Z",
    "pinned: false",
    `keywords: ${JSON.stringify(seed.keywords)}`,
    "---",
    "",
    seed.content,
  ].join("\n");
  fs.writeFileSync(file, fm);
}

/** 临时目录建 MemoryStore；校验种子全部解析成功。 */
export async function buildEvalStore(seeds: Seed[]): Promise<{ store: MemoryStore; cleanup: () => void }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eval-recall-"));
  for (const s of seeds) writeSeedMemory(tmp, s);
  const store = new MemoryStore(tmp);
  await store.rebuildIndex();
  const loaded = await store.listAll();
  if (loaded.length !== seeds.length) throw new Error(`种子解析失败：${loaded.length}/${seeds.length}`);
  return { store, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

export interface EvalConfig {
  recaller: Recaller;
  seeds: Seed[];
  cases: Case[];
  // 注意：runner 只用数据 + recaller，不持有 store——store 由调用方建适配器时单独持有。
}

export interface PerCaseResult {
  id: string;
  group: CaseGroup;
  set: string;
  dimensions: string[];
  expectedSlugs: string[];
  k: number;
  candidates: string[];
  triggered: boolean;
  hit: boolean;
  failed?: string;
}

export interface EvalSummary {
  kind: string;
  perCase: PerCaseResult[];
  failed: number;
  rag: { recallAtK: number; precisionAtK: number; mrr: number };
  behavior: BehaviorMetrics;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export async function runEvaluation(cfg: EvalConfig): Promise<EvalSummary> {
  assertValidDataset(cfg.seeds, cfg.cases);
  const perCase: PerCaseResult[] = [];
  for (const c of cfg.cases) {
    const k = c.k ?? DEFAULT_K;
    let candidates: string[] = [];
    let triggered = false;
    let failed: string | undefined;
    try {
      const res = await cfg.recaller.retrieve(c.query, { topK: k });
      triggered = res.triggered ?? true;
      candidates = res.candidates.map((x) => x.slug).slice(0, k);
    } catch (e) {
      failed = String(e);
    }
    const hit = c.expectedSlugs.length > 0 && c.expectedSlugs.every((s) => candidates.includes(s));
    perCase.push({
      id: c.id, group: c.group, set: c.set ?? "core", dimensions: c.dimensions ?? [],
      expectedSlugs: c.expectedSlugs, k, candidates, triggered, hit, failed,
    });
  }
  const valid = perCase.filter((r) => !r.failed);
  const rag = {
    recallAtK: avg(valid.map((r) => recallAtK(r.candidates, r.expectedSlugs, r.k))),
    precisionAtK: avg(valid.map((r) => precisionAtK(r.candidates, r.expectedSlugs, r.k))),
    mrr: avg(valid.map((r) => mrr(r.candidates, r.expectedSlugs))),
  };
  const behavior = computeBehaviorMetrics(valid);
  return { kind: cfg.recaller.kind, perCase, failed: perCase.length - valid.length, rag, behavior };
}

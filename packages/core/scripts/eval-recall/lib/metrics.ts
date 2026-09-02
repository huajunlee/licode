// packages/core/scripts/eval-recall/lib/metrics.ts
import type { CaseGroup } from "./recaller.js";

/** 期望 ⊆ top-k？多期望全部命中才算 1。 */
export function recallAtK(ranked: string[], expected: string[], k: number): number {
  if (k <= 0 || expected.length === 0) return 0;
  const top = ranked.slice(0, k);
  return expected.every((s) => top.includes(s)) ? 1 : 0;
}

/** |top-k ∩ 期望| ÷ k；空候选返回 0。 */
export function precisionAtK(ranked: string[], expected: string[], k: number): number {
  const top = ranked.slice(0, k);
  if (top.length === 0) return 0;
  const hit = top.filter((s) => expected.includes(s)).length;
  return hit / k;
}

/** 第一个期望 slug 排名的倒数；未命中 0。旧记忆排前面不得分（只认期望）。 */
export function mrr(ranked: string[], expected: string[]): number {
  if (expected.length === 0) return 0;
  for (let i = 0; i < ranked.length; i++) {
    if (expected.includes(ranked[i])) return 1 / (i + 1);
  }
  return 0;
}

export interface PerCaseBehavior {
  id: string;
  group: CaseGroup;
  triggered: boolean;
  candidates: string[];
  expectedSlugs: string[];
}

export interface BehaviorMetrics {
  recallA: number;
  triggerRateB: number;
  falsePositiveB: number;
  precision: number;
  fabricateD: number;
}

/** v1 行为指标，口径与 A-B-test-v1.md §3.4 一致。 */
export function computeBehaviorMetrics(results: PerCaseBehavior[]): BehaviorMetrics {
  const A = results.filter((r) => r.group === "A");
  const B = results.filter((r) => r.group === "B");
  const D = results.filter((r) => r.group === "D");
  const recallA = A.length ? A.filter((r) => r.expectedSlugs.every((s) => r.candidates.includes(s))).length / A.length : 0;
  const triggerRateB = B.length ? B.filter((r) => r.triggered).length / B.length : 0;
  const falsePositiveB = B.length ? B.filter((r) => r.candidates.length > 0).length / B.length : 0;
  // 与 v1（eval-recall.ts）口径一致：正确 = 选中的 slug 出现在任一用例的 expectedSlugs 里。
  // 例如 B 组选中某 A 组的期望 slug：对 precision 是"正确"（对 falsePositiveB 仍是误召回）。
  const totalExpected = results.flatMap((r) => r.expectedSlugs);
  const totalSelected = results.reduce((n, r) => n + r.candidates.length, 0);
  const totalCorrect = results.reduce(
    (n, r) => n + r.candidates.filter((s) => totalExpected.includes(s)).length,
    0
  );
  const precision = totalSelected === 0 ? 1 : totalCorrect / totalSelected;
  const fabricateD = D.length ? D.filter((r) => r.candidates.length > 0).length / D.length : 0;
  return { recallA, triggerRateB, falsePositiveB, precision, fabricateD };
}

// packages/core/scripts/eval-recall/lib/validate.ts
import type { Seed, Case } from "./recaller.js";
import { DEFAULT_K } from "./recaller.js";

export interface ValidationIssue {
  severity: "error" | "warning";
  message: string;
}

export function validateDataset(seeds: Seed[], cases: Case[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const slugs = new Set(seeds.map((s) => s.slug));
  const superseded = new Set<string>();

  for (const c of cases) {
    for (const s of c.expectedSlugs) {
      if (!slugs.has(s)) issues.push({ severity: "error", message: `${c.id}: expectedSlug ${s} 不存在于种子` });
    }
    const k = c.k ?? DEFAULT_K;
    if (k < c.expectedSlugs.length) {
      issues.push({ severity: "error", message: `${c.id}: k=${k} < expectedSlugs.length=${c.expectedSlugs.length}` });
    }
    if (c.set && c.set !== "core" && c.set !== "extended") {
      issues.push({ severity: "error", message: `${c.id}: 非法 set ${c.set}` });
    }
  }

  for (const s of seeds) {
    if (s.conflictsWith) {
      if (!slugs.has(s.conflictsWith)) {
        issues.push({ severity: "error", message: `${s.slug}: conflictsWith ${s.conflictsWith} 不存在` });
      }
      superseded.add(s.slug);
    }
  }

  for (const c of cases) {
    if (c.dimensions?.includes("time-conflict")) {
      for (const s of c.expectedSlugs) {
        if (superseded.has(s)) issues.push({ severity: "error", message: `${c.id}: time-conflict 用例期望了被替代记忆 ${s}` });
      }
    }
    if (c.dimensions?.includes("similar-pair") && c.expectedSlugs.length !== 1) {
      issues.push({ severity: "error", message: `${c.id}: similar-pair 用例期望必须唯一命中其一` });
    }
  }

  return issues;
}

export function assertValidDataset(seeds: Seed[], cases: Case[]): void {
  const errors = validateDataset(seeds, cases).filter((i) => i.severity === "error");
  if (errors.length) {
    throw new Error("数据集校验失败：\n" + errors.map((e) => `  - ${e.message}`).join("\n"));
  }
}

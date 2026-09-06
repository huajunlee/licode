// packages/core/scripts/eval-recall/lib/recaller.ts
export type MemoryType = "user" | "feedback" | "project" | "reference";
export type CaseGroup = "A" | "B" | "C" | "D";

export interface Seed {
  slug: string;
  name: string;
  description: string;
  type: MemoryType;
  keywords: string[];
  content: string;
  set?: "core" | "extended";   // 核心集 / 扩展集
  domain?: string;             // 分域标签（扩展集）
  conflictsWith?: string;      // 时间冲突对：旧记忆被哪条新记忆替代（spec §3.5）
}

export interface Case {
  id: string;
  group: CaseGroup;            // A=应召回 B=不应 C=探索 D=对抗
  query: string;
  expectRecall: boolean | null;
  expectedSlugs: string[];
  set?: "core" | "extended";
  dimensions?: string[];       // 维度标签，取值见 spec §3.3 词汇表
  k?: number;                  // 评测 top-k，默认 DEFAULT_K
}

export interface RecallCandidate {
  slug: string;
  score: number;
}

export interface RecallResult {
  candidates: RecallCandidate[];  // 已按相关度降序
  triggered?: boolean;            // v1：主模型是否调了工具（RAG 恒 true）
}

export type RecallerKind = "v1-tool" | "rag-keyword" | "lance-fts" | "rag-retriever" | "rag-rerank";

export interface Recaller {
  readonly kind: RecallerKind;
  retrieve(query: string, opts: { keywords?: string[]; topK: number }): Promise<RecallResult>;
}

export const DEFAULT_K = 5;

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface Memory {
  /** 文件路径 slug，如 "user/food-preferences"（不含 .md） */
  slug: string;
  /** 记忆类型 */
  type: MemoryType;
  /** 简短名称，如 "食物偏好" */
  name: string;
  /** 一句话描述，用于 MEMORY.md 索引行 */
  description: string;
  /** 记忆正文 */
  content: string;
  /** 创建时间 ISO */
  createdAt: string;
  /** 更新时间 ISO */
  updatedAt: string;
  /** 被 recall 注入上下文的累计次数（Phase 4）。未用过为 0。 */
  usageCount?: number;
  /** 最近一次被 recall 注入的 ISO 时间（Phase 4）。未用过为 ""。 */
  lastUsedAt?: string;
  /** Phase 4: 用户/Agent 标记的"永不归档"。pinned 记忆不进归档候选。 */
  pinned?: boolean;
  /**
   * Per-memory 检索关键词（Phase B，LLM 产出）。recall 的 rich-index 将据此命中。
   * 注意：与 dream.ts 的 suspicion keywords 无关——那是漂移线索词，不是检索键。
   */
  keywords?: string[];
}

/** @deprecated 使用 Memory 替代 */
export interface MemoryEntry {
  id: string;
  title: string;
  content: string;
  tags?: string[];
}

/**
 * 将名称转为 kebab-case slug。
 * "Food Preferences" → "food-preferences"
 * 中文使用 hash 兜底
 */
export function toSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[一-鿿]+/g, (match) => "-" + hashString(match) + "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    || "untitled";
}

function hashString(value: string): string {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * 可读文件名清洗：保留中文(一-鿿)/字母/数字，其余(空格、标点、/ \ : * ? " < > | 等)转 -，
 * 去首尾与重复 -。不截断（截断由调用方定）。空或全标点返回空。
 */
export function cleanName(s: string): string {
  return s
    .replace(/[^一-鿿a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

/** 从 ISO 字符串取本地时区的 HHmm（如 "1430"），用于文件名，与本地 date 对齐。 */
export function hhmmFromISO(iso: string): string {
  const d = new Date(iso);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}${m}`;
}

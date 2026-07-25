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

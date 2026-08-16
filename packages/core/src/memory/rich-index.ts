import type { Memory } from "./types.js";

/**
 * 富索引：每行 `- [name](slug.md) - description [关键词: ...] 「首行预览」`。
 * 与旧 MemoryRecall.select 的内联格式一致，供 recall 子 agent 的 prompt 使用。
 * 注意：slug 已含类型前缀（如 user/xxx），展示时拼 `.md` 后缀仅作示意。
 */
export function buildRichIndex(memories: Memory[]): string {
  return memories
    .map((m) => {
      const parts = [`- [${m.name}](${m.slug}.md) - ${m.description}`];
      if (m.keywords && m.keywords.length) parts.push(`[关键词: ${m.keywords.join(",")}]`);
      const first = (m.content.split("\n")[0] || "").trim();
      const preview = first.length > 60 ? first.slice(0, 60) + "…" : first;
      parts.push(`「${preview}」`);
      return parts.join(" ");
    })
    .join("\n");
}

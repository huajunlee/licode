import { z } from "zod";
import * as path from "node:path";
import type { Tool } from "../types.js";
import { JournalStore } from "../../diary/store.js";
import type { DiaryEntry } from "../../diary/types.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const JournalRecallParams = z.object({
  query: z
    .string()
    .optional()
    .describe("关键词或人名，搜索日记（可与 start_date/end_date 叠加，在日期范围内搜索）"),
  start_date: z
    .string()
    .regex(DATE_RE)
    .optional()
    .describe(
      "起始日期 YYYY-MM-DD。查询单日时与 end_date 填相同日期；只填 start_date 或只填 end_date 时都按那一天查询"
    ),
  end_date: z
    .string()
    .regex(DATE_RE)
    .optional()
    .describe(
      "结束日期 YYYY-MM-DD。查询单日时与 start_date 填相同日期；只填 start_date 或只填 end_date 时都按那一天查询"
    ),
  limit: z
    .number()
    .optional()
    .describe("返回条目上限（默认 5，仅在不指定日期范围和 query 时生效）"),
});

function formatEntry(e: DiaryEntry): string {
  const lines = [`[${e.meta.date} ${e.meta.id}] ${e.summary || "(无摘要)"}`];
  if (e.people.length) {
    lines.push(
      `  人物: ${e.people
        .map((p) => `${p.name}${p.relation ? `(${p.relation})` : ""}`)
        .join(", ")}`
    );
  }
  if (e.emotions.length) {
    lines.push(
      `  情绪: ${e.emotions.map((em) => `${em.state}(${em.intensity})`).join(", ")}`
    );
  }
  if (e.facts.length) {
    lines.push(`  事实: ${e.facts.map((f) => f.what).join("; ")}`);
  }
  if (e.decisions.length) {
    lines.push(`  决定: ${e.decisions.map((d) => d.decision).join("; ")}`);
  }
  return lines.join("\n");
}

export const journalRecallTool: Tool<typeof JournalRecallParams> = {
  name: "journal_recall",
  description:
    "查询用户的日记/日志记录（过去发生过的事）。仅当用户明确询问过去事件时调用（如“今天/某天干了什么”“最近发生了什么”“和某人发生过什么”），" +
    "不要在用户没问过去事件时主动调用以“了解上下文”。写日记用 /diary，查人物画像用 profile_recall。" +
    "可按日期范围（start_date/end_date）或关键词/人名（query）查询，两者可叠加（范围内搜索）；不带参数返回最近几条。" +
    "查单日：start_date 与 end_date 填相同日期；只填其中一个也按那一天查询。",
  parameters: JournalRecallParams,

  async execute(input, context) {
    const store = new JournalStore(
      path.join(context.workingDirectory, ".licode", "journal")
    );
    try {
      const hasStart = input.start_date != null;
      const hasEnd = input.end_date != null;
      let range: { start: string; end: string } | null = null;
      if (hasStart || hasEnd) {
        const start = input.start_date ?? input.end_date!;
        const end = input.end_date ?? input.start_date!;
        if (start > end) {
          return {
            status: "error",
            error: `start_date (${start}) 不能晚于 end_date (${end})`,
            errorType: "validation",
          };
        }
        range = { start, end };
      }

      let entries: DiaryEntry[];
      if (range && input.query) {
        entries = await store.search(input.query, range);
      } else if (range) {
        entries = await store.listRange(range.start, range.end);
      } else if (input.query) {
        entries = await store.search(input.query);
      } else {
        entries = await store.listRecent(input.limit ?? 5);
      }
      if (entries.length === 0) {
        return { status: "success", content: "(没有找到日记条目)" };
      }
      const content = entries.map(formatEntry).join("\n---\n");
      return {
        status: "success",
        content:
          content.length > 10000
            ? content.slice(0, 10000) + "\n... (truncated)"
            : content,
        metadata: { count: entries.length },
      };
    } catch (err) {
      return {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        errorType: "execution",
      };
    }
  },
};

import { z } from "zod";
import * as path from "node:path";
import type { Tool } from "../types.js";
import { JournalStore } from "../../diary/store.js";
import type { DiaryEntry } from "../../diary/types.js";

const JournalRecallParams = z.object({
  query: z
    .string()
    .optional()
    .describe("关键词或人名，搜索日记（与 date 二选一）"),
  date: z
    .string()
    .optional()
    .describe("指定日期 YYYY-MM-DD，返回当天所有条目"),
  limit: z
    .number()
    .optional()
    .describe("返回条目上限（默认 5，仅在不指定 query/date 时生效）"),
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
    "查询用户的日记/日志记录（过去发生过的事）。当用户问“今天/某天干了什么”“最近怎样”“和某人发生过什么”等关于过去事件的问题时调用。" +
    "可按日期(date)、关键词/人名(query)查询，或不带参数返回最近几条。",
  parameters: JournalRecallParams,

  async execute(input, context) {
    const store = new JournalStore(
      path.join(context.workingDirectory, ".licode", "journal")
    );
    try {
      let entries: DiaryEntry[];
      if (input.date) {
        entries = await store.listByDate(input.date);
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

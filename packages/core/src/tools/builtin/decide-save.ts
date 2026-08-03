import type { DiaryEntry, PersonRef } from "../../diary/types.js";
import { formatLocalDate } from "../../util/date.js";
import { z } from "zod";
import * as path from "node:path";
import type { Tool } from "../types.js";
import { JournalStore } from "../../diary/store.js";

export interface BuildEntryInput {
  topic: string;
  decision: string;
  reasoning: string;
  people?: string[];
  now: () => Date;
}

export function buildDecisionEntry(input: BuildEntryInput): DiaryEntry {
  const { topic, decision, reasoning, people, now } = input;
  const d = now();
  const iso = d.toISOString();
  const peopleRefs: PersonRef[] = (people ?? []).map((name) => ({
    name,
    relation: null,
    relationInferred: false,
    interaction: "决策涉及",
    note: null,
    specific: true,
  }));
  return {
    meta: { id: d.getTime().toString(36), date: formatLocalDate(d), createdAt: iso, endedAt: iso },
    raw: {
      content: `# 决策：${topic}\n\n## 结论\n${decision}\n\n## 理由与分析\n${reasoning}`,
      segments: [],
    },
    title: `【决策】${topic}`,
    summary: decision,
    facts: [],
    decisions: [{ decision, reasoning, context: topic }],
    emotions: [],
    people: peopleRefs,
    futureMemory: [],
  };
}

const DecideSaveParams = z.object({
  topic: z.string().describe("决策话题"),
  decision: z.string().describe("最终倾向的决定/结论"),
  reasoning: z.string().describe("理由与分析（可含选项与权衡）"),
  people: z.array(z.string()).optional().describe("涉及的人名（可选）"),
});

export const decideSaveTool: Tool<typeof DecideSaveParams> = {
  name: "decide_save",
  description:
    "仅在用户明确确认要保存决策后调用。流程：先由 decide 给出分析 -> 你询问\"要不要记下来\" -> 用户同意 -> 才调本工具写入日记。" +
    "绝不主动保存，用户没明确同意不要调用。",
  parameters: DecideSaveParams,
  async execute(input, context) {
    try {
      const entry = buildDecisionEntry({ ...input, now: () => new Date() });
      const store = new JournalStore(path.join(context.workingDirectory, ".licode", "journal"));
      await store.save(entry);
      return {
        status: "success",
        content: `已记下决策：${input.decision}（${entry.meta.date} ${entry.meta.id}）`,
        metadata: { id: entry.meta.id, date: entry.meta.date },
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

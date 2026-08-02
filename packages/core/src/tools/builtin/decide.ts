// packages/core/src/tools/builtin/decide.ts
import type { DiaryEntry, Decision, Fact } from "../../diary/types.js";
import type { PersonProfile } from "../../people/types.js";
import { hhmmFromISO } from "../../memory/types.js";
import { z } from "zod";
import * as path from "node:path";
import type { Tool } from "../types.js";
import { JournalStore } from "../../diary/store.js";
import { PersonProfileStore } from "../../people/store.js";

const RECENT_LIMIT = 5;
const MAX_CHARS = 10000;

/** 一条 entry 的话题匹配 hay：含 decisions 字段（journal_recall 的 search 不含）。 */
function entryHay(e: DiaryEntry): string {
  return [
    e.raw.content,
    e.summary,
    ...e.people.map((p) => p.name),
    ...e.facts.map((f) => f.what),
    ...e.decisions.map((d) => `${d.decision} ${d.reasoning ?? ""}`),
  ].join("\n").toLowerCase();
}

function formatDecision(d: Decision, date: string): string {
  return `- [${date}] ${d.decision}${d.reasoning ? `（理由：${d.reasoning}）` : ""}`;
}

function formatFact(f: Fact, date: string): string {
  return `- [${date}] ${f.what}`;
}

function formatProfile(p: PersonProfile): string {
  const lines = [`### ${p.meta.canonicalName}（别名：${p.meta.aliases.join(", ") || "无"}）`];
  if (p.summary) lines.push(`概述: ${p.summary}`);
  if (p.traits.length) lines.push(`特质: ${p.traits.join("; ")}`);
  if (p.preferences.length) lines.push(`喜好: ${p.preferences.join("; ")}`);
  if (p.relationshipState.length) lines.push(`关系: ${p.relationshipState.map((r) => `${r.date} ${r.state}`).join("; ")}`);
  if (p.interactions.length) lines.push(`互动: ${p.interactions.map((i) => `${i.date} ${i.event}`).join("; ")}`);
  return lines.join("\n");
}

function formatRecent(e: DiaryEntry): string {
  const hhmm = hhmmFromISO(e.meta.createdAt);
  const title = e.title || (e.summary.length > 60 ? e.summary.slice(0, 60) + "…" : e.summary);
  return `- [${e.meta.date} ${hhmm}] ${title}`;
}

const FRAMING = [
  "## 分析指引",
  "你正在帮用户做决定/给意见。结合以上历史决定、相关事实、相关人物立场与喜好、近期状态，以及系统已自动注入的长期记忆，给出分析：",
  "- 默认 B 式：列 2-3 条可选路径，各自利弊与风险，最后给一个倾向性建议（基于用户历史与处境）。",
  '- 若证据不足以支撑明确判断（信息太少/互相矛盾/超出可判断范围），不要硬编模糊答案--降级 C：把事实与各方立场摆清，明说"目前信息不足以给倾向建议"，把判断权交还用户。',
  "- 涉及人物时结合其特质/喜好/关系状态分析。",
  '- 给出分析后，必须询问用户是否要记下这次决策（如"要不要把这次决策记下来？"）。仅在用户明确同意后调用 decide_save；用户拒绝或不回应则不保存、不主动调 decide_save。',
].join("\n");

export interface GatherInput {
  entries: DiaryEntry[];
  profiles: PersonProfile[];
  topic: string;
  people?: string[];
}

export function gatherDecisionContext(input: GatherInput): string {
  const { entries, profiles, topic, people } = input;
  const topicLower = topic.toLowerCase();

  // 按日期降序（最近在前）；同日按 createdAt 降序
  const sorted = [...entries].sort(
    (a, b) => b.meta.date.localeCompare(a.meta.date) || b.meta.createdAt.localeCompare(a.meta.createdAt)
  );
  const recent = sorted.slice(0, RECENT_LIMIT);

  // 1. 话题匹配（空 topic 不匹配，防 includes("") 命中全部）
  const matching = topicLower ? sorted.filter((e) => entryHay(e).includes(topicLower)) : [];

  // 2. 历史决定：匹配 entry 的 decisions；无匹配则兜底近期 entry 的 decisions
  let decisionEntries: DiaryEntry[];
  let decisionsHeader = "## 历史相关决定";
  if (matching.length) {
    decisionEntries = matching;
  } else {
    decisionEntries = recent;
    decisionsHeader = "## 历史相关决定（无直接匹配，显示近期决定）";
  }
  const decisionLines = decisionEntries.flatMap((e) => e.decisions.map((d) => formatDecision(d, e.meta.date)));
  const decisionsBlock = decisionLines.length
    ? `${decisionsHeader}\n${decisionLines.join("\n")}`
    : "## 历史相关决定\n暂无与该话题直接相关的历史决定";

  // 3. 相关事实：匹配 entry 的 facts
  const factLines = matching.flatMap((e) => e.facts.map((f) => formatFact(f, e.meta.date)));
  const factsBlock = factLines.length ? `## 相关事实\n${factLines.join("\n")}` : "## 相关事实\n暂无相关事实";

  // 4. 相关人物：people 参数 + topic 提到 + 匹配 entry 提到的人
  const names = new Set<string>(people ?? []);
  for (const e of matching) for (const ref of e.people) names.add(ref.name);
  const relatedProfiles = profiles.filter((p) => {
    const inTopic =
      topicLower.includes(p.meta.canonicalName.toLowerCase()) ||
      p.meta.aliases.some((a) => topicLower.includes(a.toLowerCase()));
    const inNames = names.has(p.meta.canonicalName) || p.meta.aliases.some((a) => names.has(a));
    return inTopic || inNames;
  });
  const peopleBlock = relatedProfiles.length
    ? `## 相关人物\n${relatedProfiles.map(formatProfile).join("\n\n")}`
    : "## 相关人物\n暂无相关人物档案";

  // 5. 近期日记
  const recentBlock = recent.length
    ? `## 近期日记\n${recent.map(formatRecent).join("\n")}`
    : "## 近期日记\n暂无日记";

  const bulk = [
    `# 决策上下文：${topic}`,
    "",
    decisionsBlock,
    "",
    factsBlock,
    "",
    peopleBlock,
    "",
    recentBlock,
  ].join("\n");
  const framing = "\n\n" + FRAMING;
  // 仅截断 bulk，FRAMING 始终保留在末尾（含 B/C 指引与 decide_save 询问指令）
  const maxBulk = Math.max(0, MAX_CHARS - framing.length);
  const body = bulk.length > maxBulk ? bulk.slice(0, maxBulk) + "\n... (truncated)" : bulk;
  return body + framing;
}

const DecideParams = z.object({
  topic: z
    .string()
    .describe("需要做决定或征求意见的事情/问题（尽量写关键词，如'换工作'，便于匹配历史）"),
  people: z
    .array(z.string())
    .optional()
    .describe("特别相关的人名（可选；不填则自动从话题与历史中找）"),
});

export const decideTool: Tool<typeof DecideParams> = {
  name: "decide",
  description:
    "当用户请你帮忙做决定、拿主意，或征求意见/建议时调用（如\"帮我决定要不要…\"\"你觉得我该不该…\"\"给我点建议\"）。" +
    "汇聚历史决定/事实/人物/近期日记供你给依据分析。闲聊、问事实、执行任务时不要调用。用户确认记下决策时用 decide_save。话题尽量写关键词便于匹配。",
  parameters: DecideParams,
  async execute(input, context) {
    try {
      const journalStore = new JournalStore(
        path.join(context.workingDirectory, ".licode", "journal")
      );
      const profileStore = new PersonProfileStore(
        path.join(context.workingDirectory, ".licode", "people")
      );
      const [entries, profiles] = await Promise.all([
        journalStore.listAll(),
        profileStore.listAll(),
      ]);
      const content = gatherDecisionContext({
        entries,
        profiles,
        topic: input.topic,
        people: input.people,
      });
      return {
        status: "success",
        content,
        metadata: { entries: entries.length, profiles: profiles.length },
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

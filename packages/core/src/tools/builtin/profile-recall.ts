import { z } from "zod";
import * as path from "node:path";
import type { Tool } from "../types.js";
import { PersonProfileStore } from "../../people/store.js";
import type { PersonProfile } from "../../people/types.js";

const ProfileRecallParams = z.object({
  name: z.string().optional().describe("人名或别名，返回该人档案（与 limit 二选一）"),
  limit: z.number().optional().describe("无 name 时返回最近档案数（默认 5）"),
});

function formatProfile(p: PersonProfile): string {
  const lines = [`[${p.meta.canonicalName}]（别名: ${p.meta.aliases.join(", ") || "无"}）`];
  if (p.summary) lines.push(`概述: ${p.summary}`);
  if (p.traits.length) lines.push(`特质: ${p.traits.join("; ")}`);
  if (p.preferences.length) lines.push(`喜好: ${p.preferences.join("; ")}`);
  if (p.relationshipState.length) lines.push(`关系: ${p.relationshipState.map((r) => `${r.date} ${r.state}`).join("; ")}`);
  if (p.interactions.length) lines.push(`互动: ${p.interactions.map((i) => `${i.date} ${i.event}`).join("; ")}`);
  return lines.join("\n");
}

export const profileRecallTool: Tool<typeof ProfileRecallParams> = {
  name: "profile_recall",
  description:
    "查询用户的人物档案（人际关系的结构化记录）。仅当用户明确询问某个人时调用（如“王总是谁”“某人什么样”“我和某人关系怎样”），" +
    "不要在用户没问人物时主动调用。查过去发生的事件用 journal_recall。可按人名/别名查，或不带参数返回最近档案。",
  parameters: ProfileRecallParams,
  async execute(input, context) {
    const store = new PersonProfileStore(path.join(context.workingDirectory, ".licode", "people"));
    try {
      let profiles: PersonProfile[];
      if (input.name) {
        const p = await store.findByName(input.name);
        profiles = p ? [p] : [];
      } else {
        profiles = await store.listRecent(input.limit ?? 5);
      }
      if (profiles.length === 0) return { status: "success", content: "(没有找到人物档案)" };
      const content = profiles.map(formatProfile).join("\n---\n");
      return { status: "success", content, metadata: { count: profiles.length } };
    } catch (err) {
      return { status: "error", error: err instanceof Error ? err.message : String(err), errorType: "execution" };
    }
  },
};

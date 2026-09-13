import type { Skill } from "./loader.js";
import type { SystemPromptLayer } from "../../conversation/system-prompt.js";

/**
 * 把所有技能合成**一个**常驻书目层：只有 name + description + 取用指引。
 * 正文不进 system prompt，模型需要时用 Read 读 SKILL.md、用 Bash 跑 scripts/。
 * 无技能时返回 null（调用方据此跳过 addLayer）。
 */
export function skillsToPromptLayer(
  skills: Skill[],
  skillsRoot: string
): SystemPromptLayer | null {
  if (skills.length === 0) return null;

  const lines = [
    "## 可用技能",
    "",
    `技能位于 \`${skillsRoot}\` 下，每个技能一个目录，内含 SKILL.md。`,
    "当任务与某个技能的描述相符时，用 Read 读取它的 SKILL.md 全文；",
    "技能目录内的附件用 Read 读取，`scripts/` 里的脚本用 Bash 执行。",
    "",
    ...skills.map((s) => `- ${s.name}：${s.description}`),
  ];

  return {
    name: "skills",
    priority: 15,
    always: true,
    content: lines.join("\n"),
  };
}

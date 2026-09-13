import type { Skill } from "./loader.js";
import type { SystemPromptLayer } from "../../conversation/system-prompt.js";

/**
 * 把所有技能合成**一个**常驻书目层：每个技能只给 name + description + 目录。
 * 正文不进 system prompt，模型需要时用 Read 读 `<目录>/SKILL.md`、用 Bash 跑 scripts/。
 * 目录逐条列出（而非只给一个根），因为技能可能来自内置、用户、项目多个根。
 * 无技能时返回 null（调用方据此跳过 addLayer）。
 */
export function skillsToPromptLayer(skills: Skill[]): SystemPromptLayer | null {
  if (skills.length === 0) return null;

  const lines = [
    "## 可用技能",
    "",
    "下面每个技能对应一个目录（路径列在条目后），目录内含 SKILL.md。",
    "当任务与某个技能的描述相符时，用 Read 读取它的 SKILL.md 全文；",
    "技能目录内的附件用 Read 读取，`scripts/` 里的脚本用 Bash 执行。",
    "",
    ...skills.map((s) => `- ${s.name}：${s.description}\n  目录：${s.dir}`),
  ];

  return {
    name: "skills",
    priority: 15,
    always: true,
    content: lines.join("\n"),
  };
}

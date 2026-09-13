import type { SystemPromptLayer } from "../conversation/system-prompt.js";

/**
 * 人物档案存在提示层：一行静态文本，会话启动时按档案数量生成，会话期间不更新（缓存安全）。
 * 不列具体内容——具体内容由模型按需读 `.licode/people/` 下的文件。
 *
 * 这一层承接了原先 profile_recall 工具描述所承担的职责：告诉模型档案在哪、长什么样。
 * 工具删掉之后，若没有这一层，模型就无从知道人物档案的存在。
 */
export function peoplePresenceLayer(count: number): SystemPromptLayer | null {
  if (count <= 0) return null;

  const content =
    `你有 ${count} 份人物档案（你提到过的人的近况、喜好与关系变化），存放在 \`.licode/people/\` 下，` +
    "一人一个 markdown 文件：YAML frontmatter（`canonicalName` 正式名 / `aliases` 别名）" +
    "加 `## 概述` 与 `## 结构化` 的 JSON（traits / preferences / interactions / relationshipState）。" +
    "对话涉及具体的人时直接 Read 相应文件即可；**别名可能与文件名不一致**，" +
    "先 Glob 看目录里都有谁，必要时按 `aliases` 里的名字 Grep 找。";

  return { name: "people-presence", priority: 5, always: false, content };
}

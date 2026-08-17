import type { SystemPromptLayer } from "../conversation/system-prompt.js";

/**
 * 记忆存在提示层：一行静态文本，会话启动时按记忆数量量化生成，会话期间不更新
 * （缓存安全）。不列任何具体内容——具体内容由 memory_recall 工具按需查询。
 */
export function memoryPresenceLayer(count: number): SystemPromptLayer {
  const content =
    count >= 10
      ? `你有 ${Math.floor(count / 10) * 10}+ 条长期记忆（user 用户偏好 / feedback 纠偏反馈 / project 项目理解 / reference 外部资料），需要时调用 memory_recall 工具查询。`
      : count > 0
        ? `你有几条长期记忆（user 用户偏好 / feedback 纠偏反馈 / project 项目理解 / reference 外部资料），需要时调用 memory_recall 工具查询。`
        : "你目前还没有长期记忆。当用户透露偏好、决定或项目背景时会被记入，之后可用 memory_recall 工具查询。";
  return { name: "memory-presence", priority: 5, always: false, content };
}

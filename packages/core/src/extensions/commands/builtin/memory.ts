import { MemoryStore } from "../../../memory/store.js";
import type { SlashCommand } from "../registry.js";

export const memoryCommand: SlashCommand = {
  name: "memory",
  description: "Manage persistent memory (list, add)",
  async execute(args, context) {
    const store = new MemoryStore(`${context.workingDirectory}/.licode/memory`);

    const sub = args[0];

    if (!sub || sub === "list") {
      const entries = await store.list();
      if (entries.length === 0) {
        return {
          type: "action",
          message: [
            "📝 没有存储的记忆。",
            "",
            "记忆会在你使用以下触发词时自动保存：",
            '  • "我的名字是..." / "我叫..."',
            '  • "记住我喜欢/偏好..."',
            '  • "记住..."',
            "",
            "也可以手动添加：/memory add <内容>",
          ].join("\n"),
        };
      }
      const lines = entries.map(
        (e) =>
          `  [${e.id}] ${e.title}: ${e.content.slice(0, 80)}${e.content.length > 80 ? "..." : ""}`
      );
      return {
        type: "action",
        message: `📝 记忆 (${entries.length}):\n${lines.join("\n")}`,
      };
    }

    if (sub === "add") {
      const content = args.slice(1).join(" ").trim();
      if (!content) {
        return { type: "error", message: "使用方式: /memory add <内容>" };
      }
      const id = `manual-${Date.now().toString(36)}`;
      await store.save({
        id,
        title: "Manual Memory",
        content,
        tags: ["manual"],
      });
      return {
        type: "action",
        message: `✅ 已添加记忆 [${id}]: ${content.slice(0, 80)}`,
      };
    }

    return {
      type: "error",
      message: "未知子命令。使用: /memory list | add <内容>",
    };
  },
};

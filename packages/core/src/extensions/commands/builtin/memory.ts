import { MemoryStore } from "../../../memory/store.js";
import type { Memory, MemoryType } from "../../../memory/types.js";
import type { SlashCommand } from "../registry.js";

function getStore(context: { workingDirectory: string }): MemoryStore {
  return new MemoryStore(`${context.workingDirectory}/.licode/memory`);
}

async function listMemories(store: MemoryStore): Promise<string> {
  const entries = await store.listAll();
  if (entries.length === 0) {
    return [
      "📝 没有存储的记忆。",
      "",
      "记忆会在你使用以下触发词时自动保存：",
      '  • "我的名字是..." / "我叫..."',
      '  • "记住我喜欢/偏好..."',
      '  • "记住..."',
      "",
      "也可以手动添加：/memory-add <内容>",
    ].join("\n");
  }

  // Group by type
  const byType: Record<string, Memory[]> = {};
  for (const e of entries) {
    (byType[e.type] ??= []).push(e);
  }

  const typeLabels: Record<string, string> = {
    user: "👤 用户",
    feedback: "💬 反馈",
    project: "📁 项目",
    reference: "🔗 引用",
  };

  const lines: string[] = [];
  for (const [type, mems] of Object.entries(byType)) {
    lines.push(`${typeLabels[type] ?? type}:`);
    for (const m of mems) {
      const preview = m.content.length > 60
        ? m.content.slice(0, 60) + "..."
        : m.content;
      lines.push(`  [${m.slug}] ${m.name}: ${preview}`);
    }
  }

  return `📝 记忆 (${entries.length}):\n${lines.join("\n")}`;
}

function errorUnknown(): { type: "error"; message: string } {
  return {
    type: "error",
    message: "未知子命令。使用: /memory-list | /memory-add <内容> | /memory-delete <slug>",
  };
}

// ── /memory ── (backward compat, delegates to list) ──────────────────

export const memoryCommand: SlashCommand = {
  name: "memory",
  description: "Manage persistent memory",
  async execute(args, context) {
    const sub = args[0];

    if (!sub || sub === "list") {
      return { type: "action", message: await listMemories(getStore(context)) };
    }
    if (sub === "add") {
      const content = args.slice(1).join(" ").trim();
      if (!content) {
        return { type: "error", message: "使用方式: /memory-add <内容>" };
      }
      const now = new Date().toISOString();
      const slug = `user/manual-${Date.now().toString(36)}`;
      const memory: Memory = {
        slug,
        type: "user" as MemoryType,
        name: content.slice(0, 30),
        description: content.slice(0, 80),
        content,
        createdAt: now,
        updatedAt: now,
      };
      await getStore(context).save(memory);
      return {
        type: "action",
        message: `✅ 已添加记忆 [${slug}]: ${content.slice(0, 80)}`,
      };
    }
    if (sub === "delete") {
      const slug = args[1];
      if (!slug) {
        return { type: "error", message: "使用方式: /memory-delete <slug>" };
      }
      const store = getStore(context);
      const existing = await store.load(slug);
      if (!existing) {
        return { type: "error", message: `记忆 "${slug}" 未找到。` };
      }
      await store.delete(slug);
      return {
        type: "action",
        message: `🗑️ 已删除记忆 [${slug}]: ${existing.name}`,
      };
    }
    return errorUnknown();
  },
};

// ── /memory-list ─────────────────────────────────────────────────────

export const memoryListCommand: SlashCommand = {
  name: "memory-list",
  description: "列出所有记忆",
  async execute(_args, context) {
    return { type: "action", message: await listMemories(getStore(context)) };
  },
};

// ── /memory-add ──────────────────────────────────────────────────────

export const memoryAddCommand: SlashCommand = {
  name: "memory-add",
  description: "手动添加记忆",
  async execute(args, context) {
    const content = args.join(" ").trim();
    if (!content) {
      return { type: "error", message: "使用方式: /memory-add <内容>" };
    }
    const now = new Date().toISOString();
    const slug = `user/manual-${Date.now().toString(36)}`;
    const memory: Memory = {
      slug,
      type: "user" as MemoryType,
      name: content.slice(0, 30),
      description: content.slice(0, 80),
      content,
      createdAt: now,
      updatedAt: now,
    };
    await getStore(context).save(memory);
    return {
      type: "action",
      message: `✅ 已添加记忆 [${slug}]: ${content.slice(0, 80)}`,
    };
  },
};

// ── /memory-delete ───────────────────────────────────────────────────

export const memoryDeleteCommand: SlashCommand = {
  name: "memory-delete",
  description: "删除指定记忆",
  async execute(args, context) {
    const slug = args[0];
    if (!slug) {
      return { type: "error", message: "使用方式: /memory-delete <slug>" };
    }
    const store = getStore(context);
    const existing = await store.load(slug);
    if (!existing) {
      return { type: "error", message: `记忆 "${slug}" 未找到。` };
    }
    await store.delete(slug);
    return {
      type: "action",
      message: `🗑️ 已删除记忆 [${slug}]: ${existing.name}`,
    };
  },
};

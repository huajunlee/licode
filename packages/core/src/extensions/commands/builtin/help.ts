import type { SlashCommand } from "../registry.js";

const HELP_MAIN = [
  "══ LICode 帮助 ══",
  "",
  "用户指南: docs/guide/user-guide.md",
  "",
  "Slash 命令:",
  "  /help               — 显示此帮助",
  "  /help-recipes       — 列出场景 Recipes",
  "  /help-shortcuts     — 快捷键速查",
  "  /help-tools         — 内置工具速查",
  "  /clear              — 清空对话历史",
  "  /context            — 显示 token 用量和会话信息",
  "  /memory-list        — 列出所有记忆",
  "  /memory-add <内容>   — 手动添加记忆",
  "  /memory-delete <slug> — 删除指定记忆",
  "  /subagent           — 开关子 Agent 功能",
  "",
  "CLI 启动参数:",
  "  licode --session <id>  恢复会话",
  "  licode --model <name>  指定模型",
  "  licode --base-url <url> LLM API 地址",
  "  licode spec init|list|status|validate",
  "",
  '键入 /help-recipes 查看场景示例',
].join("\n");

const HELP_RECIPES = [
  "══ 场景 Recipes ══",
  "",
  "  1. 审查代码      docs/guide/recipes/code-review.md",
  "  2. 调试 bug       docs/guide/recipes/debug-bug.md",
  "  3. 添加新功能     docs/guide/recipes/add-feature.md",
  "  4. 配置 MCP 工具  docs/guide/recipes/mcp-config.md",
  "  5. 多 Agent 协作  docs/guide/recipes/multi-agent.md",
  "  6. 记忆偏好       docs/guide/recipes/memory-preferences.md",
  "  7. Hooks 自动化   docs/guide/recipes/hooks-lifecycle.md",
  "  8. Spec 驱动开发  docs/guide/recipes/spec-driven.md",
  "  9. 自定义提示词   docs/guide/recipes/system-prompt.md",
  "",
  "完整文档: docs/guide/user-guide.md",
].join("\n");

const HELP_SHORTCUTS = [
  "══ 快捷键速查 ══",
  "",
  "欢迎页:",
  "  ↑↓          选择会话",
  "  Enter       进入会话 / 新建会话",
  "",
  "聊天界面:",
  "  Enter                 发送消息",
  "  ↑↓ (输入框)           回溯输入历史",
  "  Ctrl+↑↓              切换推理卡片焦点",
  "  Enter (焦点在卡片)    展开/收起推理内容",
  "  Ctrl+Q               返回欢迎页",
  "  Ctrl+C               退出 LICode",
].join("\n");

const HELP_TOOLS = [
  "══ 内置工具速查 ══",
  "",
  "  read   读取文件    read { path, offset?, limit? }",
  "  write  写入文件    write { path, content }",
  "  edit   精确替换    edit { path, old_string, new_string, replace_all? }",
  "  bash   执行命令    bash { command, timeout? } 需确认",
  "  glob   文件名搜索  glob { pattern }",
  "  grep   内容搜索    grep { pattern, path?, include? }",
  "",
  "MCP 工具:    mcp__{server}__{tool}",
  "Skill 工具:  skill__{toolName}",
].join("\n");

// ── /help ── (backward compat: supports sub-commands via args) ──────

export const helpCommand: SlashCommand = {
  name: "help",
  description: "List all available commands and guides",
  async execute(args) {
    const sub = args[0];
    if (sub === "recipes") {
      return { type: "action", message: HELP_RECIPES };
    }
    if (sub === "shortcuts") {
      return { type: "action", message: HELP_SHORTCUTS };
    }
    if (sub === "tools") {
      return { type: "action", message: HELP_TOOLS };
    }
    return { type: "action", message: HELP_MAIN };
  },
};

// ── /help-recipes ──────────────────────────────────────────────────

export const helpRecipesCommand: SlashCommand = {
  name: "help-recipes",
  description: "列出场景 Recipes",
  async execute() {
    return { type: "action", message: HELP_RECIPES };
  },
};

// ── /help-shortcuts ────────────────────────────────────────────────

export const helpShortcutsCommand: SlashCommand = {
  name: "help-shortcuts",
  description: "快捷键速查",
  async execute() {
    return { type: "action", message: HELP_SHORTCUTS };
  },
};

// ── /help-tools ────────────────────────────────────────────────────

export const helpToolsCommand: SlashCommand = {
  name: "help-tools",
  description: "内置工具速查",
  async execute() {
    return { type: "action", message: HELP_TOOLS };
  },
};

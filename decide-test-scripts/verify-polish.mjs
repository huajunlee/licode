/**
 * 验证「交付前强制改写」真的发生。
 *
 * 抓三样东西对照：
 *   草稿  —— 模型流式吐出的原文（llm-token 事件累积）
 *   终稿  —— 落盘的 assistant 消息（改写后应当与草稿不同）
 *   事件  —— skill-polish-applied 是否发出
 *
 * 用法：cd <工作区> && node ../decide-test-scripts/verify-polish.mjs
 */
import * as fs from "node:fs";
import { initializeConversationRuntime } from "/Users/lixiaohua/Project/agent/LICode/.claude/worktrees/skill-progressive-disclosure/packages/cli/dist/cli.js";
import { AgentLoop } from "/Users/lixiaohua/Project/agent/LICode/.claude/worktrees/skill-progressive-disclosure/packages/core/dist/agent/loop.js";

const ROOT = "/Users/lixiaohua/Project/agent/LICode/.claude/worktrees/skill-progressive-disclosure";
const cwd = process.env.POLISH_WORKSPACE || `${ROOT}/decide-test-workspace-cat`;
const question = process.env.POLISH_QUESTION || "我最近在想要不要养只猫，你觉得呢？";
const OUT = process.env.POLISH_OUT || `${ROOT}/polish-verify.md`;

if (process.cwd() !== cwd) {
  console.error(`❌ 进程 cwd (${process.cwd()}) 必须等于工作区 (${cwd})`);
  process.exit(1);
}

const rt = await initializeConversationRuntime({
  cwd,
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseUrl: process.env.ANTHROPIC_BASE_URL,
  model: process.env.ANTHROPIC_MODEL || "deepseek-v4-flash",
});

const tokens = [];
const polished = [];
const events = [];
const eventBus = {
  emit(e) {
    if (e.type === "llm-token") tokens.push(e.text);
    if (e.type === "skill-polish-applied") polished.push(e);
    if (e.type === "error") events.push(`错误: ${e.error?.message ?? e.error}`);
  },
};

const loop = new AgentLoop({
  llm: rt.provider,
  conversation: rt.manager,
  tools: rt.tools,
  eventBus,
  skills: rt.extensions.skills, // ← 关键：交付前改写靠这个
});

const t0 = Date.now();
await loop.run(question);
const seconds = ((Date.now() - t0) / 1000).toFixed(1);

const draft = tokens.join("");
const msgs = rt.manager.getMessages();
const last = [...msgs].reverse().find((m) => m.role === "assistant" && typeof m.content === "string");
const finalText = last?.content ?? "";

const md = [];
const w = (s = "") => md.push(s);
w("# 交付前强制改写验证");
w();
w(`- 日期：2026-09-14`);
w(`- 工作区：\`${cwd.split("/").pop()}\``);
w(`- 问题：${question}`);
w(`- 耗时：${seconds}s`);
w();
w("## 判定");
w();
w(`- 加载的技能：${rt.extensions.skills.map((s) => s.name + (s.polishWith ? `(→${s.polishWith})` : "")).join(", ")}`);
w(`- \`skill-polish-applied\` 事件：${polished.length ? `✅ ${JSON.stringify(polished[0])}` : "❌ 未发出"}`);
w(`- 改写前的草稿：${draft.length} 字符`);
w(`- 落盘的终稿：${finalText.length} 字符`);
w(`- 终稿是否不同于草稿：${draft && finalText && finalText.trim() !== draft.trim() ? "✅ 是" : "❌ 相同"}`);
w();
if (events.length) {
  w("**运行期错误：**");
  events.forEach((e) => w(`- ${e}`));
  w();
}
w("---");
w();
w("## 改写前的草稿（模型流式输出）");
w();
w(draft || "**(空)**");
w();
w("---");
w();
w("## 改写后的终稿（落盘 / 交付给用户的）");
w();
w(finalText || "**(空)**");
w();

fs.writeFileSync(OUT, md.join("\n"), "utf-8");
console.log(`已写入: ${OUT}`);
console.log(`polish 事件: ${polished.length ? "✅ 触发" : "❌ 未触发"}`);
console.log(`草稿 ${draft.length} 字符 → 终稿 ${finalText.length} 字符`);
console.log(`终稿与草稿不同: ${draft && finalText && finalText.trim() !== draft.trim() ? "是" : "否"}`);

await rt.extensions.shutdown();
process.exit(0);
